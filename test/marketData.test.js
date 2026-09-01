const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const marketDataPath = path.join(rootDir, "src/services/marketData.js");
const prismaPath = path.join(rootDir, "src/prisma.js");
const loggerPath = path.join(rootDir, "src/lib/fileLogger.js");
const nodeFetchPath = require.resolve("node-fetch", { paths: [rootDir] });

function clearMarketDataModules() {
  delete require.cache[marketDataPath];
  delete require.cache[prismaPath];
  delete require.cache[loggerPath];
  delete require.cache[nodeFetchPath];
}

function loadMarketData({ prisma, fetchImpl }) {
  clearMarketDataModules();
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: { prisma },
  };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
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

function okJson(body) {
  return {
    ok: true,
    json: async () => body,
  };
}

function planRestrictedPayload(symbol) {
  return {
    data: {
      [symbol]: {
        status: "error",
        code: 404,
        message: "This symbol is available on Pro or Venture plan only.",
      },
    },
  };
}

function quotePayload(symbol, close = "100") {
  return {
    [symbol]: {
      meta: { symbol, currency: "EUR" },
      values: [{ datetime: "2026-05-22", close }],
    },
  };
}

test.afterEach(() => {
  clearMarketDataModules();
  delete process.env.TWELVEDATA_API_KEY;
});

test("plan-tier auto-deactivation skips ambiguous active tickers", async () => {
  process.env.TWELVEDATA_API_KEY = "test-key";
  const updateCalls = [];
  const prisma = {
    instrument: {
      findMany: async () => [
        { id: "sap-xetr", providerSymbol: "SAP" },
        { id: "sap-xnys", providerSymbol: "SAP" },
      ],
      updateMany: async (args) => {
        updateCalls.push(args);
        return { count: 1 };
      },
    },
  };
  const { fetchTwelveDataPrices } = loadMarketData({
    prisma,
    fetchImpl: async () => okJson(planRestrictedPayload("SAP")),
  });

  const result = await fetchTwelveDataPrices(
    [{ id: "sap-xetr", providerSymbol: "SAP", exchange: "XETR" }],
    { tryUnifiedSymbolOnlyFirst: true, strictOneCallPerTick: true }
  );

  assert.deepEqual(result, {});
  assert.deepEqual(updateCalls, []);
});

test("plan-tier auto-deactivation still disables an unambiguous ticker", async () => {
  process.env.TWELVEDATA_API_KEY = "test-key";
  const updateCalls = [];
  const prisma = {
    instrument: {
      findMany: async () => [{ id: "sap-xetr", providerSymbol: "SAP" }],
      updateMany: async (args) => {
        updateCalls.push(args);
        return { count: 1 };
      },
    },
  };
  const { fetchTwelveDataPrices } = loadMarketData({
    prisma,
    fetchImpl: async () => okJson(planRestrictedPayload("SAP")),
  });

  const result = await fetchTwelveDataPrices(
    [{ id: "sap-xetr", providerSymbol: "SAP", exchange: "XETR" }],
    { tryUnifiedSymbolOnlyFirst: true, strictOneCallPerTick: true }
  );

  assert.deepEqual(result, {});
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].where, { id: { in: ["sap-xetr"] } });
  assert.deepEqual(updateCalls[0].data, { isActive: false });
});

test("strict symbol-only sweep does not assign venue-less quotes to venue-specific instruments", async () => {
  process.env.TWELVEDATA_API_KEY = "test-key";
  const prisma = {
    instrument: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
  };
  const { fetchTwelveDataPrices } = loadMarketData({
    prisma,
    fetchImpl: async () => okJson(quotePayload("SAP")),
  });

  const result = await fetchTwelveDataPrices(
    [
      { id: "sap-xetr", providerSymbol: "SAP", exchange: "XETR" },
      { id: "sap-no-venue", providerSymbol: "SAP", exchange: null },
    ],
    { tryUnifiedSymbolOnlyFirst: true, strictOneCallPerTick: true }
  );

  assert.equal(result["sap-xetr"], undefined);
  assert.equal(result["sap-no-venue"].price, 100);
});
