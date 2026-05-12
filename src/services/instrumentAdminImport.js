const { z } = require("zod");
const { prisma } = require("../prisma");
const { isAdminUserEmail } = require("../lib/adminUser");

async function assertAdmin(req, res) {
  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) {
    res.status(503).json({ error: "ADMIN_EMAIL is not configured on the server" });
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { id: true, email: true },
  });

  if (!user || !isAdminUserEmail(user.email)) {
    res.status(403).json({ error: "Not allowed to perform this operation" });
    return null;
  }

  return user;
}

const createInstrumentSchema = z.object({
  provider: z.enum(["TWELVEDATA", "FINNHUB", "POLYGON", "ALPHAVANTAGE", "OTHER"]),
  providerSymbol: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  type: z.enum([
    "STOCK",
    "ETF",
    "INDEX",
    "CRYPTO",
    "FOREX",
    "FUTURE",
    "COMMODITY",
    "BOND",
    "FUND",
    "OTHER",
  ]),
  currency: z.string().max(10).optional(),
  exchange: z.string().max(50),
  country: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
});

function trimOrUndef(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function normalizeInstrumentBody(raw) {
  if (!raw || typeof raw !== "object") return {};
  let isActive = true;
  if (raw.isActive === false || raw.isActive === 0 || raw.isActive === "0" || raw.isActive === "false")
    isActive = false;
  if (raw.isActive === true || raw.isActive === 1 || raw.isActive === "1" || raw.isActive === "true")
    isActive = true;
  return {
    provider: raw.provider,
    providerSymbol: String(raw.providerSymbol ?? "").trim(),
    name: String(raw.name ?? "").trim(),
    type: raw.type,
    currency: trimOrUndef(raw.currency),
    exchange: (() => {
      const u = trimOrUndef(raw.exchange);
      return u === undefined ? "" : u;
    })(),
    country: trimOrUndef(raw.country),
    isActive,
  };
}

const bulkImportSchema = z.object({
  dryRun: z.boolean(),
  instruments: z.array(z.unknown()).min(1).max(5000),
});

async function findDbDuplicates(providerSymbolPairs) {
  const hits = [];
  const chunk = 60;
  for (let i = 0; i < providerSymbolPairs.length; i += chunk) {
    const slice = providerSymbolPairs.slice(i, i + chunk);
    const found = await prisma.instrument.findMany({
      where: {
        OR: slice.map((r) => ({
          provider: r.provider,
          providerSymbol: r.providerSymbol,
          exchange: r.exchange,
        })),
      },
      select: { provider: true, providerSymbol: true, exchange: true },
    });
    hits.push(...found);
  }
  return hits;
}

async function postSingleInstrument(req, res, next) {
  try {
    const user = await assertAdmin(req, res);
    if (!user) return;

    const body = createInstrumentSchema.parse(normalizeInstrumentBody(req.body));

    const existing = await prisma.instrument.findFirst({
      where: {
        provider: body.provider,
        providerSymbol: body.providerSymbol,
        exchange: body.exchange,
      },
      select: { id: true },
    });

    if (existing) {
      return res.status(409).json({
        error: "Instrument with this provider + symbol + exchange already exists",
      });
    }

    const instrument = await prisma.instrument.create({
      data: {
        provider: body.provider,
        providerSymbol: body.providerSymbol,
        name: body.name,
        type: body.type,
        currency: body.currency ?? null,
        exchange: body.exchange,
        country: body.country ?? null,
        isActive: body.isActive !== false,
      },
      select: {
        id: true,
        provider: true,
        providerSymbol: true,
        name: true,
        type: true,
        currency: true,
        exchange: true,
        country: true,
        isActive: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "CREATE",
        entity: "Instrument",
        entityId: instrument.id,
        meta: {
          provider: instrument.provider,
          providerSymbol: instrument.providerSymbol,
          name: instrument.name,
        },
      },
    });

    return res.status(201).json({ instrument });
  } catch (err) {
    next(err);
  }
}

async function postBulkInstruments(req, res, next) {
  try {
    const admin = await assertAdmin(req, res);
    if (!admin) return;

    const parsedTop = bulkImportSchema.safeParse(req.body);
    if (!parsedTop.success) {
      return res.status(400).json({
        error: "Invalid bulk import payload",
        details: parsedTop.error.flatten(),
      });
    }

    const { dryRun, instruments: rawList } = parsedTop.data;
    const logs = [];
    const errors = [];

    logs.push(
      `[bulk] Starting ${dryRun ? "DRY RUN" : "IMPORT"} for ${rawList.length} raw record(s).`
    );

    const normalized = [];
    for (let i = 0; i < rawList.length; i++) {
      const rowNum = i + 1;
      const norm = normalizeInstrumentBody(
        typeof rawList[i] === "object" && rawList[i] !== null ? rawList[i] : {}
      );
      const rowParsed = createInstrumentSchema.safeParse(norm);
      if (!rowParsed.success) {
        const msg = rowParsed.error.issues
          .map((e) => `${e.path.length ? e.path.join(".") : "root"}: ${e.message}`)
          .join("; ");
        errors.push({ row: rowNum, message: msg });
        logs.push(`[bulk] Row ${rowNum}: SCHEMA ERROR — ${msg}`);
      } else {
        normalized.push(rowParsed.data);
      }
    }

    if (errors.length) {
      logs.push(`[bulk] Aborted: ${errors.length} row(s) failed schema validation.`);
      return res.status(400).json({
        ok: false,
        dryRun,
        imported: 0,
        errors,
        logs,
      });
    }

    const seenKey = new Map();
    for (let i = 0; i < normalized.length; i++) {
      const r = normalized[i];
      const key = `${r.provider}\t${r.providerSymbol}\t${r.exchange}`;
      if (seenKey.has(key)) {
        const first = seenKey.get(key);
        const msg = `Duplicate provider+symbol+exchange in file (same as row ${first})`;
        errors.push({ row: i + 1, message: msg });
        logs.push(`[bulk] Row ${i + 1}: ${msg}`);
      } else {
        seenKey.set(key, i + 1);
      }
    }

    if (errors.length) {
      logs.push(`[bulk] Aborted: duplicate keys inside upload.`);
      return res.status(400).json({
        ok: false,
        dryRun,
        imported: 0,
        errors,
        logs,
      });
    }

    const dbDupes = await findDbDuplicates(normalized);
    if (dbDupes.length) {
      for (const d of dbDupes) {
        const idx = normalized.findIndex(
          (r) =>
            r.provider === d.provider &&
            r.providerSymbol === d.providerSymbol &&
            r.exchange === d.exchange
        );
        const rowNum = idx >= 0 ? idx + 1 : "?";
        const venue = d.exchange ? ` / ${d.exchange}` : "";
        const msg = `Already exists in database (${d.provider} / ${d.providerSymbol}${venue})`;
        errors.push({ row: rowNum, message: msg });
        logs.push(`[bulk] Row ${rowNum}: CONFLICT — ${msg}`);
      }
      logs.push(`[bulk] Aborted: ${dbDupes.length} conflict(s) with existing instruments.`);
      return res.status(409).json({
        ok: false,
        dryRun,
        imported: 0,
        errors,
        logs,
      });
    }

    for (let i = 0; i < normalized.length; i++) {
      const r = normalized[i];
      logs.push(
        `[bulk] Row ${i + 1}/${normalized.length}: ${r.provider} ${r.providerSymbol} (${r.name}) — OK${
          dryRun ? " (would create)" : ""
        }`
      );
    }

    if (dryRun) {
      logs.push(
        `[bulk] DRY RUN complete — all ${normalized.length} record(s) valid; no database writes.`
      );
      return res.json({
        ok: true,
        dryRun: true,
        imported: 0,
        wouldImport: normalized.length,
        errors: [],
        logs,
      });
    }

    const created = await prisma.$transaction(async (tx) => {
      const out = [];
      for (const body of normalized) {
        const instrument = await tx.instrument.create({
          data: {
            provider: body.provider,
            providerSymbol: body.providerSymbol,
            name: body.name,
            type: body.type,
            currency: body.currency ?? null,
            exchange: body.exchange,
            country: body.country ?? null,
            isActive: body.isActive !== false,
          },
          select: {
            id: true,
            provider: true,
            providerSymbol: true,
            name: true,
            type: true,
            isActive: true,
          },
        });
        out.push(instrument);
      }
      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "CREATE",
          entity: "InstrumentBulk",
          entityId: null,
          meta: {
            count: out.length,
            idsSample: out.slice(0, 5).map((x) => x.id),
          },
        },
      });
      return out;
    });

    logs.push(`[bulk] IMPORT complete — created ${created.length} instrument(s).`);

    return res.status(201).json({
      ok: true,
      dryRun: false,
      imported: created.length,
      instruments: created,
      errors: [],
      logs,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  postSingleInstrument,
  postBulkInstruments,
};
