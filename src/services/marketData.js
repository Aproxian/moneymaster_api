const fetch = require("node-fetch");

const { prisma } = require("../prisma");
const { logApp } = require("../lib/fileLogger");

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

/**
 * Twelve Data batch `time_series` often resolves US listings more reliably with ISO MIC
 * than with `exchange=NASDAQ` / `exchange=NYSE` alongside comma-separated tickers.
 */
const US_EXCHANGE_NAME_TO_MIC = new Map(
  Object.entries({
    NASDAQ: "XNAS",
    NYSE: "XNYS",
    AMEX: "XASE",
    ARCA: "ARCX",
    "NYSE ARCA": "ARCX",
    "NYSE MKT": "XASE",
    BATS: "BATS",
  }).map(([k, v]) => [k.toUpperCase().replace(/\s+/g, " "), v])
);

/** Twelve Data allows comma-separated symbols; API caps matches per response (typically 120). */
const BATCH_SIZE = parseInt(process.env.TWELVEDATA_QUOTE_BATCH_SIZE || "120", 10);
/**
 * Pause between Twelve Data HTTP batch calls **within one refresh** (chunk slice or "all" mode).
 * Chunked background sweeps pass `{ skipBatchGap: true }` so spacing is only `TWELVEDATA_SWEEP_INTERVAL_MS`
 * between slices of `TWELVEDATA_CREDITS_PER_MINUTE` instruments — not this gap plus the sweep interval.
 */
const BATCH_GAP_MS = parseInt(process.env.TWELVEDATA_BATCH_GAP_MS || "8000", 10);
/** Max instruments to pull quotes for in one `/refresh-daily` call when using chunk mode (match plan credits/min). */
const CREDITS_PER_TICK = Math.max(
  1,
  parseInt(process.env.TWELVEDATA_CREDITS_PER_MINUTE || "8", 10)
);
/** `chunk` (default): one slice per request + DB cursor. `all`: legacy full sweep in one HTTP session. */
const REFRESH_MODE = String(process.env.TWELVEDATA_REFRESH_MODE || "chunk")
  .trim()
  .toLowerCase();

const TWELVEDATA_STATE_ID = "TWELVEDATA";
/** Set `TWELVEDATA_LOG_QUOTE_REQUESTS=1` to print each Twelve Data quote URL to server logs (api key redacted). */
const LOG_TWELVE_DATA_QUOTES =
  String(process.env.TWELVEDATA_LOG_QUOTE_REQUESTS || "").toLowerCase() === "1" ||
  String(process.env.TWELVEDATA_LOG_QUOTE_REQUESTS || "").toLowerCase() === "true";

function logTwelveDataRequestUrl(url) {
  if (!LOG_TWELVE_DATA_QUOTES) return;
  try {
    const u = new URL(typeof url === "string" ? url : url.toString());
    if (u.searchParams.has("apikey")) u.searchParams.set("apikey", "***");
    const line = `[TwelveData] quote_request ${u.toString()}`;
    // eslint-disable-next-line no-console -- intentional ops/debug aid
    console.log(line);
    logApp("INFO", "TwelveData", "quote_request", u.toString());
  } catch {
    /* ignore */
  }
}

/** If true, retry each missed symbol with single-symbol requests (many HTTP calls — avoid on Basic). */
const SINGLE_FALLBACK =
  String(process.env.TWELVEDATA_SINGLE_FALLBACK || "").toLowerCase() === "1" ||
  String(process.env.TWELVEDATA_SINGLE_FALLBACK || "").toLowerCase() === "true";

/** If true, after a failed batch (e.g. global symbol error), retry once using `SYM:EXCHANGE` comma list with no venue query params (doubles credits for that slice). Set `TWELVEDATA_BATCH_COLON_RETRY=1` to enable. */
const BATCH_COLON_RETRY =
  String(process.env.TWELVEDATA_BATCH_COLON_RETRY || "").toLowerCase() === "1" ||
  String(process.env.TWELVEDATA_BATCH_COLON_RETRY || "").toLowerCase() === "true";

/**
 * When a multi-symbol batch fails with TwelveDataApiError, fall back to one HTTP call per instrument
 * with this many ms between calls (keeps Basic “8/min” plans from tripping even if `skipBatchGap` is true).
 * Set `TWELVEDATA_SERIAL_ON_BATCH_ERROR=0` to disable and surface the batch error instead.
 */
const SERIAL_ON_BATCH_ERROR = (() => {
  const s = String(process.env.TWELVEDATA_SERIAL_ON_BATCH_ERROR ?? "1").toLowerCase();
  return s !== "0" && s !== "false";
})();

