import type { Hub, Session } from "./hub.js";

/** One step of a task, as the agent named it. */
export interface Step {
  text: string;
  state: "pending" | "running" | "done";
}

/** How a task left the screens: finished, taken off by hand, or nobody reported on it any more. */
export type Ending = "done" | "cleared" | "abandoned";

export interface ProgressOptions {
  /** A task has just started waiting for the person. */
  onBlocked?: (task: Task) => void;
  /** A task is over, however it ended. Called once for each task. */
  onEnd?: (task: Task, ending: Ending) => void;
  now?: () => number;
}

/**
 * Long work an agent is doing, shown quietly on the devices: "Backup, 3 of 5,
 * deploying". An agent reports each step with the progress tool; Axis keeps
 * the latest word on each task in memory and tells every screen, the way it
 * tells them the next timer. Nothing is spoken, and a task under way is kept
 * in memory only: it is gone when Axis restarts. What is told about a task
 * that has ended is up to whoever listens for it.
 */

export interface Task {
  id: string;
  title: string;
  /** What is happening now, in a few words. */
  note: string;
  /** Steps finished and steps in all, when the work has steps. */
  done?: number;
  total?: number;
  /** The steps by name, when the agent gave them: a screen can list them. */
  steps?: Step[];
  /** True when the agent said how each step stands; otherwise that follows from `done`. */
  stepsGiven?: boolean;
  /** running: under way; blocked: waiting for the person; done: finished, shown a little longer. */
  state: "running" | "blocked" | "done";
  startedAt: number;
  updatedAt: number;
  /** When whoever reports on it was last known to be at work, if that is later than its last word. */
  aliveAt?: number;
  /** A line put up by Axis itself (a reminder), cleared by the clock; no agent reports on it and nothing is told when it ends. */
  notice?: true;
}

/** A task nobody has reported on for this long is taken to be abandoned. */
const STALE_MS = 30 * 60_000;
/** How long a finished task stays on show. */
const DONE_SHOWN_MS = 90_000;
const MAX_TASKS = 8;
const MAX_STEPS = 12;
/** Tasks that finish close together are marked with one sound, not one each. */
const CHIME_GAP_MS = 30_000;
const STEP_CHARS = 48;

const STEP_STATES: Record<string, Step["state"]> = {
  pending: "pending",
  running: "running",
  in_progress: "running",
  done: "done",
  completed: "done",
};

/** Reads the steps an agent gave: plain names, or names each with how it stands. */
function readSteps(value: unknown): { steps: Step[]; given: boolean } | undefined {
  if (value === undefined || value === null) return undefined;
  // A harness that does not yet know the tool takes a list may hand it over as the text of one.
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      value = JSON.parse(value);
    } catch {
      // Not a list after all; said below.
    }
  }
  if (!Array.isArray(value)) throw new Error("steps must be a list of short step names");
  if (value.length > MAX_STEPS) throw new Error(`steps can list ${MAX_STEPS} at most: name the larger stages`);
  let given = false;
  const steps = value.map((item): Step => {
    const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : undefined;
    const name = record ? (record.step ?? record.text ?? record.name) : item;
    const text = typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, STEP_CHARS) : "";
    if (!text) throw new Error("every step needs a name");
    const said = record ? (record.status ?? record.state) : undefined;
    if (said === undefined) return { text, state: "pending" };
    const state = typeof said === "string" ? STEP_STATES[said] : undefined;
    if (!state) throw new Error("a step is pending, running or done");
    given = true;
    return { text, state };
  });
  return { steps, given };
}

/** A task in a few words, for a list of several: " Backup 3/5", "!Backup: needs you", " Backup done". */
export function taskLine(task: Task): string {
  if (task.state === "blocked") return `!${task.title}: needs you`;
  if (task.state === "done") return ` ${task.title} done`;
  return ` ${task.title}${task.total ? ` ${task.done ?? 0}/${task.total}` : task.note ? `: ${task.note}` : ""}`;
}

