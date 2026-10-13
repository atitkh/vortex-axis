import { afterEach, describe, expect, it } from "vitest";
import { BLUEPRINT, LiveActivities, type LiveMessage, taskMessage, timerMessage } from "../src/liveactivity.js";
import type { Task } from "../src/progress.js";
import type { TimerRecord } from "../src/store.js";

/** A world of tasks and timers on a clock that only moves when told. */
function world(options: { enabled?: boolean; linked?: boolean } = {}) {
  const meta = new Map<string, string>();
  const w = {
    now: 1_000_000,
    enabled: options.enabled ?? true,
    linked: options.linked ?? true,
    tasks: [] as Task[],
    timers: [] as TimerRecord[],
    sent: [] as LiveMessage[],
    meta,
  };
  const live = new LiveActivities({
    store: { getMeta: (k: string) => meta.get(k), setMeta: (k: string, v: string) => void meta.set(k, v) } as never,
    enabled: () => w.enabled,
    publish: (m) => {
      if (!w.linked) return false;
      w.sent.push(m);
      return true;
    },
    tasks: () => w.tasks,
    timers: () => w.timers,
    now: () => w.now,
    startAfterMs: 30_000,
    gapMs: 10_000,
  });
  lives.push(live);
  return { w, live };
}
const lives: LiveActivities[] = [];
afterEach(() => lives.splice(0).forEach((l) => l.stop()));

const task = (over: Partial<Task> = {}): Task => ({ id: "t1", title: "Research", note: "searching", state: "running", startedAt: 1_000_000, updatedAt: 1_000_000, ...over });
const timer = (over: Partial<TimerRecord> = {}): TimerRecord => ({ id: 7, clientId: "c", label: "pasta", seconds: 600, dueAt: 1_600_000, createdAt: 1_000_000, ...over });

