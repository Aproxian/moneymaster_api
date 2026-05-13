"use strict";

const { prisma } = require("../prisma");
const { calendarDateInSweepTimezone } = require("../lib/investmentsRefreshCron");
const {
  refreshDailyQuotesForTwelveDataChunked,
  getTwelveDataCreditsPerTick,
} = require("./marketData");

const TWELVEDATA_STATE_ID = "TWELVEDATA";

const SWEEP_INTERVAL_MS = Math.max(
  5_000,
  parseInt(process.env.TWELVEDATA_SWEEP_INTERVAL_MS || "60000", 10)
);

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

/** Last finished chunk result (success or Twelve Data error). Updated every tick. */
let lastCompletedTick = null;
/** Last Twelve Data API error object from a tick, if any. */
let lastTwelveDataError = null;
/** Non–Twelve-Data exception message from the last tick, if any. */
let lastTickException = null;

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
 */
async function getTwelveDataSweepLiveStatus() {
  const state = await prisma.twelveDataQuoteRefreshState.findUnique({
    where: { id: TWELVEDATA_STATE_ID },
    select: {
      nextOffset: true,
      totalSnapshot: true,
      lastBackgroundSweepCompletedDate: true,
    },
  });
  const total = state?.totalSnapshot ?? 0;
  const next = state?.nextOffset ?? 0;
  const approxRemainingThisLap = total > 0 ? Math.max(0, total - next) : 0;
  return {
    ...getTwelveDataBackgroundSweepStatus(),
    cursor: state
      ? {
          nextOffset: state.nextOffset,
          totalSnapshot: state.totalSnapshot,
          lastBackgroundSweepCompletedDate: state.lastBackgroundSweepCompletedDate,
        }
      : null,
    approxInstrumentsRemainingThisLap: approxRemainingThisLap,
  };
}

function stopTwelveDataBackgroundSweep() {
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
    if (sweepBusy) {
      // eslint-disable-next-line no-console -- operational visibility
      console.warn("[TwelveDataSweep] previous tick still running; skipping this interval");
      return;
    }
    sweepBusy = true;
    try {
      const resetCycle = pendingFirstReset;
      pendingFirstReset = false;

      const result = await refreshDailyQuotesForTwelveDataChunked({ resetCycle });
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

      // eslint-disable-next-line no-console -- operational visibility (tail logs / journal)
      console.log(
        "[TwelveDataSweep] tick",
        JSON.stringify({
          quotesCreated: result.quotesCreated ?? 0,
          sliceLen: result.processedThisTick,
          offsetStart: result.offsetStart,
          nextOffset: result.nextOffset,
          total: result.instrumentsCount,
          cycleJustCompleted: Boolean(result.cycleJustCompleted),
          error: result.twelveDataError ?? null,
        })
      );

      if (result.twelveDataError) {
        // eslint-disable-next-line no-console -- operational visibility
        console.warn("[TwelveDataSweep] Twelve Data error (cursor not advanced):", result.twelveDataError);
        return;
      }

      if (result.cycleJustCompleted) {
        const quotesCreatedTotal = quotesCreatedThisSweep;
        const instrumentsCount = result.instrumentsCount;
        const auditUid = sweepAuditUserId;
        stopTwelveDataBackgroundSweep();
        try {
          const day = calendarDateInSweepTimezone();
          await prisma.twelveDataQuoteRefreshState.updateMany({
            where: { id: TWELVEDATA_STATE_ID },
            data: { lastBackgroundSweepCompletedDate: day },
          });
        } catch (persistErr) {
          // eslint-disable-next-line no-console -- avoid silent failure
          console.error("[TwelveDataSweep] lastBackgroundSweepCompletedDate update failed:", persistErr);
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
          // eslint-disable-next-line no-console -- avoid silent failure
          console.error("[TwelveDataSweep] audit log failed:", e);
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
      // eslint-disable-next-line no-console -- avoid silent failure
      console.error("[TwelveDataSweep] tick failed:", e);
    } finally {
      sweepBusy = false;
    }
  };

  // Does not call any HTTP URL on this API — runs `runTick` in-process (Twelve Data is called inside marketData).
  intervalId = setInterval(() => {
    void runTick();
  }, SWEEP_INTERVAL_MS);

  void runTick();

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
  SWEEP_INTERVAL_MS,
};
