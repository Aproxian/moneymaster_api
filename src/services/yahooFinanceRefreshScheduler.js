"use strict";

const { prisma } = require("../prisma");
const { calendarDateInSweepTimezone } = require("../lib/investmentsRefreshCron");
const {
  refreshDailyQuotesForYahooFinanceChunked,
  getYahooFinanceSymbolsPerTick,
} = require("./yahooFinanceData");
const { logApp } = require("../lib/fileLogger");

const YAHOO_STATE_ID = "YAHOOFINANCE";

/** Mirror to console (hosting) and daily file under `logs/` (see `MONEYMASTER_LOG_DIR`). */
function sweepLog(level, message, detail) {
  const prefix = "[YahooFinanceSweep]";
  if (level === "warn") {
    // eslint-disable-next-line no-console -- paired with file log
    console.warn(prefix, message, detail !== undefined ? detail : "");
  } else if (level === "error") {
    // eslint-disable-next-line no-console -- paired with file log
    console.error(prefix, message, detail !== undefined ? detail : "");
  } else {
    // eslint-disable-next-line no-console -- paired with file log
    console.log(prefix, message, detail !== undefined ? detail : "");
  }
  const lev = level === "warn" ? "WARN" : level === "error" ? "ERROR" : "INFO";
  logApp(lev, "YahooFinanceSweep", message, detail);
}

const SWEEP_INTERVAL_MS = Math.max(
  3_000,
  parseInt(process.env.YAHOO_FINANCE_SWEEP_INTERVAL_MS || "10000", 10)
);

/** If `backgroundSweepLastTickAt` is older than this, the session is treated as stale. */
function getSweepHeartbeatStaleMs() {
  return Math.max(SWEEP_INTERVAL_MS * 4, 60_000);
}

/** @type {ReturnType<typeof setInterval> | null} */
let intervalId = null;
let sweepBusy = false;
/** @type {string | null} */
let startedByUserId = null;
/** @type {string | null} */
let sweepAuditUserId = null;
/** @type {Date | null} */
let startedAt = null;
let quotesCreatedThisSweep = 0;
/** First tick uses resetCycle from the start request; later ticks never reset. */
let pendingFirstReset = false;

/** Snapshot of total active instruments when the current sweep started (for progress hints). */
let sweepTotalInstruments = 0;

/** Last finished chunk result. Updated every tick (this process only). */
let lastCompletedTick = null;
/** Non-provider exception message from the last tick, if any. */
let lastTickException = null;

function isLocalYahooSweepRunnerActive() {
  return intervalId != null;
}

function clearLocalSweepIntervalAndMemory() {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  sweepBusy = false;
  startedByUserId = null;
  sweepAuditUserId = null;
  startedAt = null;
  quotesCreatedThisSweep = 0;
  pendingFirstReset = false;
  sweepTotalInstruments = 0;
}

async function clearPersistedSweepSession() {
  try {
    await prisma.twelveDataQuoteRefreshState.updateMany({
      where: { id: YAHOO_STATE_ID },
      data: {
        backgroundSweepSessionStartedAt: null,
        backgroundSweepLastTickAt: null,
        backgroundSweepStartedByUserId: null,
        backgroundSweepInstrumentsSnapshot: null,
        backgroundSweepCancelRequested: false,
      },
    });
  } catch (e) {
    sweepLog("error", "clearPersistedSweepSession failed", e);
  }
}

async function touchSweepHeartbeat() {
  try {
    await prisma.twelveDataQuoteRefreshState.update({
      where: { id: YAHOO_STATE_ID },
      data: { backgroundSweepLastTickAt: new Date() },
    });
  } catch (e) {
    sweepLog("error", "heartbeat update failed", e);
  }
}

/**
 * Stop the in-process timer and clear DB-backed sweep session flags (any Node instance).
 */
async function stopYahooFinanceBackgroundSweep() {
  sweepLog("info", "stopYahooFinanceBackgroundSweep invoked");
  clearLocalSweepIntervalAndMemory();
  lastCompletedTick = null;
  lastTickException = null;
  await clearPersistedSweepSession();
}

/**
 * Called from cancel when this process does not hold `setInterval`.
 * Signals the runner to stop on its next tick; clears zombie sessions if heartbeat is stale.
 */