/** The steps as one line of text each, led by how it stands: `x` done, `>` running, `-` still to come. */
export function stepLines(steps: Step[]): string {
  return steps.map((s) => `${s.state === "done" ? "x" : s.state === "running" ? ">" : "-"}${s.text}`).join("\n");
}

export class Progress {
  private readonly tasks = new Map<string, Task>();
  private timer: NodeJS.Timeout | undefined;
  private chimedAt = 0;
  private readonly noticeTimers = new Map<string, NodeJS.Timeout>();

  private readonly now: () => number;
  private readonly changeListeners: (() => void)[] = [];

  constructor(
    private readonly hub: Hub,
    private readonly options: ProgressOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    hub.onConnect((session) => this.tell(session));
  }

  /** Called after every change to the tasks on show. */
  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  start(): void {
    // Finished and abandoned tasks leave the screens by the clock, with nobody reporting.
    this.timer = setInterval(() => {
      if (this.prune()) this.tell();
    }, 15_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const timer of this.noticeTimers.values()) clearTimeout(timer);
    this.noticeTimers.clear();
  }

  /** Tasks on show. One that waits for the person comes first, whatever else is going on; then the one reported on last. */
  list(): Task[] {
    // Whoever looks first may be the one to find a task gone (the live activities look every few seconds);
    // the screens are told either way, just not from inside the look.
    if (this.prune()) queueMicrotask(() => this.tell());
    const waiting = (task: Task) => (task.notice ? 2 : task.state === "blocked" ? 1 : 0);
    return [...this.tasks.values()].sort((a, b) => waiting(b) - waiting(a) || b.updatedAt - a.updatedAt);
  }

  /** Says a task is still being worked on though there is nothing new to show, so it is not taken for abandoned. */
  touch(id: string): void {
    const task = this.tasks.get(id);
    if (task) task.aliveAt = this.now();
  }

