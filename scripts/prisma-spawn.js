"use strict";

/**
 * Runs the Prisma CLI in a child with a minimal env (cPanel often injects
 * vars that break the Prisma 7 bundle at runtime even when `node --check` passes).
 * Deploy this file with the API; package.json scripts depend on it.
 */
require("dotenv/config");

const { spawnSync } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node scripts/prisma-spawn.js <prisma-cli-args...>");
  console.error("example: node scripts/prisma-spawn.js generate");
  process.exit(1);
}

if (args[0] === "--with-prisma-debug") {
  if (!process.env.DEBUG) process.env.DEBUG = "prisma:*";
  args.shift();
}

const prismaDir = path.dirname(require.resolve("prisma/package.json"));
const cli = path.join(prismaDir, "build", "index.js");
const raw = process.env;

const env = {};
const passKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_MESSAGES",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
  "DATABASE_URL",
  "DOTENV_KEY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "CI",
  "FORCE_COLOR",
  "TERM",
  "TZ",
];

for (const k of passKeys) {
  if (raw[k] != null && raw[k] !== "") env[k] = raw[k];
}

for (const k of Object.keys(raw)) {
  if (
    k.startsWith("PRISMA_") ||
    k.startsWith("npm_") ||
    k.startsWith("MYSQL") ||
    k.startsWith("MARIA")
  ) {
    env[k] = raw[k];
  }
}

for (const k of Object.keys(raw)) {
  if (k.startsWith("LD_") || k === "LIBRARY_PATH") {
    env[k] = raw[k];
  }
}

if (process.env.DEBUG) env.DEBUG = process.env.DEBUG;

const r = spawnSync(process.execPath, [cli, ...args], {
  stdio: "inherit",
  env,
  cwd: process.cwd(),
});

process.exit(r.status === 0 ? 0 : r.status == null ? 1 : r.status);
