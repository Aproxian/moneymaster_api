const fetch = require("node-fetch");

const { prisma } = require("../prisma");

const TWELVEDATA_BASE_URL =
  process.env.TWELVEDATA_BASE_URL || "https://api.twelvedata.com";

/** Twelve Data does not treat these CSV “venues” as real exchanges (use symbol-only or crypto exchange names instead). */
const PSEUDO_EXCHANGES = new Set([
  "CRYPTO",
  "FOREX",
  "COMMODITY",
  "INDEX",
  "OTC",
  "PHYSICAL",
  "PHYSICAL CURRENCY",
  "FX",
  "METAL",
  "ENERGY",
  "AGRICULTURE",
]);

/** Twelve Data allows comma-separated symbols; API caps matches per response (typically 120). */
const BATCH_SIZE = parseInt(process.env.TWELVEDATA_QUOTE_BATCH_SIZE || "120", 10);
/** Space HTTP calls so Basic-tier minutely limits (~8/min) are not exceeded. Lower on higher plans. */
const BATCH_GAP_MS = parseInt(process.env.TWELVEDATA_BATCH_GAP_MS || "8000", 10);
/** If true, retry each missed symbol with single-symbol requests (many HTTP calls — avoid on Basic). */
const SINGLE_FALLBACK =
  String(process.env.TWELVEDATA_SINGLE_FALLBACK || "").toLowerCase() === "1" ||
  String(process.env.TWELVEDATA_SINGLE_FALLBACK || "").toLowerCase() === "true";

/** Thrown when Twelve Data returns JSON `{ status: "error", code, message }` (often HTTP 200). */
class TwelveDataApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TwelveDataApiError";
    this.code = code;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isMultiSymbolTimeSeriesShape(data) {
  if (!data || typeof data !== "object") return false;
  const skip = new Set(["meta", "values", "status", "code", "message", "data"]);
  for (const k of Object.keys(data)) {
    if (skip.has(k)) continue;
    const v = data[k];
    if (v && typeof v === "object" && Array.isArray(v.values)) return true;
  }
  return false;
}

/**
 * Fail fast on whole-response errors (quota, bad key). Multi-symbol bodies use symbol keys instead.
 */
function throwIfTwelveDataGlobalError(data) {
  if (!data || data.status !== "error") return;
  if (isMultiSymbolTimeSeriesShape(data)) return;
  throw new TwelveDataApiError(
    data.message || "Twelve Data API error",
    data.code != null ? data.code : "UNKNOWN"
  );
}

/**
 * @param {string} exchangeRaw
 * @returns {{ exchange?: string, mic_code?: string }}
 */
function venueQueryParams(exchangeRaw) {
  const ex = String(exchangeRaw || "").trim();
  if (!ex) return {};
  const up = ex.toUpperCase();
  if (PSEUDO_EXCHANGES.has(up)) return {};
  // ISO MICs used in seed CSV (XLON, XETR, XPAR, XNAS, …) must use mic_code, not exchange.
  if (/^X[A-Z0-9]{3}$/.test(ex)) {
    return { mic_code: ex };
  }
  return { exchange: ex };
}

function venueGroupKey(exchangeRaw) {
  const v = venueQueryParams(exchangeRaw);
  if (v.mic_code) return `mic:${v.mic_code}`;
  if (v.exchange) return `ex:${v.exchange}`;
  return "none";
}

function parseTimeSeriesPayload(data, now) {
  if (!data || typeof data !== "object") return null;
  if (data.status === "error") return null;

  const values = Array.isArray(data.values) ? data.values : null;
  if (values && values.length) {
    const latest = values[0];
    const price = Number(latest.close);
    if (!Number.isFinite(price)) return null;
    const meta = data.meta && typeof data.meta === "object" ? data.meta : null;
    return {
      price,
      currency: data.currency || meta?.currency || null,
      asOf: latest.datetime ? new Date(latest.datetime) : now,
    };
  }
  return null;
}

/**
 * Batch time_series: symbols share the same venue params (or none).
 * @param {string[]} symbols upper or mixed case tickers
 * @param {{ exchange?: string, mic_code?: string }} venue
 */
async function fetchTwelveDataTimeSeriesBatch(symbols, venue) {
  if (!process.env.TWELVEDATA_API_KEY) {
    throw new Error("TWELVEDATA_API_KEY is not set");
  }
  if (!symbols.length) return new Map();

  const url = new URL(`${TWELVEDATA_BASE_URL}/time_series`);
  url.searchParams.set("symbol", symbols.join(","));
  url.searchParams.set("interval", "1day");
  url.searchParams.set("outputsize", "1");
  url.searchParams.set("apikey", process.env.TWELVEDATA_API_KEY);
  if (venue.exchange) url.searchParams.set("exchange", venue.exchange);
  if (venue.mic_code) url.searchParams.set("mic_code", venue.mic_code);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Twelve Data batch failed ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  throwIfTwelveDataGlobalError(data);
  const now = new Date();
  const bySym = new Map();

  if (Array.isArray(data.data)) {
    for (const entry of data.data) {
      if (!entry?.symbol) continue;
      const parsed = parseTimeSeriesPayload(entry, now);
      if (parsed) bySym.set(String(entry.symbol).toUpperCase(), parsed);
    }
    return bySym;
  }

  if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
    for (const [rawKey, entry] of Object.entries(data.data)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.status === "error") continue;
      const parsed = parseTimeSeriesPayload(entry, now);
      if (parsed) bySym.set(String(rawKey).toUpperCase(), parsed);
    }
    if (bySym.size > 0) return bySym;
  }

  for (const sym of symbols) {
    const entry =
      data[sym] ||
      data[sym.toUpperCase()] ||
      data[sym.toLowerCase()] ||
      (typeof data === "object" && data.meta && data.meta.symbol === sym ? data : null);
    if (entry && typeof entry === "object" && entry !== data) {
      const parsed = parseTimeSeriesPayload(entry, now);
      if (parsed) bySym.set(sym.toUpperCase(), parsed);
    }
  }

  if (bySym.size === 0 && parseTimeSeriesPayload(data, now)) {
    const one = parseTimeSeriesPayload(data, now);
    bySym.set(symbols[0].toUpperCase(), one);
  }

  return bySym;
}

