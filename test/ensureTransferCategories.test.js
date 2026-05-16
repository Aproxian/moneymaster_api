const assert = require("node:assert/strict");
const test = require("node:test");

const { ensureTransferCategories } = require("../src/services/ensureTransferCategories");
const { TRANSFER_RECEIVE, TRANSFER_SEND } = require("../src/lib/transferCategoryKeys");

function createFakeTx(initialRows) {
  const rows = initialRows.map((row) => ({ ...row }));
  const created = [];
  const updated = [];

  function matchesDeletedAt(row, deletedAt) {
    if (deletedAt === null) return row.deletedAt == null;
    if (deletedAt?.not === null) return row.deletedAt != null;
    return true;
  }

  return {
    rows,
    created,
    updated,
    category: {
      async findFirst({ where, select }) {
        const row = rows.find(
          (candidate) =>
            candidate.accountId === where.accountId &&
            candidate.internalKey === where.internalKey &&
            matchesDeletedAt(candidate, where.deletedAt)
        );
        if (!row) return null;
        if (select?.id) return { id: row.id };
        return { ...row };
      },

      async create({ data }) {
        const row = {
          id: `new-${rows.length + 1}`,
          deletedAt: null,
          ...data,
        };
        rows.push(row);
        created.push(row);
        return { id: row.id };
      },

      async update({ where, data }) {
        const row = rows.find((candidate) => candidate.id === where.id);
        assert.ok(row, `missing fake category ${where.id}`);
        Object.assign(row, data);
        updated.push({ id: row.id, data });
        return { id: row.id };
      },

      async updateMany({ where, data }) {
        const keys = where.internalKey?.in ?? [];
        let count = 0;
        for (const row of rows) {
          if (
            row.accountId === where.accountId &&
            row.deletedAt == null &&
            keys.includes(row.internalKey)
          ) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },
  };
}

test("ensureTransferCategories restores soft-deleted transfer rows instead of recreating them", async () => {
  const tx = createFakeTx([
    {
      id: "send-1",
      accountId: "acct-1",
      type: "EXPENSE",
      name: "Transfer (send)",
      internalKey: TRANSFER_SEND,
      lockedForManualEntry: false,
      deletedAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      id: "receive-1",
      accountId: "acct-1",
      type: "INCOME",
      name: "Transfer (receive)",
      internalKey: TRANSFER_RECEIVE,
      lockedForManualEntry: false,
      deletedAt: new Date("2026-01-01T00:00:00Z"),
    },
  ]);

  const result = await ensureTransferCategories(tx, "acct-1");

  assert.deepEqual(result, {
    sendCategoryId: "send-1",
    receiveCategoryId: "receive-1",
  });
  assert.equal(tx.created.length, 0);
  assert.equal(tx.updated.length, 2);
  assert.equal(tx.rows[0].deletedAt, null);
  assert.equal(tx.rows[0].lockedForManualEntry, true);
  assert.equal(tx.rows[1].deletedAt, null);
  assert.equal(tx.rows[1].lockedForManualEntry, true);
});

test("ensureTransferCategories still creates missing transfer rows", async () => {
  const tx = createFakeTx([]);

  const result = await ensureTransferCategories(tx, "acct-1");

  assert.match(result.sendCategoryId, /^new-/);
  assert.match(result.receiveCategoryId, /^new-/);
  assert.equal(tx.created.length, 2);
  assert.equal(tx.created[0].internalKey, TRANSFER_SEND);
  assert.equal(tx.created[1].internalKey, TRANSFER_RECEIVE);
});
