require("dotenv").config();

const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
const { PrismaClient } = require("@prisma/client");

// Avoid creating too many PrismaClient instances in dev (hot reload).
const globalForPrisma = global;

// Use 127.0.0.1 by default: on Windows, "localhost" often resolves to ::1 (IPv6) while
// MariaDB/MySQL may only listen on 127.0.0.1, causing ECONNREFUSED and pool timeouts.
const adapter =
  globalForPrisma.prismaAdapter ||
  new PrismaMariaDb({
    host: process.env.DATABASE_HOST || "127.0.0.1",
    user: process.env.DATABASE_USER || "root",
    password: process.env.DATABASE_PASSWORD || "",
    database: process.env.DATABASE_NAME || "moneymaster_dev",
    port: Number(process.env.DATABASE_PORT ?? 3306),
    connectionLimit: 5,
  });

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaAdapter = adapter;
}

module.exports = { prisma };