async function requestRemoteYahooSweepCancel() {
  const staleBefore = new Date(Date.now() - getSweepHeartbeatStaleMs());
  const row = await prisma.twelveDataQuoteRefreshState.findUnique({
    where: { id: YAHOO_STATE_ID },
    select: { backgroundSweepLastTickAt: true },
  });
  if (row?.backgroundSweepLastTickAt && row.backgroundSweepLastTickAt >= staleBefore) {
    await prisma.twelveDataQuoteRefreshState.update({
      where: { id: YAHOO_STATE_ID },
      data: { backgroundSweepCancelRequested: true },
    });
    return { remoteCancelSignaled: true };
  }
  await clearPersistedSweepSession();
  return { remoteCancelSignaled: false, clearedStaleSession: true };
}

function getYahooFinanceBackgroundSweepStatus() {
  return {
    running: intervalId != null,
    startedAt: startedAt ? startedAt.toISOString() : null,
    startedByUserId,
    intervalMs: SWEEP_INTERVAL_MS,
    symbolsPerTick: getYahooFinanceSymbolsPerTick(),
    sweepBusy,
    sweepTotalInstruments,
    lastCompletedTick,
    lastTickException,
  };
}

/**
 * DB cursor + sweep telemetry for polling (GET) while a background sweep runs.
 * Merges DB heartbeat so GET matches POST even when requests hit different Node workers.
 */
async function getYahooFinanceSweepLiveStatus() {
  const staleMs = getSweepHeartbeatStaleMs();
  const staleBefore = new Date(Date.now() - staleMs);

  const row = await prisma.twelveDataQuoteRefreshState.findUnique({
    where: { id: YAHOO_STATE_ID },
    select: {
      nextOffset: true,
      totalSnapshot: true,
      lastBackgroundSweepCompletedDate: true,
      backgroundSweepSessionStartedAt: true,
      backgroundSweepLastTickAt: true,
      backgroundSweepStartedByUserId: true,
      backgroundSweepInstrumentsSnapshot: true,
      backgroundSweepCancelRequested: true,
    },
  });

  const total = row?.totalSnapshot ?? 0;
  const next = row?.nextOffset ?? 0;
  const approxRemainingThisLap = total > 0 ? Math.max(0, total - next) : 0;

  const dbHeartbeatFresh =
    Boolean(row?.backgroundSweepLastTickAt) &&
    row.backgroundSweepLastTickAt.getTime() >= staleBefore.getTime();

  const localRunning = intervalId != null;
  const running = localRunning || dbHeartbeatFresh;
  const sweepRunnerOnThisProcess = localRunning;
  const sweepRunnerLikelyElsewhere = running && !localRunning;

  const startedAtIso = localRunning
    ? startedAt
      ? startedAt.toISOString()
      : null
    : row?.backgroundSweepSessionStartedAt?.toISOString() ?? null;

  const mergedStartedByUserId = localRunning
    ? startedByUserId
    : row?.backgroundSweepStartedByUserId ?? null;

  const mergedSweepTotalInstruments = localRunning
    ? sweepTotalInstruments
    : dbHeartbeatFresh
      ? row?.backgroundSweepInstrumentsSnapshot ?? 0
      : 0;

  const mergedLastCompletedTick = localRunning ? lastCompletedTick : null;
  const mergedLastTickException = localRunning ? lastTickException : null;
  const mergedSweepBusy = localRunning ? sweepBusy : false;

  const partialLapInDb = total > 0 && next > 0 && next < total;

  let hint;
  if (running && sweepRunnerLikelyElsewhere) {
    hint =
      "A Yahoo Finance background sweep is running on another API process (or this one): heartbeat is fresh in the database. Use sticky sessions or a single worker if you need all telemetry on one host.";
  } else if (running) {
    hint =
      "Yahoo Finance background sweep is running on this process: each interval tick fetches quotes and updates the DB cursor until this lap completes.";
  } else if (total === 0) {
    hint = "No YAHOOFINANCE instruments found; seed instruments with provider=YAHOOFINANCE before starting the sweep.";
  } else if (partialLapInDb) {
    hint =
      "Yahoo Finance sweep is not running (heartbeat stale or stopped). POST /investments/refresh-daily-yahoo with { \"backgroundSweep\": true } to start (unless already_swept_today).";
  } else {
    hint =
      "Yahoo Finance sweep is not running. POST /investments/refresh-daily-yahoo with { \"backgroundSweep\": true } to start.";
  }

  return {
    running,
    sweepRunnerOnThisProcess,
    sweepRunnerLikelyElsewhere,
    startedAt: startedAtIso,
    startedByUserId: mergedStartedByUserId,
    intervalMs: SWEEP_INTERVAL_MS,
    symbolsPerTick: getYahooFinanceSymbolsPerTick(),
    sweepBusy: mergedSweepBusy,
    sweepTotalInstruments: mergedSweepTotalInstruments,
    lastCompletedTick: mergedLastCompletedTick,
    lastTickException: mergedLastTickException,
    cursor: row
      ? {
          nextOffset: row.nextOffset,
          totalSnapshot: row.totalSnapshot,
          lastBackgroundSweepCompletedDate: row.lastBackgroundSweepCompletedDate,
        }
      : null,
    approxInstrumentsRemainingThisLap: approxRemainingThisLap,
    partialLapInDb,
    sweepHeartbeatStaleAfterMs: staleMs,
    backgroundSweepCancelPending: Boolean(row?.backgroundSweepCancelRequested),
    hint,
  };
}

