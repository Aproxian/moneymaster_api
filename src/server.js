const { app } = require("./app");
const { config } = require("./config");
const { stopTwelveDataBackgroundSweep } = require("./services/twelveDataRefreshScheduler");

const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});

function shutdown() {
  stopTwelveDataBackgroundSweep();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
