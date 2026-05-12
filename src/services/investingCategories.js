const {
  CASH_OUT_INVESTMENT,
  INVESTMENT_DEFAULT_ROWS,
} = require("../lib/investmentCategoryKeys");

/**
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} accountId
 * @param {{ createdByUserId?: string | null }} [options]
 */
async function ensureInvestmentCategories(tx, accountId, options = {}) {
  const createdByUserId = options.createdByUserId ?? null;
  const base = { accountId, ...(createdByUserId ? { createdByUserId } : {}) };

  let invOrder = 0;
  for (const r of INVESTMENT_DEFAULT_ROWS) {
    const sortOrder = invOrder++;
    await tx.category.upsert({
      where: {
        accountId_type_name: { accountId, type: "INVESTMENT", name: r.name },
      },
      create: {
        ...base,
        type: "INVESTMENT",
        name: r.name,
        icon: r.icon,
        internalKey: r.key,
        sortOrder,
      },
      update: {
        deletedAt: null,
        internalKey: r.key,
        sortOrder,
        ...(createdByUserId ? { createdByUserId } : {}),
      },
    });
  }

  await tx.category.upsert({
    where: {
      accountId_type_name: { accountId, type: "INCOME", name: "Cash Out Investment" },
    },
    create: {
      ...base,
      type: "INCOME",
      name: "Cash Out Investment",
      icon: "🔁",
      internalKey: CASH_OUT_INVESTMENT,
      sortOrder: 9000,
    },
    update: {
      deletedAt: null,
      internalKey: CASH_OUT_INVESTMENT,
      ...(createdByUserId ? { createdByUserId } : {}),
    },
  });
}

/**
 * Soft-delete default investment + cash-out categories for an account.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} accountId
 */
async function removeInvestmentCategories(tx, accountId) {
  const now = new Date();
  const defaultNames = INVESTMENT_DEFAULT_ROWS.map((r) => r.name);

  const targets = await tx.category.findMany({
    where: {
      accountId,
      deletedAt: null,
      OR: [
        { internalKey: { startsWith: "INV_" } },
        { internalKey: CASH_OUT_INVESTMENT },
        {
          type: "INVESTMENT",
          internalKey: null,
          name: { in: defaultNames },
        },
      ],
    },
    select: { id: true },
  });

  const ids = targets.map((t) => t.id);
  if (!ids.length) return;

  await tx.categoryWishlistItem.deleteMany({
    where: { categoryId: { in: ids } },
  });

  await tx.categoryMemberAccess.deleteMany({
    where: { categoryId: { in: ids } },
  });

  await tx.category.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: now },
  });
}

module.exports = { ensureInvestmentCategories, removeInvestmentCategories };
