const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const { CASH_OUT_INVESTMENT } = require("../lib/investmentCategoryKeys");
const { requireAuth } = require("../middleware/auth");
const { requireAccountMember } = require("../middleware/requireAccountMember");
const { seedDefaultCategories } = require("../services/seedDefaultCategories");

// Mounted at /accounts/:accountId/categories
const categoriesRouter = Router({ mergeParams: true });

const createCategorySchema = z.object({
  type: z.enum(["INCOME", "EXPENSE", "INVESTMENT"]),
  name: z.string().min(1).max(120),
  icon: z.string().min(1).max(10),
  color: z.string().max(20).optional(),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  icon: z.string().min(1).max(10).optional(),
  color: z.string().max(20).optional().nullable(),
});

categoriesRouter.use(requireAuth);
categoriesRouter.use(requireAccountMember("accountId"));

async function listVisibleCategories(accountId) {
  // MySQL: `NOT (internalKey = 'X')` excludes rows where internalKey IS NULL, so default
  // categories (internalKey null) vanished from the list. Exclude only the cash-out row.
  return prisma.category.findMany({
    where: {
      accountId,
      deletedAt: null,
      NOT: {
        AND: [{ internalKey: { not: null } }, { internalKey: CASH_OUT_INVESTMENT }],
      },
    },
    select: {
      id: true,
      type: true,
      name: true,
      icon: true,
      color: true,
      internalKey: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { name: "asc" },
  });
}

categoriesRouter.get("/", async (req, res, next) => {
  try {
    const { accountId } = req.params;

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true, investingEnabled: true },
    });
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    const investingEnabled = account.investingEnabled !== false;

    let categories = await listVisibleCategories(accountId);

    // No visible categories: recover from soft-deletes (e.g. investing toggle + unique constraint
    // blocking createMany) then ensure seed rows exist.
    if (categories.length === 0) {
      await prisma.$transaction(async (tx) => {
        await tx.category.updateMany({
          where: {
            accountId,
            deletedAt: { not: null },
            type: { in: ["INCOME", "EXPENSE"] },
            internalKey: null,
          },
          data: { deletedAt: null },
        });

        if (investingEnabled) {
          await tx.category.updateMany({
            where: {
              accountId,
              deletedAt: { not: null },
              OR: [
                { internalKey: { startsWith: "INV_" } },
                { internalKey: CASH_OUT_INVESTMENT },
                { type: "INVESTMENT", internalKey: null },
              ],
            },
            data: { deletedAt: null },
          });
        }

        await seedDefaultCategories(tx, accountId, { investingEnabled });
      });
      categories = await listVisibleCategories(accountId);
    }

    return res.json({
      categories,
      investingEnabled,
    });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.get("/:categoryId/watchlist", async (req, res, next) => {
  try {
    const { accountId, categoryId } = req.params;

    const cat = await prisma.category.findFirst({
      where: {
        id: categoryId,
        accountId,
        deletedAt: null,
        type: "INVESTMENT",
      },
      select: { id: true },
    });

    if (!cat) {
      return res.status(404).json({ error: "Investment category not found" });
    }

    const items = await prisma.categoryWishlistItem.findMany({
      where: { categoryId },
      select: {
        instrument: {
          select: {
            id: true,
            provider: true,
            providerSymbol: true,
            name: true,
            type: true,
            currency: true,
            exchange: true,
            country: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return res.json({
      instruments: items.map((row) => row.instrument),
    });
  } catch (err) {
    next(err);
  }
});

const watchlistAddSchema = z.object({
  instrumentId: z.string().min(1),
});

categoriesRouter.post("/:categoryId/watchlist", async (req, res, next) => {
  try {
    const { accountId, categoryId } = req.params;
    const body = watchlistAddSchema.parse(req.body);

    const cat = await prisma.category.findFirst({
      where: {
        id: categoryId,
        accountId,
        deletedAt: null,
        type: "INVESTMENT",
      },
      select: { id: true },
    });

    if (!cat) {
      return res.status(404).json({ error: "Investment category not found" });
    }

    const instrument = await prisma.instrument.findFirst({
      where: { id: body.instrumentId, isActive: true },
      select: { id: true },
    });

    if (!instrument) {
      return res.status(400).json({ error: "Instrument not found or inactive" });
    }

    await prisma.categoryWishlistItem.create({
      data: {
        categoryId,
        instrumentId: body.instrumentId,
      },
    });

    const row = await prisma.instrument.findUnique({
      where: { id: body.instrumentId },
      select: {
        id: true,
        provider: true,
        providerSymbol: true,
        name: true,
        type: true,
        currency: true,
        exchange: true,
        country: true,
      },
    });

    return res.status(201).json({ instrument: row });
  } catch (err) {
    if (err && err.code === "P2002") {
      return res.status(409).json({ error: "Instrument is already in this wishlist" });
    }
    next(err);
  }
});

categoriesRouter.delete("/:categoryId/watchlist/:instrumentId", async (req, res, next) => {
  try {
    const { accountId, categoryId, instrumentId } = req.params;

    const cat = await prisma.category.findFirst({
      where: {
        id: categoryId,
        accountId,
        deletedAt: null,
        type: "INVESTMENT",
      },
      select: { id: true },
    });

    if (!cat) {
      return res.status(404).json({ error: "Investment category not found" });
    }

    const result = await prisma.categoryWishlistItem.deleteMany({
      where: { categoryId, instrumentId },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: "Wishlist entry not found" });
    }

    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

categoriesRouter.post("/", async (req, res, next) => {
  try {
    const { accountId } = req.params;

    const body = createCategorySchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true },
    });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    const existing = await prisma.category.findFirst({
      where: {
        accountId,
        type: body.type,
        name: body.name,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (existing) {
      return res
        .status(409)
        .json({ error: "Category with this name already exists for account" });
    }

    const category = await prisma.category.create({
      data: {
        accountId,
        type: body.type,
        name: body.name,
        icon: body.icon,
        color: body.color ?? null,
      },
      select: {
        id: true,
        type: true,
        name: true,
        icon: true,
        color: true,
        createdAt: true,
      },
    });

    return res.status(201).json({ category });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.patch("/:categoryId", async (req, res, next) => {
  try {
    const { accountId, categoryId } = req.params;

    const body = updateCategorySchema.parse(req.body);

    const existing = await prisma.category.findFirst({
      where: {
        id: categoryId,
        accountId,
        deletedAt: null,
      },
      select: {
        id: true,
        type: true,
        name: true,
      },
    });

    if (!existing) {
      return res.status(404).json({ error: "Category not found" });
    }

    if (body.name && body.name !== existing.name) {
      const nameTaken = await prisma.category.findFirst({
        where: {
          accountId,
          type: existing.type,
          name: body.name,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (nameTaken) {
        return res
          .status(409)
          .json({ error: "Category with this name already exists for account" });
      }
    }

    const updated = await prisma.category.update({
      where: { id: categoryId },
      data: {
        name: body.name ?? undefined,
        icon: body.icon ?? undefined,
        color:
          body.color === undefined
            ? undefined
            : body.color === null
            ? null
            : body.color,
      },
      select: {
        id: true,
        type: true,
        name: true,
        icon: true,
        color: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({ category: updated });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.delete("/:categoryId", async (req, res, next) => {
  try {
    const { accountId, categoryId } = req.params;

    const existing = await prisma.category.findFirst({
      where: {
        id: categoryId,
        accountId,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "Category not found" });
    }

    await prisma.category.update({
      where: { id: categoryId },
      data: { deletedAt: new Date() },
    });

    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = { categoriesRouter };

