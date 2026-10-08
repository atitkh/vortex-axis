import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { CLIENT_SOCKET_PATH } from "@vortex-axis/protocol";
import type { Config } from "./config.js";
import { createHttpHandler } from "./http.js";
import { Hub } from "./hub.js";
import { Store } from "./store.js";

export interface App {
  store: Store;
  hub: Hub;
  server: Server;
  /** Port actually bound, useful when the configured port is 0. */
  port: number;
  close(): Promise<void>;
}

/** Wires the store, the hub and the HTTP server together and starts listening. */
export async function startApp(config: Config, log: (line: string) => void = () => {}): Promise<App> {
  const store = new Store(config.dataDir);
  const hub = new Hub({ store, helloTimeoutMs: config.helloTimeoutMs, log });
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
      hub.closeAll();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      store.close();
    },
  };
}
