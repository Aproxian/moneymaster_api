const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { logApp } = require("./lib/fileLogger");

const { authRouter } = require("./routes/auth");
const { meRouter } = require("./routes/me");
const { accountsRouter } = require("./routes/accounts");
const { accountExtrasRouter } = require("./routes/accountExtras");
const { scheduledTransactionsRouter } = require("./routes/scheduledTransactions");
const { transfersRouter } = require("./routes/transfers");
const { transactionsRouter } = require("./routes/transactions");
const { categoriesRouter } = require("./routes/categories");
const { investmentsRouter } = require("./routes/investments");
const { instrumentsRouter } = require("./routes/instruments");
const { accountInvestmentsRouter } = require("./routes/accountInvestments");
const { accountInstrumentsRouter } = require("./routes/accountInstruments");
const { webhooksRouter } = require("./routes/webhooks");

const { requireAuth } = require("./middleware/auth");
const { requirePremium } = require("./middleware/requirePremium");

const app = express();

if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
// Explicit bytes: bulk CSV can exceed 100kb default (Express / body-parser).
const JSON_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
const bodyLimitMsg = `[MoneyMASTER] express.json body limit: ${(JSON_BODY_LIMIT_BYTES / (1024 * 1024)).toFixed(0)} MiB`;
// eslint-disable-next-line no-console -- startup diagnostic (confirms limit is applied)
console.info(bodyLimitMsg);
logApp("INFO", "App", bodyLimitMsg);

app.use("/auth", authRouter);
// `/accounts` (list/create) and `/me` stay ungated so login bootstrap + the paywall can load.
app.use("/accounts", accountsRouter);
// Ledger data + operations are gated behind an active `full_access` entitlement
// (no-op unless PREMIUM_ENFORCEMENT_ENABLED is set). Mounted behind requireAuth so req.auth exists.
app.use("/accounts/:accountId", requireAuth, requirePremium, accountExtrasRouter);
app.use("/accounts/:accountId/scheduled-transactions", requireAuth, requirePremium, scheduledTransactionsRouter);
app.use("/accounts/:accountId/categories", requireAuth, requirePremium, categoriesRouter);
app.use("/accounts/:accountId/transactions", requireAuth, requirePremium, transactionsRouter);
app.use("/accounts/:accountId/investments", requireAuth, requirePremium, accountInvestmentsRouter);
app.use("/accounts/:accountId/instruments", requireAuth, requirePremium, accountInstrumentsRouter);
// `/investments` carries the cron endpoints (refreshDailyAuth, userId may be null) — do not gate.
app.use("/investments", investmentsRouter);
app.use("/instruments", requireAuth, requirePremium, instrumentsRouter);
app.use("/transfers", requireAuth, requirePremium, transfersRouter);
app.use("/webhooks", webhooksRouter);
app.use("/", meRouter);

// Basic error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  logApp("ERROR", "Express", "unhandled route error", err instanceof Error ? err : { message: String(err) });
  const tooLarge =
    err?.type === "entity.too.large" ||
    err?.name === "PayloadTooLargeError" ||
    err?.status === 413 ||
    err?.statusCode === 413;
  if (tooLarge) {
    return res.status(413).json({
      errorMessage: "Request body too large for this server",
      hint: "Restart the API after updating body limits, or send the bulk import in smaller batches.",
    });
  }
  return res.status(500).json({ errorMessage: "Internal server error" });
});

module.exports = { app };