const SERIAL_GAP_MS = Math.max(
  7500,
  parseInt(process.env.TWELVEDATA_SERIAL_GAP_MS || "7500", 10)
);

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

/** Strip accidental `TICKER@MIC` / `TICKER@NYSE` stored in `providerSymbol`. */
function sanitizeTwelveDataSymbol(sym) {
  let s = String(sym || "").trim();
  const at = s.indexOf("@");
  if (at > 0) s = s.slice(0, at);
  s = s.replace(/\s+/g, "");
  return s;
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
  const usMic = US_EXCHANGE_NAME_TO_MIC.get(up);
  if (usMic) return { mic_code: usMic };
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
 * @param {unknown} data
 * @param {string[]} symbolsForKeys uppercased tickers used to fill the result map
 */
function parseTimeSeriesBatchResponse(data, symbolsForKeys) {
  if (!data || typeof data !== "object") return new Map();
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
      if (parsed) {
        const keyUp = String(rawKey).toUpperCase();
        const base = keyUp.includes(":") ? keyUp.split(":")[0] : keyUp;
        bySym.set(keyUp, parsed);
        if (base !== keyUp) bySym.set(base, parsed);
      }
    }
    if (bySym.size > 0) return bySym;
  }

  for (const sym of symbolsForKeys) {
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

  if (bySym.size === 0 && parseTimeSeriesPayload(data, now) && symbolsForKeys.length) {
    const one = parseTimeSeriesPayload(data, now);
    bySym.set(symbolsForKeys[0].toUpperCase(), one);
  }

  return bySym;
}

/**
 * Batch time_series: try several venue/symbol encodings (Twelve Data is picky about `mic_code` + multi-symbol).
 * @param {string[]} symbols upper or mixed case tickers
 * @param {{ exchange?: string, mic_code?: string }} venue
 * @param {{ exchangeRawForRetry?: string | null }} [options] Raw DB `exchange` for fallbacks
 */
