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

function loadMarketDataWithFetch(fetchImpl, prisma) {
  process.env.MONEYMASTER_LOG_DIR = "0";
  process.env.TWELVEDATA_API_KEY = "test-key";

  const marketDataPath = path.resolve(__dirname, "../src/services/marketData.js");
  const prismaPath = path.resolve(__dirname, "../src/prisma.js");
  const fileLoggerPath = path.resolve(__dirname, "../src/lib/fileLogger.js");
  const nodeFetchPath = require.resolve("node-fetch");

  delete require.cache[marketDataPath];
  delete require.cache[prismaPath];
  delete require.cache[fileLoggerPath];
  delete require.cache[nodeFetchPath];
  stubModule(prismaPath, { prisma });
  stubModule(fileLoggerPath, { logApp: () => {} });
  stubModule(nodeFetchPath, fetchImpl);

  return require(marketDataPath);
}

test("TwelveData batch plan errors do not deactivate every matching ticker", async () => {
  let updateManyCalls = 0;
  const { fetchTwelveDataPrices } = loadMarketDataWithFetch(
    async () => ({
      ok: true,
      json: async () => ({
        status: "error",
        code: 404,
        message: "This symbol is available for Pro or Venture plan only",
      }),
    }),
    {
      instrument: {
        updateMany: async () => {
          updateManyCalls += 1;
          return { count: 0 };
        },
      },
    }
  );

  await assert.rejects(
    () =>
      fetchTwelveDataPrices(
        [
          { id: "sap-xetr", providerSymbol: "SAP", exchange: "XETR" },
          { id: "sap-nyse", providerSymbol: "SAP", exchange: "NYSE" },
        ],
        {
          skipBatchGap: true,
          tryUnifiedSymbolOnlyFirst: true,
          strictOneCallPerTick: true,
        }
      ),
    /Pro or Venture/
  );
  assert.equal(updateManyCalls, 0);
});
