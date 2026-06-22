const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");

const express = require("express");

const transfersModulePath = require.resolve("../src/routes/transfers");

function loadTransfersRouter({ prisma, assertAccess }) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent?.filename === transfersModulePath) {
      if (request === "../prisma") return { prisma };
      if (request === "../middleware/auth") {
        return {
          requireAuth(req, _res, next) {
            req.auth = { userId: "user_member" };
            next();
          },
        };
      }
      if (request === "../services/nonNegativeCashBalance") {
        return {
          async throwIfExpenseWouldCauseNegativeCashBalance() {},
        };
      }
      if (request === "../services/categoryMemberAccess") {
        return { assertCategoryManualMemberAccess: assertAccess };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[transfersModulePath];
  try {
    return require(transfersModulePath).transfersRouter;
  } finally {
    Module._load = originalLoad;
    delete require.cache[transfersModulePath];
  }
}

function makePrismaMock() {
  const calls = {
    transactionOpened: false,
  };
  const accounts = new Map([
    ["from_account", { id: "from_account", currency: "EUR", walletsEnabled: false }],
    ["to_account", { id: "to_account", currency: "EUR", walletsEnabled: false }],
  ]);
  const categories = new Map([
    [
      "from_category",
      {
        id: "from_category",
        type: "EXPENSE",
        internalKey: null,
        lockedForManualEntry: false,
        memberAccessRestricted: true,
      },
    ],
    [
      "to_category",
      {
        id: "to_category",
        type: "INCOME",
        internalKey: null,
        lockedForManualEntry: false,
        memberAccessRestricted: true,
      },
    ],
  ]);

  return {
    calls,
    prisma: {
      account: {
        async findFirst({ where }) {
          return accounts.get(where.id) ?? null;
        },
      },
      accountMember: {
        async findUnique() {
          return { role: "MEMBER" };
        },
      },
      category: {
        async findFirst({ where }) {
          const category = categories.get(where.id);
          if (!category || category.accountId !== undefined) return null;
          if (category.type !== where.type) return null;
          return category;
        },
      },
      accountWallet: {
        async findFirst() {
          return null;
        },
      },
      async $transaction() {
        calls.transactionOpened = true;
        throw new Error("transfer write should not run when category access is denied");
      },
    },
  };
}

async function postTransfer(router) {
  const app = express();
  app.use(express.json());
  app.use("/transfers", router);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err?.message || "unexpected" });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/transfers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromAccountId: "from_account",
        toAccountId: "to_account",
        fromCategoryId: "from_category",
        toCategoryId: "to_category",
        amountMinor: 1234,
      }),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("POST /transfers rejects source categories denied by member access", async () => {
  const accessCalls = [];
  const { calls, prisma } = makePrismaMock();
  const router = loadTransfersRouter({
    prisma,
    async assertAccess(_client, { category }) {
      accessCalls.push(category.id);
      if (category.id === "from_category") {
        const err = new Error("CATEGORY_ACCESS_DENIED");
        err.statusCode = 403;
        throw err;
      }
    },
  });

  const response = await postTransfer(router);

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: "You do not have access to this category" });
  assert.deepEqual(accessCalls, ["from_category"]);
  assert.equal(calls.transactionOpened, false);
});

test("POST /transfers rejects destination categories denied by member access", async () => {
  const accessCalls = [];
  const { calls, prisma } = makePrismaMock();
  const router = loadTransfersRouter({
    prisma,
    async assertAccess(_client, { category }) {
      accessCalls.push(category.id);
      if (category.id === "to_category") {
        const err = new Error("CATEGORY_ACCESS_DENIED");
        err.statusCode = 403;
        throw err;
      }
    },
  });

  const response = await postTransfer(router);

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: "You do not have access to this category" });
  assert.deepEqual(accessCalls, ["from_category", "to_category"]);
  assert.equal(calls.transactionOpened, false);
});
