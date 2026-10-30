import type { Activity } from "./activity.js";
import type { Delivery } from "./delivery.js";
import type { Hub, Session } from "./hub.js";
import type { Progress } from "./progress.js";
import { describeWhen, nextOccurrence, parseRepeat, parseWhen, timeOfDayOf, weekdayOf } from "./recurrence.js";
import type { ReminderRecord, Store } from "./store.js";

/** setTimeout cannot wait longer than this; a longer wait is simply re-armed. */
const MAX_WAIT_MS = 2 ** 31 - 1;
export const MAX_REMINDERS = 100;
export const MAX_REMINDER_CHARS = 200;

export interface RemindersOptions {
  store: Store;
  hub: Hub;
  progress: Progress;
  /** Used for everywhere and quiet-hours routing. */
  delivery?: Delivery | undefined;
  activity?: Activity | undefined;
  /** Read at each use: the zone can be changed while Axis runs. */
  timeZone: () => string;
  /**
   * Has the agent say the reminder in one natural sentence on `session` (a plain turn that holds computers look-only).
   * `late` is how long past its time it is, in words, when it is. Without it the static line is said.
   */
  runLine?: (session: Session, reminder: ReminderRecord, late?: string) => Promise<{ handedOver: boolean; heard: boolean; silent: boolean }>;
  /** A notification for a phone that is away and has the page closed; nothing is promised about it. */
  tellPhones?: (title: string, body: string, tag: string) => void;
  /** A notification to every phone not online, away or not; how many were sent. */
  notifyAll?: (title: string, body: string, tag: string) => Promise<number>;
  now?: () => number;
  log?: (line: string) => void;
  /** How long after a failed first try the one retry waits. */
  retryMs?: number;
  /** How long a device's chime is given before the words start. */
  chimeMs?: number;
  /** A reminder this far past its time (after a restart) is missed, not spoken. */
  lateOkMs?: number;
  /** How long the line stays on the screens. */
  cardMs?: number;
}

/** What `Reminders.set` is given. `at` is the first (or only) time; `repeat` makes it repeat at that time of day. */
export interface ReminderInput {
  text: string;
  at: string;
  repeat?: string | undefined;
  clientId?: string | undefined;
  location?: string | undefined;
  everywhere?: boolean | undefined;
  urgent?: boolean | undefined;
}

/** Wall-clock reminders, once or on repeat, said wherever the person is when they are due. Kept apart from timers on purpose: nothing counts down. */
export class Reminders {
  private wait: NodeJS.Timeout | undefined;
  private stopped = true;
  private readonly firing = new Set<number>();
  private readonly changeListeners: (() => void)[] = [];
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly retryMs: number;
  private readonly chimeMs: number;
  private readonly lateOkMs: number;
  private readonly cardMs: number;

  constructor(private readonly options: RemindersOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.retryMs = options.retryMs ?? 300_000;
    this.chimeMs = options.chimeMs ?? 900;
    this.lateOkMs = options.lateOkMs ?? 6 * 3600_000;
    this.cardMs = options.cardMs ?? 60_000;
  }

