const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AccountCurrencyChangedError,
  lockAccountCurrencyForUpdate,
  assertAccountCurrencyLocked,
  assertAccountsCurrencyLocked,
} = require("../src/lib/lockAccountCurrency");

test("lockAccountCurrencyForUpdate issues FOR UPDATE and returns currency", async () => {
  let sqlText = "";
  const values = [];
  const tx = {
    $queryRaw: async (strings, ...params) => {
      sqlText = Array.isArray(strings) ? strings.join("?") : String(strings);
      values.push(...params);
      return [{ id: "account-1", currency: "EUR", deletedAt: null }];
    },
  };

  const locked = await lockAccountCurrencyForUpdate(tx, "account-1");

  assert.match(sqlText, /FOR UPDATE/i);
  assert.match(sqlText, /FROM `Account`/);
  assert.deepEqual(values, ["account-1"]);
  assert.deepEqual(locked, { id: "account-1", currency: "EUR" });
});

test("lockAccountCurrencyForUpdate returns null for missing or soft-deleted accounts", async () => {
  const missing = { $queryRaw: async () => [] };
  assert.equal(await lockAccountCurrencyForUpdate(missing, "missing"), null);

  const deleted = {
    $queryRaw: async () => [
      { id: "account-1", currency: "EUR", deletedAt: new Date("2026-08-05T00:00:00.000Z") },
    ],
  };
  assert.equal(await lockAccountCurrencyForUpdate(deleted, "account-1"), null);
});

test("assertAccountCurrencyLocked accepts matching currency", async () => {
  const tx = {
    $queryRaw: async () => [{ id: "account-1", currency: "EUR", deletedAt: null }],
  };
  const locked = await assertAccountCurrencyLocked(tx, "account-1", "EUR");
  assert.deepEqual(locked, { id: "account-1", currency: "EUR" });
});

test("assertAccountCurrencyLocked fails closed when currency already changed", async () => {
  const tx = {
    $queryRaw: async () => [{ id: "account-1", currency: "USD", deletedAt: null }],
  };

  await assert.rejects(
    () => assertAccountCurrencyLocked(tx, "account-1", "EUR"),
    (err) =>
      err instanceof AccountCurrencyChangedError &&
      err.statusCode === 409 &&
      err.code === "account_currency_changed"
  );
});

test("assertAccountCurrencyLocked rejects missing accounts with 404", async () => {
  const tx = { $queryRaw: async () => [] };
  await assert.rejects(
    () => assertAccountCurrencyLocked(tx, "missing", "EUR"),
    (err) => err instanceof Error && err.statusCode === 404
  );
});

/**
 * Models the critical race: a ledger writer prepared amountMinor in EUR while
 * change-currency commits EUR→USD. The writer must take Account FOR UPDATE and
 * fail closed instead of inserting an unconverted mixed-currency row that
 * balances would sum as if it were USD cents.
 */
test("writer fails closed after concurrent change-currency commits", async () => {
  let accountCurrency = "EUR";

  async function runChangeCurrency() {
    const tx = {
      $queryRaw: async () => [
        { id: "account-1", currency: accountCurrency, deletedAt: null },
      ],
    };
    await assertAccountCurrencyLocked(tx, "account-1", "EUR");
    accountCurrency = "USD";
  }

  async function runWriterCreate(expectedCurrency) {
    const tx = {
      $queryRaw: async () => [
        { id: "account-1", currency: accountCurrency, deletedAt: null },
      ],
    };
    await assertAccountCurrencyLocked(tx, "account-1", expectedCurrency);
    return { stamped: expectedCurrency };
  }

  await runChangeCurrency();
  await assert.rejects(
    () => runWriterCreate("EUR"),
    AccountCurrencyChangedError
  );
  assert.equal(accountCurrency, "USD");
});

/**
 * Writer-before-converter: writer holds the account lock first, inserts in the
 * old currency, then converter claims and includes that row in conversion.
 */
test("writer-before-converter serializes so converter still sees matching currency", async () => {
  let accountCurrency = "EUR";
  const ledger = [];

  async function runWriter() {
    const tx = {
      $queryRaw: async () => [
        { id: "account-1", currency: accountCurrency, deletedAt: null },
      ],
    };
    await assertAccountCurrencyLocked(tx, "account-1", "EUR");
    ledger.push({ amountMinor: 5000, currency: "EUR" });
  }

  async function runConverter() {
    const tx = {
      $queryRaw: async () => [
        { id: "account-1", currency: accountCurrency, deletedAt: null },
      ],
    };
    await assertAccountCurrencyLocked(tx, "account-1", "EUR");
    for (const row of ledger) {
      if (row.currency === "EUR") {
        row.amountMinor = Math.round(row.amountMinor * 1.1);
        row.currency = "USD";
      }
    }
    accountCurrency = "USD";
  }

  await runWriter();
  await runConverter();
  assert.deepEqual(ledger, [{ amountMinor: 5500, currency: "USD" }]);
  assert.equal(accountCurrency, "USD");
});

test("assertAccountsCurrencyLocked locks in stable id order", async () => {
  const order = [];
  const tx = {
    $queryRaw: async (strings, ...params) => {
      order.push(params[0]);
      return [{ id: params[0], currency: "EUR", deletedAt: null }];
    },
  };

  await assertAccountsCurrencyLocked(tx, [
    { accountId: "account-z", expectedCurrency: "EUR" },
    { accountId: "account-a", expectedCurrency: "EUR" },
  ]);

  assert.deepEqual(order, ["account-a", "account-z"]);
});
