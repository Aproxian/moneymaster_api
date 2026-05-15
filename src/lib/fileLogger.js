"use strict";

const fs = require("fs/promises");
const path = require("path");

/** @type {string | false | null} null = not resolved yet */
let resolvedDir = null;
let warnedWriteFailure = false;

function fileLoggingDisabled() {
  const v = String(process.env.MONEYMASTER_LOG_DIR ?? "").trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no";
}

/**
 * Absolute directory for daily log files. Default: `<cwd>/logs`.
 * Set `MONEYMASTER_LOG_DIR` to an absolute path on the server (e.g. under the app root).
 * Set to `0`, `off`, or `false` to disable file logging.
 */
function resolveLogDir() {
  if (resolvedDir !== null) return resolvedDir;
  if (fileLoggingDisabled()) {
    resolvedDir = false;
    return resolvedDir;
  }
  const raw = String(process.env.MONEYMASTER_LOG_DIR ?? "").trim();
  const dir = raw !== "" ? path.resolve(raw) : path.join(process.cwd(), "logs");
  resolvedDir = dir;
  return resolvedDir;
}

function logFileBasenameUtc() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `moneymaster-${y}-${m}-${day}.log`;
}

function serializeDetail(detail) {
  if (detail === undefined) return "";
  if (typeof detail === "string") return detail;
  if (detail instanceof Error) {
    return JSON.stringify({ message: detail.message, stack: detail.stack });
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/**
 * Append one line to today's log file (UTC date in filename). Fire-and-forget; never throws.
 * @param {"INFO"|"WARN"|"ERROR"} level
 * @param {string} tag short source id (e.g. TwelveDataSweep)
 * @param {string} message
 * @param {unknown} [detail] optional JSON-serializable payload or Error
 */
function logApp(level, tag, message, detail) {
  const dir = resolveLogDir();
  if (dir === false) return;

  void (async () => {
    try {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, logFileBasenameUtc());
      const ts = new Date().toISOString();
      const extra =
        detail !== undefined && detail !== null ? `\t${serializeDetail(detail)}` : "";
      const line = `${ts}\t${level}\t${tag}\t${message}${extra}\n`;
      await fs.appendFile(file, line, "utf8");
    } catch (e) {
      if (!warnedWriteFailure) {
        warnedWriteFailure = true;
        // eslint-disable-next-line no-console -- last resort when file log fails
        console.error("[AppFileLog] first write failed:", e?.message || e);
      }
    }
  })();
}

module.exports = { logApp, resolveLogDir };
