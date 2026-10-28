import { describe, expect, it } from "vitest";
import { ROLLOUT_WAIT_MS, Rollouts, RolloutBusy, type RolloutSession } from "../src/rollout.js";

const TYPE = "waveshare-amoled-1.8";
const OLD = "0.20.0";
const NEW = "0.21.0";

/** Boards, their connections and a clock, all pretend. */
function world(boards: { id: string; rssi?: number; online?: boolean; busy?: boolean }[]) {
  let at = 1_000_000;
  const clients = new Map(boards.map((b) => [b.id, { id: b.id, name: `Board ${b.id}`, type: TYPE, version: OLD }]));
  const sessions = new Map<string, RolloutSession>();
  const busy = new Set(boards.filter((b) => b.busy).map((b) => b.id));
  const sent: string[] = [];
  const notes: string[] = [];
  const refuse = new Set<string>();
  let saved: string | undefined;
  const connect = (id: string, rssi?: number) => sessions.set(id, { connectedAt: at, readings: rssi === undefined ? {} : { rssi }, readAt: {} });
  for (const b of boards) if (b.online !== false) connect(b.id, b.rssi);
  const deps = {
    client: (id: string) => clients.get(id),
    clientIds: () => [...clients.keys()],
    session: (id: string) => sessions.get(id),
    busy: (id: string) => busy.has(id),
    target: () => NEW,
    send: async (id: string) => {
      if (refuse.has(id)) throw new Error("refused");
      sent.push(id);
    },
    note: (_subject: string, text: string) => void notes.push(text),
    load: () => saved,
    save: (json: string) => void (saved = json),
    now: () => at,
    everyMs: 0,
  };
  const w = {
    deps,
    sent,
    notes,
    busy,
    refuse,
    sessions,
    rollouts: new Rollouts(deps),
    advance: (ms: number) => void (at += ms),
    /** The board restarts on `version` and, unless told not to, reports readings. */
    comeBack(id: string, version: string, readings = true) {
      at += 1000;
      clients.get(id)!.version = version;
      connect(id, -60);
      if (readings) {
        at += 1000;
        sessions.get(id)!.readAt = { rssi: at };
      }
    },
    status: () => Object.fromEntries((w.rollouts.view()?.devices ?? []).map((d) => [d.id, d.status])),
    restart: () => (w.rollouts = new Rollouts(deps)),
  };
  return w;
}

