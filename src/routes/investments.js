const { Router } = require("express");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { refreshDailyAuth } = require("../middleware/refreshDailyAuth");
const { isAdminUserEmail } = require("../lib/adminUser");
const {
  calendarDateInSweepTimezone,
  SWEEP_DAY_TIMEZONE,
  CRON_SECRET_HEADER,
} = require("../lib/investmentsRefreshCron");
const { refreshDailyQuotesForTwelveData } = require("../services/marketData");
const {
  startTwelveDataBackgroundSweep,
  stopTwelveDataBackgroundSweep,
  getTwelveDataBackgroundSweepStatus,
  getTwelveDataSweepLiveStatus,
  isLocalSweepRunnerActive,
  requestRemoteBackgroundSweepCancel,
} = require("../services/twelveDataRefreshScheduler");

const investmentsRouter = Router();

const TWELVEDATA_STATE_ID = "TWELVEDATA";

async function assertAdmin(req, res) {
  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) {
    res.status(503).json({ error: "ADMIN_EMAIL is not configured on the server" });
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { id: true, email: true },
  });

  if (!user || !isAdminUserEmail(user.email)) {
    res.status(403).json({ error: "Not allowed to perform this operation" });
    return null;
  }

  return user;
}

/** Cron requests must not run arbitrary chunk refresh (credit burn); only sweep control. */
function rejectCronNonSweepBody(req, res, backgroundSweep, cancelBackgroundSweep) {
  if (!req.refreshDailyCron) return false;
  if (backgroundSweep || cancelBackgroundSweep) return false;
  res.status(403).json({
    error: "cron_only_background_sweep",
    message:
      "When using cron header authentication, send backgroundSweep: true or cancelBackgroundSweep: true only.",
  });
  return true;
}

/** Poll while a background sweep runs (same auth as POST /refresh-daily: JWT admin or cron header). */
investmentsRouter.get("/twelve-data-sweep-status", refreshDailyAuth, async (req, res, next) => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL?.trim();
    if (!req.refreshDailyCron && adminEmail) {
      const user = await assertAdmin(req, res);
      if (!user) return;
    }
    const live = await getTwelveDataSweepLiveStatus();
    return res.json({
      provider: "TWELVEDATA",
      ...live,
      cronAuthHeaderName: CRON_SECRET_HEADER,
    });
  } catch (err) {
    next(err);
  }
});

investmentsRouter.post("/refresh-daily", refreshDailyAuth, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const resetCycle =
      body.resetCycle === true || body.resetCycle === "true" || body.resetCycle === 1;
    const backgroundSweep =
      body.backgroundSweep === true ||
      body.backgroundSweep === "true" ||
      body.backgroundSweep === 1;
    const cancelBackgroundSweep =
      body.cancelBackgroundSweep === true ||
      body.cancelBackgroundSweep === "true" ||
      body.cancelBackgroundSweep === 1;

    if (rejectCronNonSweepBody(req, res, backgroundSweep, cancelBackgroundSweep)) {
      return;
    }

    const adminEmail = process.env.ADMIN_EMAIL?.trim();
    if (!req.refreshDailyCron && adminEmail) {
      const user = await assertAdmin(req, res);
      if (!user) return;
    }

    const auditUserId = req.auth?.userId ?? null;
    const auditCron = Boolean(req.refreshDailyCron);

    if (cancelBackgroundSweep) {
      if (isLocalSweepRunnerActive()) {
        await stopTwelveDataBackgroundSweep();
      } else {
        await requestRemoteBackgroundSweepCancel();
      }
      await prisma.auditLog.create({
        data: {
          userId: auditUserId,
          action: "UPDATE",
          entity: "QuoteCache",
          entityId: null,
          meta: {
            provider: "TWELVEDATA",
            backgroundSweepCancelled: true,
            ...(auditCron ? { investmentsCron: true } : {}),
          },
        },
      });
      return res.json({
        provider: "TWELVEDATA",
        cancelled: true,
        sweep: getTwelveDataBackgroundSweepStatus(),
      });
    }

    if (backgroundSweep) {
      const today = calendarDateInSweepTimezone();
      const stateRow = await prisma.twelveDataQuoteRefreshState.findUnique({
        where: { id: TWELVEDATA_STATE_ID },
        select: { lastBackgroundSweepCompletedDate: true },
      });
      if (stateRow?.lastBackgroundSweepCompletedDate === today) {
        return res.status(409).json({
          provider: "TWELVEDATA",
          error: "already_swept_today",
          sweepDayTimezone: SWEEP_DAY_TIMEZONE,
          lastBackgroundSweepCompletedDate: stateRow.lastBackgroundSweepCompletedDate,
        });
      }

      const started = await startTwelveDataBackgroundSweep({
        userId: auditUserId,
        resetCycle,
      });
      if (!started.ok) {
        return res.status(409).json({
          provider: "TWELVEDATA",
          error: started.error || "sweep_not_started",
          sweep: getTwelveDataBackgroundSweepStatus(),
        });
      }

      await prisma.auditLog.create({
        data: {
          userId: auditUserId,
          action: "UPDATE",
          entity: "QuoteCache",
          entityId: null,
          meta: {
            provider: "TWELVEDATA",
            backgroundSweepStarted: true,
            intervalMs: started.intervalMs,
            ticksPerFullCycle: started.ticksPerFullCycle,
            estimatedDurationMs: started.estimatedDurationMs,
            resetCycleFirstTick: resetCycle,
            ...(auditCron ? { investmentsCron: true } : {}),
          },
        },
      });

      return res.status(202).json({
        provider: "TWELVEDATA",
        accepted: true,
        sweep: "background_started",
        intervalMs: started.intervalMs,
        creditsPerTick: started.creditsPerTick,
        instrumentsCount: started.instrumentsCount,
        ticksPerFullCycle: started.ticksPerFullCycle,
        estimatedDurationMs: started.estimatedDurationMs,
        sweepDayTimezone: SWEEP_DAY_TIMEZONE,
        cronAuthHeaderName: CRON_SECRET_HEADER,
        hint:
          "One setInterval runs on this server: first chunk immediately, then one chunk per interval until the cycle completes. At most one successful full sweep per calendar day in sweepDayTimezone. Use cancelBackgroundSweep to stop.",
      });
    }

    const result = await refreshDailyQuotesForTwelveData({ resetCycle });

    await prisma.auditLog.create({
      data: {
        userId: auditUserId,
        action: "UPDATE",
        entity: "QuoteCache",
        entityId: null,
        meta: {
          provider: "TWELVEDATA",
          mode: result.mode,
          instrumentsCount: result.instrumentsCount,
          quotesCreated: result.quotesCreated,
          ...(result.mode === "chunk"
            ? {
                chunkSize: result.chunkSize,
                offsetStart: result.offsetStart,
                nextOffset: result.nextOffset,
                cycleJustCompleted: result.cycleJustCompleted,
              }
            : {}),
          ...(result.twelveDataError ? { twelveDataError: result.twelveDataError } : {}),
          ...(auditCron ? { investmentsCron: true } : {}),
        },
      },
    });

    return res.json({
      provider: "TWELVEDATA",
      ...result,
      sweep: getTwelveDataBackgroundSweepStatus(),
    });
  } catch (err) {
    next(err);
  }
});

investmentsRouter.use(requireAuth);

const {
  postSingleInstrument,
  postBulkInstruments,
} = require("../services/instrumentAdminImport");

investmentsRouter.post("/instruments", postSingleInstrument);
investmentsRouter.post("/instruments/bulk", postBulkInstruments);

module.exports = { investmentsRouter };
