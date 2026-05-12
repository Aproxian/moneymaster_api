const { Router } = require("express");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { isAdminUserEmail } = require("../lib/adminUser");
const {
  refreshDailyQuotesForTwelveData,
} = require("../services/marketData");
const {
  startTwelveDataBackgroundSweep,
  stopTwelveDataBackgroundSweep,
  getTwelveDataBackgroundSweepStatus,
} = require("../services/twelveDataRefreshScheduler");

const investmentsRouter = Router();

investmentsRouter.use(requireAuth);

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

investmentsRouter.post("/refresh-daily", async (req, res, next) => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL?.trim();
    if (adminEmail) {
      const user = await assertAdmin(req, res);
      if (!user) return;
    }

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

    if (cancelBackgroundSweep) {
      stopTwelveDataBackgroundSweep();
      await prisma.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "UPDATE",
          entity: "QuoteCache",
          entityId: null,
          meta: { provider: "TWELVEDATA", backgroundSweepCancelled: true },
        },
      });
      return res.json({
        provider: "TWELVEDATA",
        cancelled: true,
        sweep: getTwelveDataBackgroundSweepStatus(),
      });
    }

    if (backgroundSweep) {
      const started = await startTwelveDataBackgroundSweep({
        userId: req.auth.userId,
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
          userId: req.auth.userId,
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
        hint:
          "One setInterval runs on this server: first chunk immediately, then one chunk per interval until the cycle completes. Call once per day (e.g. cron). Use cancelBackgroundSweep to stop.",
      });
    }

    const result = await refreshDailyQuotesForTwelveData({ resetCycle });

    await prisma.auditLog.create({
      data: {
        userId: req.auth.userId,
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

const {
  postSingleInstrument,
  postBulkInstruments,
} = require("../services/instrumentAdminImport");

investmentsRouter.post("/instruments", postSingleInstrument);
investmentsRouter.post("/instruments/bulk", postBulkInstruments);

module.exports = { investmentsRouter };
