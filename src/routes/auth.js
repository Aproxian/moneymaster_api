const { Router } = require("express");
const { z } = require("zod");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const { prisma } = require("../prisma");
const { config } = require("../config");
const { seedDefaultCategories } = require("../services/seedDefaultCategories");
const { isAdminUserEmail } = require("../lib/adminUser");

const authRouter = Router();

/**
 * Helpers
 */
function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function signAccessToken(userId) {
  return jwt.sign({ userId }, config.jwtAccessSecret, { expiresIn: config.accessTtlSeconds });
}

function makeRefreshToken() {
  // random opaque token (stored client-side), hashed in DB
  return crypto.randomBytes(48).toString("base64url");
}

function refreshExpiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + config.refreshTtlDays);
  return d;
}

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(80).optional(),
  currency: z.string().min(1).max(10).optional(),
  investingEnabled: z.boolean().optional(),
});

authRouter.post("/register", async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const accountCurrency = (body.currency ?? "EUR").toUpperCase();
    const investingEnabled = body.investingEnabled ?? true;

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) return res.status(409).json({ error: "Email already in use" });

    const passwordHash = await bcrypt.hash(body.password, 12);

    // Create user + personal account + membership + default categories atomically
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: body.email,
          passwordHash,
          displayName: body.displayName ?? null,
        },
        select: { id: true, email: true, displayName: true },
      });

      const account = await tx.account.create({
        data: {
          name: "Personal",
          currency: accountCurrency,
          investingEnabled,
          members: {
            create: {
              userId: user.id,
              role: "OWNER",
            },
          },
        },
        select: { id: true, currency: true },
      });

      await tx.user.update({
        where: { id: user.id },
        data: { personalAccountId: account.id },
      });

      await seedDefaultCategories(tx, account.id, { investingEnabled });

      // Create session
      const refreshToken = makeRefreshToken();
      const refreshTokenHash = sha256(refreshToken);

      await tx.session.create({
        data: {
          userId: user.id,
          refreshTokenHash,
          userAgent: req.get("user-agent") ?? null,
          ip: req.ip ?? null,
          expiresAt: refreshExpiryDate(),
        },
      });

      // Optional audit
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "CREATE",
          entity: "User",
          entityId: user.id,
          meta: { email: user.email },
        },
      });

      return { user, accountId: account.id, refreshToken };
    });

    const accessToken = signAccessToken(result.user.id);

    return res.status(201).json({
      user: {
        ...result.user,
        personalAccountId: result.accountId,
        isAdmin: isAdminUserEmail(result.user.email),
      },
      accessToken,
      refreshToken: result.refreshToken,
      personalAccountId: result.accountId,
    });
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      select: {
        id: true,
        email: true,
        displayName: true,
        passwordHash: true,
        personalAccountId: true,
        deletedAt: true,
      },
    });

    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    if (user.deletedAt) {
      return res.status(401).json({ error: "This account has been closed" });
    }

    const ok = await bcrypt.compare(body.password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const refreshToken = makeRefreshToken();
    await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: sha256(refreshToken),
        userAgent: req.get("user-agent") ?? null,
        ip: req.ip ?? null,
        expiresAt: refreshExpiryDate(),
      },
    });

    const accessToken = signAccessToken(user.id);

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "LOGIN",
        entity: "User",
        entityId: user.id,
      },
    });

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        personalAccountId: user.personalAccountId,
        isAdmin: isAdminUserEmail(user.email),
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const body = refreshSchema.parse(req.body);

    const tokenHash = sha256(body.refreshToken);

    const session = await prisma.session.findFirst({
      where: {
        refreshTokenHash: tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, userId: true },
    });

    if (!session) return res.status(401).json({ error: "Invalid refresh token" });

    const userRow = await prisma.user.findFirst({
      where: { id: session.userId, deletedAt: null },
      select: { id: true },
    });
    if (!userRow) {
      return res.status(401).json({ error: "Account has been deleted or is unavailable" });
    }

    // Rotation: revoke old session, create new session, return new refresh + access
    const { accessToken, newRefreshToken } = await prisma.$transaction(async (tx) => {
      await tx.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });

      const newRefreshToken = makeRefreshToken();
      await tx.session.create({
        data: {
          userId: session.userId,
          refreshTokenHash: sha256(newRefreshToken),
          userAgent: req.get("user-agent") ?? null,
          ip: req.ip ?? null,
          expiresAt: refreshExpiryDate(),
        },
      });

      return {
        accessToken: signAccessToken(session.userId),
        newRefreshToken,
      };
    });

    return res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    next(err);
  }
});

const logoutSchema = z.object({
  refreshToken: z.string().min(20),
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const body = logoutSchema.parse(req.body);
    const tokenHash = sha256(body.refreshToken);

    const session = await prisma.session.findFirst({
      where: {
        refreshTokenHash: tokenHash,
        revokedAt: null,
      },
      select: { id: true, userId: true },
    });

    if (!session) return res.status(204).json({ ok: true });

    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        userId: session.userId,
        action: "LOGOUT",
        entity: "Session",
        entityId: session.id,
      },
    });

    return res.status(204).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { authRouter };