  /** Called after every change to the reminders. */
  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.wait) clearTimeout(this.wait);
    this.wait = undefined;
  }

  set(input: ReminderInput): ReminderRecord {
    const text = (input.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_REMINDER_CHARS);
    if (!text) throw new Error("say what to remind them of");
    if (this.list().length >= MAX_REMINDERS) throw new Error(`there are ${MAX_REMINDERS} reminders already: cancel some first`);
    const zone = this.options.timeZone();
    const now = this.now();
    const dueAt = parseWhen(input.at, zone, now);
    const repeating = input.repeat !== undefined && input.repeat.trim() !== "";
    const days = repeating ? parseRepeat(input.repeat!, weekdayOf(dueAt, zone)) : undefined;
    const reminder = this.options.store.addReminder({
      text,
      dueAt,
      ...(repeating ? { timeOfDay: timeOfDayOf(dueAt, zone), days } : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.location ? { location: input.location } : {}),
      everywhere: Boolean(input.everywhere),
      urgent: Boolean(input.urgent),
      attempts: 0,
      missedCount: 0,
      createdAt: now,
    });
    this.options.activity?.note("reminder", reminder.clientId ?? "", `Reminder set for ${describeWhen(dueAt, zone)}${repeating ? ` (repeats ${input.repeat})` : ""}: ${text}`);
    this.arm();
    this.changed();
    return reminder;
  }

  list(): ReminderRecord[] {
    return this.options.store.listReminders();
  }

  /** Removes the reminders that match everything given (text is matched as part of the words). With nothing given, none. */
  cancel(match: { id?: number | undefined; text?: string | undefined; all?: boolean }): ReminderRecord[] {
    if (match.id === undefined && match.text === undefined && !match.all) return [];
    const text = match.text?.toLowerCase();
    const gone = this.list().filter((r) => (match.id === undefined || r.id === match.id) && (text === undefined || r.text.toLowerCase().includes(text)));
    for (const r of gone) {
      this.options.store.removeReminder(r.id);
      this.options.activity?.note("reminder", r.clientId ?? "", `Reminder cancelled: ${r.text}`);
    }
    if (gone.length) {
      this.arm();
      this.changed();
    }
    return gone;
  }

  /** Clears MISSED from the reminders that have it: a one-off goes, a repeating one keeps repeating. */
  dismiss(match: { id?: number | undefined; all?: boolean }): ReminderRecord[] {
    if (match.id === undefined && !match.all) return [];
    const gone = this.list().filter((r) => r.missedAt !== undefined && (match.id === undefined || r.id === match.id));
    for (const r of gone) {
      if (r.timeOfDay) this.options.store.updateReminder(r.id, { missedAt: undefined, missedCount: 0 });
      else this.options.store.removeReminder(r.id);
    }
    if (gone.length) {
      this.arm();
      this.changed();
    }
    return gone;
  }

  /** The hub's time zone changed: repeating reminders not yet due are worked out again, so 09:00 stays 09:00 there. */
  rezone(): void {
    const zone = this.options.timeZone();
    const now = this.now();
    for (const r of this.list()) {
      if (!r.timeOfDay || !r.days || r.dueAt === undefined || r.dueAt <= now || r.attempts > 0) continue;
      const dueAt = nextOccurrence({ timeOfDay: r.timeOfDay, days: r.days }, now, zone);
      if (dueAt !== r.dueAt) this.options.store.updateReminder(r.id, { dueAt });
    }
    this.arm();
    this.changed();
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  /** When a reminder next needs attention: its retry, else its due time. Missed one-offs have neither. */
  private timeOf(r: ReminderRecord): number | undefined {
    return r.retryAt ?? r.dueAt;
  }

  private arm(): void {
    if (this.wait) clearTimeout(this.wait);
    this.wait = undefined;
    if (this.stopped) return;
    const times = this.list()
      .filter((r) => !this.firing.has(r.id))
      .map((r) => this.timeOf(r))
      .filter((t): t is number => t !== undefined);
    if (!times.length) return;
    const delay = Math.min(MAX_WAIT_MS, Math.max(0, Math.min(...times) - this.now()));
    this.wait = setTimeout(() => this.tick(), delay);
    this.wait.unref();
  }

  private tick(): void {
    const now = this.now();
    for (const r of this.list()) {
      const at = this.timeOf(r);
      if (this.firing.has(r.id) || at === undefined || at > now) continue;
      void this.fire(r);
    }
    this.arm();
  }

  private async fire(r: ReminderRecord): Promise<void> {
    this.firing.add(r.id);
    try {
      const now = this.now();
      const lateMs = now - (r.dueAt ?? now);
      // After a long outage the moment has passed; saying it now would only confuse.
      if (lateMs > this.lateOkMs) {
        this.miss(r, `more than ${Math.round(this.lateOkMs / 3600_000)} hours late`);
        return;
      }
      const late = lateMs >= 120_000 ? `${Math.round(lateMs / 60_000)} minutes` : undefined;
      const ok = await this.deliver(r, late).catch((error: Error) => {
        this.log(`reminder ${r.id} not delivered: ${error.message}`);
        return false;
      });
      if (ok) this.done(r);
      else if (r.attempts === 0) {
        this.options.store.updateReminder(r.id, { attempts: 1, retryAt: this.now() + this.retryMs });
        this.options.activity?.note("reminder", r.clientId ?? "", `Reminder not delivered, will try again: ${r.text}`, "warn");
      } else this.miss(r, "not delivered on the second try");
    } finally {
      this.firing.delete(r.id);
      if (!this.stopped) this.arm();
      this.changed();
    }
  }

  /** The normal path: a line on every screen, a chime, the agent's one sentence (or the static line), phones. True when delivered. */
  private async deliver(r: ReminderRecord, late: string | undefined): Promise<boolean> {
    const { hub, progress, store } = this.options;
    const session = hub.pickOutput({});
    const plain = r.text.replace(/[.!?]+$/, "");
    const staticLine = `Reminder: ${plain}.${late ? ` It was due ${late} ago.` : ""}`;
    const screens = progress.notice(`reminder-${r.id}`, r.text, "Reminder", this.cardMs);
    this.options.tellPhones?.("Reminder", r.text, `reminder-${r.id}`);
    // A device with a chime plays it first, so the words are not the first thing heard.
    if (hub.profile(session.client).profile !== "silent" && store.getSchema(session.client.type)?.actions.some((a) => a.name === "chime")) {
      const chimed = await hub.command(session, "chime", undefined, 3000).catch(() => undefined);
      if (chimed?.ok) await new Promise((resolve) => setTimeout(resolve, this.chimeMs));
    }
    let said: { handedOver: boolean; heard: boolean; silent: boolean } | undefined;
    if (this.options.runLine) said = await this.options.runLine(session, r, late).catch((error: Error) => {
      this.log(`reminder ${r.id}: the agent could not say it: ${error.message}`);
      return undefined;
    });
    let heard = Boolean(said?.heard);
    const handedOver = Boolean(said?.handedOver);
    if (!said || (said.silent && !handedOver)) {
      heard = (await hub.say(session, staticLine).catch(() => ({ heard: false }))).heard;
    }
    const delivered = heard || handedOver || screens > 0;
    this.options.activity?.note("reminder", session.client.id, `Reminder said on ${session.client.name}${delivered ? "" : " (not confirmed)"}: ${r.text}`);
    return delivered;
  }

  /** Delivered: a one-off is finished with; a repeating one moves to its next time. */
  private done(r: ReminderRecord): void {
    if (!r.timeOfDay || !r.days) {
      this.options.store.removeReminder(r.id);
      return;
    }
    this.options.store.updateReminder(r.id, { dueAt: this.next(r), attempts: 0, retryAt: undefined });
  }

  /** Not said anywhere: kept, marked, and shown until dismissed. A repeating one moves on and keeps the mark. */
  private miss(r: ReminderRecord, why: string): void {
    const missedAt = this.now();
    if (r.timeOfDay && r.days) {
      this.options.store.updateReminder(r.id, { dueAt: this.next(r), attempts: 0, retryAt: undefined, missedAt, missedCount: r.missedCount + 1 });
    } else {
      this.options.store.updateReminder(r.id, { dueAt: undefined, attempts: 0, retryAt: undefined, missedAt, missedCount: r.missedCount + 1 });
    }
    this.options.activity?.note("reminder", r.clientId ?? "", `MISSED reminder (${why}): ${r.text}`, "warn");
  }

  private next(r: ReminderRecord): number {
    return nextOccurrence({ timeOfDay: r.timeOfDay!, days: r.days! }, Math.max(this.now(), r.dueAt ?? 0), this.options.timeZone());
  }
}
