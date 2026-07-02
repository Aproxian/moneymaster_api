"use strict";

const DEFAULT_QUOTE_CACHE_KEEP_PER_INSTRUMENT = 1;

function parseKeepMostRecentCount(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_QUOTE_CACHE_KEEP_PER_INSTRUMENT;
  }

  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 1) {
    const err = new Error("keepMostRecentCount must be a positive integer");
    err.statusCode = 400;
    throw err;
  }

  return value;
}

async function trimQuoteCache(prisma, keepMostRecentCount) {
  const rowsBefore = await prisma.quoteCache.count();

  if (rowsBefore <= keepMostRecentCount) {
    return {
      ok: true,
      keepMostRecentCount,
      rowsBefore,
      rowsDeleted: 0,
      rowsAfter: rowsBefore,
    };
  }

  await prisma.$executeRaw`
    DELETE q FROM QuoteCache q
    JOIN (
      SELECT id FROM (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY instrumentId, provider
            ORDER BY createdAt DESC, asOf DESC, id DESC
          ) AS rn
        FROM QuoteCache
      ) ranked
      WHERE ranked.rn > ${keepMostRecentCount}
    ) d ON q.id = d.id
  `;

  const rowsAfter = await prisma.quoteCache.count();

  return {
    ok: true,
    keepMostRecentCount,
    rowsBefore,
    rowsDeleted: rowsBefore - rowsAfter,
    rowsAfter,
  };
}

module.exports = {
  DEFAULT_QUOTE_CACHE_KEEP_PER_INSTRUMENT,
  parseKeepMostRecentCount,
  trimQuoteCache,
};
