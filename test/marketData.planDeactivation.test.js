const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const marketDataPath = path.resolve(__dirname, "../src/services/marketData.js");
const prismaPath = path.resolve(__dirname, "../src/prisma.js");
const fileLoggerPath = path.resolve(__dirname, "../src/lib/fileLogger.js");

function loadMarketDataWithStubs(fetchImpl, prisma) {
  delete require.cache[marketDataPath];
  delete require.cache[prismaPath];
  delete require.cache[fileLoggerPath];

  const nodeFetchPath = require.resolve("node-fetch");
  delete require.cache[nodeFetchPath];

  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: { prisma },
  };
  require.cache[fileLoggerPath] = {
    id: fileLoggerPath,
    filename: fileLoggerPath,
    loaded: true,
    exports: { logApp: () => {} },
  };
  require.cache[nodeFetchPath] = {
    id: nodeFetchPath,
    filename: nodeFetchPath,
    loaded: true,
    exports: fetchImpl,
  };

  return require(marketDataPath);
}

test("batch plan-tier errors do not deactivate every matching ticker across venues", async (t) => {
  const originalApiKey = process.env.TWELVEDATA_API_KEY;
  const originalAutoDeactivate = process.env.TWELVEDATA_AUTO_DEACTIVATE_PLAN_SYMBOLS;
  process.env.TWELVEDATA_API_KEY = "test-key";
  process.env.TWELVEDATA_AUTO_DEACTIVATE_PLAN_SYMBOLS = "1";

  t.after(() => {
    if (originalApiKey === undefined) {
      delete process.env.TWELVEDATA_API_KEY;
    } else {
      process.env.TWELVEDATA_API_KEY = originalApiKey;
    }
    if (originalAutoDeactivate === undefined) {
      delete process.env.TWELVEDATA_AUTO_DEACTIVATE_PLAN_SYMBOLS;
    } else {
      process.env.TWELVEDATA_AUTO_DEACTIVATE_PLAN_SYMBOLS = originalAutoDeactivate;
    }
    delete require.cache[marketDataPath];
    delete require.cache[prismaPath];
    delete require.cache[fileLoggerPath];
    delete require.cache[require.resolve("node-fetch")];
  });

  const prisma = {
    instrument: {
      findMany: async () => {
        throw new Error("batch plan-tier handling must not scan instruments by ticker");
      },
      updateMany: async () => {
        throw new Error("batch plan-tier handling must not deactivate instruments by ticker");
      },
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      data: {
        BMW: {
          status: "error",
          code: 404,
          message: "This symbol is available on Pro or Venture plan only",
        },
      },
    }),
  });

  const { fetchTwelveDataPrices } = loadMarketDataWithStubs(fetchImpl, prisma);

  const prices = await fetchTwelveDataPrices(
    [
      { id: "bmw-xetr", providerSymbol: "BMW", exchange: "XETR" },
      { id: "bmw-us", providerSymbol: "BMW", exchange: "NYSE" },
    ],
    { tryUnifiedSymbolOnlyFirst: true, strictOneCallPerTick: true }
  );

  assert.deepEqual(prices, {});
});
