const { app } = require("./app");
const { config } = require("./config");
const { logApp } = require("./lib/fileLogger");
const { stopTwelveDataBackgroundSweep } = require("./services/twelveDataRefreshScheduler");

const server = app.listen(config.port, () => {
  const msg = `API listening on http://localhost:${config.port}`;
  console.log(msg);
  logApp("INFO", "Server", msg);
});

async function shutdown() {
  await stopTwelveDataBackgroundSweep();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
