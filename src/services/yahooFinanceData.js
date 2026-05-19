"use strict";

const { prisma } = require("../prisma");
const { logApp } = require("../lib/fileLogger");

const YAHOO_FINANCE_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

const YAHOO_STATE_ID = "YAHOOFINANCE";

/** Max instruments to fetch per background sweep tick. */
const SYMBOLS_PER_TICK = Math.max(
  1,
  parseInt(process.env.YAHOO_FINANCE_SYMBOLS_PER_TICK || "20", 10)
);

/** Per-symbol HTTP request timeout in ms. */
const REQUEST_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.YAHOO_FINANCE_REQUEST_TIMEOUT_MS || "8000", 10)
);

/** Set YAHOO_FINANCE_LOG_REQUESTS=1 to log each fetch URL. */
const LOG_REQUESTS =
  String(process.env.YAHOO_FINANCE_LOG_REQUESTS || "").toLowerCase() === "1" ||
  String(process.env.YAHOO_FINANCE_LOG_REQUESTS || "").toLowerCase() === "true";

function logYahooRequestUrl(url) {
  if (!LOG_REQUESTS) return;
  // eslint-disable-next-line no-console -- intentional ops/debug aid
  console.log(`[YahooFinance] quote_request ${url}`);
  logApp("INFO", "YahooFinance", "quote_request", url);
}

/**
 * Fetch a single daily quote from Yahoo Finance.
 *
 * @param {string} yahooSymbol  Native Yahoo ticker (e.g. "AAPL", "AZN.L", "BTC-USD", "EURUSD=X")
 * @returns {Promise<{ price: number, currency: string | null, asOf: Date } | null>}
 *   Returns null on 404, timeout, or any malformed response — never throws.
 */
async function fetchYahooFinanceQuote(yahooSymbol) {
  const url = `${YAHOO_FINANCE_BASE_URL}/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
  logYahooRequestUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MoneyMASTER/1.0)",
        Accept: "application/json",
      },
    });

    if (!res.ok) return null; // 404 = unknown symbol; skip silently

    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price = Number(meta.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) return null;

    const currency = typeof meta.currency === "string" ? meta.currency : null;

    // regularMarketTime is Unix seconds; fall back to now if absent.
    const ts = meta.regularMarketTime;
    const asOf = typeof ts === "number" && ts > 0 ? new Date(ts * 1000) : new Date();

    return { price, currency, asOf };
  } catch (e) {
    if (e.name === "AbortError") return null; // timeout — skip silently
    // Network errors (ECONNREFUSED etc.) — log and skip
    logApp("WARN", "YahooFinance", "fetch_network_error", {
      symbol: yahooSymbol,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load all active YAHOOFINANCE instruments ordered by id (same ordering as Twelve Data sweep).
 */
async function loadYahooInstrumentsOrdered() {
  return prisma.instrument.findMany({
    where: { provider: "YAHOOFINANCE", isActive: true },
    orderBy: { id: "asc" },
    select: {
      id: true,
      providerSymbol: true,
      exchange: true,
      type: true,
      currency: true,
    },
  });
}

function instrumentDisplayLabel(i) {
  const ex = String(i.exchange || "").trim();
  const sym = String(i.providerSymbol || "").trim();
  return ex ? `${sym}@${ex}` : sym;
}

/**
 * Rate-friendly chunked refresh for Yahoo Finance: one tick's worth of instruments per call.
 * Advances a DB cursor in TwelveDataQuoteRefreshState (id = "YAHOOFINANCE").
 *
 * Schedule the background sweep ~every YAHOO_FINANCE_SWEEP_INTERVAL_MS (default 10 s).
 * Full cycle ≈ ceil(n / SYMBOLS_PER_TICK) ticks.
 *
 * @param {{ resetCycle?: boolean }} [options]
 */
async function refreshDailyQuotesForYahooFinanceChunked(options = {}) {
  const resetCycle = Boolean(options.resetCycle);
  const instruments = await loadYahooInstrumentsOrdered();
  const total = instruments.length;

  if (total === 0) {
    return {
      mode: "chunk",
      provider: "YAHOOFINANCE",
      instrumentsCount: 0,
      chunkSize: SYMBOLS_PER_TICK,
      offsetStart: 0,
      nextOffset: 0,
      processedThisTick: 0,
      quotesCreated: 0,
      missingSymbols: [],
      cycleJustCompleted: true,
      ticksPerFullCycle: 0,
      estimatedTicksRemainingInCycle: 0,
    };
  }

  // Upsert the YAHOOFINANCE cursor row (reuses TwelveDataQuoteRefreshState table).
  let state = await prisma.twelveDataQuoteRefreshState.findUnique({
    where: { id: YAHOO_STATE_ID },
  });
  if (!state) {
    state = await prisma.twelveDataQuoteRefreshState.create({
      data: { id: YAHOO_STATE_ID, nextOffset: 0, totalSnapshot: total },
    });
  }

  let offset = state.nextOffset;
  if (resetCycle) {
    offset = 0;
  } else if (state.totalSnapshot !== total) {
    // Instrument count changed — reset to avoid out-of-range slices.
    offset = 0;
  }
  if (offset >= total) offset = 0;

  const slice = instruments.slice(offset, offset + SYMBOLS_PER_TICK);
  const offsetStart = offset;

  // Fetch sequentially — polite to Yahoo Finance, no rate-limit maths required.
  const quoteResults = {};
  const missingSymbols = [];

  for (const inst of slice) {
    const q = await fetchYahooFinanceQuote(inst.providerSymbol);
    if (q) {
      quoteResults[inst.id] = q;
    } else {
      missingSymbols.push(instrumentDisplayLabel(inst));
    }
  }

  let createdCount = 0;
  let nextOffset = offset + slice.length;
  const cycleJustCompleted = nextOffset >= total;
  if (cycleJustCompleted) nextOffset = 0;

  await prisma.$transaction(async (tx) => {
    for (const inst of slice) {
      const q = quoteResults[inst.id];
      if (!q) continue;
      await tx.quoteCache.create({
        data: {
          instrumentId: inst.id,
          provider: "YAHOOFINANCE",
          price: q.price,
          currency: q.currency,
          asOf: q.asOf,
        },
      });
      createdCount += 1;
    }

    await tx.twelveDataQuoteRefreshState.update({
      where: { id: YAHOO_STATE_ID },
      data: { nextOffset, totalSnapshot: total },
    });
  });

  const remainingAfterThisTick = Math.max(0, total - (offset + slice.length));

  return {
    mode: "chunk",
    provider: "YAHOOFINANCE",
    instrumentsCount: total,
    chunkSize: SYMBOLS_PER_TICK,
    offsetStart,
    nextOffset,
    processedThisTick: slice.length,
    quotesCreated: createdCount,
    missingSymbols,
    cycleJustCompleted,
    ticksPerFullCycle: Math.ceil(total / SYMBOLS_PER_TICK),
    estimatedTicksRemainingInCycle: Math.ceil(remainingAfterThisTick / SYMBOLS_PER_TICK),
  };
}

module.exports = {
  refreshDailyQuotesForYahooFinanceChunked,
  /** @returns {number} max instruments per sweep tick */
  getYahooFinanceSymbolsPerTick: () => SYMBOLS_PER_TICK,
};
