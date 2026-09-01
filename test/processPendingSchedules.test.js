const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

async function runWithFakePrisma({ updateManyResult }) {
  const processPath = path.resolve(__dirname, "../src/services/processPendingSchedules.js");
  const prismaPath = path.resolve(__dirname, "../src/prisma.js");
  const materializePath = path.resolve(__dirname, "../src/services/materializeScheduledPayload.js");
  const loggerPath = path.resolve(__dirname, "../src/lib/fileLogger.js");

  delete require.cache[processPath];
  delete require.cache[prismaPath];
  delete require.cache[materializePath];
  delete require.cache[loggerPath];

  const dueAt = new Date(Date.now() - 60_000);
  const schedule = {
    id: "sched_1",
    accountId: "acct_1",
    createdByUserId: "creator_1",
    kind: "DELAY_ONCE",
    status: "PENDING",
    cancelledAt: null,
    executeAt: dueAt,
    nextRunAt: dueAt,
    payload: { tab: "expense" },
  };
  const operations = [];
  const tx = {
    pendingTransactionSchedule: {
      findFirst: async () => schedule,
      updateMany: async (args) => {
        operations.push({ op: "claim", args });
        return updateManyResult;
      },
    },
  };

  stubModule(prismaPath, {
    prisma: {
      pendingTransactionSchedule: {
        findMany: async () => [schedule],
      },
      $transaction: async (fn) => fn(tx),
    },
  });
  stubModule(materializePath, {
    materializeScheduledPayload: async () => {
      operations.push({ op: "materialize" });
    },
  });
  stubModule(loggerPath, { logApp: () => {} });

  const { processPendingSchedulesForUser } = require(processPath);
  await processPendingSchedulesForUser("member_1");
  return operations;
}

test("one-shot schedules are claimed before materialization", async () => {
  const operations = await runWithFakePrisma({ updateManyResult: { count: 1 } });

  assert.equal(operations[0].op, "claim");
  assert.equal(operations[0].args.data.status, "COMPLETED");
  assert.equal(operations[1].op, "materialize");
});

test("one-shot schedules skip materialization when another worker already claimed", async () => {
  const operations = await runWithFakePrisma({ updateManyResult: { count: 0 } });

  assert.deepEqual(
    operations.map((op) => op.op),
    ["claim"]
  );
});