async function fetchTwelveDataTimeSeriesBatch(symbols, venue, options = {}) {
  if (!process.env.TWELVEDATA_API_KEY) {
    throw new Error("TWELVEDATA_API_KEY is not set");
  }
  const cleaned = symbols.map(sanitizeTwelveDataSymbol).filter(Boolean);
  if (!cleaned.length) return new Map();

  const keysUpper = cleaned.map((s) => s.toUpperCase());
  const comma = cleaned.join(",");

  async function doFetch(symbolParam, v) {
    const url = new URL(`${TWELVEDATA_BASE_URL}/time_series`);
    url.searchParams.set("symbol", symbolParam);
    url.searchParams.set("interval", "1day");
    url.searchParams.set("outputsize", "1");
    url.searchParams.set("apikey", process.env.TWELVEDATA_API_KEY);
    if (v.exchange) url.searchParams.set("exchange", v.exchange);
    if (v.mic_code) url.searchParams.set("mic_code", v.mic_code);

    logTwelveDataRequestUrl(url);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Twelve Data batch failed ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    throwIfTwelveDataGlobalError(data);
    return parseTimeSeriesBatchResponse(data, keysUpper);
  }

  const rawEx = String(options.exchangeRawForRetry || "").trim();
  const rawUp = rawEx.toUpperCase();

  const seen = new Set();
  /** @type {{ symbolParam: string, v: { exchange?: string, mic_code?: string } }[]} */
  const attempts = [];

  function addAttempt(symbolParam, v) {
    const k = `${symbolParam}|${v.exchange || ""}|${v.mic_code || ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    attempts.push({ symbolParam, v });
  }

  addAttempt(comma, venue);

  if (rawEx && !PSEUDO_EXCHANGES.has(rawUp)) {
    const samePlainExchange =
      venue.exchange && venue.exchange.trim().toUpperCase() === rawUp && !venue.mic_code;
    if (!samePlainExchange) {
      addAttempt(comma, { exchange: rawEx });
    }
  }

  addAttempt(comma, {});

  if (BATCH_COLON_RETRY && rawEx && !PSEUDO_EXCHANGES.has(rawUp)) {
    addAttempt(
      cleaned.map((s) => `${s.toUpperCase()}:${rawUp}`).join(","),
      {}
    );
  }

  /** @type {TwelveDataApiError | null} */
  let lastTd = null;
  for (const att of attempts) {
    try {
      const m = await doFetch(att.symbolParam, att.v);
      if (m.size > 0) return m;
    } catch (e) {
      if (e instanceof TwelveDataApiError) {
        lastTd = e;
      } else {
        throw e;
      }
    }
  }
  if (lastTd) throw lastTd;
  return new Map();
}

async function fetchTwelveDataTimeSeriesSingle(symbol, venue) {
  if (!process.env.TWELVEDATA_API_KEY) {
    throw new Error("TWELVEDATA_API_KEY is not set");
  }

  symbol = sanitizeTwelveDataSymbol(symbol);

  const url = new URL(`${TWELVEDATA_BASE_URL}/time_series`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1day");
  url.searchParams.set("outputsize", "1");
  url.searchParams.set("apikey", process.env.TWELVEDATA_API_KEY);
  if (venue.exchange) url.searchParams.set("exchange", venue.exchange);
  if (venue.mic_code) url.searchParams.set("mic_code", venue.mic_code);

  logTwelveDataRequestUrl(url);

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
  const rawEx = String(instrument.exchange || "").trim();
  const rawUp = rawEx.toUpperCase();

  /** @type {{ exchange?: string, mic_code?: string }[]} */
  const tries = [primary];
  if (rawEx && !PSEUDO_EXCHANGES.has(rawUp) && primary.mic_code) {
    tries.push({ exchange: rawEx });
  }
  tries.push({});

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

/**
 * @param {{ id: string, providerSymbol: string, exchange?: string | null }[]} instruments
 * @param {{ skipBatchGap?: boolean }} [options] When true, omit `BATCH_GAP_MS` sleeps between Twelve Data
 *   HTTP calls (used by chunk refresh so `TWELVEDATA_SWEEP_INTERVAL_MS` is the only throttle between slices).
 */
async function fetchTwelveDataPrices(instruments, options = {}) {
  const skipBatchGap = Boolean(options.skipBatchGap);
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
        bySym = await fetchTwelveDataTimeSeriesBatch(symbols, venue, {
          exchangeRawForRetry: list[0].exchange,
        });
      } catch (e) {
        if (e instanceof TwelveDataApiError && SERIAL_ON_BATCH_ERROR) {
          for (let idx = 0; idx < chunk.length; idx++) {
            const inst = chunk[idx];
            try {
              const q = await fetchQuoteForInstrument(inst);
              if (q) {
                const su = sanitizeTwelveDataSymbol(inst.providerSymbol).toUpperCase();
                bySym.set(su, q);
              }
            } catch (e2) {
              if (e2 instanceof TwelveDataApiError) throw e2;
            }
            if (idx < chunk.length - 1 && SERIAL_GAP_MS > 0) {
              await sleep(SERIAL_GAP_MS);
            }
          }
        } else if (e instanceof TwelveDataApiError) {
          throw e;
        } else {
          bySym = new Map();
        }
      }

      for (const inst of chunk) {
        const su = sanitizeTwelveDataSymbol(inst.providerSymbol).toUpperCase();
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
          if (!skipBatchGap && BATCH_GAP_MS > 0) await sleep(BATCH_GAP_MS);
        }
      }

      if (!skipBatchGap && BATCH_GAP_MS > 0) await sleep(BATCH_GAP_MS);
    }
  }

  return result;
}

function instrumentDisplayLabel(i) {
  const ex = String(i.exchange || "").trim();
  const sym = sanitizeTwelveDataSymbol(i.providerSymbol);
  return ex ? `${sym}@${ex}` : sym;
}

async function loadTwelveDataInstrumentsOrdered() {
  return prisma.instrument.findMany({
    where: {
      provider: "TWELVEDATA",
      isActive: true,
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      providerSymbol: true,
      exchange: true,
      currency: true,
    },
  });
}

/**
 * Legacy: fetch all instruments in one run (many API credits; OK on higher tiers).
 */
async function refreshDailyQuotesForTwelveDataAll() {
  const instruments = await loadTwelveDataInstrumentsOrdered();

  let pricesByInstrumentId;
  try {
    pricesByInstrumentId = await fetchTwelveDataPrices(instruments);
  } catch (e) {
    if (e instanceof TwelveDataApiError) {
      const missingSymbols = instruments.map(instrumentDisplayLabel);
      return {
        mode: "all",
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
        missingSymbols.push(instrumentDisplayLabel(instrument));
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
    mode: "all",
    instrumentsCount: instruments.length,
    quotesCreated: createdCount,
    missingSymbols,
  };
}

/**
 * Rate-friendly: one HTTP “tick” worth of instruments per call; advance a DB cursor.
 * Schedule the route ~once per minute (e.g. cron); full cycle ≈ ceil(n / CREDITS_PER_TICK) minutes.
 */
async function refreshDailyQuotesForTwelveDataChunked(options = {}) {
  const resetCycle = Boolean(options.resetCycle);
  const instruments = await loadTwelveDataInstrumentsOrdered();
  const total = instruments.length;

  if (total === 0) {
    return {
      mode: "chunk",
      provider: "TWELVEDATA",
      instrumentsCount: 0,
      chunkSize: CREDITS_PER_TICK,
      offsetStart: 0,
      nextOffset: 0,
      processedThisTick: 0,
      quotesCreated: 0,
      missingSymbols: [],
      cycleJustCompleted: true,
      ticksPerFullCycle: 0,
      estimatedTicksRemainingInCycle: 0,
      recommendedIntervalMs: 60_000,
    };
  }

  let state = await prisma.twelveDataQuoteRefreshState.findUnique({
    where: { id: TWELVEDATA_STATE_ID },
  });

  if (!state) {
    state = await prisma.twelveDataQuoteRefreshState.create({
      data: {
        id: TWELVEDATA_STATE_ID,
        nextOffset: 0,
        totalSnapshot: total,
      },
    });
  }

  let offset = state.nextOffset;
  if (resetCycle) {
    offset = 0;
  } else if (state.totalSnapshot !== total) {
    offset = 0;
  }

  if (offset >= total) {
    offset = 0;
  }

  const slice = instruments.slice(offset, offset + CREDITS_PER_TICK);
  const offsetStart = offset;

  let pricesByInstrumentId;
  try {
    pricesByInstrumentId = await fetchTwelveDataPrices(slice, { skipBatchGap: true });
  } catch (e) {
    if (e instanceof TwelveDataApiError) {
      return {
        mode: "chunk",
        provider: "TWELVEDATA",
        instrumentsCount: total,
        chunkSize: CREDITS_PER_TICK,
        offsetStart,
        nextOffset: offset,
        processedThisTick: slice.length,
        quotesCreated: 0,
        missingSymbols: slice.map(instrumentDisplayLabel),
        twelveDataError: {
          code: e.code,
          message: e.message,
        },
        cycleJustCompleted: false,
        ticksPerFullCycle: Math.ceil(total / CREDITS_PER_TICK),
        estimatedTicksRemainingInCycle: Math.ceil((total - offset) / CREDITS_PER_TICK),
        recommendedIntervalMs: 60_000,
        note:
          "Cursor not advanced after Twelve Data error; retry after the window resets or raise limits.",
      };
    }
    throw e;
  }

  let createdCount = 0;
  const missingSymbols = [];
  let nextOffset = offset + slice.length;
  const cycleJustCompleted = nextOffset >= total;
  if (cycleJustCompleted) {
    nextOffset = 0;
  }

  await prisma.$transaction(async (tx) => {
    for (const instrument of slice) {
      const quote = pricesByInstrumentId[instrument.id];
      if (!quote) {
        missingSymbols.push(instrumentDisplayLabel(instrument));
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

    await tx.twelveDataQuoteRefreshState.update({
      where: { id: TWELVEDATA_STATE_ID },
      data: {
        nextOffset,
        totalSnapshot: total,
      },
    });
  });

  const remainingAfterThisTick = Math.max(0, total - (offset + slice.length));

  return {
    mode: "chunk",
    provider: "TWELVEDATA",
    instrumentsCount: total,
    chunkSize: CREDITS_PER_TICK,
    offsetStart,
    nextOffset,
    processedThisTick: slice.length,
    quotesCreated: createdCount,
    missingSymbols,
    cycleJustCompleted,
    ticksPerFullCycle: Math.ceil(total / CREDITS_PER_TICK),
    estimatedTicksRemainingInCycle: Math.ceil(remainingAfterThisTick / CREDITS_PER_TICK),
    recommendedIntervalMs: 60_000,
  };
}

/**
 * @param {{ resetCycle?: boolean }} [options]
 */
async function refreshDailyQuotesForTwelveData(options = {}) {
  if (REFRESH_MODE === "all") {
    return refreshDailyQuotesForTwelveDataAll();
  }
  return refreshDailyQuotesForTwelveDataChunked(options);
}

module.exports = {
  TwelveDataApiError,
  fetchTwelveDataPrices,
  refreshDailyQuotesForTwelveData,
  refreshDailyQuotesForTwelveDataChunked,
  /** @type {number} max instruments per chunk tick (for sweep planner UIs) */
  getTwelveDataCreditsPerTick: () => CREDITS_PER_TICK,
};
