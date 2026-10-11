import type { Activity } from "./activity.js";
import type { Hub, Session } from "./hub.js";
import type { Store, TimerRecord } from "./store.js";

/** How often a timer that could not be announced is tried again, and for how long. */
const RETRY_MS = 15_000;
const GIVE_UP_MS = 10 * 60_000;
/** setTimeout cannot wait longer than this; a longer timer is simply re-armed. */
const MAX_WAIT_MS = 2 ** 31 - 1;
export const MAX_TIMER_SECONDS = 7 * 24 * 3600;
export const MAX_TIMERS = 50;

export interface TimersOptions {
  store: Store;
  hub: Hub;
  activity?: Activity | undefined;
  now?: () => number;
  log?: (line: string) => void;
  retryMs?: number;
  /** How long a device's chime is given before the words start. */
  chimeMs?: number;
}

/** "5 minute", "1 hour 30 minute", "45 second": a length of time as it is said before the word "timer". */
export function spokenLength(seconds: number): string {
  const parts: string[] = [];
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) parts.push(`${hours} hour`);
  if (minutes) parts.push(`${minutes} minute`);
  if (rest || !parts.length) parts.push(`${rest} second`);
  return parts.join(" ");
}

/**
 * Timers agents set for a person. Axis keeps them, not the client, so one
 * survives a device restart and can be announced somewhere else when its own
 * device is off. When one is due it is spoken on its own client only; every
 * client with a screen is kept told of the next timer so it can count down.
 */
export class Timers {
  private readonly store: Store;
  private readonly hub: Hub;
  private readonly activity: Activity | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly retryMs: number;
  private readonly chimeMs: number;
  private wait: NodeJS.Timeout | undefined;
  /** When each overdue timer is next tried. */
  private readonly retryAt = new Map<number, number>();
  private readonly firing = new Set<number>();
  private stopped = false;
  private readonly changeListeners: (() => void)[] = [];

  constructor(options: TimersOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.activity = options.activity;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.chimeMs = options.chimeMs ?? 900;
    this.hub.onConnect((session) => this.tell(session));
  }

