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
const {
  refreshDailyQuotesForYahooFinanceChunked,
  getYahooFinanceSymbolsPerTick,
} = require("../services/yahooFinanceData");
const {
  startYahooFinanceBackgroundSweep,
  stopYahooFinanceBackgroundSweep,
  getYahooFinanceBackgroundSweepStatus,
  getYahooFinanceSweepLiveStatus,
  isLocalYahooSweepRunnerActive,
  requestRemoteYahooSweepCancel,
} = require("../services/yahooFinanceRefreshScheduler");

const investmentsRouter = Router();

const TWELVEDATA_STATE_ID = "TWELVEDATA";
const YAHOO_STATE_ID = "YAHOOFINANCE";

/**
 * Which provider is currently active for the automated daily sweep.
 * Change QUOTE_ACTIVE_PROVIDER in your .env and restart to switch.
 * Does not affect the dedicated /refresh-daily or /refresh-daily-yahoo endpoints
 * (those always use their respective provider regardless of this value).
 */
const ACTIVE_QUOTE_PROVIDER =
  (process.env.QUOTE_ACTIVE_PROVIDER ?? "TWELVEDATA").trim().toUpperCase();

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

async function requireAdminUnlessCron(req, res) {
  if (req.refreshDailyCron) return true;
  const user = await assertAdmin(req, res);
  return Boolean(user);
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
    if (!(await requireAdminUnlessCron(req, res))) return;
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

    if (!(await requireAdminUnlessCron(req, res))) return;

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

/** Poll while a Yahoo Finance background sweep runs (same auth as POST /refresh-daily-yahoo). */
investmentsRouter.get("/yahoo-finance-sweep-status", refreshDailyAuth, async (req, res, next) => {
  try {
    if (!(await requireAdminUnlessCron(req, res))) return;
    const live = await getYahooFinanceSweepLiveStatus();
    return res.json({
      provider: "YAHOOFINANCE",
      activeProvider: ACTIVE_QUOTE_PROVIDER,
      ...live,
      cronAuthHeaderName: CRON_SECRET_HEADER,
    });
  } catch (err) {
    next(err);
  }
});

investmentsRouter.post("/refresh-daily-yahoo", refreshDailyAuth, async (req, res, next) => {
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

    if (!(await requireAdminUnlessCron(req, res))) return;

    const auditUserId = req.auth?.userId ?? null;
    const auditCron = Boolean(req.refreshDailyCron);

    if (cancelBackgroundSweep) {
      if (isLocalYahooSweepRunnerActive()) {
        await stopYahooFinanceBackgroundSweep();
      } else {
        await requestRemoteYahooSweepCancel();
      }
      await prisma.auditLog.create({
        data: {
          userId: auditUserId,
          action: "UPDATE",
          entity: "QuoteCache",
          entityId: null,
          meta: {
            provider: "YAHOOFINANCE",
            backgroundSweepCancelled: true,
            ...(auditCron ? { investmentsCron: true } : {}),
          },
        },
      });
      return res.json({
        provider: "YAHOOFINANCE",
        cancelled: true,
        sweep: getYahooFinanceBackgroundSweepStatus(),
      });
    }

    if (backgroundSweep) {
      const today = calendarDateInSweepTimezone();
      const stateRow = await prisma.twelveDataQuoteRefreshState.findUnique({
        where: { id: YAHOO_STATE_ID },
        select: { lastBackgroundSweepCompletedDate: true },
      });
      if (stateRow?.lastBackgroundSweepCompletedDate === today) {
        return res.status(409).json({
          provider: "YAHOOFINANCE",
          error: "already_swept_today",
          sweepDayTimezone: SWEEP_DAY_TIMEZONE,
          lastBackgroundSweepCompletedDate: stateRow.lastBackgroundSweepCompletedDate,
        });
      }

      const started = await startYahooFinanceBackgroundSweep({
        userId: auditUserId,
        resetCycle,
      });
      if (!started.ok) {
        return res.status(409).json({
          provider: "YAHOOFINANCE",
          error: started.error || "sweep_not_started",
          sweep: getYahooFinanceBackgroundSweepStatus(),
        });
      }

      await prisma.auditLog.create({
        data: {
          userId: auditUserId,
          action: "UPDATE",
          entity: "QuoteCache",
          entityId: null,
          meta: {
            provider: "YAHOOFINANCE",
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
        provider: "YAHOOFINANCE",
        accepted: true,
        sweep: "background_started",
        intervalMs: started.intervalMs,
        symbolsPerTick: started.symbolsPerTick,
        instrumentsCount: started.instrumentsCount,
        ticksPerFullCycle: started.ticksPerFullCycle,
        estimatedDurationMs: started.estimatedDurationMs,
        sweepDayTimezone: SWEEP_DAY_TIMEZONE,
        cronAuthHeaderName: CRON_SECRET_HEADER,
        hint:
          "One setInterval runs on this server: first chunk immediately, then one chunk per interval until the cycle completes. At most one successful full sweep per calendar day in sweepDayTimezone. Use cancelBackgroundSweep to stop.",
      });
    }

    // Synchronous single-tick path (manual or cron without backgroundSweep flag)
    const result = await refreshDailyQuotesForYahooFinanceChunked({ resetCycle });

    await prisma.auditLog.create({
      data: {
        userId: auditUserId,
        action: "UPDATE",
        entity: "QuoteCache",
        entityId: null,
        meta: {
          provider: "YAHOOFINANCE",
          mode: result.mode,
          instrumentsCount: result.instrumentsCount,
          quotesCreated: result.quotesCreated,
          ...(result.cycleJustCompleted
            ? { cycleJustCompleted: true }
            : {
                chunkSize: result.chunkSize,
                offsetStart: result.offsetStart,
                nextOffset: result.nextOffset,
              }),
          ...(auditCron ? { investmentsCron: true } : {}),
        },
      },
    });

    return res.json({
      provider: "YAHOOFINANCE",
      activeProvider: ACTIVE_QUOTE_PROVIDER,
      ...result,
      sweep: getYahooFinanceBackgroundSweepStatus(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Trim `QuoteCache` to the newest N rows per instrument (by createdAt, then asOf, then id).
 * Auth: same as POST /investments/refresh-daily (cron header + secret or admin JWT).
 *
 * Query or JSON body: `keepMostRecentCount` (optional). When omitted, keeps one row
 * per instrument.
 */
investmentsRouter.post("/quote-cache/trim", refreshDailyAuth, async (req, res, next) => {
  try {
    if (!(await requireAdminUnlessCron(req, res))) return;

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const raw =
      req.query?.keepMostRecentCount ??
      req.query?.keep_most_recent_count ??
      body.keepMostRecentCount ??
      body.keep_most_recent_count;

    let keepMostRecentCount;
    if (raw === undefined || raw === null || raw === "") {
      keepMostRecentCount = 1;
    } else {
      const n = parseInt(String(raw), 10);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({
          error: "keepMostRecentCount must be a non-negative integer",
        });
      }
      keepMostRecentCount = n;
    }

    const rowsBefore = await prisma.quoteCache.count();

    if (keepMostRecentCount === 0) {
      const del = await prisma.quoteCache.deleteMany({});
      return res.json({
        ok: true,
        keepMostRecentCount: 0,
        rowsBefore,
        rowsDeleted: del.count,
        rowsAfter: 0,
      });
    }

    if (rowsBefore <= keepMostRecentCount) {
      return res.json({
        ok: true,
        keepMostRecentCount,
        rowsBefore,
        rowsDeleted: 0,
        rowsAfter: rowsBefore,
      });
    }

    await prisma.$executeRaw`
      DELETE q FROM QuoteCache q
      LEFT JOIN (
        SELECT id FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY instrumentId
              ORDER BY createdAt DESC, asOf DESC, id DESC
            ) AS rn
          FROM QuoteCache
        ) inner_keep
        WHERE rn <= ${keepMostRecentCount}
      ) k ON q.id = k.id
      WHERE k.id IS NULL
    `;

    const rowsAfter = await prisma.quoteCache.count();
    const rowsDeleted = rowsBefore - rowsAfter;

    return res.json({
      ok: true,
      keepMostRecentCount,
      rowsBefore,
      rowsDeleted,
      rowsAfter,
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
