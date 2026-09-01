const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadMarketDataWithFetch(fetchImpl) {
  process.env.MONEYMASTER_LOG_DIR = "0";
  process.env.TWELVEDATA_API_KEY = "test-key";

  const marketDataPath = path.resolve(__dirname, "../src/services/marketData.js");
  const prismaPath = path.resolve(__dirname, "../src/prisma.js");
  const fileLoggerPath = path.resolve(__dirname, "../src/lib/fileLogger.js");

  delete require.cache[marketDataPath];
  stubModule(prismaPath, { prisma: {} });
  stubModule(fileLoggerPath, { logApp: () => {} });

  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "node-fetch") return fetchImpl;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(marketDataPath);
  } finally {
    Module._load = originalLoad;
  }
}

test("strict TwelveData sweep mode surfaces failed unified requests", async () => {
  const { fetchTwelveDataPrices } = loadMarketDataWithFetch(async () => ({
    ok: false,
    status: 503,
    text: async () => "provider unavailable",
  }));

  await assert.rejects(
    () =>
      fetchTwelveDataPrices(
        [{ id: "inst_1", providerSymbol: "AAPL", exchange: "NASDAQ" }],
        {
          skipBatchGap: true,
          tryUnifiedSymbolOnlyFirst: true,
          strictOneCallPerTick: true,
        }
      ),
    /Twelve Data batch failed 503: provider unavailable/
  );
});
