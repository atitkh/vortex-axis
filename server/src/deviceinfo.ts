import type { Capability, Scalar, ScalarMap } from "@vortex-axis/protocol";
import type { Hub } from "./hub.js";
import type { ClientRecord, Store } from "./store.js";
import type { ClientNow } from "./turns.js";
import { olderThanHeld } from "./versions.js";
import type { ProfileName, ProfileReason } from "./profiles.js";

/**
 * One device as a plain object: who it is, whether it is here, what it is doing, and its vitals from the readings it
 * reported (`sense`). For the agent's `vortex.axis.sense`, the admin page's map and its attention list, so all of them
 * say the same thing. A reading a device did not send is left out, never guessed.
 *
 * The readings it understands (all optional): battery (0 to 100 %), charging (1/0), batteryMv, rssi (dBm), heap
 * (free bytes), uptimeS, chipTempC, pickupsToday, touchesToday, turnsToday, onPower (1/0), lastStart (why it last
 * started), soundDb and soundActive (1/0), and from a board's charger usbMv (USB input millivolts), chargerState (the
 * power chip's charge phase, CHARGER_PHASES) and chargeHeld (1 while the charge limit holds charging off). Boards send
 * them every minute; a vital (battery, charging, batteryMv, usbMv, chargerState, chargeHeld, chipTempC, rssi, heap,
 * soundDb, soundActive) that has not arrived for STALE_READING_MS is left out as
 * unknown, so a battery taken out of a running board stops being shown once the board stops reporting it.
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
  /** A board's charger: its phase, whether the charge limit holds it, USB volts, and all of it as one plain line. */
  charger?: {
    state?: number;
    held?: boolean;
    /** The charge limit in force when it is held (`chargeLimit` as sent, after the profile). */
    limit?: number;
    usbMv?: number;
    /** For the admin page's detail only, never spoken: "USB 4.98 V". */
    usbText?: string;
    /** "charging (constant current)", "charging, tapering", "full", "held at 80% by the charge limit", "not charging". */
    line?: string;
  };
}

/** The power chip's charge phases by `chargerState` (AXP2101 register 0x01, low three bits). */
export const CHARGER_PHASES = ["trickle", "pre-charge", "constant current", "constant voltage", "done", "stopped"] as const;

/** The charger in plain words, from the readings and the charge limit in force. Undefined when nothing was reported. */
export function chargerLine(state: number | undefined, held: boolean | undefined, limit: number | undefined): string | undefined {
  if (held) return limit !== undefined && limit < 100 ? `held at ${limit}% by the charge limit` : "held by the charge limit";
  if (state === undefined) return undefined;
  if (state === 0 || state === 1 || state === 2) return `charging (${CHARGER_PHASES[state]})`;
  if (state === 3) return "charging, tapering";
  if (state === 4) return "full";
  return "not charging";
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
  /** A newer build Axis holds for it, when there is one (server/src/versions.ts decides). */
  updateAvailable?: string;
  capabilities: { reported: Capability[]; off: Capability[]; effective: Capability[] };
  state: DeviceState;
  stateSince?: number;
  vitals: Vitals;
  /** Short things to look at ("battery low (14%)"), worst first; empty when it is fine. */
  attention: string[];
  /** How long it may be offline before that is listed under attention; null for never. */
  offlineAfterMs: number | null;
  /** The profile it is on (profiles.ts) and why: chosen by hand, the battery rule, or "auto" with no rule in force. */
  profile: ProfileName;
  profileReason: ProfileReason;
  /** The charge limit it is sent (its own `chargeLimit`, or Dock's); absent when not known. */
  chargeLimit?: number;
}

export interface DeviceInput {
  client: ClientRecord;
  /** Its resolved settings (location, offlineAlert). */
  settings: ScalarMap;
  /** Its live connection, when online. */
  session?: { connectedAt: number; readings: ScalarMap; readAt?: Record<string, number> } | undefined;
  /** What it is in the middle of, when anything. */
  now?: ClientNow | undefined;
  /** The version of the build Axis holds for its type, if any. */
  held?: string | undefined;
  /** Its profile, from `Hub.profile`; normal when not given. */
  profile?: { profile: ProfileName; reason: ProfileReason } | undefined;
  /** The `chargeLimit` it is sent (its own, or Dock's), for the charger line. */
  chargeLimit?: number | undefined;
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

  private extra: (clientId: string) => string[] = () => [];

  /** Adds items to every device's attention list (a firmware rollout's held boards). */
  useAttention(extra: (clientId: string) => string[]): void {
    this.extra = extra;
  }

