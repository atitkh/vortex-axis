import type { Hub, Session } from "./hub.js";

/**
 * Long work an agent is doing, shown quietly on the devices: "Backup, 3 of 5,
 * deploying". An agent reports each step with the progress tool; Axis keeps
 * the latest word on each task in memory and tells every screen, the way it
 * tells them the next timer. Nothing is spoken and nothing is stored: it is a
 * glance, not a log, and it is gone when Axis restarts.
 */

export interface Task {
  id: string;
  title: string;
  /** What is happening now, in a few words. */
  note: string;
  /** Steps finished and steps in all, when the work has steps. */
  done?: number;
  total?: number;
  /** running: under way; blocked: waiting for the person; done: finished, shown a little longer. */
  state: "running" | "blocked" | "done";
  startedAt: number;
  updatedAt: number;
}

/** A task nobody has reported on for this long is taken to be abandoned. */
const STALE_MS = 30 * 60_000;
/** How long a finished task stays on show. */
const DONE_SHOWN_MS = 90_000;
const MAX_TASKS = 8;

export class Progress {
  private readonly tasks = new Map<string, Task>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly hub: Hub,
    private readonly now: () => number = Date.now,
  ) {
    hub.onConnect((session) => this.tell(session));
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
  }

  /** Tasks on show, the one reported on last first. */
  list(): Task[] {
    this.prune();
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Reports on a task, making it if it is new. Returns it and how many screens were told. */
  update(input: { id?: string | undefined; title?: string | undefined; note?: string | undefined; done?: number | undefined; total?: number | undefined; state?: Task["state"] | undefined }): { task: Task; screens: number } {
    const id = (input.id ?? "task").slice(0, 40);
    const before = this.tasks.get(id);
    // Reporting again on a task that has finished starts it afresh.
    const base = before && before.state !== "done" ? before : undefined;
    const title = (input.title ?? base?.title ?? "").trim().slice(0, 40);
    if (!title) throw new Error("give the task a title: a word or two for what is being done");
    const total = input.total ?? base?.total;
    const done = input.done ?? base?.done;
    if (total !== undefined && (!Number.isInteger(total) || total < 1 || total > 999)) throw new Error("total must be a whole number of steps, 1 to 999");
    if (done !== undefined && (!Number.isInteger(done) || done < 0 || (total !== undefined && done > total))) throw new Error("done must be a whole number of steps, no more than total");
    const task: Task = {
      id,
      title,
      note: (input.note ?? "").trim().slice(0, 80),
      ...(done !== undefined ? { done } : {}),
      ...(total !== undefined ? { total } : {}),
      state: input.state ?? "running",
      startedAt: base?.startedAt ?? this.now(),
      updatedAt: this.now(),
    };
    this.tasks.delete(id);
    this.tasks.set(id, task);
    // The oldest go when there are too many to mean anything on a small screen.
    while (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value!);
    return { task, screens: this.tell() };
  }

  /** Takes a task, or every task, off the screens. */
  clear(id?: string): number {
    const before = this.tasks.size;
    if (id === undefined) this.tasks.clear();
    else this.tasks.delete(id);
    if (this.tasks.size !== before) this.tell();
    return before - this.tasks.size;
  }

  private prune(): boolean {
    let changed = false;
    for (const [id, task] of this.tasks) {
      const age = this.now() - task.updatedAt;
      if (age > STALE_MS || (task.state === "done" && age > DONE_SHOWN_MS)) {
        this.tasks.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** Tells screens the task to show: the one reported on last, and how many there are. */
  private tell(only?: Session): number {
    const all = this.list();
    const top = all[0];
    const params = top
      ? { title: top.title, note: top.note, done: top.done ?? -1, total: top.total ?? 0, state: top.state, count: all.length }
      : { title: "", note: "", done: -1, total: 0, state: "none", count: 0 };
    let screens = 0;
    for (const session of only ? [only] : this.hub.sessions()) {
      if (!session.client.capabilities.includes("screen")) continue;
      screens++;
      // A client that shows no progress says so or says nothing; either is fine.
      this.hub.command(session, "progress.show", params, 3000).catch(() => undefined);
    }
    return screens;
  }
}
