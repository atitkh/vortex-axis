import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { CLIENT_SOCKET_PATH } from "@vortex-axis/protocol";
import { Activity } from "./activity.js";
import { Backup } from "./backup.js";
import { NODE_COMMANDS, NODE_TOOLS, createInvokeHandler } from "./commands.js";
import { Timers } from "./timers.js";
import { ToolAccess } from "./tools.js";
import { AXIS_COMMIT, AXIS_VERSION } from "./version.js";
import { WakeWordStore, WakeWordSync } from "./wakewords.js";
import type { Config } from "./config.js";
import { GatewayClient } from "./gateway/client.js";
import type { LinkOptions } from "./gateway/link.js";
import { Delivery } from "./delivery.js";
import { HomeAssistant } from "./homeassistant.js";
import { applySavedHubSettings } from "./hubconfig.js";
import { Live } from "./live.js";
import { Voiceprints } from "./voiceprint.js";
import { createHttpHandler } from "./http.js";
import { AgentAsks } from "./agentasks.js";
import { CardMirror } from "./cards.js";
import { RealtimeTalk } from "./talk.js";
import { Attachment } from "./attach.js";
import { SelfCheck } from "./selfcheck.js";
import { Progress } from "./progress.js";
import { Background } from "./background.js";
import { LiveActivities } from "./liveactivity.js";
import { PushService } from "./push.js";
import { Hub } from "./hub.js";
import { Store } from "./store.js";
import { isSilent, type Services } from "./turns.js";
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
  /** Copies the data folder to the backup folder on a schedule, when one is set up. */
  backup: Backup;
  /** Long work agents are doing, shown on the screens. */
  progress: Progress;
  /** Which tools agents have, and the tokens that let a harness in by MCP. */
  tools: ToolAccess;
  server: Server;
  /** Port actually bound, useful when the configured port is 0. */
  port: number;
  close(): Promise<void>;
}

