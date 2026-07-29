const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CurrencyChangeConflictError,
  lockAccountCurrencyForUpdate,
} = require("../src/lib/claimCurrencyChange");

test("lockAccountCurrencyForUpdate issues FOR UPDATE and accepts matching currency", async () => {
  let sqlText = "";
  const values = [];
  const tx = {
    $queryRaw: async (strings, ...params) => {
      sqlText = Array.isArray(strings) ? strings.join("?") : String(strings);
      values.push(...params);
      return [{ id: "account-1", currency: "EUR", deletedAt: null }];
    },
  };

  const locked = await lockAccountCurrencyForUpdate(tx, {
    accountId: "account-1",
    expectedCurrency: "EUR",
  });

  assert.match(sqlText, /FOR UPDATE/i);
  assert.match(sqlText, /FROM `Account`/);
  assert.deepEqual(values, ["account-1"]);
  assert.deepEqual(locked, { id: "account-1", currency: "EUR" });
});

test("lockAccountCurrencyForUpdate rejects when currency already changed", async () => {
  const tx = {
    $queryRaw: async () => [{ id: "account-1", currency: "USD", deletedAt: null }],
  };

  await assert.rejects(
    () =>
      lockAccountCurrencyForUpdate(tx, {
        accountId: "account-1",
        expectedCurrency: "EUR",
      }),
    (err) =>
      err instanceof CurrencyChangeConflictError &&
      err.statusCode === 409 &&
      err.code === "currency_change_conflict"
  );
});

test("lockAccountCurrencyForUpdate rejects missing or soft-deleted accounts", async () => {
  const missing = {
    $queryRaw: async () => [],
  };
  await assert.rejects(
    () =>
      lockAccountCurrencyForUpdate(missing, {
        accountId: "missing",
        expectedCurrency: "EUR",
      }),
    (err) => err instanceof Error && err.statusCode === 404
  );

  const deleted = {
    $queryRaw: async () => [
      { id: "account-1", currency: "EUR", deletedAt: new Date("2026-07-29T00:00:00.000Z") },
    ],
  };
  await assert.rejects(
    () =>
      lockAccountCurrencyForUpdate(deleted, {
        accountId: "account-1",
        expectedCurrency: "EUR",
      }),
    (err) => err instanceof Error && err.statusCode === 404
  );
});

/**
 * Models the critical race: two converters both observed oldCurrency outside
 * the write transaction. Only the first lock holder may proceed; the second
 * must fail closed after seeing the post-commit currency.
 */
test("second concurrent converter fails closed after first claims currency", async () => {
  let accountCurrency = "EUR";
  let conversions = 0;

  async function runConverter(fxRate) {
    const oldCurrency = "EUR";
    const newCurrency = "USD";

    // Simulated interactive transaction boundary.
    const tx = {
      $queryRaw: async () => [
        { id: "account-1", currency: accountCurrency, deletedAt: null },
      ],
    };

    await lockAccountCurrencyForUpdate(tx, {
      accountId: "account-1",
      expectedCurrency: oldCurrency,
    });

    // Winner converts then stamps account currency (as the route does).
    conversions += 1;
    accountCurrency = newCurrency;
    return { fxRate, conversions };
  }

  await runConverter(1.1);
  await assert.rejects(() => runConverter(1.1), CurrencyChangeConflictError);
  assert.equal(conversions, 1);
  assert.equal(accountCurrency, "USD");
});
