import { randomUUID } from "node:crypto";
import type { ScalarMap } from "@vortex-axis/protocol";
import { olderThanHeld } from "./versions.js";

/**
 * Staged rollout of board firmware ("Update all" on the admin page). One board goes first (the canary); the rest
 * follow only once it is proven, at most `parallel` at a time. A board counts as proven when it has connected again
 * after it was told to update, reports the build it was sent and has sent fresh readings: by then it has reached
 * Axis, which is when its firmware keeps the new build instead of rolling back (`axis_client.cpp`, `UNPROVEN_MS`).
 * A canary that comes back on another version, never comes back or refuses stops the rollout and holds the rest.
 *
 * Runs on the server, so closing the admin page does not stop it. One at a time. The state is in memory and saved
 * in `meta` on every change; a rollout that was running when Axis stopped is marked interrupted at the next start,
 * never resumed.
 */

export type RolloutState = "running" | "stopping" | "done" | "aborted" | "cancelled" | "interrupted";
export type RolloutStatus = "waiting" | "updating" | "proven" | "held" | "skipped" | "failed";

export interface RolloutDevice {
  id: string;
  name: string;
  type: string;
  /** The version it was on when the rollout started. */
  from: string;
  /** The version it is sent. */
  to: string;
  /** The version it reports now, when it is connected. */
  version?: string | undefined;
  status: RolloutStatus;
  /** Why it is held, skipped or failed; what it is waiting for. */
  detail?: string | undefined;
  canary?: boolean | undefined;
  sentAt?: number | undefined;
  doneAt?: number | undefined;
}

export interface RolloutView {
  id: string;
  state: RolloutState;
  /** "canary" until the canary is proven, then "rest"; "finished" once nothing more will happen. */
  stage: "canary" | "rest" | "finished";
  startedAt: number;
  endedAt?: number | undefined;
  /** Why it stopped early (abort, cancel, restart). */
  reason?: string | undefined;
  canary?: string | undefined;
  /** Why that board was picked to go first. */
  canaryWhy?: string | undefined;
  devices: RolloutDevice[];
}

/** What the rollout needs of a connected board. */
export interface RolloutSession {
  connectedAt: number;
  readings: ScalarMap;
  readAt: Record<string, number>;
}

export interface RolloutDeps {
  /** A paired client's name, type and the version it last reported. */
  client: (id: string) => { id: string; name: string; type: string; version: string } | undefined;
  /** Every paired client's id. */
  clientIds: () => string[];
  /** Its live connection, when online. */
  session: (id: string) => RolloutSession | undefined;
  /** Whether it is in the middle of a turn. */
  busy: (id: string) => boolean;
  /** The firmware version Axis sends to a type; undefined when none (or the type is not a board). */
  target: (type: string) => string | undefined;
  /** Tells a board to update; throws with the reason when it does not take the command. */
  send: (id: string) => Promise<void>;
  /** Writes to the activity log. */
  note: (subject: string, text: string, level: "info" | "warn" | "bad") => void;
  load?: () => string | undefined;
  save?: (json: string) => void;
  now?: () => number;
  /** How often the rollout looks at its boards while running; 0 for never (tests call `tick`). */
  everyMs?: number;
  /** How long a board told to update has to come back proven. Longer than the firmware's own 3-minute window. */
  waitMs?: number;
  /** How long a board may stay busy before it is skipped. */
  busyMs?: number;
  /** How many boards after the canary update at once. */
  parallel?: number;
}

export const ROLLOUT_WAIT_MS = 6 * 60_000;
export const ROLLOUT_BUSY_MS = 15 * 60_000;
export const ROLLOUT_PARALLEL = 2;

export class RolloutBusy extends Error {}