  /** Called after every change to the timers: one set, cancelled or gone off. */
  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  start(): void {
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.wait) clearTimeout(this.wait);
  }

  set(session: Session, seconds: number, label: string): TimerRecord {
    if (this.store.listTimers().length >= MAX_TIMERS) throw new Error(`there are already ${MAX_TIMERS} timers running`);
    const now = this.now();
    const timer = this.store.addTimer({
      clientId: session.client.id,
      label: label.slice(0, 60),
      seconds,
      dueAt: now + seconds * 1000,
      createdAt: now,
    });
    this.activity?.note("timer", timer.clientId, `Timer set on ${session.client.name}: ${this.name(timer)}`);
    this.arm();
    this.tell();
    return timer;
  }

  list(clientId?: string): TimerRecord[] {
    return this.store.listTimers().filter((t) => clientId === undefined || t.clientId === clientId);
  }

  /** Cancels the timers that match everything given. With nothing given, none. */
  cancel(match: { id?: number | undefined; label?: string | undefined; clientId?: string | undefined; all?: boolean }): TimerRecord[] {
    if (match.id === undefined && match.label === undefined && match.clientId === undefined && !match.all) return [];
    const label = match.label?.toLowerCase();
    const gone = this.store.listTimers().filter(
      (t) =>
        (match.id === undefined || t.id === match.id) &&
        (label === undefined || t.label.toLowerCase() === label) &&
        (match.clientId === undefined || t.clientId === match.clientId),
    );
    for (const timer of gone) {
      this.store.removeTimer(timer.id);
      this.retryAt.delete(timer.id);
      this.activity?.note("timer", timer.clientId, `Timer cancelled: ${this.name(timer)}`);
    }
    if (gone.length) {
      this.arm();
      this.tell();
    }
    return gone;
  }

  /** "pasta" or "5 minute": what a timer is called when it is spoken. */
  name(timer: TimerRecord): string {
    return timer.label || spokenLength(timer.seconds);
  }

  /** Sets the one wake-up for whichever timer needs attention soonest. */
  private arm(): void {
    if (this.wait) clearTimeout(this.wait);
    this.wait = undefined;
    if (this.stopped) return;
    const times = this.store
      .listTimers()
      .filter((t) => !this.firing.has(t.id))
      .map((t) => this.retryAt.get(t.id) ?? t.dueAt);
    if (!times.length) return;
    const delay = Math.min(MAX_WAIT_MS, Math.max(0, Math.min(...times) - this.now()));
    this.wait = setTimeout(() => this.tick(), delay);
    this.wait.unref();
  }

  private tick(): void {
    const now = this.now();
    for (const timer of this.store.listTimers()) {
      if (this.firing.has(timer.id) || (this.retryAt.get(timer.id) ?? timer.dueAt) > now) continue;
      void this.fire(timer);
    }
    this.arm();
  }

  /** Announces a timer that is due. One that cannot be announced yet is kept and tried again. */
  private async fire(timer: TimerRecord): Promise<void> {
    this.firing.add(timer.id);
    try {
      const session = this.outputFor(timer);
      const lateMin = Math.round((this.now() - timer.dueAt) / 60_000);
      const words =
        lateMin >= 1
          ? `Your ${this.name(timer)} timer finished ${lateMin} minute${lateMin === 1 ? "" : "s"} ago.`
          : `Your ${this.name(timer)} timer is done.`;
      // A device with a chime plays it first, so the words are not the first thing heard.
      if (this.store.getSchema(session.client.type)?.actions.some((a) => a.name === "chime")) {
        const chimed = await this.hub.command(session, "chime", undefined, 3000).catch(() => undefined);
        // Speech that starts while the chime is still sounding cuts it off, and can be cut off by it.
        if (chimed?.ok) await new Promise((resolve) => setTimeout(resolve, this.chimeMs));
      }
      const { heard } = await this.hub.say(session, words);
      this.store.removeTimer(timer.id);
      this.retryAt.delete(timer.id);
      this.activity?.note("timer", timer.clientId, `Timer done: ${this.name(timer)}, on ${session.client.name}${heard ? "" : " (not confirmed as heard)"}`);
    } catch (error) {
      if (this.now() - timer.dueAt >= GIVE_UP_MS) {
        this.store.removeTimer(timer.id);
        this.retryAt.delete(timer.id);
        this.activity?.note("timer", timer.clientId, `Timer "${this.name(timer)}" could not be announced: ${(error as Error).message}`, "warn");
      } else {
        this.log(`timer ${timer.id} not announced yet: ${(error as Error).message}`);
        this.retryAt.set(timer.id, this.now() + this.retryMs);
      }
    } finally {
      this.firing.delete(timer.id);
      if (!this.stopped) {
        this.arm();
        this.tell();
      }
    }
  }

  /** The timer's own client when it can speak or show text now; otherwise wherever agent speech goes. */
  private outputFor(timer: TimerRecord): Session {
    const own = this.hub.session(timer.clientId);
    const caps = own?.client.capabilities ?? [];
    if (own && (caps.includes("speaker") || caps.includes("screen"))) return own;
    return this.hub.pickOutput({});
  }

  /**
   * Tells every client with a screen which timer is next, so each can count
   * down. A timer shows everywhere but is announced only where it was set.
   */
  private tell(only?: Session): void {
    const all = this.list();
    if (!only) for (const listener of this.changeListeners) listener();
    const next = all[0];
    const params = next
      ? // An unnamed timer is shown as "Timer 0:42". Its length would read like a second timer starting.
        // The id lets a client with a cancel button say which timer it means.
        { label: next.label || "Timer", ms: Math.max(1, next.dueAt - this.now()), count: all.length, id: next.id }
      : { label: "", ms: 0, count: 0 };
    for (const session of only ? [only] : this.hub.sessions()) {
      if (!session.client.capabilities.includes("screen")) continue;
      // A client that shows no countdown says so or says nothing; either is fine.
      this.hub.command(session, "timer.next", params, 3000).catch(() => undefined);
    }
  }
}