export { AXIS_VERSION };

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
  // What an admin saved on the Integrations page wins over the environment, from here on.
  applySavedHubSettings(store, config);
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
  // Which of the agent's conversations the devices are heard in: Axis's own, unless a person pointed them at another.
  const homeSession = () => (gateway.agentId() ? `agent:${gateway.agentId()}:${config.gateway.sessionKey}` : undefined);
  const attachment: Attachment = new Attachment({
    source: gateway,
    store,
    // By its whole key when the agent is known, and by its name otherwise: whichever agent it belongs to, it is Axis's own.
    isHome: (key) => key === homeSession() || key === config.gateway.sessionKey || key.endsWith(`:${config.gateway.sessionKey}`),
    // A realtime voice session belongs to one conversation: the next thing said opens one in the new place.
    onChange: () => talk.stop(),
  });
  gateway.setElsewhere(() => attachment.sessionKey());
  // The gateway's realtime voice, for devices set to it. It talks in the same conversation as typed and spoken turns,
  // and only while the agent is an OpenClaw gateway that Axis is connected to.
  const talk = new RealtimeTalk({
    source: gateway,
    available: () => services.agent === gateway && gateway.status().operator.state === "connected",
    sessionKey: () => attachment.current()?.sessionKey ?? homeSession(),
    provider: process.env.AXIS_TALK_PROVIDER || undefined,
    log,
  });
  // Set once: nothing that reloads the other services touches it.
  services.talk = talk;
  const reloadServices = () => {
    applyRuntimeConfig(services, loadRuntimeConfig(store, config), gateway, config.gateway.sessionKey);
    Object.assign(services, options.services);
    void checkHealth();
  };

  const live = new Live();
  const voices = new Voiceprints({ store, service: () => services.voiceprint, sessionKey: config.gateway.sessionKey });
  const hub = new Hub({
    store,
    live,
    voices,
    helloTimeoutMs: config.helloTimeoutMs,
    pingIntervalMs: config.pingIntervalMs,
    services,
    wakeWindowMs: config.wakeWindowMs,
    maxUtteranceMs: config.maxUtteranceMs,
    outputHoldMs: config.outputHoldMs,
    timeZone: config.timeZone,
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
  // One function carries out every tool call, whichever door it came in by: the OpenClaw node here, MCP in http.ts.
  // A phone is told about a task only while the person is away from the screens: Home Assistant says so.
  const tellPhones = (title: string, body: string, tag: string) => {
    if (store.getMeta("away") !== "1") return;
    for (const id of store.pushClientIds()) {
      if (hub.session(id)) continue;
      push.notify(id, { title, body, tag }).catch(() => undefined);
    }
  };
  const progress = new Progress(hub, {
    // Sent even when a phone also shows it as a live activity: tapping this notification opens the installed web app,
    // which tapping the activity cannot.
    onBlocked: (task) => tellPhones(`${task.title}: needs you`, task.note || "The agent is waiting for you.", `task-${task.id}`),
    onEnd: (task, ending) => {
      const at = Date.now();
      activity.task({
        at,
        taskId: task.id,
        title: task.title,
        note: task.note,
        ...(task.done !== undefined ? { done: task.done } : {}),
        ...(task.total !== undefined ? { total: task.total } : {}),
        ending,
        startedAt: task.startedAt,
      });
      background.ended(task, ending);
      if (ending !== "done") return;
      const minutes = Math.max(1, Math.round((at - task.startedAt) / 60_000));
      tellPhones(`${task.title} done`, task.note || `Finished in ${minutes} min.`, `task-${task.id}`);
    },
  });
  progress.start();
  // A run the device stopped waiting for is followed here, shown as a task, and its answer said when it comes.
  const background: Background = new Background({
    progress,
    deliver: async (clientId, text) => {
      if (store.getMeta("away") === "1") {
        const phone = store.pushClientIds().find((id) => !hub.session(id));
        const client = phone ? store.getClient(phone) : undefined;
        if (client) return delivery.sayTo(client, text);
      }
      try {
        return await delivery.sayOn(hub.pickOutput({}), text);
      } catch {
        // Nobody to say it to now: kept for the device that asked, for when it is back.
        const client = store.getClient(clientId);
        if (client) return delivery.sayTo(client, text);
      }
    },
    // The agent answering turns stops its own runs.
    abort: async (run) => services.agent?.abortRun?.(run),
    isSilent,
    log,
  });
  if (config.handoverMs > 0) hub.useBackground(background, `${config.gateway.sessionKey}-busy`, config.handoverMs);
  // An OpenClaw agent's own step list reaches the screens with no tool call.
  // What such an agent waits on the person for, a question or an approval, is put to them on a device;
  // or, while Home Assistant says they are away, on a phone that takes notifications.
  const asks: AgentAsks = new AgentAsks({
    source: gateway,
    questions: () => config.mirrorQuestions,
    approvals: () => config.mirrorApprovals,
    listening: () => gateway.status().watch?.missing.includes("operator.questions") === false,
    onChange: (sessionKey) => cards.refresh(sessionKey),
    log,
    note: (text) => activity.note("agent", "", text, "info"),
    route: {
      ask: async ({ question, choices, timeoutMs, silent, signal }) => {
        if (store.getMeta("away") === "1") {
          const phone = store.listClients().find((client) => delivery.canAskByNotification(client, choices));
          if (phone) return delivery.askByNotification(phone, question, choices, timeoutMs);
        }
        let session;
        try {
          session = hub.pickOutput({});
        } catch {
          return undefined;
        }
        const caps = session.client.capabilities;
        if (!caps.includes("mic") && !(choices.length && caps.includes("screen"))) return undefined;
        // A choice to tap needs a screen; without one an approval cannot be given here at all.
        if (silent && !caps.includes("screen")) return undefined;
        return hub.ask(session, question, choices, timeoutMs, { silent, signal });
      },
    },
  });
  const cards: CardMirror = new CardMirror({ source: gateway, progress, enabled: () => config.mirrorCards, waitingOn: (sessionKey) => asks.waitingOn(sessionKey), log });
  cards.start();
  // Whether the gateway still offers what all of the above lean on: asked whenever the link comes up.
  const selfCheck = new SelfCheck({
    source: gateway,
    connected: () => services.agent === gateway && gateway.status().operator.state === "connected",
    features: {
      cards: () => config.mirrorCards,
      questions: () => config.mirrorQuestions,
      approvals: () => config.mirrorApprovals,
      realtime: () => store.getLayer("global", "").voiceMode === "realtime" || store.listClients().some((client) => store.getLayer("device", client.id).voiceMode === "realtime"),
      toolIcons: () => store.getLayer("global", "").toolIcons !== "off",
    },
    sessionKey: () => (gateway.agentId() ? `agent:${gateway.agentId()}:${config.gateway.sessionKey}` : undefined),
    log,
    onChange: (check, was) =>
      activity.note("service", "openclaw", check.state === "problem" ? `${check.label} stopped working: ${check.detail}` : `${check.label} is working again`, check.state === "problem" ? "bad" : "info"),
  });
  let checkTimer: NodeJS.Timeout | undefined;
  gateway.onEvent((event) => {
    // The operator link has just come up: a moment for it to settle, then look.
    if (event !== "watch.connected") return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => void selfCheck.run().catch(() => undefined), 1500);
    checkTimer.unref();
  });
  /** The scopes Axis asks the gateway for beyond its own turns, by what is switched on. */
  const watchGateway = () =>
    gateway.watch([...(config.mirrorQuestions ? ["operator.questions"] : []), ...(config.mirrorApprovals ? ["operator.approvals"] : [])]);
  const tools = new ToolAccess(store, activity);
  const invoke = tools.guard(
    createInvokeHandler({ hub, store, timers, delivery, progress, attachment, activity, pairingCodeTtlMs: config.pairingCodeTtlMs, version: AXIS_VERSION, startedAt }),
  );
  gateway.onInvokeCommand(invoke);

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

  let homeAssistant: HomeAssistant | undefined;
  // Tasks and timers on phones, by way of Home Assistant; only with its link set up and the switch on.
  const liveActivities = new LiveActivities({
    store,
    enabled: () => config.liveActivities && Boolean(config.homeAssistant),
    publish: (message) => homeAssistant?.publishLive(message) ?? false,
    tasks: () => progress.list(),
    timers: () => timers.list(),
    url: () => (config.publicHosts[0] ? `https://${config.publicHosts[0]}/` : undefined),
    log,
  });
  const syncLive = () => {
    try {
      liveActivities.sync();
    } catch (error) {
      log(`live activities: ${(error as Error).message}`);
    }
  };
  progress.onChange(syncLive);
  timers.onChange(syncLive);
  const startHomeAssistant = () => {
    homeAssistant?.stop();
    homeAssistant = config.homeAssistant
      ? new HomeAssistant({ ...config.homeAssistant, hub, store, delivery, version: AXIS_VERSION, onLiveAck: (payload) => liveActivities.acknowledged(payload), log })
      : undefined;
    homeAssistant?.start();
  };
  startHomeAssistant();
  hub.onGesture((session, gesture) => homeAssistant?.gesture(session.client.id, gesture));

  /** Carries a change made on the Integrations page, already written into `config`, to the parts that use it. */
  const applyHubSettings = (changed: { mqtt: boolean }) => {
    hub.setTimeZone(config.timeZone);
    activity.setRetention(config.activityDays * 86_400_000);
    delivery.setHoldMs(config.messageHoldMs);
    if (changed.mqtt) startHomeAssistant();
    syncLive();
    watchGateway();
  };

  // Words kept in memory for the admin page are deleted when their time is up, not only hidden.
  const forgetTimer = setInterval(() => {
    live.forgetOldWords();
    hub.forgetScreens();
    delivery.prune();
  }, 60_000);
  forgetTimer.unref();

  // Quiet hours begin and end on the clock, not on an edit, so somebody has to look.
  const quietTimer = setInterval(() => hub.checkQuiet(), 60_000);
  quietTimer.unref();
  hub.onConnect(() => hub.checkQuiet());

  const backup = new Backup({ store, config, activity, log });
  backup.start();

  let healthTimer: NodeJS.Timeout | undefined;
  if (config.healthIntervalMs > 0) {
    void checkHealth();
    healthTimer = setInterval(() => void checkHealth(), config.healthIntervalMs);
    healthTimer.unref();
  }

  const server = createServer(
    createHttpHandler({ liveActivities, voices, attachment, selfCheck, talk, config, store, hub, gateway, activity, live, homeAssistant: () => homeAssistant, applyHubSettings, backup, tools, invoke, progress, timers, wakeWords, wakeWordSync, push, delivery, services, reloadServices, version: AXIS_VERSION, commit: AXIS_COMMIT, startedAt }),
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
  watchGateway();
  timers.start();
  liveActivities.start();
  recordLinks();

  return {
    store,
    activity,
    hub,
    gateway,
    timers,
    delivery,
    push,
    backup,
    progress,
    tools,
    server,
    port,
    async close() {
      backup.stop();
      progress.stop();
      liveActivities.stop();
      cards.stop();
      clearTimeout(checkTimer);
      talk.stop();
      asks.stop();
      if (healthTimer) clearInterval(healthTimer);
      clearInterval(quietTimer);
      clearInterval(forgetTimer);
      homeAssistant?.stop();
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
