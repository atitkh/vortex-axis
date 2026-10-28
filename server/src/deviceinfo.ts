import type { Capability, Scalar, ScalarMap } from "@vortex-axis/protocol";
import type { Hub } from "./hub.js";
import type { ClientRecord, Store } from "./store.js";
import type { ClientNow } from "./turns.js";

/**
 * One device as a plain object: who it is, whether it is here, what it is doing, and its vitals from the readings it
 * reported (`sense`). For the agent's `vortex.axis.sense`, the admin page's map and its attention list, so all of them
 * say the same thing. A reading a device did not send is left out, never guessed.
 *
 * The readings it understands (all optional): battery (0 to 100 %), charging (1/0), batteryMv, rssi (dBm), heap
 * (free bytes), uptimeS, chipTempC, pickupsToday, touchesToday, turnsToday, onPower (1/0), lastStart (why it last
 * started), soundDb and soundActive (1/0).
 */

/** What kind of thing a device is: for its picture and for when being offline matters. */
export type DeviceKind = "board" | "round" | "browser" | "computer" | "headset";

export function deviceKind(client: Pick<ClientRecord, "type" | "reported" | "capabilities">, readings: ScalarMap = {}): DeviceKind {
  if (client.type === "web") return "browser";
  if (client.type === "meta-quest" || client.type === "quest-panels") return "headset";
  if (client.reported.includes("desktop")) return "computer";
  if (number(readings.screenRound) === 1) return "round";
  return "board";
}

/** How long each kind may be offline before it needs attention, when its Offline alert setting is "auto". Absent: never. */
export const AUTO_OFFLINE_MS: Partial<Record<DeviceKind, number>> = {
  board: 15 * 60_000,
  round: 15 * 60_000,
  computer: 12 * 3_600_000,
  headset: 12 * 3_600_000,
};

/** How long this device may be offline before it needs attention, by its `offlineAlert` setting; null for never. */
export function offlineAfterMs(kind: DeviceKind, offlineAlert: Scalar | undefined): number | null {
  if (offlineAlert === "never") return null;
  if (offlineAlert === "always") return 10 * 60_000;
  return AUTO_OFFLINE_MS[kind] ?? null;
}

/**
 * Wi-Fi signal in words. RSSI in dBm: strong at -60 and above, ok down to -70, weak down to -80, poor below that.
 * Weak and poor are listed under attention: voice streaming starts to stutter there.
 */
export function signalLabel(rssi: number): "strong" | "ok" | "weak" | "poor" {
  if (rssi >= -60) return "strong";
  if (rssi >= -70) return "ok";
  if (rssi >= -80) return "weak";
  return "poor";
}

/** A battery under this many percent is low (listed under attention unless it is charging). */
export const LOW_BATTERY = 20;

export interface Vitals {
  battery?: { percent?: number; charging?: boolean; millivolts?: number; label?: "low" | "ok" };
  signal?: { rssi: number; label: ReturnType<typeof signalLabel> };
  uptime?: { seconds: number; text: string };
  memory?: { freeBytes: number };
  chipTempC?: number;
  usage?: { pickupsToday?: number; touchesToday?: number; turnsToday?: number };
  onPower?: boolean;
  /** Why it last started, as the device words it (a reset reason on a board). */
  lastRestart?: string;
  sound?: { db?: number; active?: boolean };
}

export type DeviceState = "offline" | "idle" | ClientNow["state"];

export interface DeviceInfo {
  id: string;
  name: string;
  type: string;
  kind: DeviceKind;
  location?: string;
  online: boolean;
  /** When the current connection started; absent when offline. */
  connectedSince?: number;
  /** When it was last connected; null if it never was. Now, when it is online. */
  lastSeen: number | null;
  /** Its firmware or app version, as it said in its `hello`. */
  version: string;
  /** A different build Axis holds for it, when there is one. */
  updateAvailable?: string;
  capabilities: { reported: Capability[]; off: Capability[]; effective: Capability[] };
  state: DeviceState;
  stateSince?: number;
  vitals: Vitals;
  /** Short things to look at ("battery low (14%)"), worst first; empty when it is fine. */
  attention: string[];
  /** How long it may be offline before that is listed under attention; null for never. */
  offlineAfterMs: number | null;
}

