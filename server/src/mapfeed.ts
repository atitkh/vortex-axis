import type { Status } from "@vortex-axis/protocol";
import type { DeviceInfo } from "./deviceinfo.js";
import type { ClientChange } from "./hub.js";
import type { LiveEvent, LiveTurn } from "./live.js";
import type { TurnRecord } from "./store.js";

/**
 * The admin page's system map: the devices, the services behind Axis and how they connect (`GET /admin/map`), and
 * what changes as it happens (`GET /admin/map/stream`). Read-only, built from what Axis already holds.
 */

export interface MapService {
  id: "agent" | "gateway-node" | "stt" | "tts" | "voiceprint" | "homeassistant";
  name: string;
  /** "up", "down" or "unknown" for a speech service or the agent; a link state for the gateway; "on"/"off" for voiceprints. */
  state: string;
  /** How long it took in the last turn that used it, in milliseconds. */
  lastMs?: number;
  /** When that turn was. */
  lastAt?: number;
  error?: string;
}

export interface MapEdge {
  from: string;
  to: string;
  /** link: a device connected to Axis; speech, agent, node, voiceprint, mqtt: Axis to a service. */
  kind: "link" | "speech" | "agent" | "node" | "voiceprint" | "mqtt";
}

export interface MapInput {
  devices: DeviceInfo[];
  upstream: Status["upstream"];
  /** Whether the agent is the OpenClaw gateway (else an OpenAI-style endpoint). */
  usesGateway: boolean;
  /** The gateway's command link (node role), when the gateway is used. */
  node?: { state: string; error?: string | undefined };
  /** Voiceprints, when this Axis has them: whether turns are checked. */
  voiceprint?: boolean;
  /** Home Assistant through MQTT, when it is set up. */
  homeAssistant?: { connected: boolean; error: string | null } | null;
  /** Recent turns, newest first, for each service's last latency. */
  recentTurns: TurnRecord[];
  axis: { version: string; startedAt: number };
  at: number;
}

export function buildMap(input: MapInput) {
  const { upstream, recentTurns } = input;
  const last = (pick: (t: TurnRecord) => number | undefined) => {
    for (const turn of recentTurns) {
      const ms = pick(turn);
      if (ms !== undefined) return { lastMs: ms, lastAt: turn.at };
    }
    return {};
  };
  const services: MapService[] = [
    { id: "agent", name: input.usesGateway ? "OpenClaw gateway" : "Agent endpoint", state: upstream.openclaw, ...last((t) => t.agentMs) },
  ];
  if (input.usesGateway && input.node) {
    services.push({ id: "gateway-node", name: "Gateway command link", state: input.node.state, ...(input.node.error ? { error: input.node.error } : {}) });
  }
  services.push(
    { id: "stt", name: "Speech recognition", state: upstream.stt, ...last((t) => t.sttMs) },
    {
      id: "tts",
      name: "Speech synthesis",
      state: upstream.tts,
      // As the activity page's synthesis time: first audio less recognition and the agent.
      ...last((t) => (t.firstAudioMs !== undefined && t.agentMs !== undefined ? t.firstAudioMs - (t.sttMs ?? 0) - t.agentMs : undefined)),
    },
  );
  if (input.voiceprint !== undefined) services.push({ id: "voiceprint", name: "Voiceprints", state: input.voiceprint ? "on" : "off" });
  if (input.homeAssistant) {
    services.push({
      id: "homeassistant",
      name: "Home Assistant (MQTT)",
      state: input.homeAssistant.connected ? "up" : "down",
      ...(input.homeAssistant.error ? { error: input.homeAssistant.error } : {}),
    });
  }
  const edges: MapEdge[] = input.devices.filter((d) => d.online).map((d) => ({ from: d.id, to: "axis", kind: "link" }));
  const kinds: Record<MapService["id"], MapEdge["kind"]> = {
    agent: "agent",
    "gateway-node": "node",
    stt: "speech",
    tts: "speech",
    voiceprint: "voiceprint",
    homeassistant: "mqtt",
  };
  for (const service of services) edges.push({ from: "axis", to: service.id, kind: kinds[service.id] });
  return { axis: input.axis, nodes: input.devices, services, edges, at: input.at };
}

/** How often one client's readings may go out on the stream. Coming online, going offline and turn stages go at once. */
export const READINGS_EVERY_MS = 5_000;

/** A turn as the map shows it: where it is, never what was said. */
export interface MapTurn {
  key: string;
  clientId: string;
  stage: LiveTurn["stages"][number]["name"] | "done";
  startedAt: number;
  endedAt?: number;
  outcome?: LiveTurn["outcome"];
}

export interface MapFeedDeps {
  /** One device as it is now; undefined when it was removed. */
  info: (clientId: string) => DeviceInfo | undefined;
  onClientChange: (listener: (clientId: string, change: ClientChange) => void) => () => void;
  subscribeLive?: ((listener: (event: LiveEvent) => void) => () => void) | undefined;
  send: (event: "client" | "turn", data: unknown) => void;
  everyMs?: number;
  now?: () => number;
}

/**
 * The map's stream of changes: a device's info when it comes online or goes offline (at once), when it reports
 * readings (at most once per `everyMs` per device, the latest winning) and when a turn changes stage; and each turn's
 * stage. Returns how to stop.
 */
export function startMapFeed(deps: MapFeedDeps): () => void {
  const every = deps.everyMs ?? READINGS_EVERY_MS;
  const now = deps.now ?? Date.now;
  const sentAt = new Map<string, number>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const stages = new Map<string, string>();

  const sendClient = (clientId: string) => {
    const timer = pending.get(clientId);
    if (timer) clearTimeout(timer);
    pending.delete(clientId);
    sentAt.set(clientId, now());
    const info = deps.info(clientId);
    deps.send("client", info ?? { id: clientId, removed: true });
  };

  const stopHub = deps.onClientChange((clientId, change) => {
    if (change !== "readings") return sendClient(clientId);
    if (pending.has(clientId)) return;
    const wait = (sentAt.get(clientId) ?? -Infinity) + every - now();
    if (wait <= 0) return sendClient(clientId);
    const timer = setTimeout(() => sendClient(clientId), wait);
    timer.unref?.();
    pending.set(clientId, timer);
  });

  const stopLive = deps.subscribeLive?.((event) => {
    if (event.type !== "turn") return;
    const turn = event.turn;
    const stage: MapTurn["stage"] = turn.endedAt !== undefined ? "done" : turn.stages.at(-1)?.name ?? "listening";
    if (stages.get(turn.key) === stage) return;
    if (stage === "done") stages.delete(turn.key);
    else stages.set(turn.key, stage);
    const view: MapTurn = {
      key: turn.key,
      clientId: turn.clientId,
      stage,
      startedAt: turn.startedAt,
      ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
      ...(turn.outcome ? { outcome: turn.outcome } : {}),
    };
    deps.send("turn", view);
    sendClient(turn.clientId);
  });

  return () => {
    stopHub();
    stopLive?.();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  };
}
