import { cfg, assertReady } from "./config.js";
import { db } from "./store.js";
import { startWorker } from "./worker.js";
import { createApp } from "./app.js";
assertReady();
const worker = startWorker();
const server = createApp({ workerStatus: worker.status }).listen(
  cfg.port,
  cfg.host,
  () =>
    console.log(
      JSON.stringify({
        event: "listening",
        host: cfg.host,
        port: cfg.port,
        mode: cfg.dryRun ? "dry-run" : "live",
      }),
    ),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const stopHttp = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  const force = setTimeout(() => process.exit(1), 30000);
  force.unref();
  await worker.stop();
  await stopHttp;
  db.close();
  clearTimeout(force);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
server.on("error", async (error) => {
  console.error(JSON.stringify({ event: "server_error", code: error.code }));
  await worker.stop();
  db.close();
  process.exitCode = 1;
});
