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

function getTwelveDataBackgroundSweepStatus() {
  return {
    running: intervalId != null,
    startedAt: startedAt ? startedAt.toISOString() : null,
    startedByUserId,
    intervalMs: SWEEP_INTERVAL_MS,
    creditsPerTick: getTwelveDataCreditsPerTick(),
    sweepBusy,
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
      // eslint-disable-next-line no-console -- avoid silent failure
      console.error("[TwelveDataSweep] tick failed:", e);
    } finally {
      sweepBusy = false;
    }
  };

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
  SWEEP_INTERVAL_MS,
};
