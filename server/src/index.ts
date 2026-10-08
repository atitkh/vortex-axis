import { startApp } from "./app.js";
import { loadConfig } from "./config.js";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const config = loadConfig();
const app = await startApp(config, log);

log(`VorteX Axis listening on ${config.host}:${app.port}`);
if (!config.adminToken) log("admin API is disabled: set AXIS_ADMIN_TOKEN to enable it");

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