describe("live activities", () => {
  it("shows a task only once it has run for 30 s", () => {
    const { w, live } = world();
    w.tasks = [task()];
    live.sync();
    expect(w.sent).toEqual([]);
    w.now += 30_000;
    live.sync();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ tag: "axis-task-t1", title: "Research", message: "searching", data: { live_update: true, silent: false } });
  });

  it("never shows a task that finishes before then", () => {
    const { w, live } = world();
    w.tasks = [task()];
    live.sync();
    w.now += 20_000;
    w.tasks = [task({ state: "done" })];
    live.sync();
    w.now += 60_000;
    live.sync();
    expect(w.sent).toEqual([]);
  });

  it("shows a task waiting for the person at once, with a sound", () => {
    const { w, live } = world();
    w.tasks = [task({ state: "blocked", note: "pick a date" })];
    live.sync();
    expect(w.sent[0]).toMatchObject({ message: "Needs you: pick a date", data: { silent: false, relevance_score: 1, critical_text: "needs you" } });
  });

  it("spaces out updates, but sends a change of state at once", () => {
    const { w, live } = world();
    w.now += 30_000;
    w.tasks = [task()];
    live.sync();
    w.tasks = [task({ note: "reading" })];
    live.sync();
    expect(w.sent).toHaveLength(1);
    w.tasks = [task({ note: "reading", state: "blocked" })];
    live.sync();
    expect(w.sent.map((m) => m.message)).toEqual(["searching", "Needs you: reading"]);
  });

  it("sends a step within the same state quietly, and a change of state with a sound", () => {
    const { w, live } = world();
    w.now += 30_000;
    w.tasks = [task()];
    live.sync();
    w.now += 10_000;
    w.tasks = [task({ note: "reading" })];
    live.sync();
    w.tasks = [task({ note: "reading", state: "blocked" })];
    live.sync();
    w.tasks = [task({ note: "writing" })];
    live.sync();
    expect(w.sent.map((m) => [m.message, m.data!.silent])).toEqual([["searching", false], ["reading", true], ["Needs you: reading", false], ["writing", false]]);
  });

  it("sends a held-back update when the gap is over", () => {
    const { w, live } = world();
    w.now += 30_000;
    w.tasks = [task()];
    live.sync();
    w.now += 2_000;
    w.tasks = [task({ note: "reading" })];
    live.sync();
    w.now += 10_000;
    live.sync();
    expect(w.sent.map((m) => m.message)).toEqual(["searching", "reading"]);
  });

  it("marks a finished task done, quietly, and ends it when it leaves the screens", () => {
    const { w, live } = world();
    w.now += 30_000;
    w.tasks = [task({ total: 3, done: 1 })];
    live.sync();
    expect(w.sent[0]!.data).toMatchObject({ progress: 1, progress_max: 3, critical_text: "1/3" });
    w.tasks = [task({ total: 3, done: 3, state: "done" })];
    live.sync();
    expect(w.sent[1]).toMatchObject({ message: "Done", data: { silent: false, notification_icon: "mdi:check-circle" } });
    w.tasks = [];
    live.sync();
    expect(w.sent[2]).toEqual({ tag: "axis-task-t1", end: true });
  });

  it("shows a timer of a minute or more as a countdown, and not a shorter one", () => {
    const { w, live } = world();
    w.timers = [timer(), timer({ id: 8, seconds: 30, dueAt: 1_030_000 })];
    live.sync();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ tag: "axis-timer-7", title: "pasta", message: "10 minutes timer", data: { chronometer: true, when: 1600, when_relative: false } });
  });

  it("says a timer is done the moment it is due, with a sound, then ends it a minute later", () => {
    const { w, live } = world();
    w.timers = [timer()];
    live.sync();
    // Still in the list while the device announces it.
    w.now = 1_600_000;
    live.sync();
    expect(w.sent[1]).toMatchObject({ message: "Done", data: { silent: false } });
    w.now = 1_603_000;
    w.timers = [];
    live.sync();
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]).toMatchObject({ message: "Done", data: { silent: false } });
    w.now += 61_000;
    live.sync();
    expect(w.sent[2]).toEqual({ tag: "axis-timer-7", end: true });
  });

  it("ends a cancelled timer at once", () => {
    const { w, live } = world();
    w.timers = [timer()];
    live.sync();
    w.now += 5_000;
    w.timers = [];
    live.sync();
    expect(w.sent[1]).toEqual({ tag: "axis-timer-7", end: true });
  });

  it("ends everything when switched off, and sends nothing while off", () => {
    const { w, live } = world();
    w.timers = [timer()];
    live.sync();
    w.enabled = false;
    live.sync();
    expect(w.sent[1]).toEqual({ tag: "axis-timer-7", end: true });
    w.timers = [timer({ id: 9 })];
    live.sync();
    expect(w.sent).toHaveLength(2);
  });

  it("keeps trying when Home Assistant cannot be reached", () => {
    const { w, live } = world({ linked: false });
    w.timers = [timer()];
    live.sync();
    expect(live.status().showing).toBe(0);
    w.linked = true;
    live.sync();
    expect(live.status().showing).toBe(1);
  });

  it("ends what an earlier run of Axis left on the phone", () => {
    const first = world();
    first.w.timers = [timer()];
    first.live.sync();
    const { w, live } = world({ linked: false });
    for (const [k, v] of first.w.meta) w.meta.set(k, v);
    live.start();
    live.sync();
    w.linked = true;
    live.sync();
    expect(w.sent).toEqual([{ tag: "axis-timer-7", end: true }]);
  });

  it("sends a test on a tag of its own and says which phones Home Assistant passed it to", async () => {
    const { w, live } = world();
    const result = live.test(50);
    const tag = w.sent[0]!.tag;
    expect(tag).toMatch(/^axis-test-/);
    live.acknowledged(JSON.stringify({ tag: "axis-task-x", phone: "Other" }));
    live.acknowledged(JSON.stringify({ tag, phone: "Sam's iPhone" }));
    live.acknowledged(JSON.stringify({ tag, phone: "Spare phone" }));
    expect(await result).toEqual({ sent: true, phones: ["Sam's iPhone", "Spare phone"] });
  });

  it("tells when Home Assistant passed one on", () => {
    const { live } = world();
    live.acknowledged(JSON.stringify({ tag: "axis-test", phone: "Sam's iPhone" }));
    expect(live.status().lastAck).toEqual({ at: 1_000_000, phone: "Sam's iPhone" });
  });
});

describe("what goes to the phone", () => {
  it("keeps tags to what the companion app takes", () => {
    expect(taskMessage(task({ id: "card:agent:main/x y" })).tag).toBe("axis-task-card_agent_main_x_y");
    expect(timerMessage(timer({ seconds: 3660, label: "" }), false).message).toBe("1 hour 1 minute timer");
  });

  it("opens the web client on tap when Axis has a public address", () => {
    expect(taskMessage(task(), "https://axis.example.org/").data).toMatchObject({ url: "https://axis.example.org/" });
  });

  it("has a blueprint that listens where Axis sends and answers where Axis listens", () => {
    expect(BLUEPRINT).toContain("topic: vortex-axis/live\n");
    expect(BLUEPRINT).toContain("topic: vortex-axis/live/ack");
    expect(BLUEPRINT).toContain("message: clear_notification");
  });
});