export interface DeviceInput {
  client: ClientRecord;
  /** Its resolved settings (location, offlineAlert). */
  settings: ScalarMap;
  /** Its live connection, when online. */
  session?: { connectedAt: number; readings: ScalarMap } | undefined;
  /** What it is in the middle of, when anything. */
  now?: ClientNow | undefined;
  /** The version of the build Axis holds for its type, if any. */
  held?: string | undefined;
}

/** Builds DeviceInfo for the clients Axis knows, from the store, the connected sessions and the builds it holds. */
export class Devices {
  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    /** The version of the build Axis holds for a client type, if any. */
    private readonly held: (type: string) => string | undefined = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  info(client: ClientRecord, doing = this.hub.doing()): DeviceInfo {
    return deviceInfo(
      {
        client,
        settings: this.store.resolveSettings(client),
        session: this.hub.session(client.id),
        now: doing.find((d) => d.clientId === client.id),
        held: this.held(client.type),
      },
      this.now(),
    );
  }

  all(): DeviceInfo[] {
    const doing = this.hub.doing();
    return this.store.listClients().map((client) => this.info(client, doing));
  }
}

export function deviceInfo(input: DeviceInput, at: number): DeviceInfo {
  const { client, settings, session } = input;
  const readings = session?.readings ?? {};
  const kind = deviceKind(client, readings);
  const online = Boolean(session);
  const location = typeof settings.location === "string" && settings.location.trim() ? settings.location.trim() : undefined;
  const info: DeviceInfo = {
    id: client.id,
    name: client.name,
    type: client.type,
    kind,
    ...(location ? { location } : {}),
    online,
    ...(session ? { connectedSince: session.connectedAt } : {}),
    lastSeen: online ? at : client.lastSeenAt,
    version: client.version,
    ...(input.held && client.version && input.held !== client.version ? { updateAvailable: input.held } : {}),
    capabilities: { reported: client.reported, off: client.off, effective: client.capabilities },
    state: !online ? "offline" : input.now?.state ?? "idle",
    ...(online && input.now ? { stateSince: input.now.since } : {}),
    vitals: vitals(readings),
    attention: [],
    offlineAfterMs: offlineAfterMs(kind, settings.offlineAlert),
  };
  info.attention = attention(info, at);
  return info;
}

function vitals(readings: ScalarMap): Vitals {
  const out: Vitals = {};
  const percent = number(readings.battery);
  const charging = flag(readings.charging);
  const millivolts = number(readings.batteryMv);
  if (percent !== undefined || charging !== undefined || millivolts !== undefined) {
    const p = percent === undefined ? undefined : Math.round(Math.min(100, Math.max(0, percent)));
    out.battery = {
      ...(p !== undefined ? { percent: p, label: p < LOW_BATTERY ? "low" : "ok" } : {}),
      ...(charging !== undefined ? { charging } : {}),
      ...(millivolts !== undefined ? { millivolts } : {}),
    };
  }
  const rssi = number(readings.rssi);
  if (rssi !== undefined) out.signal = { rssi, label: signalLabel(rssi) };
  const uptime = number(readings.uptimeS);
  if (uptime !== undefined && uptime >= 0) out.uptime = { seconds: Math.round(uptime), text: duration(uptime * 1000) };
  const heap = number(readings.heap);
  if (heap !== undefined) out.memory = { freeBytes: heap };
  const temp = number(readings.chipTempC);
  if (temp !== undefined) out.chipTempC = temp;
  const usage: NonNullable<Vitals["usage"]> = {};
  for (const key of ["pickupsToday", "touchesToday", "turnsToday"] as const) {
    const value = number(readings[key]);
    if (value !== undefined) usage[key] = value;
  }
  if (Object.keys(usage).length) out.usage = usage;
  const onPower = flag(readings.onPower);
  if (onPower !== undefined) out.onPower = onPower;
  if (typeof readings.lastStart === "string" && readings.lastStart) out.lastRestart = readings.lastStart;
  const db = number(readings.soundDb);
  const active = flag(readings.soundActive);
  if (db !== undefined || active !== undefined) out.sound = { ...(db !== undefined ? { db } : {}), ...(active !== undefined ? { active } : {}) };
  return out;
}

