import { describe, expect, it } from "vitest";
import { CardMirror, taskIdFor, titleFor } from "../src/cards.js";

/** A gateway that holds cards and sessions, and a progress board that keeps what it is told. */
function world() {
  const cards = new Map<string, { steps: { step: string; status: string }[] } | null>();
  const sessions = new Map<string, Record<string, unknown>>();
  const listeners: ((event: string, payload: any) => void)[] = [];
  const told: any[] = [];
  const cleared: string[] = [];
  const touched: string[] = [];
  let enabled = true;
  const mirror = new CardMirror({
    source: {
      onEvent: (listener) => void listeners.push(listener),
      call: async (method, params: any) => {
        if (method === "progressCard.get") return { card: cards.get(params.sessionKey) ?? null };
        if (method === "sessions.list") return { sessions: [...sessions.entries()].map(([key, s]) => ({ key, ...s })) };
        throw new Error(`unexpected ${method}`);
      },
    },
    progress: {
      update: (input: any) => {
        told.push(input);
        return { task: input, screens: 1 };
      },
      clear: (id?: string) => {
        cleared.push(id ?? "");
        return 1;
      },
      touch: (id: string) => void touched.push(id),
    },
    enabled: () => enabled,
    settleMs: 1,
    pollMs: 1_000_000,
  });
  const change = async (sessionKey: string) => {
    for (const listener of listeners) listener("progressCard.changed", { sessionKey, revision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { cards, sessions, told, cleared, touched, mirror, change, poll: () => (mirror as any).poll() as Promise<void>, enable: (on: boolean) => (enabled = on) };
}

const steps = (...status: string[]) => ({ steps: status.map((s, i) => ({ step: `Step ${i + 1}`, status: s })) });

describe("progress cards of an OpenClaw gateway", () => {
  it("names a task after where the person talks to the agent", () => {
    expect(titleFor({ origin: { label: "#VorteX Axis channel id:1557529238935052340" }, displayName: "1194 #vortex-axis" })).toBe("VorteX Axis");
    expect(titleFor({ label: "Homelab", displayName: "x" })).toBe("Homelab");
    expect(titleFor({})).toBe("Agent");
  });

  it("shows a card as a task, step by step, and finishes with it", async () => {
    const w = world();
    const key = "agent:main:discord:channel:1";
    w.sessions.set(key, { origin: { label: "#Homelab channel id:1" }, classification: "channel", hasActiveRun: true });
    w.cards.set(key, steps("completed", "in_progress", "pending"));
    await w.change(key);
    expect(w.told).toHaveLength(1);
    expect(w.told[0]).toMatchObject({ id: taskIdFor(key), title: "Homelab", note: "Step 2", state: "running" });
    expect(w.told[0].steps).toHaveLength(3);

    // The same card again is not told twice.
    await w.change(key);
    expect(w.told).toHaveLength(1);

    w.cards.set(key, steps("completed", "completed", "completed"));
    await w.change(key);
    expect(w.told[1]).toMatchObject({ state: "done", note: "" });

    // The card being put away afterwards takes the task with it.
    w.cards.set(key, null);
    await w.change(key);
    expect(w.cleared).toEqual([taskIdFor(key)]);
  });

  it("takes steps left with nobody at work for waiting on the person, and follows the session back to work", async () => {
    const w = world();
    const key = "agent:main:discord:channel:2";
    w.sessions.set(key, { label: "Axis", classification: "channel", hasActiveRun: true });
    w.cards.set(key, steps("completed", "in_progress"));
    await w.change(key);
    expect(w.told.at(-1)).toMatchObject({ state: "running" });

    await w.poll();
    expect(w.touched).toEqual([taskIdFor(key)]);
    expect(w.told).toHaveLength(1);

    w.sessions.get(key)!.hasActiveRun = false;
    await w.poll();
    expect(w.told.at(-1)).toMatchObject({ state: "blocked", note: "Step 2" });

    w.sessions.get(key)!.hasActiveRun = true;
    await w.poll();
    expect(w.told.at(-1)).toMatchObject({ state: "running" });
  });

  it("takes a session waiting for its subagents for at work, and says how many are running", async () => {
    const w = world();
    const key = "agent:main:discord:channel:3";
    const kids = ["agent:coder:subagent:a", "agent:coder:subagent:b", "agent:coder:subagent:c"];
    w.sessions.set(key, { label: "Axis", classification: "channel", hasActiveRun: false, childSessions: kids });
    for (const k of kids) w.sessions.set(k, { label: k, classification: "subagent", isBackground: true, hasActiveRun: k !== kids[2] });
    w.cards.set(key, steps("completed", "in_progress", "pending"));
    await w.change(key);
    // The turn is over with steps left, but two of three subagents are running: not "needs you".
    expect(w.told.at(-1)).toMatchObject({ state: "running", note: "2/3 agents running · Step 2" });

    w.sessions.get(kids[0]!)!.hasActiveRun = false;
    w.sessions.get(kids[1]!)!.hasActiveRun = false;
    await w.poll();
    // All finished and the agent has not come back: now it is the person's move, and the count stays.
    expect(w.told.at(-1)).toMatchObject({ state: "blocked", note: "3/3 agents done · Step 2" });

    // A subagent reported by the session itself (the flag) counts as at work even when its row is not listed.
    w.sessions.set(key, { label: "Axis", classification: "channel", hasActiveRun: false, hasActiveSubagentRun: true });
    await w.poll();
    expect(w.told.at(-1)).toMatchObject({ state: "running", note: "Step 2" });

    // The card finished: no count, as before.
    w.cards.set(key, steps("completed", "completed", "completed"));
    await w.change(key);
    expect(w.told.at(-1)).toMatchObject({ state: "done", note: "" });
  });

  it("leaves out scheduled jobs, cards already finished, and everything when switched off", async () => {
    const w = world();
    w.sessions.set("agent:main:cron:1", { label: "Automation: sync", classification: "cron", isBackground: true, hasActiveRun: true });
    w.cards.set("agent:main:cron:1", steps("in_progress", "pending"));
    await w.change("agent:main:cron:1");

    w.sessions.set("old", { label: "Old", classification: "channel", hasActiveRun: false });
    w.cards.set("old", steps("completed", "completed"));
    await w.change("old");
    expect(w.told).toHaveLength(0);

    w.sessions.set("live", { label: "Live", classification: "channel", hasActiveRun: true });
    w.cards.set("live", steps("in_progress"));
    await w.change("live");
    expect(w.told).toHaveLength(1);

    w.enable(false);
    w.cards.set("live", steps("completed"));
    await w.change("live");
    expect(w.told).toHaveLength(1);
    await w.poll();
    expect(w.cleared).toEqual([taskIdFor("live")]);
  });
});
