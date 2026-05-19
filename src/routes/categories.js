const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const { CASH_OUT_INVESTMENT } = require("../lib/investmentCategoryKeys");
const { requireAuth } = require("../middleware/auth");
const { requireAccountMember } = require("../middleware/requireAccountMember");
const { seedDefaultCategories } = require("../services/seedDefaultCategories");
const {
  accountIsPersonalForUser,
  canConfigureCategoryMemberAccess,
  computeManualEntryAllowedForMe,
  getCategoryMemberAccessState,
  getPrimaryOwnerUserId,
  setCategoryMemberAccess,
} = require("../services/categoryMemberAccess");

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
  lockedForManualEntry: z.boolean().optional(),
});

const reorderCategoriesSchema = z.object({
  type: z.enum(["INCOME", "EXPENSE", "INVESTMENT"]),
  orderedCategoryIds: z.array(z.string().min(1)),
});

const putMemberAccessSchema = z.object({
  memberAccessRestricted: z.boolean(),
  newMembersLockedByDefault: z.boolean(),
  allowedUserIds: z.array(z.string().min(1)),
});

categoriesRouter.use(requireAuth);
categoriesRouter.use(requireAccountMember("accountId"));

/** System-only rows hidden from the Categories screen (cash-out is ledger-only, not user-editable). */
function visibleCategoriesWhere(accountId) {
  return {
    accountId,
    deletedAt: null,
    NOT: {
      AND: [{ internalKey: { not: null } }, { internalKey: CASH_OUT_INVESTMENT }],
    },
  };
}