/**
 * @param {{ userId?: string | null, resetCycle?: boolean }} options
 */
async function startYahooFinanceBackgroundSweep(options = {}) {
  const userId = options.userId ?? null;
  if (intervalId != null) {
    return { ok: false, error: "already_running", ...getYahooFinanceBackgroundSweepStatus() };
  }

  const total = await prisma.instrument.count({
    where: { provider: "YAHOOFINANCE", isActive: true },
  });
  const symbolsPerTick = getYahooFinanceSymbolsPerTick();
  const ticksPerFullCycle = total === 0 ? 0 : Math.ceil(total / symbolsPerTick);
  const estimatedDurationMs = ticksPerFullCycle * SWEEP_INTERVAL_MS;

  const staleBefore = new Date(Date.now() - getSweepHeartbeatStaleMs());
  const existing = await prisma.twelveDataQuoteRefreshState.findUnique({
    where: { id: YAHOO_STATE_ID },
    select: { backgroundSweepLastTickAt: true },
  });
  if (
    existing?.backgroundSweepLastTickAt &&
    existing.backgroundSweepLastTickAt.getTime() >= staleBefore.getTime()
  ) {
    return { ok: false, error: "already_running", ...getYahooFinanceBackgroundSweepStatus() };
  }

  await prisma.twelveDataQuoteRefreshState.upsert({
    where: { id: YAHOO_STATE_ID },
    create: { id: YAHOO_STATE_ID, nextOffset: 0, totalSnapshot: total },
    update: { totalSnapshot: total },
  });

  const now = new Date();
  const claimed = await prisma.twelveDataQuoteRefreshState.updateMany({
    where: {
      id: YAHOO_STATE_ID,
      OR: [{ backgroundSweepLastTickAt: null }, { backgroundSweepLastTickAt: { lt: staleBefore } }],
    },
    data: {
      backgroundSweepSessionStartedAt: now,
      backgroundSweepLastTickAt: now,
      backgroundSweepStartedByUserId: userId,
      backgroundSweepInstrumentsSnapshot: total,
      backgroundSweepCancelRequested: false,
    },
  });

  if (claimed.count === 0) {
    return { ok: false, error: "already_running", ...getYahooFinanceBackgroundSweepStatus() };
  }

  startedByUserId = userId;
  sweepAuditUserId = userId;
  startedAt = new Date();
  quotesCreatedThisSweep = 0;
  pendingFirstReset = Boolean(options.resetCycle);
  sweepTotalInstruments = total;
  lastCompletedTick = null;
  lastTickException = null;

  const runTick = async () => {
    if (!intervalId) return;

    const cancelRow = await prisma.twelveDataQuoteRefreshState.findUnique({
      where: { id: YAHOO_STATE_ID },
      select: { backgroundSweepCancelRequested: true },
    });
    if (cancelRow?.backgroundSweepCancelRequested) {
      sweepLog("info", "tick loop exiting (backgroundSweepCancelRequested)");
      await clearPersistedSweepSession();
      clearLocalSweepIntervalAndMemory();
      lastCompletedTick = null;
      lastTickException = null;
      return;
    }

    if (sweepBusy) {
      sweepLog("warn", "previous tick still running; skipping this interval");
      return;
    }
    sweepBusy = true;
    try {
      const resetCycle = pendingFirstReset;
      pendingFirstReset = false;

      const result = await refreshDailyQuotesForYahooFinanceChunked({ resetCycle });
      quotesCreatedThisSweep += result.quotesCreated || 0;

      lastTickException = null;
      lastCompletedTick = {
        at: new Date().toISOString(),
        offsetStart: result.offsetStart,
        nextOffset: result.nextOffset,
        sliceLen: result.processedThisTick,
        quotesCreated: result.quotesCreated ?? 0,
        missingCount: result.missingSymbols?.length ?? 0,
        missingSample: (result.missingSymbols ?? []).slice(0, 10),
        cycleJustCompleted: Boolean(result.cycleJustCompleted),
      };

      sweepLog("info", "tick", {
        quotesCreated: result.quotesCreated ?? 0,
        sliceLen: result.processedThisTick,
        offsetStart: result.offsetStart,
        nextOffset: result.nextOffset,
        total: result.instrumentsCount,
        cycleJustCompleted: Boolean(result.cycleJustCompleted),
        missingCount: result.missingSymbols?.length ?? 0,
      });

      if (result.cycleJustCompleted) {
        const quotesCreatedTotal = quotesCreatedThisSweep;
        const instrumentsCount = result.instrumentsCount;
        const auditUid = sweepAuditUserId;
        await stopYahooFinanceBackgroundSweep();
        if (instrumentsCount > 0) {
          try {
            const day = calendarDateInSweepTimezone();
            await prisma.twelveDataQuoteRefreshState.updateMany({
              where: { id: YAHOO_STATE_ID },
              data: { lastBackgroundSweepCompletedDate: day },
            });
          } catch (persistErr) {
            sweepLog("error", "lastBackgroundSweepCompletedDate update failed", persistErr);
          }
        }
        try {
          await prisma.auditLog.create({
            data: {
              userId: auditUid,
              action: "UPDATE",
              entity: "YahooFinanceQuoteSweep",
              entityId: null,
              meta: {
                completed: true,
                quotesCreatedTotal,
                instrumentsCount,
              },
            },
          });
        } catch (e) {
          sweepLog("error", "audit log failed", e);
        }
      }
    } catch (e) {
      lastTickException = e instanceof Error ? e.message : String(e);
      lastCompletedTick = {
        at: new Date().toISOString(),
        offsetStart: null,
        nextOffset: null,
        sliceLen: null,
        quotesCreated: 0,
        missingCount: 0,
        missingSample: [],
        cycleJustCompleted: false,
      };
      sweepLog("error", "tick failed", e);
    } finally {
      sweepBusy = false;
      if (intervalId != null) {
        await touchSweepHeartbeat();
      }
    }
  };

  intervalId = setInterval(() => {
    void runTick();
  }, SWEEP_INTERVAL_MS);

  void runTick();

  sweepLog("info", "Yahoo Finance background sweep started", {
    userId,
    intervalMs: SWEEP_INTERVAL_MS,
    instrumentsCount: total,
    symbolsPerTick,
    resetCycle: Boolean(options.resetCycle),
  });

  return {
    ok: true,
    intervalMs: SWEEP_INTERVAL_MS,
    estimatedDurationMs,
    ticksPerFullCycle,
    symbolsPerTick,
    instrumentsCount: total,
  };
}

module.exports = {
  startYahooFinanceBackgroundSweep,
  stopYahooFinanceBackgroundSweep,
  getYahooFinanceBackgroundSweepStatus,
  getYahooFinanceSweepLiveStatus,
  isLocalYahooSweepRunnerActive,
  requestRemoteYahooSweepCancel,
  YAHOO_SWEEP_INTERVAL_MS: SWEEP_INTERVAL_MS,
};
