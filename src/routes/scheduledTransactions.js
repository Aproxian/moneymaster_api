const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { requireAccountMember } = require("../middleware/requireAccountMember");

const scheduledTransactionsRouter = Router({ mergeParams: true });

const schedulePayloadSchema = z.object({
  tab: z.enum(["income", "expense", "invest"]),
  amountMinor: z.number().int().positive(),
  categoryId: z.string().min(1),
  walletId: z.string().min(1).optional().nullable(),
  note: z.string().max(500).optional().nullable(),
  instrumentId: z.string().optional().nullable(),
  quantity: z.number().positive().optional().nullable(),
});

const createDelaySchema = z.object({
  kind: z.literal("DELAY_ONCE"),
  executeAt: z.coerce.date(),
  payload: schedulePayloadSchema,
});

const createRecurSchema = z.object({
  kind: z.literal("RECURRING"),
  recurrenceUnit: z.enum(["HOUR", "DAY", "WEEK", "MONTH", "YEAR"]),
  intervalCount: z.number().int().min(1).max(3650),
  hourOfDay: z.number().int().min(0).max(23).optional().nullable(),
  startAt: z.coerce.date(),
  payload: schedulePayloadSchema,
});

const createScheduleSchema = z.discriminatedUnion("kind", [createDelaySchema, createRecurSchema]);

scheduledTransactionsRouter.use(requireAuth);
scheduledTransactionsRouter.use(requireAccountMember("accountId"));

scheduledTransactionsRouter.get("/", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const rows = await prisma.pendingTransactionSchedule.findMany({
      where: { accountId, cancelledAt: null, status: "PENDING" },
      orderBy: { nextRunAt: "asc" },
      select: {
        id: true,
        kind: true,
        status: true,
        executeAt: true,
        recurrenceUnit: true,
        intervalCount: true,
        hourOfDay: true,
        nextRunAt: true,
        lastRunAt: true,
        payload: true,
        createdAt: true,
      },
    });
    return res.json({
      schedules: rows.map((r) => ({
        ...r,
        executeAt: r.executeAt ? r.executeAt.toISOString() : null,
        nextRunAt: r.nextRunAt.toISOString(),
        lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

scheduledTransactionsRouter.post("/", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.auth.userId;
    const body = createScheduleSchema.parse(req.body);

    const payload = schedulePayloadSchema.parse(body.payload);
    if (payload.tab === "invest") {
      if (!payload.instrumentId || payload.quantity == null) {
        return res.status(400).json({ error: "invest schedules require instrumentId and quantity" });
      }
    } else if (payload.instrumentId || payload.quantity != null) {
      return res.status(400).json({ error: "instrumentId/quantity only for invest tab" });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: {
        id: true,
        investingEnabled: true,
        walletsEnabled: true,
        walletMigrationPending: true,
      },
    });
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (payload.tab === "invest" && !account.investingEnabled) {
      return res.status(400).json({ error: "Investing is disabled for this account" });
    }
    const walletsLive = account.walletsEnabled || account.walletMigrationPending;
    if (walletsLive && !payload.walletId) {
      return res.status(400).json({ error: "walletId is required when this account uses wallets" });
    }
    if (!walletsLive && payload.walletId) {
      return res.status(400).json({ error: "walletId is not used when wallets are disabled" });
    }

    let nextRunAt;
    let executeAt = null;
    let recurrenceUnit = null;
    let intervalCount = 1;
    let hourOfDay = null;

    if (body.kind === "DELAY_ONCE") {
      executeAt = body.executeAt;
      nextRunAt = body.executeAt;
    } else {
      recurrenceUnit = body.recurrenceUnit;
      intervalCount = body.intervalCount;
      hourOfDay = body.hourOfDay ?? null;
      nextRunAt = body.startAt;
    }

    const row = await prisma.pendingTransactionSchedule.create({
      data: {
        accountId,
        createdByUserId: userId,
        kind: body.kind,
        status: "PENDING",
        executeAt,
        recurrenceUnit,
        intervalCount,
        hourOfDay,
        nextRunAt,
        payload,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId,
        action: "CREATE",
        entity: "PendingTransactionSchedule",
        entityId: row.id,
        meta: { accountId, kind: body.kind },
      },
    });

    return res.status(201).json({
      schedule: {
        id: row.id,
        kind: row.kind,
        nextRunAt: row.nextRunAt.toISOString(),
        executeAt: row.executeAt ? row.executeAt.toISOString() : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

scheduledTransactionsRouter.post("/:scheduleId/cancel", async (req, res, next) => {
  try {
    const { accountId, scheduleId } = req.params;
    const userId = req.auth.userId;

    const row = await prisma.pendingTransactionSchedule.findFirst({
      where: { id: scheduleId, accountId, status: "PENDING", cancelledAt: null },
      select: { id: true },
    });
    if (!row) return res.status(404).json({ error: "Schedule not found" });

    await prisma.pendingTransactionSchedule.update({
      where: { id: scheduleId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        userId,
        action: "DELETE",
        entity: "PendingTransactionSchedule",
        entityId: scheduleId,
        meta: { accountId, cancel: true },
      },
    });

    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = { scheduledTransactionsRouter };
