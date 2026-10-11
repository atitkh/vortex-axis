import type { Task } from "./progress.js";
import type { Store, TimerRecord } from "./store.js";
import { spokenLength } from "./timers.js";

/**
 * Tasks and timers as Live Activities on a phone (iOS; Live Updates on Android),
 * through Home Assistant's companion app.
 *
 * Axis speaks to Home Assistant only over MQTT, and a phone's notify action is
 * not reachable from there. So Axis publishes each activity on
 * `vortex-axis/live` and a blueprint in Home Assistant (served by Axis, see
 * BLUEPRINT) hands it to the phone it was set up for, then says so on
 * `vortex-axis/live/ack`, which shows on the Integrations page.
 *
 * Not everything goes. iOS limits how often activities may start and be
 * updated, and drops what goes over quietly, so:
 * - a task shows once it has run for `startAfterMs` (a short one never does),
 *   or at once when it waits for the person ("needs you");
 * - a timer shows when it is a minute or longer;
 * - updates to one activity are at least `gapMs` apart, except a change of
 *   state (running, needs you, done), which goes at once;
 * - a change of state (needs you, done, back to work, a timer going off) sounds
 *   and goes at full priority; a step within the same state goes quietly, at the
 *   low priority iOS may hold back;
 * - a timer shows "Done" the moment it is due.
 * An activity ends when its task leaves the screens or its timer is cancelled,
 * or a minute after the timer went off.
 */

export const LIVE_TOPIC = "vortex-axis/live";
export const LIVE_ACK_TOPIC = "vortex-axis/live/ack";

/** What goes to Home Assistant: the notification's title and message, and the companion app's `data`. */
export interface LiveMessage {
  tag: string;
  end?: true;
  title?: string;
  message?: string;
  data?: Record<string, string | number | boolean>;
}

export interface LiveActivitiesOptions {
  store: Store;
  /** Whether the feature is switched on. */
  enabled: () => boolean;
  /** Publishes to Home Assistant's broker. False when the link is down, so nothing was sent. */
  publish: (message: LiveMessage) => boolean;
  tasks: () => Task[];
  timers: () => TimerRecord[];
  /** Where tapping an activity goes: the web client's address, when Axis has a public one. */
  url?: () => string | undefined;
  now?: () => number;
  startAfterMs?: number;
  gapMs?: number;
  log?: (line: string) => void;
}

const META_KEY = "live_tags";
const TIMER_MIN_SECONDS = 60;
const TIMER_DONE_SHOWN_MS = 60_000;

interface Shown {
  /** What was last sent, to send only a change. */
  sent: string;
  state: string;
  sentAt: number;
  /** A change held back by the gap, sent when it is over. */
  waiting?: NodeJS.Timeout | undefined;
}

const COLORS = { running: "#03A9F4", blocked: "#FF9800", done: "#4CAF50", timer: "#AB47BC" };

