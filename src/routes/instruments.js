const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const {
  postSingleInstrument,
  postBulkInstruments,
} = require("../services/instrumentAdminImport");

const instrumentsRouter = Router();

instrumentsRouter.use(requireAuth);

instrumentsRouter.post("/bulk", postBulkInstruments);
instrumentsRouter.post("/create", postSingleInstrument);

const listSchema = z.object({
  query: z.preprocess(
    (v) => (Array.isArray(v) ? v[0] : v),
    z.union([z.string(), z.undefined()]).optional()
  ),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

instrumentsRouter.get("/", async (req, res, next) => {
  try {
    const parsed = listSchema.parse(req.query);
    const take = parsed.limit || 20;
    const q = String(parsed.query ?? "")
      .trim()
      .slice(0, 120);

    let instruments;

    if (q.length > 0) {
      // Prisma `mode: insensitive` + contains is unreliable on some MySQL/MariaDB setups (returns 0 rows
      // even when plain `findMany` without a text filter lists the same symbols). Use explicit LOWER + LIKE.
      const pattern = `%${q}%`;
      instruments = await prisma.$queryRaw`
        SELECT
          id,
          provider,
          providerSymbol,
          name,
          type,
          currency,
          exchange,
          country
        FROM Instrument
        WHERE isActive = 1
          AND (
            LOWER(providerSymbol) LIKE LOWER(${pattern})
            OR LOWER(name) LIKE LOWER(${pattern})
          )
        ORDER BY providerSymbol ASC
        LIMIT ${take}
      `;
    } else {
      instruments = await prisma.instrument.findMany({
        where: { isActive: true },
        select: {
          id: true,
          provider: true,
          providerSymbol: true,
          name: true,
          type: true,
          currency: true,
          exchange: true,
          country: true,
        },
        orderBy: { providerSymbol: "asc" },
        take,
      });
    }

    return res.json({ instruments });
  } catch (err) {
    next(err);
  }
});

module.exports = { instrumentsRouter };