  info(client: ClientRecord, doing = this.hub.doing()): DeviceInfo {
    const info = deviceInfo(
      {
        client,
        settings: this.store.resolveSettings(client),
        session: this.hub.session(client.id),
        now: doing.find((d) => d.clientId === client.id),
        held: this.held(client.type),
        profile: this.hub.profile(client),
        chargeLimit: number(this.hub.effectiveSettings(client).chargeLimit),
      },
      this.now(),
    );
    info.attention.push(...this.extra(client.id));
    return info;
  }

  all(): DeviceInfo[] {
    const doing = this.hub.doing();
    return this.store.listClients().map((client) => this.info(client, doing));
  }
}

export function deviceInfo(input: DeviceInput, at: number): DeviceInfo {
  const { client, settings, session } = input;
  const readings = fresh(session, at);
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
    ...(input.held && olderThanHeld(client.version, input.held) ? { updateAvailable: input.held } : {}),
    capabilities: { reported: client.reported, off: client.off, effective: client.capabilities },
    state: !online ? "offline" : input.now?.state ?? "idle",
    ...(online && input.now ? { stateSince: input.now.since } : {}),
    vitals: vitals(readings, input.chargeLimit),
    attention: [],
    offlineAfterMs: offlineAfterMs(kind, settings.offlineAlert),
    profile: input.profile?.profile ?? "normal",
    profileReason: input.profile?.reason ?? "auto",
    ...(input.chargeLimit !== undefined ? { chargeLimit: input.chargeLimit } : {}),
  };
  info.attention = attention(info, at);
  return info;
}

/** How long a vital reading counts after it last arrived: five of a board's minutely reports. */
export const STALE_READING_MS = 5 * 60_000;
const VITAL_KEYS = ["battery", "charging", "batteryMv", "usbMv", "chargerState", "chargeHeld", "chipTempC", "rssi", "heap", "soundDb", "soundActive"];

/** The readings without the vitals that have not arrived for STALE_READING_MS. */
export function fresh(session: DeviceInput["session"], at: number): ScalarMap {
  const readings = session?.readings ?? {};
  const readAt = session?.readAt;
  if (!readAt) return readings;
  const stale = VITAL_KEYS.filter((key) => key in readings && readAt[key] !== undefined && at - readAt[key]! > STALE_READING_MS);
  if (!stale.length) return readings;
  const out = { ...readings };
  for (const key of stale) delete out[key];
  return out;
}

function vitals(readings: ScalarMap, chargeLimit?: number): Vitals {
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
  const rawState = number(readings.chargerState);
  const state = rawState !== undefined && Number.isInteger(rawState) && rawState >= 0 && rawState < CHARGER_PHASES.length ? rawState : undefined;
  const held = flag(readings.chargeHeld);
  const usbMv = number(readings.usbMv);
  if (state !== undefined || held !== undefined || usbMv !== undefined) {
    const line = chargerLine(state, held, chargeLimit);
    out.charger = {
      ...(state !== undefined ? { state } : {}),
      ...(held !== undefined ? { held } : {}),
      ...(held && chargeLimit !== undefined ? { limit: chargeLimit } : {}),
      ...(usbMv !== undefined ? { usbMv, usbText: `USB ${(usbMv / 1000).toFixed(2)} V` } : {}),
      ...(line ? { line } : {}),
    };
  }
  return out;
}

/** The admin page's rules for a device: offline past its alert time, never connected, a newer build held, plus vitals. */
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
    // The charger only when it explains the battery: held by the limit, or full. USB volts are never spoken.
    const charger = info.vitals.charger;
    if (charger?.held || charger?.line === "full") parts.push(charger.line!);
    if (onPower === true) parts.push("on power");
    else if (onPower === false && battery?.percent === undefined) parts.push("on battery");
    if (signal) parts.push(`${signal.label} Wi-Fi`);
    if (uptime) parts.push(`up ${uptime.text}`);
  }
  if (info.profile === "dock") parts.push(dockLine(info.chargeLimit));
  else if (info.profile !== "normal") parts.push(`on ${info.profile === "power-saver" ? "power saver" : info.profile}${info.profileReason === "battery" ? " for its low battery" : ""}`);
  if (info.updateAvailable) parts.push("an update is waiting");
  return `${info.name}: ${parts.join(", ")}.`;
}

/** What Dock does, in a few words: "Dock: charging held at 80%". */
export function dockLine(limit: number | undefined): string {
  return limit !== undefined && limit < 100 ? `Dock: charging held at ${limit}%` : "Dock: no charge limit";
}

/** The device needing attention most: the lowest battery not charging (nor held by the charge limit), else the weakest signal; undefined when none. */
export function lowest(infos: DeviceInfo[]): { client: string; reason: string } | undefined {
  // A battery held by the charge limit is on USB, not running down.
  const batteries = infos.filter((i) => i.vitals.battery?.percent !== undefined && !i.vitals.battery.charging && !i.vitals.charger?.held);
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
