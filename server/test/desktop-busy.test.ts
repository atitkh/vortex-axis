import { describe, expect, it } from "vitest";
import { Desktops } from "../src/desktop.js";

/** A hub with one computer and one screen, whose screen takes or drops "desktop.busy" as the test says. */
function world(deliver: (call: number, on: number) => boolean) {
  const calls: number[] = [];
  const board = { client: { id: "board", name: "Desk board", capabilities: ["screen", "speaker", "mic"] } };
  const pc = { client: { id: "pc", name: "Desk PC", capabilities: ["desktop", "screen"] } };
  const hub = {
    onConnect: () => undefined,
    sessions: () => [board, pc],
    session: (id: string) => (id === "pc" ? pc : board),
    settings: () => ({}),
    command: async (_session: unknown, name: string, params: { on: number }) => {
      if (name !== "desktop.busy") return { ok: true };
      calls.push(params.on);
      if (!deliver(calls.length, params.on)) throw new Error("Desk board did not answer \"desktop.busy\" in 3 s");
      return { ok: true };
    },
  };
  const desktops = new Desktops(hub as never, {} as never, Date.now, { deliverMs: 5, retryMs: 5 });
  const internals = desktops as unknown as { touch(session: unknown, action: string, params: object): void; using: Map<string, unknown>; tellScreens(): void; told: Set<string> };
  return { calls, internals, pc };
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe("telling screens an agent is at a computer", () => {
  it("asks a screen again when it did not take the command, so it is never left in the wrong state", async () => {
    // The board misses the first two "on"s and the first "off": it was busy with a conversation.
    let offs = 0;
    const w = world((call, on) => (on === 1 ? call >= 3 : ++offs >= 2));
    w.internals.touch(w.pc, "look", {});
    await settle();
    expect(w.calls).toEqual([1, 1, 1]);
    expect(w.internals.told.has("board")).toBe(true);

    // The agent leaves: the "off" is missed once and delivered on the retry. It is not left glowing.
    w.internals.using.clear();
    w.internals.tellScreens();
    await settle();
    expect(w.calls).toEqual([1, 1, 1, 0, 0]);
    expect(w.internals.told.has("board")).toBe(false);
  });

  it("gives up on a screen that never answers instead of asking for ever", async () => {
    const w = world(() => false);
    w.internals.touch(w.pc, "look", {});
    await settle(200);
    // The first try plus five more, then it is left until the next change.
    expect(w.calls).toHaveLength(6);
    expect(w.internals.told.has("board")).toBe(false);
  });

  it("does not undo a newer state when an old delivery fails late", async () => {
    // The "on" is slow to fail; meanwhile the agent has left and "off" has been taken.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: number[] = [];
    const board = { client: { id: "board", name: "Desk board", capabilities: ["screen"] } };
    const pc = { client: { id: "pc", name: "Desk PC", capabilities: ["desktop"] } };
    const hub = {
      onConnect: () => undefined,
      sessions: () => [board, pc],
      session: (id: string) => (id === "pc" ? pc : board),
      settings: () => ({}),
      command: async (_s: unknown, _n: string, params: { on: number }) => {
        calls.push(params.on);
        if (params.on === 1) {
          await gate;
          throw new Error("late failure");
        }
        return { ok: true };
      },
    };
    const d = new Desktops(hub as never, {} as never, Date.now, { deliverMs: 5, retryMs: 5 });
    const x = d as unknown as { touch(session: unknown, a: string, p: object): void; using: Map<string, unknown>; tellScreens(): void; told: Set<string> };
    x.touch(pc, "look", {});
    x.using.clear();
    x.tellScreens();
    await settle(20);
    release();
    await settle(40);
    expect(calls).toEqual([1, 0]);
    expect(x.told.has("board")).toBe(false);
  });
});
