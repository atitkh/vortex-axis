import { describe, expect, it, vi } from "vitest";
import type { Capability } from "@vortex-axis/protocol";
import { Reminders } from "../src/reminders.js";
import type { TextToSpeech } from "../src/speech.js";
import { connect, ctx, newPairedClient, useServer } from "./harness.js";

const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: () =>
    (async function* () {
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
useServer(() => ({ tts }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function device(name: string, capabilities: Capability[] = ["screen", "speaker", "mic"]) {
  const identity = await newPairedClient({ capabilities, type: "board", name });
  const client = await connect(identity, { capabilities, type: "board" });
  await client.next("status");
  return client;
}

const addReminder = (extra: Record<string, unknown> = {}) =>
  ctx.app.store.addReminder({ text: "Take the pills", dueAt: Date.now() + 50, everywhere: false, urgent: false, attempts: 0, missedCount: 0, createdAt: Date.now(), ...extra });

const engine = (extra: Record<string, unknown> = {}) => {
  ctx.app.reminders.stop();
  const options = { store: ctx.app.store, hub: ctx.app.hub, progress: ctx.app.progress, delivery: ctx.app.delivery, timeZone: () => "America/Chicago", retryMs: 150, chimeMs: 10 };
  return new Reminders({ ...options, ...extra } as ConstructorParameters<typeof Reminders>[0]);
};

describe("an everywhere reminder that is not delivered", () => {
  it("keeps one row through the retry and the miss, even when the delivery dropped it", async () => {
    await device("Box", ["speaker", "mic"]);
    vi.spyOn(ctx.app.hub, "quiet").mockReturnValue(true);
    const own = engine();
    const r = addReminder({ everywhere: true });
    own.start();
    await sleep(600);
    own.stop();
    vi.restoreAllMocks();
    expect(ctx.app.store.listReminders().find((x) => x.id === r.id)).toMatchObject({ missedCount: 1 });
    const rows = ctx.app.store.notificationsForReminder(r.id);
    expect(rows.map((n) => n.status)).toEqual(["missed"]);
  });
});

describe("a reminder that is cancelled or removed", () => {
  it("drops the row of a firing still waiting for its retry", async () => {
    await device("Box", ["speaker", "mic"]);
    vi.spyOn(ctx.app.hub, "quiet").mockReturnValue(true);
    const own = engine({ retryMs: 60_000, notifyAll: async () => 0 });
    const r = addReminder();
    own.start();
    await sleep(200);
    expect(ctx.app.store.listReminders().find((x) => x.id === r.id)).toMatchObject({ attempts: 1 });
    expect(ctx.app.store.notificationsForReminder(r.id).map((n) => n.status)).toEqual(["pending"]);
    expect(own.cancel({ id: r.id })).toHaveLength(1);
    own.stop();
    vi.restoreAllMocks();
    expect(ctx.app.store.notificationsForReminder(r.id).map((n) => n.status)).toEqual(["dropped"]);
  });

  it("a new reminder that gets an old one's id does not take over the old one's row", async () => {
    await device("Box", ["speaker", "mic"]);
    const quiet = vi.spyOn(ctx.app.hub, "quiet").mockReturnValue(true);
    const own = engine({ retryMs: 60_000, notifyAll: async () => 0 });
    const old = addReminder({ text: "Old words" });
    own.start();
    await sleep(200);
    own.stop();
    quiet.mockRestore();
    expect(ctx.app.store.notificationsForReminder(old.id)).toHaveLength(1);
    ctx.app.store.removeReminder(old.id);
    await sleep(5);
    await device("Desk");
    const fresh = addReminder({ text: "New words", createdAt: Date.now() });
    expect(fresh.id).toBe(old.id);
    const again = engine();
    again.start();
    await sleep(400);
    again.stop();
    const rows = ctx.app.store.notificationsForReminder(fresh.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.body).toContain("New words");
  });
});