/** The admin page's rules for a device: offline past its alert time, never connected, a different build held, plus vitals. */
function attention(info: DeviceInfo, at: number): string[] {
  const items: string[] = [];
  if (!info.online && info.offlineAfterMs !== null) {
    if (info.lastSeen === null) items.push("never connected");
    else if (at - info.lastSeen > info.offlineAfterMs) items.push(`offline for ${duration(at - info.lastSeen)}`);
  }
  const battery = info.vitals.battery;
  if (battery?.label === "low" && !battery.charging) items.push(`battery low (${battery.percent}%)`);
  const signal = info.vitals.signal;
  if (signal && (signal.label === "weak" || signal.label === "poor")) items.push(`${signal.label} Wi-Fi (${signal.rssi} dBm)`);
  if (info.updateAvailable) items.push(`old firmware (${info.version}; ${info.updateAvailable} is available)`);
  return items;
}

/** One sentence about a device, written to be spoken. */
export function spokenSummary(info: DeviceInfo, at: number): string {
  const parts: string[] = [];
  if (!info.online) {
    parts.push(info.lastSeen === null ? "never connected" : `offline for ${duration(at - info.lastSeen)}`);
  } else {
    parts.push(info.state === "idle" || info.state === "offline" ? "online" : `online and ${info.state === "asked" ? "asking a question" : info.state}`);
    const { battery, signal, uptime, onPower } = info.vitals;
    if (battery?.percent !== undefined) {
      parts.push(`battery ${battery.percent}%${battery.charging ? " and charging" : battery.label === "low" ? ", low" : ""}`);
    } else if (battery?.charging) parts.push("charging");
    if (onPower === true) parts.push("on power");
    else if (onPower === false && battery?.percent === undefined) parts.push("on battery");
    if (signal) parts.push(`${signal.label} Wi-Fi`);
    if (uptime) parts.push(`up ${uptime.text}`);
  }
  if (info.updateAvailable) parts.push("an update is waiting");
  return `${info.name}: ${parts.join(", ")}.`;
}

/** The device needing attention most: the lowest battery not charging, else the weakest signal; undefined when none. */
export function lowest(infos: DeviceInfo[]): { client: string; reason: string } | undefined {
  const batteries = infos.filter((i) => i.vitals.battery?.percent !== undefined && !i.vitals.battery.charging);
  const low = batteries.sort((a, b) => a.vitals.battery!.percent! - b.vitals.battery!.percent!)[0];
  if (low) return { client: low.name, reason: `battery ${low.vitals.battery!.percent}%` };
  const weak = infos.filter((i) => i.vitals.signal).sort((a, b) => a.vitals.signal!.rssi - b.vitals.signal!.rssi)[0];
  if (weak) return { client: weak.name, reason: `${weak.vitals.signal!.label} Wi-Fi (${weak.vitals.signal!.rssi} dBm)` };
  return undefined;
}

/** A span in the largest whole unit: "3 days", "1 hour", "12 minutes", "less than a minute". */
export function duration(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(ms / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"}`;
  }
  return "less than a minute";
}

function number(value: Scalar | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function flag(value: Scalar | undefined): boolean | undefined {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return undefined;
}
