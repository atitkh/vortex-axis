import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { CLIENT_SOCKET_PATH } from "@vortex-axis/protocol";
import { ChatCompletionsAgent } from "./agent.js";
import type { Config } from "./config.js";
import { createHttpHandler } from "./http.js";
import { Hub } from "./hub.js";
import { OpenAiSpeechToText, OpenAiTextToSpeech } from "./speech.js";
import { Store } from "./store.js";
import type { Services } from "./turns.js";

export interface App {
  store: Store;
  hub: Hub;
  server: Server;
  /** Port actually bound, useful when the configured port is 0. */
  port: number;
  close(): Promise<void>;
}

/** Builds the upstream clients the configuration names. Anything not configured is left out. */
export function servicesFromConfig(config: Config): Services {
  return {
    stt: config.stt ? new OpenAiSpeechToText(config.stt) : undefined,
    tts: config.tts ? new OpenAiTextToSpeech(config.tts) : undefined,
    agent: config.agent ? new ChatCompletionsAgent(config.agent) : undefined,
  };
}

/** Wires the store, the hub and the HTTP server together and starts listening. */
export async function startApp(
  config: Config,
  log: (line: string) => void = () => {},
  services: Services = servicesFromConfig(config),
): Promise<App> {
  const store = new Store(config.dataDir);
  const hub = new Hub({
    store,
    helloTimeoutMs: config.helloTimeoutMs,
    services,
    wakeWindowMs: config.wakeWindowMs,
    maxUtteranceMs: config.maxUtteranceMs,
    log,
  });

  // A service that is not configured counts as down, so clients can say so.
  const checkHealth = async () => {
    const check = (service: { healthy(): Promise<boolean> } | undefined) =>
      service ? service.healthy().then((ok) => (ok ? "up" : "down") as "up" | "down") : Promise.resolve("down" as const);
    const [openclaw, stt, tts] = await Promise.all([check(services.agent), check(services.stt), check(services.tts)]);
    hub.setUpstream({ openclaw, stt, tts });
  };
  let healthTimer: NodeJS.Timeout | undefined;
  if (config.healthIntervalMs > 0) {
    void checkHealth();
    healthTimer = setInterval(() => void checkHealth(), config.healthIntervalMs);
    healthTimer.unref();
  }

  const server = createServer(createHttpHandler({ config, store, hub }));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://axis").pathname;
    if (path !== CLIENT_SOCKET_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => hub.accept(ws));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    store,
    hub,
    server,
    port,
    async close() {
      if (healthTimer) clearInterval(healthTimer);
      hub.closeAll();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      store.close();
    },
  };
}
