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

function isTwelveDataRateLimitError(e) {
  return e instanceof TwelveDataApiError && (e.code === 429 || e.code === "429");
}

/** Twelve Data returns HTTP 200 with e.g. code 404 and a plan upsell message for `/quote` and `time_series`. */
function isTwelveDataPlanTierRestriction(code, message) {
  const c = code === 404 || code === "404" || Number(code) === 404;
  if (!c) return false;
  const m = String(message || "").toLowerCase();
  return m.includes("pro or venture") || m.includes("venture plan");
}

function autoDeactivatePlanRestrictedSymbolsEnabled() {
  return !String(process.env.TWELVEDATA_AUTO_DEACTIVATE_PLAN_SYMBOLS ?? "1").match(/^(0|false|off)$/i);
}

/**
 * @param {Set<string> | string[]} tickerUppers sanitized upper tickers (e.g. TTM)
 */
async function deactivateTwelveDataInstrumentsByTickerUppers(tickerUppers) {
  if (!autoDeactivatePlanRestrictedSymbolsEnabled()) return;
  const want = new Set(
    [...tickerUppers].map((t) => String(t).toUpperCase()).filter(Boolean)
  );
  if (want.size === 0) return;
  try {
    const rows = await prisma.instrument.findMany({
      where: { provider: "TWELVEDATA", isActive: true },
      select: { id: true, providerSymbol: true },
    });
    const idsByTicker = new Map();
    for (const row of rows) {
      const ticker = sanitizeTwelveDataSymbol(row.providerSymbol).toUpperCase();
      if (!want.has(ticker)) continue;
      if (!idsByTicker.has(ticker)) idsByTicker.set(ticker, []);
      idsByTicker.get(ticker).push(row.id);
    }
    const ids = [];
    const skippedAmbiguousTickers = [];
    for (const [ticker, tickerIds] of idsByTicker) {
      if (tickerIds.length === 1) {
        ids.push(tickerIds[0]);
      } else {
        skippedAmbiguousTickers.push(ticker);
      }
    }
    if (skippedAmbiguousTickers.length > 0) {
      logApp("WARN", "TwelveData", "auto_deactivate_skipped_ambiguous_tickers", {
        tickers: skippedAmbiguousTickers,
      });
    }
    if (ids.length === 0) return;
    const res = await prisma.instrument.updateMany({
      where: { id: { in: ids } },
      data: { isActive: false },
    });
    logApp("WARN", "TwelveData", "auto_deactivated_plan_restricted_symbols", {
      tickers: [...want],
      rowsUpdated: res.count,
    });
  } catch (e) {
    logApp(
      "ERROR",
      "TwelveData",
      "auto_deactivate_plan_restricted_failed",
      e instanceof Error ? e.message : String(e)
    );
  }
}

async function deactivateTwelveDataInstrumentById(instrumentId) {
  if (!autoDeactivatePlanRestrictedSymbolsEnabled() || !instrumentId) return;
  try {
    const res = await prisma.instrument.updateMany({
      where: { id: instrumentId, provider: "TWELVEDATA", isActive: true },
      data: { isActive: false },
    });
    if (res.count > 0) {
      logApp("WARN", "TwelveData", "auto_deactivated_plan_restricted_instrument", {
        instrumentId,
      });
    }
  } catch (e) {
    logApp(
      "ERROR",
      "TwelveData",
      "auto_deactivate_plan_restricted_failed",
      e instanceof Error ? e.message : String(e)
    );
  }
}

/**
 * Per-symbol plan errors inside a multi-symbol `time_series` body (global `status` may still be ok).
 * @param {unknown} data
 * @returns {Set<string>} upper tickers to deactivate
 */