async function fetchTwelveDataTimeSeriesSingle(symbol, venue) {
  if (!process.env.TWELVEDATA_API_KEY) {
    throw new Error("TWELVEDATA_API_KEY is not set");
  }

  const url = new URL(`${TWELVEDATA_BASE_URL}/time_series`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1day");
  url.searchParams.set("outputsize", "1");
  url.searchParams.set("apikey", process.env.TWELVEDATA_API_KEY);
  if (venue.exchange) url.searchParams.set("exchange", venue.exchange);
  if (venue.mic_code) url.searchParams.set("mic_code", venue.mic_code);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Twelve Data request failed with status ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  throwIfTwelveDataGlobalError(data);
  const now = new Date();
  return parseTimeSeriesPayload(data, now);
}

/**
 * Try venue-specific params, then symbol-only (fixes wrong MIC vs exchange and pseudo-venues).
 */
async function fetchQuoteForInstrument(instrument) {
  const sym = instrument.providerSymbol;
  const primary = venueQueryParams(instrument.exchange);
  const tries = [primary, {}];
  const seen = new Set();
  for (const venue of tries) {
    const key = JSON.stringify(venue);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const q = await fetchTwelveDataTimeSeriesSingle(sym, venue);
      if (q) return q;
    } catch (e) {
      if (e instanceof TwelveDataApiError) throw e;
    }
  }
  return null;
}

async function fetchTwelveDataPrices(instruments) {
  if (!instruments.length) {
    return {};
  }

  const result = {};

  const groups = new Map();
  for (const inst of instruments) {
    const key = venueGroupKey(inst.exchange);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(inst);
  }

  for (const [, list] of groups) {
    const venue = venueQueryParams(list[0].exchange);
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const chunk = list.slice(i, i + BATCH_SIZE);
      const symbols = chunk.map((x) => x.providerSymbol);
      let bySym = new Map();
      try {
        bySym = await fetchTwelveDataTimeSeriesBatch(symbols, venue);
      } catch (e) {
        if (e instanceof TwelveDataApiError) throw e;
        bySym = new Map();
      }

      for (const inst of chunk) {
        const su = inst.providerSymbol.toUpperCase();
        const hit = bySym.get(su) || bySym.get(inst.providerSymbol);
        if (hit) result[inst.id] = hit;
      }

      if (SINGLE_FALLBACK) {
        for (const inst of chunk) {
          if (result[inst.id]) continue;
          try {
            const q = await fetchQuoteForInstrument(inst);
            if (q) result[inst.id] = q;
          } catch (e) {
            if (e instanceof TwelveDataApiError) throw e;
          }
          if (BATCH_GAP_MS > 0) await sleep(BATCH_GAP_MS);
        }
      }

      if (BATCH_GAP_MS > 0) await sleep(BATCH_GAP_MS);
    }
  }

  return result;
}

async function refreshDailyQuotesForTwelveData() {
  const instruments = await prisma.instrument.findMany({
    where: {
      provider: "TWELVEDATA",
      isActive: true,
    },
    select: {
      id: true,
      providerSymbol: true,
      exchange: true,
      currency: true,
    },
  });

  let pricesByInstrumentId;
  try {
    pricesByInstrumentId = await fetchTwelveDataPrices(instruments);
  } catch (e) {
    if (e instanceof TwelveDataApiError) {
      const missingSymbols = instruments.map((i) => {
        const ex = String(i.exchange || "").trim();
        return ex ? `${i.providerSymbol}@${ex}` : i.providerSymbol;
      });
      return {
        instrumentsCount: instruments.length,
        quotesCreated: 0,
        missingSymbols,
        twelveDataError: {
          code: e.code,
          message: e.message,
        },
      };
    }
    throw e;
  }

  let createdCount = 0;
  const missingSymbols = [];

  await prisma.$transaction(async (tx) => {
    for (const instrument of instruments) {
      const quote = pricesByInstrumentId[instrument.id];
      if (!quote) {
        const ex = String(instrument.exchange || "").trim();
        missingSymbols.push(ex ? `${instrument.providerSymbol}@${ex}` : instrument.providerSymbol);
        continue;
      }

      await tx.quoteCache.create({
        data: {
          instrumentId: instrument.id,
          provider: "TWELVEDATA",
          price: quote.price,
          currency: quote.currency,
          asOf: quote.asOf,
        },
      });

      createdCount += 1;
    }
  });

  return {
    instrumentsCount: instruments.length,
    quotesCreated: createdCount,
    missingSymbols,
  };
}

module.exports = {
  TwelveDataApiError,
  fetchTwelveDataPrices,
  refreshDailyQuotesForTwelveData,
};