async function listVisibleCategories(accountId) {
  return prisma.category.findMany({
    where: visibleCategoriesWhere(accountId),
    select: {
      id: true,
      type: true,
      name: true,
      icon: true,
      color: true,
      internalKey: true,
      lockedForManualEntry: true,
      createdByUserId: true,
      memberAccessRestricted: true,
      newMembersLockedByDefault: true,
      sortOrder: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

async function withCategoryMemberUi(accountId, userId, categories) {
  const isPersonal = await accountIsPersonalForUser(prisma, userId, accountId);
  const primaryOwnerUserId = await getPrimaryOwnerUserId(prisma, accountId);
  const restrictedIds = categories
    .filter((c) => c.memberAccessRestricted)
    .map((c) => c.id);
  let grantSet = new Set();
  if (!isPersonal && restrictedIds.length) {
    const grants = await prisma.categoryMemberAccess.findMany({
      where: { userId, categoryId: { in: restrictedIds } },
      select: { categoryId: true },
    });
    grantSet = new Set(grants.map((g) => g.categoryId));
  }
  return categories.map((c) => ({
    ...c,
    manualEntryAllowedForMe: computeManualEntryAllowedForMe({
      category: c,
      isPersonal,
      userId,
      primaryOwnerUserId,
      hasExplicitGrant: grantSet.has(c.id),
    }),
    canConfigureMemberLocks: canConfigureCategoryMemberAccess({
      isPersonal,
      category: c,
      primaryOwnerUserId,
      userId,
    }),
  }));
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

    const userId = req.auth.userId;
    const withUi = await withCategoryMemberUi(accountId, userId, categories);

    return res.json({
      categories: withUi,
      investingEnabled,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /accounts/:accountId/categories/reorder
 * Sets `sortOrder` to each category's index in `orderedCategoryIds` (must list every visible
 * category of that `type` exactly once, same set as GET /categories for that type).
 */
categoriesRouter.put("/reorder", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.auth.userId;
    const body = reorderCategoriesSchema.parse(req.body);

    const expectedRows = await prisma.category.findMany({
      where: {
        ...visibleCategoriesWhere(accountId),
        type: body.type,
      },
      select: { id: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    const expectedIds = new Set(expectedRows.map((r) => r.id));
    if (body.orderedCategoryIds.length !== expectedIds.size) {
      return res.status(400).json({
        error:
          "orderedCategoryIds must list every category of this type exactly once (same count as on the Categories screen)",
      });
    }
    for (const id of body.orderedCategoryIds) {
      if (!expectedIds.has(id)) {
        return res.status(400).json({ error: "Unknown category id or wrong type for this reorder" });
      }
    }

    await prisma.$transaction(
      body.orderedCategoryIds.map((id, index) =>
        prisma.category.update({
          where: { id },
          data: { sortOrder: index },
        })
      )
    );

    await prisma.auditLog.create({
      data: {
        userId,
        action: "UPDATE",
        entity: "CategoryOrder",
        entityId: accountId,
        meta: { accountId, type: body.type, count: body.orderedCategoryIds.length },
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid body", details: err.flatten() });
    }
    next(err);
  }
});

categoriesRouter.get("/:categoryId/member-access", async (req, res, next) => {
  try {
    const { accountId, categoryId } = req.params;
    const userId = req.auth.userId;

    if (await accountIsPersonalForUser(prisma, userId, accountId)) {
      return res.status(403).json({ error: "Member access is only available on shared accounts" });
    }

    const primaryOwnerUserId = await getPrimaryOwnerUserId(prisma, accountId);
    const category = await prisma.category.findFirst({
      where: { id: categoryId, accountId, deletedAt: null },
      select: {
        id: true,
        internalKey: true,
        lockedForManualEntry: true,
        createdByUserId: true,
        memberAccessRestricted: true,
        newMembersLockedByDefault: true,
      },
    });
    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    const isPersonal = false;
    if (
      !canConfigureCategoryMemberAccess({
        isPersonal,
        category,
        primaryOwnerUserId,
        userId,
      })
    ) {
      return res.status(403).json({ error: "You cannot change lock settings for this category" });
    }

    const state = await getCategoryMemberAccessState(prisma, { accountId, categoryId });
    if (!state) {
      return res.status(404).json({ error: "Category not found" });
    }

    return res.json({
      memberAccessRestricted: state.memberAccessRestricted,
      newMembersLockedByDefault: state.newMembersLockedByDefault,
      allowedUserIds: state.allowedUserIds,
      primaryOwnerUserId: state.primaryOwnerUserId,
    });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.put("/:categoryId/member-access", async (req, res, next) => {
  try {
    const { accountId, categoryId } = req.params;
    const userId = req.auth.userId;
    const body = putMemberAccessSchema.parse(req.body);

    if (await accountIsPersonalForUser(prisma, userId, accountId)) {
      return res.status(403).json({ error: "Member access is only available on shared accounts" });
    }

    const primaryOwnerUserId = await getPrimaryOwnerUserId(prisma, accountId);
    const category = await prisma.category.findFirst({
      where: { id: categoryId, accountId, deletedAt: null },
      select: {
        id: true,
        internalKey: true,
        lockedForManualEntry: true,
        createdByUserId: true,
        memberAccessRestricted: true,
        newMembersLockedByDefault: true,
      },
    });
    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    const isPersonal = false;
    if (
      !canConfigureCategoryMemberAccess({
        isPersonal,
        category,
        primaryOwnerUserId,
        userId,
      })
    ) {
      return res.status(403).json({ error: "You cannot change lock settings for this category" });
    }

    await setCategoryMemberAccess(prisma, {
      accountId,
      categoryId,
      allowedUserIds: body.allowedUserIds,
      memberAccessRestricted: body.memberAccessRestricted,
      newMembersLockedByDefault: body.newMembersLockedByDefault,
    });

    const state = await getCategoryMemberAccessState(prisma, { accountId, categoryId });
    return res.json({
      memberAccessRestricted: state.memberAccessRestricted,
      newMembersLockedByDefault: state.newMembersLockedByDefault,
      allowedUserIds: state.allowedUserIds,
      primaryOwnerUserId: state.primaryOwnerUserId,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid body", details: err.flatten() });
    }
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
    const userId = req.auth.userId;

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

    const maxRow = await prisma.category.aggregate({
      where: { accountId, type: body.type, deletedAt: null },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxRow._max.sortOrder ?? -1) + 1;

    const category = await prisma.category.create({
      data: {
        accountId,
        type: body.type,
        name: body.name,
        icon: body.icon,
        color: body.color ?? null,
        sortOrder,
        createdByUserId: userId,
      },
      select: {
        id: true,
        type: true,
        name: true,
        icon: true,
        color: true,
        sortOrder: true,
        internalKey: true,
        lockedForManualEntry: true,
        createdByUserId: true,
        memberAccessRestricted: true,
        newMembersLockedByDefault: true,
        createdAt: true,
      },
    });

    const [withUi] = await withCategoryMemberUi(accountId, userId, [category]);

    return res.status(201).json({ category: withUi });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.patch("/:categoryId", async (req, res, next) => {
  try {
    const { accountId, categoryId } = req.params;
    const userId = req.auth.userId;

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
        internalKey: true,
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

    if (body.lockedForManualEntry !== undefined && existing.internalKey != null) {
      return res.status(400).json({
        error: "System categories cannot change manual-entry lock",
      });
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
        lockedForManualEntry:
          body.lockedForManualEntry === undefined ? undefined : body.lockedForManualEntry,
      },
      select: {
        id: true,
        type: true,
        name: true,
        icon: true,
        color: true,
        internalKey: true,
        lockedForManualEntry: true,
        createdByUserId: true,
        memberAccessRestricted: true,
        newMembersLockedByDefault: true,
        sortOrder: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const [withUi] = await withCategoryMemberUi(accountId, userId, [updated]);

    return res.json({ category: withUi });
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

    const activeTxCount = await prisma.transaction.count({
      where: {
        accountId,
        categoryId,
        revokedAt: null,
      },
    });
    if (activeTxCount > 0) {
      return res.status(409).json({
        error: "category_has_non_revoked_transactions",
        message:
          "Revoke every transaction that still uses this category before deleting it. Revoked rows remain in history but no longer block removal.",
        nonRevokedTransactionCount: activeTxCount,
      });
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