/** A tag the companion app takes: letters, digits, `-` and `_`, 64 at most. */
function tagFor(kind: "task" | "timer", id: string | number): string {
  return `axis-${kind}-${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
}

export function taskMessage(task: Task, url?: string): LiveMessage {
  const state = task.state;
  const steps = task.total ? `${task.done ?? 0}/${task.total}` : "";
  const message =
    state === "blocked" ? (task.note ? `Needs you: ${task.note}` : "Needs you")
    : state === "done" ? "Done"
    : task.note || "Working on it";
  return {
    tag: tagFor("task", task.id),
    title: task.title,
    message,
    data: {
      tag: tagFor("task", task.id),
      live_update: true,
      ...(task.total ? { progress: task.done ?? 0, progress_max: task.total } : {}),
      critical_text: state === "blocked" ? "needs you" : state === "done" ? "done" : steps || "working",
      notification_icon: state === "blocked" ? "mdi:account-alert" : state === "done" ? "mdi:check-circle" : "mdi:progress-clock",
      notification_icon_color: COLORS[state],
      // Waiting for the person takes the Dynamic Island; a finished task gives it up.
      relevance_score: state === "blocked" ? 1 : state === "done" ? 0.2 : 0.5,
      // Settled per update in show(): only a step within the same state goes quietly.
      silent: false,
      ...(url ? { url } : {}),
    },
  };
}

export function timerMessage(timer: TimerRecord, done: boolean, url?: string): LiveMessage {
  const tag = tagFor("timer", timer.id);
  return {
    tag,
    title: timer.label || "Timer",
    message: done ? "Done" : `${spokenLength(timer.seconds).replace(/(\d+) (\w+)/g, (_m, n: string, unit: string) => `${n} ${unit}${n === "1" ? "" : "s"}`)} timer`,
    data: {
      tag,
      live_update: true,
      ...(done ? {} : { chronometer: true, when: Math.round(timer.dueAt / 1000), when_relative: false }),
      critical_text: done ? "done" : "timer",
      notification_icon: done ? "mdi:timer-check" : "mdi:timer-outline",
      notification_icon_color: COLORS.timer,
      relevance_score: done ? 0.9 : 0.8,
      silent: false,
      ...(url ? { url } : {}),
    },
  };
}

export class LiveActivities {
  private readonly shown = new Map<string, Shown>();
  /** Timers that went off, kept on show for a minute, by tag. */
  private readonly rang = new Map<string, { timer: TimerRecord; at: number }>();
  /** Timers seen last time, to tell one that went off from one cancelled. */
  private lastTimers = new Map<string, TimerRecord>();
  private timer: NodeJS.Timeout | undefined;
  private dueTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly startAfterMs: number;
  private readonly gapMs: number;
  private sentCount = 0;
  private lastSentAt: number | undefined;
  private lastAck: { at: number; phone?: string | undefined } | undefined;
  /** Tests waiting to hear Home Assistant passed theirs on. */
  private readonly ackWaiters: ((tag: string, phone: string | undefined) => void)[] = [];
  /** Activities an earlier run of Axis left on show, still to be ended. */
  private leftover: string[] = [];

  constructor(private readonly options: LiveActivitiesOptions) {
    this.now = options.now ?? Date.now;
    this.startAfterMs = options.startAfterMs ?? 30_000;
    this.gapMs = options.gapMs ?? 10_000;
  }

  start(): void {
    // Activities left on the phone by an Axis that stopped are ended; their tasks are gone.
    this.forgetEarlier();
    // A task passes its 30 s, a rung timer its minute, with nobody saying so.
    this.timer = setInterval(() => this.sync(), 5_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.dueTimer);
    for (const s of this.shown.values()) clearTimeout(s.waiting);
  }

  /** How it stands, for the Integrations page. */
  status() {
    return {
      enabled: this.options.enabled(),
      showing: this.shown.size,
      sent: this.sentCount,
      lastSentAt: this.lastSentAt ?? null,
      lastAck: this.lastAck ?? null,
    };
  }

  /** Home Assistant's blueprint said it passed one on to a phone. */
  acknowledged(payload: string): void {
    let phone: string | undefined;
    let tag: string | undefined;
    try {
      const body = JSON.parse(payload) as { phone?: unknown; tag?: unknown };
      if (typeof body.phone === "string") phone = body.phone.slice(0, 80);
      if (typeof body.tag === "string") tag = body.tag;
    } catch {
      // An acknowledgement that says nothing more is still one.
    }
    this.lastAck = { at: this.now(), phone };
    if (tag) for (const waiter of this.ackWaiters.splice(0)) waiter(tag, phone);
  }

  /** Puts a short test activity on the phone, to check the blueprint is set up. Ends by itself. */
  async test(waitMs = 5_000): Promise<{ sent: boolean; phones: string[] }> {
    // A tag of its own each time: iOS may not start an activity again on a tag that was just ended.
    const tag = `axis-test-${Date.now().toString(36)}`;
    const phones: string[] = [];
    // Kept listening until the wait is over: every phone's automation answers on its own.
    const heard = (from: string, phone: string | undefined) => {
      if (from === tag) phones.push(phone ?? "a phone");
      this.ackWaiters.push(heard);
    };
    this.ackWaiters.push(heard);
    const sent = this.send({
      tag,
      title: "VorteX Axis",
      message: "Live activities work",
      data: { tag, live_update: true, chronometer: true, when: 30, when_relative: true, notification_icon: "mdi:check-network", notification_icon_color: COLORS.running },
    });
    if (!sent) {
      this.ackWaiters.splice(this.ackWaiters.indexOf(heard), 1);
      return { sent, phones };
    }
    setTimeout(() => this.send({ tag, end: true }), 30_000).unref();
    // Each phone's automation answers on its own; wait a little for all of them.
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const left = this.ackWaiters.indexOf(heard);
    if (left >= 0) this.ackWaiters.splice(left, 1);
    return { sent, phones };
  }

  /** Looks at the tasks and timers and sends what changed. Called on every change and every few seconds. */
  sync(): void {
    if (this.leftover.length) this.endLeftover();
    if (!this.options.enabled()) {
      if (this.shown.size) this.endAll();
      return;
    }
    const now = this.now();
    const url = this.options.url?.();
    const wanted = new Map<string, { message: LiveMessage; state: string }>();

    for (const task of this.options.tasks()) {
      const tag = tagFor("task", task.id);
      const old = now - task.startedAt >= this.startAfterMs;
      // A task that finishes before it was ever shown stays off the phone.
      if (!this.shown.has(tag) && (task.state === "done" || (task.state === "running" && !old))) continue;
      wanted.set(tag, { message: taskMessage(task, url), state: task.state });
    }

    const timers = new Map(this.options.timers().map((t) => [tagFor("timer", t.id), t]));
    for (const [tag, timer] of this.lastTimers) {
      // Gone from the list close to when it was due: it went off, rather than being cancelled.
      if (!timers.has(tag) && this.shown.has(tag) && timer.dueAt <= now + 2_000 && !this.rang.has(tag)) this.rang.set(tag, { timer, at: now });
    }
    this.lastTimers = timers;
    let nextDue = Infinity;
    for (const [tag, timer] of timers) {
      if (timer.seconds < TIMER_MIN_SECONDS && !this.shown.has(tag)) continue;
      // Due: "Done" now, not once the device has finished announcing it and the timer is gone.
      if (timer.dueAt <= now) {
        if (this.shown.has(tag) && !this.rang.has(tag)) this.rang.set(tag, { timer, at: timer.dueAt });
        continue;
      }
      nextDue = Math.min(nextDue, timer.dueAt);
      wanted.set(tag, { message: timerMessage(timer, false, url), state: "running" });
    }
    for (const [tag, rang] of this.rang) {
      if (now - rang.at > TIMER_DONE_SHOWN_MS) this.rang.delete(tag);
      else wanted.set(tag, { message: timerMessage(rang.timer, true, url), state: "done" });
    }

    for (const [tag, want] of wanted) this.show(tag, want.message, want.state);
    for (const tag of [...this.shown.keys()]) if (!wanted.has(tag)) this.end(tag);
    // Looked at again the moment the next timer is due.
    clearTimeout(this.dueTimer);
    if (nextDue !== Infinity) this.dueTimer = setTimeout(() => this.sync(), Math.max(0, nextDue - now) + 50).unref();
  }

  private show(tag: string, message: LiveMessage, state: string): void {
    const shown = this.shown.get(tag);
    // A change of state (needs you, done, a timer going off, back to work) sounds and goes at full priority;
    // a step within the same state goes quietly, which iOS may deliver late.
    if (message.data) message.data.silent = Boolean(shown && shown.state === state);
    const body = JSON.stringify(message);
    if (shown && shown.sent === body) return;
    const now = this.now();
    // A change of state goes at once; anything else waits out the gap since the last update.
    if (shown && shown.state === state && now - shown.sentAt < this.gapMs) {
      if (!shown.waiting) shown.waiting = setTimeout(() => {
        shown.waiting = undefined;
        this.sync();
      }, shown.sentAt + this.gapMs - now).unref();
      return;
    }
    if (!this.send(message)) return;
    if (shown) clearTimeout(shown.waiting);
    this.shown.set(tag, { sent: body, state, sentAt: now });
    if (!shown) this.remember();
  }

  private end(tag: string): void {
    const shown = this.shown.get(tag);
    clearTimeout(shown?.waiting);
    // When the link is down the activity is kept, to be ended when it is back.
    if (!this.send({ tag, end: true })) return;
    this.shown.delete(tag);
    this.rang.delete(tag);
    this.remember();
  }

  private endAll(): void {
    for (const tag of [...this.shown.keys()]) this.end(tag);
  }

  private send(message: LiveMessage): boolean {
    let sent = false;
    try {
      sent = this.options.publish(message);
    } catch (error) {
      this.options.log?.(`live activity not sent: ${(error as Error).message}`);
    }
    if (sent) {
      this.sentCount++;
      this.lastSentAt = this.now();
    }
    return sent;
  }

  /** Keeps the tags on show, so an Axis that restarts can end them. */
  private remember(): void {
    this.options.store.setMeta(META_KEY, JSON.stringify([...new Set([...this.shown.keys(), ...this.leftover])]));
  }

  private forgetEarlier(): void {
    const saved = this.options.store.getMeta(META_KEY);
    if (!saved) return;
    try {
      this.leftover = (JSON.parse(saved) as unknown[]).filter((t): t is string => typeof t === "string");
    } catch {
      // Unreadable: nothing to end.
    }
  }

  /** Ends what an earlier run left, once Home Assistant can be reached. */
  private endLeftover(): void {
    const before = this.leftover.length;
    this.leftover = this.leftover.filter((tag) => !this.shown.has(tag) && !this.send({ tag, end: true }));
    if (this.leftover.length !== before) this.remember();
  }
}

/** The Home Assistant blueprint that passes Axis's activities on to one phone. */
export const BLUEPRINT = `blueprint:
  name: VorteX Axis live activities
  description: >-
    Shows VorteX Axis tasks and timers on a phone with the Home Assistant app,
    as Live Activities on iOS (lock screen and Dynamic Island) or Live Updates
    on Android. Switch on "Live activities" on Axis's Integrations page too.
    Make one automation from this blueprint for each phone.
  domain: automation
  input:
    phone:
      name: Phone
      description: The phone to show them on.
      selector:
        device:
          filter:
            - integration: mobile_app
mode: queued
max: 25
variables:
  phone: !input phone
triggers:
  - trigger: mqtt
    topic: ${LIVE_TOPIC}
conditions:
  - condition: template
    value_template: "{{ trigger.payload_json is defined and trigger.payload_json.tag is defined }}"
actions:
  - if:
      - condition: template
        value_template: "{{ trigger.payload_json.end | default(false) }}"
    then:
      - domain: mobile_app
        type: notify
        device_id: !input phone
        message: clear_notification
        data:
          tag: "{{ trigger.payload_json.tag }}"
    else:
      - domain: mobile_app
        type: notify
        device_id: !input phone
        title: "{{ trigger.payload_json.title }}"
        message: "{{ trigger.payload_json.message }}"
        data: "{{ trigger.payload_json.data }}"
  - action: mqtt.publish
    data:
      topic: ${LIVE_ACK_TOPIC}
      payload: "{{ {'tag': trigger.payload_json.tag, 'phone': device_attr(phone, 'name')} | to_json }}"
`;
