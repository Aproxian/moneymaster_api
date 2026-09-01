"use strict";

const { prisma } = require("../prisma");
const { calendarDateInSweepTimezone } = require("../lib/investmentsRefreshCron");
const {
  refreshDailyQuotesForTwelveDataChunked,
  getTwelveDataCreditsPerTick,
} = require("./marketData");
const { logApp } = require("../lib/fileLogger");

const TWELVEDATA_STATE_ID = "TWELVEDATA";

/** Mirror to console (hosting) and daily file under `logs/` (see `MONEYMASTER_LOG_DIR`). */
function sweepLog(level, message, detail) {
  const prefix = "[TwelveDataSweep]";
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
  logApp(lev, "TwelveDataSweep", message, detail);
}

const SWEEP_INTERVAL_MS = Math.max(
  5_000,
  parseInt(process.env.TWELVEDATA_SWEEP_INTERVAL_MS || "60000", 10)
);

/** If `backgroundSweepLastTickAt` is older than this, the session is treated as stale (crashed worker). */
function getSweepHeartbeatStaleMs() {
  return Math.max(SWEEP_INTERVAL_MS * 4, 120_000);
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
/** First HTTP tick uses resetCycle from the start request; later ticks never reset. */
let pendingFirstReset = false;

/** Snapshot of total active instruments when the current sweep started (for progress hints). */
let sweepTotalInstruments = 0;

/** Last finished chunk result (success or Twelve Data error). Updated every tick (this process only). */
let lastCompletedTick = null;
/** Last Twelve Data API error object from a tick, if any. */
let lastTwelveDataError = null;
/** Non–Twelve-Data exception message from the last tick, if any. */
let lastTickException = null;
/**
 * Epoch ms before which no API tick should fire after a 429 rate-limit response.
 * Each consecutive 429 doubles the wait (65 s → 130 s → 260 s → 260 s …) so the
 * Twelve Data rolling 60-second window has time to drain before we retry.
 */
let rateLimitCooldownUntil = 0;
/** How many consecutive 429s we have seen without a successful tick in between. */
let consecutive429Count = 0;

/** Minimum pause after first 429 (must exceed Twelve Data's 60-second rolling window). */
const RATE_LIMIT_BASE_COOLDOWN_MS = 65_000;
/** Maximum pause between 429 retries (caps exponential back-off). */
const RATE_LIMIT_MAX_COOLDOWN_MS = 260_000;

function isLocalSweepRunnerActive() {
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
  rateLimitCooldownUntil = 0;
  consecutive429Count = 0;
}

async function clearPersistedSweepSession() {
  try {
    await prisma.twelveDataQuoteRefreshState.updateMany({
      where: { id: TWELVEDATA_STATE_ID },
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
      where: { id: TWELVEDATA_STATE_ID },
      data: { backgroundSweepLastTickAt: new Date() },
    });
  } catch (e) {
    sweepLog("error", "heartbeat update failed", e);
  }
}

/**
 * Stop the in-process timer and clear DB-backed sweep session flags (any Node instance).
 */
async function stopTwelveDataBackgroundSweep() {
  sweepLog("info", "stopTwelveDataBackgroundSweep invoked");
  clearLocalSweepIntervalAndMemory();
  lastCompletedTick = null;
  lastTwelveDataError = null;
  lastTickException = null;
  await clearPersistedSweepSession();
}

/**
 * Called from cancel when this process does not hold `setInterval`. Signals the runner to stop on its next tick.
 * If there is no fresh heartbeat, clears zombie session fields.
 */
async function requestRemoteBackgroundSweepCancel() {
  const staleBefore = new Date(Date.now() - getSweepHeartbeatStaleMs());
  const row = await prisma.twelveDataQuoteRefreshState.findUnique({
    where: { id: TWELVEDATA_STATE_ID },
    select: { backgroundSweepLastTickAt: true },
  });
  if (row?.backgroundSweepLastTickAt && row.backgroundSweepLastTickAt >= staleBefore) {
    await prisma.twelveDataQuoteRefreshState.update({
      where: { id: TWELVEDATA_STATE_ID },
      data: { backgroundSweepCancelRequested: true },
    });
    return { remoteCancelSignaled: true };
  }
  await clearPersistedSweepSession();
  return { remoteCancelSignaled: false, clearedStaleSession: true };
}

function getTwelveDataBackgroundSweepStatus() {
  return {
    running: intervalId != null,
    startedAt: startedAt ? startedAt.toISOString() : null,
    startedByUserId,
    intervalMs: SWEEP_INTERVAL_MS,
    creditsPerTick: getTwelveDataCreditsPerTick(),
    sweepBusy,
    sweepTotalInstruments,
    lastCompletedTick,
    lastTwelveDataError,
    lastTickException,
  };
}

/**
 * DB cursor + sweep telemetry for polling (GET) while a background sweep runs.
 * Merges DB heartbeat so GET matches POST even when requests hit different Node workers.
 */
async function getTwelveDataSweepLiveStatus() {
  const staleMs = getSweepHeartbeatStaleMs();
  const staleBefore = new Date(Date.now() - staleMs);

  const row = await prisma.twelveDataQuoteRefreshState.findUnique({
    where: { id: TWELVEDATA_STATE_ID },
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
  const mergedLastTwelveDataError = localRunning ? lastTwelveDataError : null;
  const mergedLastTickException = localRunning ? lastTickException : null;
  const mergedSweepBusy = localRunning ? sweepBusy : false;

  const partialLapInDb = total > 0 && next > 0 && next < total;

  let hint;
  if (running && sweepRunnerLikelyElsewhere) {
    hint =
      "A background sweep is running on another API process (or this one): heartbeat is fresh in the database. `lastCompletedTick` / errors below reflect only this process. Use sticky sessions or a single worker if you need all telemetry on one host.";
  } else if (running) {
    hint =
      "Background sweep is running on this process: each interval tick calls Twelve Data and updates the DB cursor until this lap completes (or a Twelve Data error blocks advancing the offset).";
  } else if (total === 0) {
    hint = "No instruments in the TWELVEDATA snapshot; start a sweep after active instruments exist.";
  } else if (partialLapInDb) {
    hint =
      "Background sweep is not running (heartbeat stale or stopped). The cursor is the last persisted offset. POST /investments/refresh-daily with { \"backgroundSweep\": true } to start (unless already_swept_today).";
  } else {
    hint =
      "Background sweep is not running; the cursor will not advance automatically. Start POST /investments/refresh-daily with { \"backgroundSweep\": true } (unless already_swept_today), or run a synchronous refresh without backgroundSweep to advance one chunk per request.";
  }

  return {
    running,
    sweepRunnerOnThisProcess,
    sweepRunnerLikelyElsewhere,
    startedAt: startedAtIso,
    startedByUserId: mergedStartedByUserId,
    intervalMs: SWEEP_INTERVAL_MS,
    creditsPerTick: getTwelveDataCreditsPerTick(),
    sweepBusy: mergedSweepBusy,
    sweepTotalInstruments: mergedSweepTotalInstruments,
    lastCompletedTick: mergedLastCompletedTick,
    lastTwelveDataError: mergedLastTwelveDataError,
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
 * @param {{ userId: string | null, resetCycle?: boolean }} options
 * @returns {Promise<{ ok: boolean, error?: string, intervalMs?: number, estimatedDurationMs?: number, ticksPerFullCycle?: number }>}
 */
async function startTwelveDataBackgroundSweep(options) {
  const userId = options.userId ?? null;
  if (intervalId != null) {
    return { ok: false, error: "already_running", ...getTwelveDataBackgroundSweepStatus() };
  }

  const total = await prisma.instrument.count({
    where: { provider: "TWELVEDATA", isActive: true },
  });
  const credits = getTwelveDataCreditsPerTick();
  const ticksPerFullCycle = total === 0 ? 0 : Math.ceil(total / credits);
  const estimatedDurationMs = ticksPerFullCycle * SWEEP_INTERVAL_MS;

  const staleBefore = new Date(Date.now() - getSweepHeartbeatStaleMs());
  const existing = await prisma.twelveDataQuoteRefreshState.findUnique({
    where: { id: TWELVEDATA_STATE_ID },
    select: { backgroundSweepLastTickAt: true },
  });
  if (
    existing?.backgroundSweepLastTickAt &&
    existing.backgroundSweepLastTickAt.getTime() >= staleBefore.getTime()
  ) {
    return { ok: false, error: "already_running", ...getTwelveDataBackgroundSweepStatus() };
  }

  await prisma.twelveDataQuoteRefreshState.upsert({
    where: { id: TWELVEDATA_STATE_ID },
    create: {
      id: TWELVEDATA_STATE_ID,
      nextOffset: 0,
      totalSnapshot: total,
    },
    update: {
      totalSnapshot: total,
    },
  });

  const now = new Date();
  const claimed = await prisma.twelveDataQuoteRefreshState.updateMany({
    where: {
      id: TWELVEDATA_STATE_ID,
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
    return { ok: false, error: "already_running", ...getTwelveDataBackgroundSweepStatus() };
  }

  startedByUserId = userId;
  sweepAuditUserId = userId;
  startedAt = new Date();
  quotesCreatedThisSweep = 0;
  pendingFirstReset = Boolean(options.resetCycle);
  sweepTotalInstruments = total;
  lastCompletedTick = null;
  lastTwelveDataError = null;
  lastTickException = null;

  const runTick = async () => {
    if (!intervalId) return;

    const cancelRow = await prisma.twelveDataQuoteRefreshState.findUnique({
      where: { id: TWELVEDATA_STATE_ID },
      select: { backgroundSweepCancelRequested: true },
    });
    if (cancelRow?.backgroundSweepCancelRequested) {
      sweepLog("info", "tick loop exiting (backgroundSweepCancelRequested)");
      await clearPersistedSweepSession();
      clearLocalSweepIntervalAndMemory();
      lastCompletedTick = null;
      lastTwelveDataError = null;
      lastTickException = null;
      return;
    }

    if (sweepBusy) {
      sweepLog("warn", "previous tick still running; skipping this interval");
      return;
    }

    // Rate-limit cooldown: if the last tick returned 429, pause until the Twelve Data
    // 60-second rolling window has had time to drain before retrying.
    if (rateLimitCooldownUntil > 0 && Date.now() < rateLimitCooldownUntil) {
      const remainingS = Math.ceil((rateLimitCooldownUntil - Date.now()) / 1000);
      sweepLog("info", `rate-limit cooldown active — skipping tick (${remainingS}s remaining)`);
      return;
    }
    if (rateLimitCooldownUntil > 0 && Date.now() >= rateLimitCooldownUntil) {
      sweepLog("info", "rate-limit cooldown elapsed — resuming sweep");
      rateLimitCooldownUntil = 0;
    }

    sweepBusy = true;
    try {
      const resetCycle = pendingFirstReset;
      pendingFirstReset = false;

      const result = await refreshDailyQuotesForTwelveDataChunked({
        resetCycle,
        skipBatchGap: true,
      });
      quotesCreatedThisSweep += result.quotesCreated || 0;

      lastTwelveDataError = result.twelveDataError ?? null;
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
        twelveDataError: result.twelveDataError ?? null,
      };

      sweepLog("info", "tick", {
        quotesCreated: result.quotesCreated ?? 0,
        sliceLen: result.processedThisTick,
        offsetStart: result.offsetStart,
        nextOffset: result.nextOffset,
        total: result.instrumentsCount,
        cycleJustCompleted: Boolean(result.cycleJustCompleted),
        error: result.twelveDataError ?? null,
      });

      if (result.twelveDataError) {
        if (result.twelveDataError.code === 429 || result.twelveDataError.code === "429") {
          // Exponential back-off: 65 s → 130 s → 260 s (capped).
          consecutive429Count += 1;
          const cooldownMs = Math.min(
            RATE_LIMIT_BASE_COOLDOWN_MS * Math.pow(2, consecutive429Count - 1),
            RATE_LIMIT_MAX_COOLDOWN_MS
          );
          rateLimitCooldownUntil = Date.now() + cooldownMs;
          sweepLog("warn", `rate-limit 429 — cooling down for ${Math.round(cooldownMs / 1000)}s (consecutive: ${consecutive429Count})`, result.twelveDataError);
        } else {
          sweepLog("warn", "Twelve Data error (cursor not advanced)", result.twelveDataError);
        }
        return;
      }

      // Successful tick — reset 429 counter.
      consecutive429Count = 0;
      rateLimitCooldownUntil = 0;

      if (result.cycleJustCompleted) {
        const quotesCreatedTotal = quotesCreatedThisSweep;
        const instrumentsCount = result.instrumentsCount;
        const auditUid = sweepAuditUserId;
        await stopTwelveDataBackgroundSweep();
        if (quotesCreatedTotal > 0) {
          try {
            const day = calendarDateInSweepTimezone();
            await prisma.twelveDataQuoteRefreshState.updateMany({
              where: { id: TWELVEDATA_STATE_ID },
              data: { lastBackgroundSweepCompletedDate: day },
            });
          } catch (persistErr) {
            sweepLog("error", "lastBackgroundSweepCompletedDate update failed", persistErr);
          }
        } else {
          sweepLog("warn", "full sweep ended with zero quotes; not marking day complete", {
            instrumentsCount,
          });
        }
        try {
          await prisma.auditLog.create({
            data: {
              userId: auditUid,
              action: "UPDATE",
              entity: "TwelveDataQuoteSweep",
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
        twelveDataError: null,
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

  sweepLog("info", "background sweep started", {
    userId,
    intervalMs: SWEEP_INTERVAL_MS,
    instrumentsCount: total,
    creditsPerTick: credits,
    resetCycle: Boolean(options.resetCycle),
  });

  return {
    ok: true,
    intervalMs: SWEEP_INTERVAL_MS,
    estimatedDurationMs,
    ticksPerFullCycle,
    creditsPerTick: credits,
    instrumentsCount: total,
  };
}

module.exports = {
  startTwelveDataBackgroundSweep,
  stopTwelveDataBackgroundSweep,
  getTwelveDataBackgroundSweepStatus,
  getTwelveDataSweepLiveStatus,
  isLocalSweepRunnerActive,
  requestRemoteBackgroundSweepCancel,
  SWEEP_INTERVAL_MS,
};
