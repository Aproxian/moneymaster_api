const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

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

const app = express();

if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
// Explicit bytes: bulk CSV can exceed 100kb default (Express / body-parser).
const JSON_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
// eslint-disable-next-line no-console -- startup diagnostic (confirms limit is applied)
console.info(
  `[MoneyMASTER] express.json body limit: ${(JSON_BODY_LIMIT_BYTES / (1024 * 1024)).toFixed(0)} MiB`
);

app.use("/auth", authRouter);
app.use("/accounts", accountsRouter);
app.use("/accounts/:accountId", accountExtrasRouter);
app.use("/accounts/:accountId/scheduled-transactions", scheduledTransactionsRouter);
app.use("/accounts/:accountId/categories", categoriesRouter);
app.use("/accounts/:accountId/transactions", transactionsRouter);
app.use("/accounts/:accountId/investments", accountInvestmentsRouter);
app.use("/accounts/:accountId/instruments", accountInstrumentsRouter);
app.use("/investments", investmentsRouter);
app.use("/instruments", instrumentsRouter);
app.use("/transfers", transfersRouter);
app.use("/", meRouter);

// Basic error handler
app.use((err, _req, res, _next) => {
  console.error(err);
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