export class Rollouts {
  private current: RolloutView | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** When each waiting board was first found busy. */
  private busySince = new Map<string, number>();
  private sending = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: RolloutDeps) {
    this.now = deps.now ?? Date.now;
    this.current = this.restore();
  }

  /** The current or last rollout; undefined when there has been none. */
  view(): RolloutView | undefined {
    if (!this.current) return undefined;
    return { ...this.current, devices: this.current.devices.map((d) => ({ ...d, version: this.deps.client(d.id)?.version ?? d.version })) };
  }

  running(): boolean {
    return this.current?.state === "running" || this.current?.state === "stopping";
  }

  /**
   * Starts a rollout over the given boards, or every board on an older build than Axis holds for it (offline ones
   * are listed as skipped).
   * Throws `RolloutBusy` while one runs, and an Error when there is nothing to update.
   */
  start(ids?: string[]): RolloutView {
    if (this.running()) throw new RolloutBusy("a rollout is already running");
    const devices: RolloutDevice[] = [];
    const chosen = ids ?? this.deps.clientIds();
    for (const id of [...new Set(chosen)]) {
      const client = this.deps.client(id);
      if (!client) throw new Error(`no such client: ${id}`);
      const to = this.deps.target(client.type);
      const base = { id, name: client.name, type: client.type, from: client.version, to: to ?? "" };
      if (!to) {
        if (ids) devices.push({ ...base, status: "skipped", detail: "no firmware build is held for its type" });
        continue;
      }
      if (!olderThanHeld(client.version, to)) {
        if (ids) devices.push({ ...base, status: "skipped", detail: `already on ${client.version}` });
        continue;
      }
      if (!this.deps.session(id)) devices.push({ ...base, status: "skipped", detail: "offline" });
      else devices.push({ ...base, status: "waiting" });
    }
    if (!devices.some((d) => d.status === "waiting")) throw new Error("no connected board is on an older build than the one Axis holds for it");
    this.busySince.clear();
    this.current = { id: randomUUID(), state: "running", stage: "canary", startedAt: this.now(), devices };
    const waiting = devices.filter((d) => d.status === "waiting").length;
    this.deps.note("rollout", `Rollout started over ${waiting} board${waiting === 1 ? "" : "s"}: one first, the rest once it is proven`, "info");
    this.changed();
    if ((this.deps.everyMs ?? 2000) > 0) {
      this.timer = setInterval(() => this.tick(), this.deps.everyMs ?? 2000);
      this.timer.unref?.();
    }
    this.tick();
    return this.view()!;
  }

  /** Sends no more updates. Boards already told to update are still watched until they come back or time out. */
  cancel(): RolloutView | undefined {
    const r = this.current;
    if (!r || !this.running()) return this.view();
    r.reason = r.reason ?? "cancelled from the admin page";
    for (const d of r.devices) if (d.status === "waiting") Object.assign(d, { status: "skipped", detail: "cancelled" });
    r.state = "stopping";
    this.deps.note("rollout", "Rollout cancelled: no more boards will be sent the update", "warn");
    this.settle("cancelled");
    this.changed();
    return this.view();
  }

  /** Why each held board is held, for the attention list. Empty once it is on the build anyway. */
  attention(id: string): string[] {
    const d = this.current?.devices.find((x) => x.id === id && x.status === "held");
    if (!d || this.running()) return [];
    const client = this.deps.client(id);
    if (client && !olderThanHeld(client.version, d.to)) return [];
    return [`update held (${d.detail ?? "rollout stopped"})`];
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Looks at every board once: notes what came back, sends what may go next. */
  tick(): void {
    const r = this.current;
    if (!r || !this.running()) return;
    const at = this.now();
    const wait = this.deps.waitMs ?? ROLLOUT_WAIT_MS;
    for (const d of r.devices) {
      if (d.status !== "updating" || this.sending.has(d.id)) continue;
      const client = this.deps.client(d.id);
      const session = this.deps.session(d.id);
      const back = session && d.sentAt !== undefined && session.connectedAt > d.sentAt;
      if (back && client?.version === d.to && Object.values(session.readAt).some((t) => t >= session.connectedAt)) {
        this.finish(d, "proven", undefined);
      } else if (back && client && client.version !== d.to && !olderThanHeld(d.to, client.version)) {
        this.finish(d, "failed", `came back on ${client.version} instead of ${d.to}: the new build rolled back or did not install`);
      } else if (at - (d.sentAt ?? at) > wait) {
        this.finish(d, "failed", back ? `came back on ${d.to} but sent no readings within ${minutes(wait)}` : `did not come back within ${minutes(wait)}`);
      }
    }
    if (r.state === "running") this.sendNext(at);
    this.settle(r.state === "stopping" && r.reason?.startsWith("cancelled") ? "cancelled" : "aborted");
    this.changed();
  }

  private sendNext(at: number): void {
    const r = this.current!;
    const canary = r.devices.find((d) => d.canary);
    if (canary && canary.status !== "proven") return;
    if (canary) r.stage = "rest";
    const room = canary ? (this.deps.parallel ?? ROLLOUT_PARALLEL) - r.devices.filter((d) => d.status === "updating").length : 1;
    if (room <= 0) return;
    const free: RolloutDevice[] = [];
    for (const d of r.devices.filter((x) => x.status === "waiting")) {
      if (!this.deps.session(d.id)) {
        Object.assign(d, { status: "skipped", detail: "offline" });
        continue;
      }
      if (this.deps.busy(d.id)) {
        const since = this.busySince.get(d.id) ?? at;
        this.busySince.set(d.id, since);
        if (at - since > (this.deps.busyMs ?? ROLLOUT_BUSY_MS)) Object.assign(d, { status: "skipped", detail: `busy in a turn for ${minutes(at - since)}` });
        else d.detail = "busy in a turn; tried again shortly";
        continue;
      }
      this.busySince.delete(d.id);
      d.detail = undefined;
      free.push(d);
    }
    if (!canary) {
      if (!free.length) return;
      const pick = pickCanary(free, (id) => this.deps.session(id));
      pick.device.canary = true;
      r.canary = pick.device.id;
      r.canaryWhy = pick.why;
      this.deps.note("rollout", `${pick.device.name} goes first (${pick.why})`, "info");
      this.send(pick.device);
      return;
    }
    for (const d of free.slice(0, room)) this.send(d);
  }

  private send(d: RolloutDevice): void {
    d.status = "updating";
    d.sentAt = this.now();
    d.detail = undefined;
    this.sending.add(d.id);
    this.deps.send(d.id).then(
      () => {
        this.sending.delete(d.id);
        this.deps.note(d.id, `${d.name} told to update from ${d.from} to ${d.to}${d.canary ? " (first of the rollout)" : ""}`, "info");
        this.changed();
      },
      (error: unknown) => {
        this.sending.delete(d.id);
        this.finish(d, "failed", `did not take the update: ${(error as Error).message}`);
        this.tick();
      },
    );
  }

  private finish(d: RolloutDevice, status: "proven" | "failed", detail: string | undefined): void {
    const r = this.current!;
    Object.assign(d, { status, detail, doneAt: this.now() });
    if (status === "proven") {
      this.deps.note(d.id, `${d.name} is proven on ${d.to}${d.canary ? "; the rest follow" : ""}`, "info");
      return;
    }
    this.deps.note(d.id, `${d.name} ${detail}`, "bad");
    if (r.state !== "running") return;
    const reason = d.canary ? `the first board, ${d.name}, ${detail}` : `${d.name} ${detail}`;
    r.reason = reason;
    r.state = "stopping";
    let held = 0;
    for (const x of r.devices) {
      if (x.status !== "waiting") continue;
      Object.assign(x, { status: "held", detail: reason });
      held++;
    }
    this.deps.note("rollout", `Rollout stopped: ${reason}.${held ? ` ${held} board${held === 1 ? "" : "s"} held on the old build.` : ""}`, "bad");
  }

  /** Ends a stopping rollout once nothing is in flight, and a running one once every board is through. */
  private settle(stopped: "aborted" | "cancelled"): void {
    const r = this.current!;
    if (r.devices.some((d) => d.status === "updating")) return;
    if (r.state === "running" && r.devices.some((d) => d.status === "waiting")) return;
    const end: RolloutState = r.state === "stopping" ? stopped : "done";
    r.state = end;
    r.stage = "finished";
    r.endedAt = this.now();
    this.close();
    if (end === "done") {
      const proven = r.devices.filter((d) => d.status === "proven").length;
      const skipped = r.devices.filter((d) => d.status === "skipped").length;
      this.deps.note("rollout", `Rollout finished: ${proven} board${proven === 1 ? "" : "s"} updated${skipped ? `, ${skipped} skipped` : ""}`, "info");
    }
  }

  private changed(): void {
    if (this.current) this.deps.save?.(JSON.stringify(this.current));
  }

  /** The last rollout from `meta`; one that was running when Axis stopped is marked interrupted. */
  private restore(): RolloutView | undefined {
    let saved: RolloutView | undefined;
    try {
      const text = this.deps.load?.();
      saved = text ? (JSON.parse(text) as RolloutView) : undefined;
    } catch {
      return undefined;
    }
    if (!saved || !Array.isArray(saved.devices)) return undefined;
    if (saved.state === "running" || saved.state === "stopping") {
      const reason = "Axis restarted during the rollout; it is not resumed";
      saved.state = "interrupted";
      saved.stage = "finished";
      saved.endedAt = this.now();
      saved.reason = saved.reason ?? reason;
      for (const d of saved.devices) {
        if (d.status === "waiting") Object.assign(d, { status: "held", detail: reason });
        else if (d.status === "updating") Object.assign(d, { status: "skipped", detail: "Axis restarted while it was updating; not watched" });
      }
      this.deps.note("rollout", `Rollout interrupted: ${reason}`, "warn");
      this.deps.save?.(JSON.stringify(saved));
    }
    return saved;
  }
}

/** The board that goes first: of those not busy, the one with the strongest Wi-Fi; one with no signal reading last. */
export function pickCanary(free: RolloutDevice[], session: (id: string) => RolloutSession | undefined): { device: RolloutDevice; why: string } {
  const rssi = (d: RolloutDevice) => {
    const v = session(d.id)?.readings.rssi;
    return typeof v === "number" ? v : undefined;
  };
  const ranked = [...free].sort((a, b) => (rssi(b) ?? -Infinity) - (rssi(a) ?? -Infinity));
  const device = ranked[0]!;
  const signal = rssi(device);
  const why =
    free.length === 1 ? "the only board free to update" : signal !== undefined ? `not in a turn, strongest Wi-Fi at ${signal} dBm` : "not in a turn; no board reported its Wi-Fi signal";
  return { device, why };
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 1 ? `${m} minute${m === 1 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`;
}