function extractPlanRestrictedTickerUppersFromTimeSeriesPayload(data) {
  const out = new Set();
  if (!data || typeof data !== "object") return out;

  const consider = (entry, keyHint) => {
    if (!entry || typeof entry !== "object") return;
    if (entry.status !== "error") return;
    if (!isTwelveDataPlanTierRestriction(entry.code, entry.message)) return;
    const raw = String(keyHint || entry.symbol || "").trim();
    if (!raw) return;
    const up = raw.toUpperCase();
    const base = up.includes(":") ? up.split(":")[0] : up;
    const cleaned = sanitizeTwelveDataSymbol(base).toUpperCase();
    if (cleaned) out.add(cleaned);
  };

  if (Array.isArray(data.data)) {
    for (const entry of data.data) {
      consider(entry, entry?.symbol);
    }
  } else if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
    for (const [rawKey, entry] of Object.entries(data.data)) {
      consider(entry, rawKey);
    }
  }

  return out;
}

async function handleTwelveDataJsonBeforeThrow(data, keysUpperSingleSymbolBatch) {
  const tierSyms = extractPlanRestrictedTickerUppersFromTimeSeriesPayload(data);
  if (tierSyms.size > 0) {
    await deactivateTwelveDataInstrumentsByTickerUppers(tierSyms);
  }
  if (
    data?.status === "error" &&
    !isMultiSymbolTimeSeriesShape(data) &&
    isTwelveDataPlanTierRestriction(data.code, data.message) &&
    keysUpperSingleSymbolBatch.length === 1
  ) {
    await deactivateTwelveDataInstrumentsByTickerUppers(new Set(keysUpperSingleSymbolBatch));
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
 * Non-US exchanges that look like ISO MICs (start with X + 3 uppercase chars) but must be
 * sent as `exchange=` rather than `mic_code=` to Twelve Data.  The Twelve Data API only
 * accepts `mic_code` for US venues (XNAS, XNYS, XASE, ARCX …); for international venues it
 * ignores or misroutes `mic_code` and requires the plain `exchange` param.
 */
const INTL_MIC_STYLE_AS_EXCHANGE = new Set([
  "XLON", // London Stock Exchange
  "XETR", // Xetra (Frankfurt)
  "XPAR", // Euronext Paris
  "XAMS", // Euronext Amsterdam
  "XBRU", // Euronext Brussels
  "XMIL", // Borsa Italiana
  "XMAD", // Bolsa de Madrid
  "XTSE", // Toronto Stock Exchange
  "XASX", // Australian Securities Exchange
  "XHKG", // Hong Kong Stock Exchange
  "XTKS", // Tokyo Stock Exchange
  "XSHG", // Shanghai Stock Exchange
  "XSHE", // Shenzhen Stock Exchange
  "XBOM", // Bombay Stock Exchange
  "XNSE", // National Stock Exchange of India
]);

/**
 * @param {string} exchangeRaw
 * @returns {{ exchange?: string, mic_code?: string }}
 */
function venueQueryParams(exchangeRaw) {
  const ex = String(exchangeRaw || "").trim();
  if (!ex) return {};
  const up = ex.toUpperCase();
  if (PSEUDO_EXCHANGES.has(up)) return {};
  // Known US exchanges: convert friendly name → ISO MIC that Twelve Data accepts.
  const usMic = US_EXCHANGE_NAME_TO_MIC.get(up);
  if (usMic) return { mic_code: usMic };
  // International exchanges that are formatted like ISO MICs (XLON, XETR, …) but must be
  // passed as `exchange=` to Twelve Data (mic_code is silently ignored for non-US venues).
  if (INTL_MIC_STYLE_AS_EXCHANGE.has(up)) return { exchange: ex };
  // Other 4-char X-prefixed tokens that are not in the override set: treat as mic_code.
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

function canUseUnifiedSymbolOnlyQuote(instrument) {
  const venue = venueQueryParams(instrument.exchange);
  return !venue.exchange && !venue.mic_code;
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

function batchCoversAllSymbols(bySym, keysUpper) {
  for (const k of keysUpper) {
    if (!bySym.has(k)) return false;
  }
  return true;
}

/**
 * Batch time_series: try several venue/symbol encodings (Twelve Data is picky about `mic_code` + multi-symbol).
 * @param {string[]} symbols upper or mixed case tickers
 * @param {{ exchange?: string, mic_code?: string }} venue
 * @param {{ exchangeRawForRetry?: string | null, maxVenueAttempts?: number }} [options] Raw DB `exchange` for fallbacks.
 *   `maxVenueAttempts` caps venue/symbol-encoding retries (each attempt can cost a full batch of credits).
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
    await handleTwelveDataJsonBeforeThrow(data, keysUpper);
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

  const maxAtt =
    typeof options.maxVenueAttempts === "number" && options.maxVenueAttempts > 0
      ? options.maxVenueAttempts
      : attempts.length;
  const attemptsToRun = attempts.slice(0, Math.min(maxAtt, attempts.length));

  /** @type {TwelveDataApiError | null} */
  let lastTd = null;
  /** Merged quotes from all attempts (later attempts can fill gaps left by earlier partial parses). */
  const merged = new Map();
  for (const att of attemptsToRun) {
    try {
      const m = await doFetch(att.symbolParam, att.v);
      for (const [k, v] of m) {
        merged.set(k, v);
      }
      if (batchCoversAllSymbols(merged, keysUpper)) return merged;
    } catch (e) {
      if (e instanceof TwelveDataApiError) {
        if (isTwelveDataRateLimitError(e)) throw e;
        lastTd = e;
      } else {
        throw e;
      }
    }
  }
  if (lastTd && merged.size === 0) throw lastTd;
  return merged;
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
  await handleTwelveDataJsonBeforeThrow(data, [sanitizeTwelveDataSymbol(symbol).toUpperCase()]);
  throwIfTwelveDataGlobalError(data);
  const now = new Date();
  return parseTimeSeriesPayload(data, now);
}

/**
 * Try venue-specific params, then symbol-only (fixes wrong MIC vs exchange and pseudo-venues).
 * @param {{ maxVenueTries?: number }} [opts] When set (e.g. 1), only the first distinct venue is tried (saves credits after a unified batch already ran).
 */
async function fetchQuoteForInstrument(instrument, opts = {}) {
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
  /** @type {{ exchange?: string, mic_code?: string }[]} */
  const venueList = [];
  for (const venue of tries) {
    const key = JSON.stringify(venue);
    if (seen.has(key)) continue;
    seen.add(key);
    venueList.push(venue);
  }

  const maxV =
    typeof opts.maxVenueTries === "number" && opts.maxVenueTries > 0
      ? Math.min(opts.maxVenueTries, venueList.length)
      : venueList.length;

  for (let vi = 0; vi < maxV; vi++) {
    const venue = venueList[vi];
    try {
      const q = await fetchTwelveDataTimeSeriesSingle(sym, venue);
      if (q) return q;
    } catch (e) {
      if (e instanceof TwelveDataApiError) {
        if (isTwelveDataPlanTierRestriction(e.code, e.message)) {
          await deactivateTwelveDataInstrumentById(instrument.id);
        }
        throw e;
      }
    }
  }
  return null;
}

/**
 * @param {{ id: string, providerSymbol: string, exchange?: string | null }[]} instruments
 * @param {{ skipBatchGap?: boolean, tryUnifiedSymbolOnlyFirst?: boolean }} [options]
 *   `skipBatchGap`: omit `BATCH_GAP_MS` sleeps (sweep uses tick interval instead).
 *   `tryUnifiedSymbolOnlyFirst`: for small batches (≤ `TWELVEDATA_QUOTE_BATCH_SIZE`), call Twelve Data once with
 *   all tickers and **no** `exchange` / `mic_code` before splitting by venue. That avoids 7+7 credits when the
 *   first MIC batch is empty but a plain multi-symbol request would succeed (typical Basic-plan blow-up).
 */
async function fetchTwelveDataPrices(instruments, options = {}) {
  const skipBatchGap = Boolean(options.skipBatchGap);
  const tryUnifiedSymbolOnlyFirst = Boolean(options.tryUnifiedSymbolOnlyFirst);
  if (!instruments.length) {
    return {};
  }

  const result = {};

  /**
   * When true (passed from background sweep via skipBatchGap), we do exactly one HTTP call
   * per tick — the unified no-venue batch. Any symbols not resolved by that call are left
   * unresolved for this tick and will be retried next sweep cycle.  This guarantees the tick
   * never burns more than CREDITS_PER_TICK credits regardless of venue-grouping complexity.
   */
  const strictOneCallPerTick = Boolean(options.strictOneCallPerTick);

  let toFetch = instruments;
  if (
    tryUnifiedSymbolOnlyFirst &&
    toFetch.length > 0 &&
    toFetch.length <= BATCH_SIZE
  ) {
    const symbols = toFetch.map((x) => x.providerSymbol);
    try {
      const bySym = await fetchTwelveDataTimeSeriesBatch(symbols, {}, {});
      for (const inst of toFetch) {
        if (!canUseUnifiedSymbolOnlyQuote(inst)) continue;
        const su = sanitizeTwelveDataSymbol(inst.providerSymbol).toUpperCase();
        const hit = bySym.get(su) || bySym.get(inst.providerSymbol);
        if (hit) result[inst.id] = hit;
      }
    } catch (e) {
      if (e instanceof TwelveDataApiError && isTwelveDataRateLimitError(e)) {
        throw e;
      }
    }
    toFetch = instruments.filter((i) => !result[i.id]);
    if (!toFetch.length || strictOneCallPerTick) {
      // strictOneCallPerTick: return after the single unified call regardless of gaps;
      // venue retries are deferred to the next sweep cycle to keep credits predictable.
      return result;
    }
  }

  const groups = new Map();
  for (const inst of toFetch) {
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
          // Cap to 1 venue attempt for single-symbol chunks (avoids a second call for the
          // same symbol after SINGLE_FALLBACK) AND when strictOneCallPerTick is set (sweep
          // mode) so that no multi-symbol venue group ever retries with a different encoding.
          ...(chunk.length === 1 || strictOneCallPerTick ? { maxVenueAttempts: 1 } : {}),
        });
      } catch (e) {
        if (e instanceof TwelveDataApiError && isTwelveDataRateLimitError(e)) {
          throw e;
        }
        if (e instanceof TwelveDataApiError && SERIAL_ON_BATCH_ERROR) {
          for (let idx = 0; idx < chunk.length; idx++) {
            const inst = chunk[idx];
            try {
              const q = await fetchQuoteForInstrument(inst, {
                maxVenueTries: tryUnifiedSymbolOnlyFirst ? 1 : undefined,
              });
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
            const q = await fetchQuoteForInstrument(inst, {
              maxVenueTries: tryUnifiedSymbolOnlyFirst ? 1 : undefined,
            });
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
  /** When true (background sweep), omit `BATCH_GAP_MS` inside fetch; same quote resolution as manual chunk. */
  const skipBatchGap = Boolean(options.skipBatchGap);
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
    pricesByInstrumentId = await fetchTwelveDataPrices(slice, {
      skipBatchGap,
      // In sweep mode (skipBatchGap=true) we do exactly one HTTP call per tick so that
      // credit usage equals CREDITS_PER_TICK regardless of how many venue groups the
      // slice spans.  Any symbols not resolved by the unified call are left for the next
      // sweep cycle.  In non-sweep (manual chunk) mode the usual venue fallback chain runs.
      tryUnifiedSymbolOnlyFirst: true,
      strictOneCallPerTick: skipBatchGap,
    });
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
 * @param {{ resetCycle?: boolean, skipBatchGap?: boolean }} [options]
 *   `skipBatchGap` is true for background sweep only: omits `BATCH_GAP_MS` sleeps between internal Twelve Data calls
 *   (sweep interval still spaces ticks). Quote resolution is the same as manual chunk refresh.
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
