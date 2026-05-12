/**
 * Default categories for every new account (signup personal account or POST /accounts).
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} accountId
 * @param {{ investingEnabled?: boolean }} [options]
 */
const { ensureInvestmentCategories } = require("./investingCategories");

/** Core INCOME/EXPENSE rows (no investments). Used for seeding and for restoring soft-deleted defaults. */
const CORE_SEED_ROWS = [
  { type: "EXPENSE", name: "Bills", icon: "📃" },
  { type: "EXPENSE", name: "Food", icon: "🍽️" },
  { type: "EXPENSE", name: "Medicine", icon: "💊" },
  { type: "EXPENSE", name: "Clothes", icon: "🛍️" },
  { type: "EXPENSE", name: "Transport", icon: "🚌" },
  { type: "EXPENSE", name: "Entertainment", icon: "🎉" },
  { type: "EXPENSE", name: "Home", icon: "🏠" },
  { type: "EXPENSE", name: "Utilities", icon: "💡" },
  { type: "EXPENSE", name: "Shopping", icon: "🛒" },
  { type: "EXPENSE", name: "Subscriptions", icon: "📱" },
  { type: "INCOME", name: "Salary", icon: "💼" },
  { type: "INCOME", name: "Gift", icon: "💵" },
  { type: "INCOME", name: "Freelance", icon: "💻" },
  { type: "INCOME", name: "Other income", icon: "➕" },
];

const CORE_DEFAULT_NAMES = CORE_SEED_ROWS.map((r) => r.name);

async function seedDefaultCategories(tx, accountId, options = {}) {
  const investingEnabled = options.investingEnabled !== false;

  let expenseOrder = 0;
  let incomeOrder = 0;
  await tx.category.createMany({
    data: CORE_SEED_ROWS.map((row) => ({
      accountId,
      type: row.type,
      name: row.name,
      icon: row.icon,
      sortOrder: row.type === "EXPENSE" ? expenseOrder++ : incomeOrder++,
    })),
    skipDuplicates: true,
  });

  if (investingEnabled) {
    await ensureInvestmentCategories(tx, accountId);
  }
}

module.exports = { seedDefaultCategories, CORE_DEFAULT_NAMES };
