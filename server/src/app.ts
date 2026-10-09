import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { CLIENT_SOCKET_PATH } from "@vortex-axis/protocol";
import { Activity } from "./activity.js";
import { NODE_COMMANDS, NODE_TOOLS, createInvokeHandler } from "./commands.js";
import { Timers } from "./timers.js";
import { WakeWordStore, WakeWordSync } from "./wakewords.js";
import type { Config } from "./config.js";
import { GatewayClient } from "./gateway/client.js";
import type { LinkOptions } from "./gateway/link.js";
import { Delivery } from "./delivery.js";
import { createHttpHandler } from "./http.js";
import { PushService } from "./push.js";
import { Hub } from "./hub.js";
import { Store } from "./store.js";
import type { Services } from "./turns.js";
import { applyRuntimeConfig, loadRuntimeConfig } from "./upstream.js";

export interface App {
  store: Store;
  activity: Activity;
  hub: Hub;
  /** The OpenClaw gateway link. It exists even when another agent answers turns. */
  gateway: GatewayClient;
  timers: Timers;
  /** Gets agent-started speech to a client by whatever route it has: live, by notification, or kept for later. */
  delivery: Delivery;
  push: PushService;
  server: Server;
  /** Port actually bound, useful when the configured port is 0. */
  port: number;
  close(): Promise<void>;
}

export const AXIS_VERSION = "0.1.0";

/**
 * Evens out a service's status checks: a service that was up is called down
 * only after two missed checks in a row. One slow answer, such as when this
 * machine is busy, is not the service going away.
 */
export function steadyStatus(): (checked: "up" | "down") => "up" | "down" {
  let shown: "up" | "down" | undefined;
  let misses = 0;
  return (checked) => {
    misses = checked === "up" ? 0 : misses + 1;
    if (checked === "up" || shown !== "up" || misses >= 2) shown = checked;
    return shown;
  };
}

export interface StartOptions {
  log?: (line: string) => void;
  /** Stand-ins for upstream clients, for tests. A stand-in is never replaced by saved settings. */
  services?: Services;
  /** Delays for the gateway link, for tests. */
  gatewayTiming?: LinkOptions["timing"];
}

/** Wires the store, the hub and the HTTP server together and starts listening. */
export async function startApp(config: Config, options: StartOptions = {}): Promise<App> {
  const log = options.log ?? (() => {});
  const startedAt = Date.now();
  const store = new Store(config.dataDir);
  const activity = new Activity(store, { retentionMs: config.activityDays * 86_400_000 });
  activity.start();

  // The gateway's two links each get an uptime timeline.
  const LINK_NAMES = { operator: "Gateway turn link", node: "Gateway command link" } as const;
  const recordLinks = () => {
    const status = gateway.status();
    for (const key of ["operator", "node"] as const) {
      const state = status[key].state;
      const bad = state === "auth_failed" || state === "unreachable";
      const detail = status[key].error ? `: ${status[key].error}` : "";
      activity.state("service", key, state, `${LINK_NAMES[key]} ${state.replace(/_/g, " ")}${bad ? detail : ""}`, bad ? "bad" : state === "connected" ? "info" : "warn");
    }
  };

  const gateway = new GatewayClient({
    store,
    url: config.gateway.url,
    agentId: config.gateway.agentId,
    sessionKey: config.gateway.sessionKey,
    displayName: config.gateway.displayName,
    version: AXIS_VERSION,
    commands: [...NODE_COMMANDS],
    tools: NODE_TOOLS,
    log,
    onStateChange: () => {
      recordLinks();
      void checkHealth();
    },
    ...(options.gatewayTiming ? { timing: options.gatewayTiming } : {}),
  });

  // One object for the life of the process: the turn logic reads it on every
  // turn, so a settings change takes effect without a restart.
  const services: Services = {};
  const reloadServices = () => {
    applyRuntimeConfig(services, loadRuntimeConfig(store, config), gateway, config.gateway.sessionKey);
    Object.assign(services, options.services);
    void checkHealth();
  };

  const hub = new Hub({
    store,
    helloTimeoutMs: config.helloTimeoutMs,
    pingIntervalMs: config.pingIntervalMs,
    services,
    wakeWindowMs: config.wakeWindowMs,
    maxUtteranceMs: config.maxUtteranceMs,
    outputHoldMs: config.outputHoldMs,
    activity,
    log,
  });
  const timers = new Timers({ store, hub, activity, log });
  const wakeWords = new WakeWordStore(config.dataDir);
  const wakeWordSync = new WakeWordSync(wakeWords, store, hub);
  // Browsers that allowed notifications are reached through their push service when their page is closed.
  // The push service wants a way to contact the sender: the public address when there is one.
  const push = new PushService(store, config.publicHosts[0] ? `https://${config.publicHosts[0]}` : "mailto:vortex-axis@localhost", log);
  const delivery = new Delivery({
    hub,
    store,
    push,
    holdMs: config.messageHoldMs,
    note: (clientId, text, level) => {
      log(text);
      activity.note("message", clientId, text, level ?? "info");
    },
  });
  gateway.onInvokeCommand(
    createInvokeHandler({ hub, store, timers, delivery, activity, pairingCodeTtlMs: config.pairingCodeTtlMs, version: AXIS_VERSION, startedAt }),
  );

  // A service that is not configured counts as down, so clients can say so.
  const sttStatus = steadyStatus();
  const ttsStatus = steadyStatus();
  async function checkHealth(): Promise<void> {
    const check = (service: { healthy(): Promise<boolean> } | undefined) =>
      service ? service.healthy().then((ok) => (ok ? "up" : "down") as "up" | "down") : Promise.resolve("down" as const);
    const [openclaw, stt, tts] = await Promise.all([check(services.agent), check(services.stt), check(services.tts)]);
    hub.setUpstream({ openclaw, stt: services.stt ? sttStatus(stt) : stt, tts: services.tts ? ttsStatus(tts) : tts });
  }
  applyRuntimeConfig(services, loadRuntimeConfig(store, config), gateway, config.gateway.sessionKey);
  Object.assign(services, options.services);

  let healthTimer: NodeJS.Timeout | undefined;
  if (config.healthIntervalMs > 0) {
    void checkHealth();
    healthTimer = setInterval(() => void checkHealth(), config.healthIntervalMs);
    healthTimer.unref();
  }

  const server = createServer(
    createHttpHandler({ config, store, hub, gateway, activity, timers, wakeWords, wakeWordSync, push, delivery, services, reloadServices, version: AXIS_VERSION, startedAt }),
  );
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
  gateway.start();
  timers.start();
  recordLinks();

  return {
    store,
    activity,
    hub,
    gateway,
    timers,
    delivery,
    push,
    server,
    port,
    async close() {
      if (healthTimer) clearInterval(healthTimer);
      timers.stop();
      gateway.stop();
      hub.closeAll();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      activity.stop();
      store.close();
    },
  };
}
