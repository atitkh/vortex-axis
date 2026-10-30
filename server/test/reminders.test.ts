import { describe, expect, it, vi } from "vitest";
import type { Capability } from "@vortex-axis/protocol";
import type { Agent } from "../src/agent.js";
import { Reminders } from "../src/reminders.js";
import type { TextToSpeech } from "../src/speech.js";
import { admin, connect, ctx, newPairedClient, restart, useServer } from "./harness.js";

const asked: string[] = [];
let answer = ["Time to take the pills."];
const agent: Agent = {
  reply: (message) =>
    (async function* () {
      asked.push(message);
      for (const piece of answer) yield piece;
    })(),
  healthy: async () => true,
};
const spoken: string[] = [];
const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: (text) =>
    (async function* () {
      spoken.push(text);
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
useServer(() => {
  asked.length = spoken.length = 0;
  answer = ["Time to take the pills."];
  return { agent, tts };
});

async function device(name: string, capabilities: Capability[] = ["screen", "speaker", "mic"]) {
  const identity = await newPairedClient({ capabilities, type: "board", name });
  const client = await connect(identity, { capabilities, type: "board" });
  await client.next("status");
  return client;
}

async function hearOut(client: Awaited<ReturnType<typeof device>>, from = 0) {
  const start = await client.next("speak.start", from);
  await client.next("speak.end", from, (m) => m.turnId === start.turnId);
  client.send({ t: "playback", turnId: start.turnId, state: "finished" });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const add = (extra: Record<string, unknown> = {}) =>
  ctx.app.store.addReminder({ text: "Take the pills", dueAt: Date.now() + 300, everywhere: false, urgent: false, attempts: 0, missedCount: 0, createdAt: Date.now(), ...extra });

describe("reminders", () => {
  it("fires at its time with the agent's own sentence, shows a line, and never touches the timers", async () => {
    const desk = await device("Desk");
    const row = add();
    ctx.app.reminders.start();
    await hearOut(desk);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("[reminder:");
    expect(asked[0]).toContain("Do not use tools");
    expect(asked[0]).toContain("Take the pills");
    expect(spoken.join(" ")).toBe("Time to take the pills.");
    expect(spoken.join(" ")).not.toMatch(/About/);
    // The line under the face, titled with the words.
    const shown = await desk.next("command", 0, (m) => m.name === "progress.show" && (m.params as any)?.title === "Take the pills");
    expect(shown.params).toMatchObject({ note: "Reminder", state: "running" });
    await sleep(100);
    // The key invariant: a reminder is not a timer, so no screen is told to count down and the list stays empty.
    // (A device is told "no timer" when it connects, with count 0; a countdown would carry a count.)
    expect(desk.received.some((m) => m.t === "command" && m.name === "timer.next" && Number((m.params as any)?.count) > 0)).toBe(false);
    expect(ctx.app.timers.list()).toHaveLength(0);
    expect(ctx.app.store.listReminders().find((r) => r.id === row.id)).toBeUndefined();
    // The line is not an agent task: it is absent from the admin view of tasks.
    expect((await admin("GET", "/admin/now")).body.tasks).toEqual([]);
  });

  it("says the static line when the agent answers NO_REPLY", async () => {
    const desk = await device("Desk");
    answer = ["NO_REPLY"];
    add();
    ctx.app.reminders.start();
    await hearOut(desk);
    expect(spoken.join(" ")).toBe("Reminder: Take the pills.");
  });

  it("says the static line when the agent turn throws", async () => {
    const desk = await device("Desk");
    ctx.app.reminders.stop();
    const own = new Reminders({
      store: ctx.app.store, hub: ctx.app.hub, progress: ctx.app.progress, timeZone: () => "America/Chicago",
      runLine: async () => { throw new Error("gateway down"); },
    });
    add();
    own.start();
    await hearOut(desk);
    own.stop();
    expect(spoken.join(" ")).toBe("Reminder: Take the pills.");
  });

  it("survives a restart of Axis", async () => {
    add({ dueAt: Date.now() + 2500 });
    await restart();
    expect(ctx.app.store.listReminders()).toHaveLength(1);
    const desk = await device("Desk");
    await hearOut(desk);
    expect(spoken.join(" ")).toBe("Time to take the pills.");
  });

  it("with nothing to say it on, retries once and then keeps it as missed", async () => {
    ctx.app.reminders.stop();
    const own = new Reminders({ store: ctx.app.store, hub: ctx.app.hub, progress: ctx.app.progress, timeZone: () => "America/Chicago", retryMs: 150 });
    const row = add({ dueAt: Date.now() + 50 });
    own.start();
    await sleep(120);
    expect(ctx.app.store.listReminders()[0]).toMatchObject({ id: row.id, attempts: 1 });
    expect(ctx.app.store.listReminders()[0]!.retryAt).toBeGreaterThan(Date.now() - 100);
    await sleep(400);
    own.stop();
    const kept = ctx.app.store.listReminders()[0]!;
    expect(kept).toMatchObject({ text: "Take the pills", missedCount: 1, attempts: 0 });
    expect(kept.dueAt).toBeUndefined();
    expect(kept.missedAt).toBeDefined();
    // Dismissing removes a one-off.
    expect(ctx.app.reminders.dismiss({ all: true })).toHaveLength(1);
    expect(ctx.app.store.listReminders()).toHaveLength(0);
  });

  it("moves a repeating reminder on after delivery and keeps its missed count", async () => {
    const desk = await device("Desk");
    const row = add({ timeOfDay: "09:00", days: "0,1,2,3,4,5,6", missedAt: Date.now() - 1000, missedCount: 2 });
    ctx.app.reminders.start();
    await hearOut(desk);
    await sleep(100);
    const after = ctx.app.store.listReminders().find((r) => r.id === row.id)!;
    expect(after.dueAt).toBeGreaterThan(Date.now());
    expect(after).toMatchObject({ missedCount: 2, attempts: 0 });
    expect(after.missedAt).toBeDefined();
    // Dismissing clears the mark and leaves it repeating.
    ctx.app.reminders.dismiss({ id: row.id });
    expect(ctx.app.store.listReminders()[0]).toMatchObject({ missedCount: 0, timeOfDay: "09:00" });
    expect(ctx.app.store.listReminders()[0]!.missedAt).toBeUndefined();
  });

  it("does not speak one that is more than six hours late: it goes straight to missed", async () => {
    await device("Desk");
    add({ dueAt: Date.now() - 7 * 3600_000 });
    ctx.app.reminders.start();
    await sleep(300);
    expect(spoken).toHaveLength(0);
    expect(asked).toHaveLength(0);
    expect(ctx.app.store.listReminders()[0]).toMatchObject({ missedCount: 1 });
    expect(ctx.app.store.listReminders()[0]!.dueAt).toBeUndefined();
  });

  it("puts a notice on the screens that clears itself and is kept out of the admin tasks", async () => {
    const desk = await device("Desk");
    expect(ctx.app.progress.notice("t", "Call Sam", "Reminder", 250)).toBe(1);
    await desk.next("command", 0, (m) => m.name === "progress.show" && (m.params as any)?.title === "Call Sam");
    expect(ctx.app.progress.list().map((t) => t.id)).toEqual(["notice-t"]);
    expect((await admin("GET", "/admin/now")).body.tasks).toEqual([]);
    await sleep(400);
    expect(ctx.app.progress.list()).toHaveLength(0);
    const last = [...desk.received].reverse().find((m) => m.t === "command" && m.name === "progress.show") as any;
    expect(last.params.state).toBe("none");
  });

  it("sets a repeating reminder from words and rejects bad ones", () => {
    const r = ctx.app.reminders;
    const at = new Date(Date.now() + 3 * 24 * 3600_000).toISOString().slice(0, 16) + ":00Z";
    const made = r.set({ text: "Stretch\nnow ", at, repeat: "weekdays" });
    expect(made).toMatchObject({ text: "Stretch now", days: "1,2,3,4,5" });
    expect(made.timeOfDay).toMatch(/^\d\d:\d\d$/);
    expect(() => r.set({ text: "", at })).toThrow();
    expect(() => r.set({ text: "x", at: "2020-01-01 09:00" })).toThrow(/past/);
    expect(r.cancel({ text: "stretch" })).toHaveLength(1);
  });

  describe("targeting and quiet hours", () => {
    const idOf = (name: string) => [...ctx.app.hub.sessions()].find((s) => s.client.name === name)!.client.id;
    const engine = (extra: Record<string, unknown> = {}) => {
      ctx.app.reminders.stop();
      const options = { store: ctx.app.store, hub: ctx.app.hub, progress: ctx.app.progress, delivery: ctx.app.delivery, timeZone: () => "America/Chicago", retryMs: 150, chimeMs: 10 };
      return new Reminders({ ...options, ...extra } as ConstructorParameters<typeof Reminders>[0]);
    };
    const row = (extra: Record<string, unknown> = {}) => add(extra);
    const spoke = (c: Awaited<ReturnType<typeof device>>) => c.received.some((m) => m.t === "speak.start");

    it("last spoken-to wins over the default, and the default over any, decided at fire time", async () => {
      const a = await device("A");
      const b = await device("B");
      ctx.app.store.patchLayer("global", "", { defaultClient: idOf("B") });
      const recent = vi.spyOn((ctx.app.hub as any).turns, "recentInput").mockReturnValue(idOf("A"));
      const own = engine();
      const r = row({ dueAt: Date.now() + 50 });
      expect(own.route(r)).toMatchObject({ kind: "speak", session: { client: { id: idOf("A") } } });
      recent.mockReturnValue(undefined);
      expect(own.route(r)).toMatchObject({ kind: "speak", session: { client: { id: idOf("B") } } });
      ctx.app.store.patchLayer("global", "", { defaultClient: "" });
      expect(own.route(r).kind).toBe("speak");
      recent.mockRestore();
      void a; void b;
    });

    it("in quiet hours with a screen shows it silently: no agent turn, no audio", async () => {
      const desk = await device("Desk");
      vi.spyOn(ctx.app.hub, "quiet").mockReturnValue(true);
      const own = engine();
      const r = row({ dueAt: Date.now() + 50 });
      expect(own.route(r)).toMatchObject({ kind: "hush" });
      own.start();
      await sleep(400);
      own.stop();
      expect(asked).toHaveLength(0);
      expect(spoke(desk)).toBe(false);
      expect(ctx.app.store.listReminders().find((x) => x.id === r.id)).toBeUndefined();
      vi.restoreAllMocks();
    });

    it("in quiet hours with a speaker only sends a notification and no audio", async () => {
      const box = await device("Box", ["speaker", "mic"]);
      vi.spyOn(ctx.app.hub, "quiet").mockReturnValue(true);
      const notifyAll = vi.fn(async () => 1);
      const own = engine({ notifyAll });
      const r = row({ dueAt: Date.now() + 50 });
      expect(own.route(r)).toEqual({ kind: "push" });
      own.start();
      await sleep(400);
      own.stop();
      expect(notifyAll).toHaveBeenCalledOnce();
      expect(spoke(box)).toBe(false);
      expect(asked).toHaveLength(0);
      expect(ctx.app.store.listReminders().find((x) => x.id === r.id)).toBeUndefined();
      vi.restoreAllMocks();
    });

    it("in quiet hours with no screen and no push retries once and then keeps it as missed", async () => {
      const box = await device("Box", ["speaker", "mic"]);
      vi.spyOn(ctx.app.hub, "quiet").mockReturnValue(true);
      const own = engine({ notifyAll: async () => 0 });
      const r = row({ dueAt: Date.now() + 50 });
      own.start();
      await sleep(120);
      expect(ctx.app.store.listReminders().find((x) => x.id === r.id)).toMatchObject({ attempts: 1 });
      await sleep(400);
      own.stop();
      expect(ctx.app.store.listReminders().find((x) => x.id === r.id)).toMatchObject({ missedCount: 1 });
      expect(spoke(box)).toBe(false);
      vi.restoreAllMocks();
    });

    it("urgent speaks through quiet hours, but the silent profile never speaks even when urgent", async () => {
      const desk = await device("Desk");
      vi.spyOn(ctx.app.hub, "quiet").mockReturnValue(true);
      const own = engine();
      const urgent = row({ urgent: true });
      expect(own.route(urgent).kind).toBe("speak");
      own.start();
      await hearOut(desk);
      own.stop();
      vi.spyOn(ctx.app.hub, "profile").mockReturnValue({ profile: "silent", reason: "setting" } as any);
      expect(own.route(urgent).kind).toBe("hush");
      vi.restoreAllMocks();
    });

    it("everywhere says the static line on every device", async () => {
      const a = await device("A");
      const b = await device("B");
      const own = engine();
      row({ everywhere: true, dueAt: Date.now() + 50 });
      own.start();
      await hearOut(a);
      await hearOut(b);
      own.stop();
      expect(spoken).toContain("Reminder: Take the pills.");
      expect(asked).toHaveLength(0);
    });

    it("an offline target is retried, then falls back to the usual pick", async () => {
      const desk = await device("Desk");
      const ghost = await newPairedClient({ capabilities: ["screen", "speaker", "mic"], type: "board", name: "Ghost" });
      const own = engine();
      const r = row({ clientId: ghost.clientId, dueAt: Date.now() + 50 });
      expect(() => own.route(r)).toThrow(/offline/);
      own.start();
      await sleep(120);
      expect(ctx.app.store.listReminders().find((x) => x.id === r.id)).toMatchObject({ attempts: 1 });
      await hearOut(desk);
      await sleep(100);
      own.stop();
      expect(ctx.app.store.listReminders().find((x) => x.id === r.id)).toBeUndefined();
    });

    it("tells away phones on the normal path", async () => {
      const desk = await device("Desk");
      const tellPhones = vi.fn();
      const own = engine({ tellPhones });
      row({ dueAt: Date.now() + 50 });
      own.start();
      await hearOut(desk);
      own.stop();
      expect(tellPhones).toHaveBeenCalledWith("Reminder", "Take the pills", expect.stringMatching(/^reminder-/));
    });
  });
});