/** Lets the pretend sends resolve. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("staged firmware rollout", () => {
  it("sends the board with the strongest signal first, and only that one", async () => {
    const w = world([{ id: "a", rssi: -75 }, { id: "b", rssi: -52 }, { id: "c" }]);
    const view = w.rollouts.start();
    await settle();
    expect(view).toMatchObject({ state: "running", stage: "canary", canary: "b" });
    expect(view.canaryWhy).toMatch(/-52 dBm/);
    expect(w.sent).toEqual(["b"]);
    w.rollouts.tick();
    expect(w.sent).toEqual(["b"]);
  });

  it("passes over a board in a turn for the canary, and retries it later", async () => {
    const w = world([{ id: "a", rssi: -50, busy: true }, { id: "b", rssi: -70 }]);
    w.rollouts.start();
    await settle();
    expect(w.sent).toEqual(["b"]);
    expect(w.rollouts.view()!.devices.find((d) => d.id === "a")!.detail).toMatch(/busy/);
    w.comeBack("b", NEW);
    w.rollouts.tick();
    await settle();
    expect(w.sent).toEqual(["b"]);
    w.busy.delete("a");
    w.rollouts.tick();
    await settle();
    expect(w.sent).toEqual(["b", "a"]);
  });

  it("updates the rest at most two at a time once the canary is proven", async () => {
    const w = world([{ id: "a", rssi: -40 }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e", online: false }]);
    w.rollouts.start();
    await settle();
    expect(w.status().e).toBe("skipped");
    w.comeBack("a", NEW, false);
    w.rollouts.tick();
    expect(w.status().a).toBe("updating");
    w.sessions.get("a")!.readAt = { rssi: 2_000_000 };
    w.rollouts.tick();
    await settle();
    expect(w.status()).toMatchObject({ a: "proven", b: "updating", c: "updating", d: "waiting" });
    expect(w.rollouts.view()!.stage).toBe("rest");
    w.comeBack("b", NEW);
    w.rollouts.tick();
    await settle();
    expect(w.status()).toMatchObject({ b: "proven", c: "updating", d: "updating" });
    w.comeBack("c", NEW);
    w.comeBack("d", NEW);
    w.rollouts.tick();
    expect(w.rollouts.view()).toMatchObject({ state: "done", stage: "finished" });
    expect(w.sent).toEqual(["a", "b", "c", "d"]);
    expect(w.rollouts.view()!.devices.find((d) => d.id === "e")!.detail).toBe("offline");
  });

  it("aborts and holds the rest when the canary comes back on the old build", async () => {
    const w = world([{ id: "a", rssi: -40 }, { id: "b" }, { id: "c" }]);
    w.rollouts.start();
    await settle();
    w.comeBack("a", OLD);
    w.rollouts.tick();
    const view = w.rollouts.view()!;
    expect(view.state).toBe("aborted");
    expect(view.reason).toMatch(/came back on 0\.20\.0 instead of 0\.21\.0/);
    expect(w.status()).toEqual({ a: "failed", b: "held", c: "held" });
    expect(w.sent).toEqual(["a"]);
    expect(w.rollouts.attention("b")[0]).toMatch(/^update held/);
    expect(w.rollouts.attention("a")).toEqual([]);
    expect(w.notes.some((n) => n.startsWith("Rollout stopped"))).toBe(true);
  });

  it("aborts when the canary does not come back within six minutes, or refuses", async () => {
    const w = world([{ id: "a" }, { id: "b" }]);
    w.rollouts.start();
    await settle();
    w.advance(ROLLOUT_WAIT_MS - 5000);
    w.rollouts.tick();
    expect(w.rollouts.view()!.state).toBe("running");
    w.advance(10_000);
    w.rollouts.tick();
    expect(w.rollouts.view()).toMatchObject({ state: "aborted", reason: expect.stringMatching(/did not come back within 6 minutes/) });
    expect(w.status().b).toBe("held");

    const v = world([{ id: "a" }, { id: "b" }]);
    v.refuse.add("a").add("b");
    v.rollouts.start();
    await settle();
    expect(v.rollouts.view()).toMatchObject({ state: "aborted", reason: expect.stringMatching(/did not take the update: refused/) });
    expect(v.status()).toEqual({ a: "failed", b: "held" });
  });

  it("stops the queue on a failure after the canary but keeps watching what was sent", async () => {
    const w = world([{ id: "a", rssi: -40 }, { id: "b" }, { id: "c" }, { id: "d" }]);
    w.rollouts.start();
    await settle();
    w.comeBack("a", NEW);
    w.rollouts.tick();
    await settle();
    w.comeBack("b", OLD);
    w.rollouts.tick();
    expect(w.rollouts.view()!.state).toBe("stopping");
    expect(w.status()).toEqual({ a: "proven", b: "failed", c: "updating", d: "held" });
    w.comeBack("c", NEW);
    w.rollouts.tick();
    expect(w.rollouts.view()!.state).toBe("aborted");
    expect(w.status().c).toBe("proven");
    expect(w.sent).toEqual(["a", "b", "c"]);
  });

  it("allows one at a time, cancels, and marks a running one interrupted after a restart", async () => {
    const w = world([{ id: "a" }, { id: "b" }]);
    w.rollouts.start();
    expect(() => w.rollouts.start()).toThrow(RolloutBusy);
    await settle();
    w.rollouts.cancel();
    expect(w.rollouts.view()!.state).toBe("stopping");
    expect(w.status()).toEqual({ a: "updating", b: "skipped" });
    w.comeBack("a", NEW);
    w.rollouts.tick();
    expect(w.rollouts.view()!.state).toBe("cancelled");
    expect(w.rollouts.start().devices.map((d) => [d.id, d.status])).toEqual([["b", "updating"]]);

    const r = world([{ id: "a" }, { id: "b" }]);
    r.rollouts.start();
    await settle();
    r.restart();
    expect(r.rollouts.view()).toMatchObject({ state: "interrupted", stage: "finished", reason: expect.stringMatching(/restarted/) });
    expect(r.status()).toEqual({ a: "skipped", b: "held" });
    expect(r.rollouts.running()).toBe(false);
  });
});