  /** Reports on a task, making it if it is new. Returns it and how many screens were told. */
  update(input: { id?: string | undefined; title?: string | undefined; note?: string | undefined; done?: number | undefined; total?: number | undefined; state?: Task["state"] | undefined; steps?: unknown }): { task: Task; screens: number } {
    const id = (input.id ?? "task").slice(0, 40);
    const before = this.tasks.get(id);
    // Reporting again on a task that has finished starts it afresh.
    const base = before && before.state !== "done" ? before : undefined;
    const title = (input.title ?? base?.title ?? "").trim().slice(0, 40);
    if (!title) throw new Error("give the task a title: a word or two for what is being done");
    const read = readSteps(input.steps);
    let steps = read?.steps ?? base?.steps;
    const stepsGiven = read ? read.given : (base?.stepsGiven ?? false);
    const state = input.state ?? "running";
    const total = input.total ?? (read ? read.steps.length : base?.total);
    // Steps that came with how they stand say how far along the work is, unless the agent says otherwise.
    const done = input.done ?? (read?.given ? read.steps.filter((s) => s.state === "done").length : state === "done" && total !== undefined ? total : base?.done);
    if (total !== undefined && (!Number.isInteger(total) || total < 1 || total > 999)) throw new Error("total must be a whole number of steps, 1 to 999");
    if (done !== undefined && (!Number.isInteger(done) || done < 0 || (total !== undefined && done > total))) throw new Error("done must be a whole number of steps, no more than total");
    if (steps && !stepsGiven) {
      // Plain names: the first `done` of them are behind, and the next is the one in hand.
      const behind = state === "done" ? steps.length : (done ?? 0);
      steps = steps.map((s, i) => ({ text: s.text, state: i < behind ? "done" : i === behind ? "running" : "pending" }));
    } else if (steps && state === "done") {
      steps = steps.map((s) => ({ text: s.text, state: "done" }));
    }
    const task: Task = {
      id,
      title,
      note: (input.note ?? "").trim().slice(0, 80),
      ...(done !== undefined ? { done } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(steps ? { steps, stepsGiven } : {}),
      state,
      startedAt: base?.startedAt ?? this.now(),
      updatedAt: this.now(),
    };
    this.tasks.delete(id);
    this.tasks.set(id, task);
    // The oldest go when there are too many to mean anything on a small screen.
    while (this.tasks.size > MAX_TASKS) {
      const [oldest, dropped] = this.tasks.entries().next().value!;
      this.tasks.delete(oldest);
      if (dropped.state !== "done" && !dropped.notice) this.options.onEnd?.(dropped, "abandoned");
    }
    const finished = state === "done" && before?.state !== "done";
    const screens = this.tell(undefined, finished);
    if (finished) this.options.onEnd?.(task, "done");
    else if (state === "blocked" && base?.state !== "blocked") this.options.onBlocked?.(task);
    return { task, screens };
  }

  /** Puts a line on every screen for `ms`, then takes it off. Returns how many screens were told. */
  notice(id: string, title: string, note: string, ms: number): number {
    const key = `notice-${id}`.slice(0, 40);
    clearTimeout(this.noticeTimers.get(key));
    const task: Task = { id: key, title: title.trim().slice(0, 200), note: note.trim().slice(0, 80), state: "running", startedAt: this.now(), updatedAt: this.now(), notice: true };
    this.tasks.delete(key);
    this.tasks.set(key, task);
    const timer = setTimeout(() => {
      this.noticeTimers.delete(key);
      if (this.tasks.get(key) === task) {
        this.tasks.delete(key);
        this.tell();
      }
    }, ms);
    timer.unref();
    this.noticeTimers.set(key, timer);
    return this.tell();
  }

  /** Takes a task, or every task, off the screens. */
  clear(id?: string): number {
    const gone = [...this.tasks.values()].filter((task) => id === undefined || task.id === id);
    for (const task of gone) {
      this.tasks.delete(task.id);
      // A finished task was told about when it finished.
      if (task.state !== "done" && !task.notice) this.options.onEnd?.(task, "cleared");
    }
    if (gone.length) this.tell();
    return gone.length;
  }

  /** Takes the finished tasks off the screens (a swipe down on a board). Ones still under way stay. */
  clearDone(): number {
    const gone = [...this.tasks.values()].filter((task) => task.state === "done");
    for (const task of gone) this.tasks.delete(task.id);
    if (gone.length) this.tell();
    return gone.length;
  }

  private prune(): boolean {
    let changed = false;
    for (const [id, task] of this.tasks) {
      const age = this.now() - Math.max(task.updatedAt, task.aliveAt ?? 0);
      if (age > STALE_MS || (task.state === "done" && age > DONE_SHOWN_MS)) {
        this.tasks.delete(id);
        if (task.state !== "done" && !task.notice) this.options.onEnd?.(task, "abandoned");
        changed = true;
      }
    }
    return changed;
  }

  /** Tells screens the task to show: the one reported on last, and how many there are. */
  private tell(only?: Session, finished = false): number {
    const all = this.list();
    if (!only) for (const listener of this.changeListeners) listener();
    const top = all[0];
    const params: Record<string, string | number | boolean> = top
      ? { title: top.title, note: top.note, done: top.done ?? -1, total: top.total ?? 0, state: top.state, count: all.length }
      : { title: "", note: "", done: -1, total: 0, state: "none", count: 0 };
    if (top?.steps?.length) params.steps = stepLines(top.steps);
    // The other tasks, a line each, for a screen to list on request: `!` leads one that waits for the person.
    if (all.length > 1) params.others = all.slice(1).map(taskLine).join("\n");
    // Several tasks finishing together make one sound between them.
    if (finished && this.now() - this.chimedAt < CHIME_GAP_MS) finished = false;
    if (finished) this.chimedAt = this.now();
    let screens = 0;
    for (const session of only ? [only] : this.hub.sessions()) {
      if (!session.client.capabilities.includes("screen")) continue;
      screens++;
      // A task that has just finished may be marked with a sound, once, and never in quiet hours.
      const chime = finished && !this.hub.quiet(session.client);
      // A client that shows no progress says so or says nothing; either is fine.
      this.hub.command(session, "progress.show", chime ? { ...params, chime: true } : params, 3000).catch(() => undefined);
    }
    return screens;
  }
}
