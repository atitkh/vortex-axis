import { describe, expect, it } from "vitest";
import { SelfCheck, type Check } from "../src/selfcheck.js";

const ALL = {
  methods: ["agent", "agents.list", "progressCard.get", "sessions.list", "question.list", "question.resolve", "exec.approval.resolve", "plugin.approval.resolve", "talk.session.create", "talk.session.appendAudio", "talk.session.submitToolResult", "talk.client.toolCall", "talk.catalog"],
  events: ["agent", "progressCard.changed", "question.requested", "question.resolved", "exec.approval.requested", "plugin.approval.requested", "talk.event"],
};

function world(over: { methods?: string[]; events?: string[]; scopes?: string[]; fail?: string; connected?: boolean; off?: string[] } = {}) {
  const calls: string[] = [];
  const changes: [string, Check["state"]][] = [];
  const state = { methods: over.methods ?? ALL.methods, events: over.events ?? ALL.events, scopes: over.scopes ?? ["operator.read", "operator.write", "operator.questions", "operator.approvals"], fail: over.fail, connected: over.connected ?? true };
  const on = (name: string) => () => !(over.off ?? []).includes(name);
  const check = new SelfCheck({
    source: {
      features: () => ({ methods: state.methods, events: state.events }),
      scopes: () => state.scopes,
      call: async (method) => {
        calls.push(method);
        if (method === state.fail) throw new Error("unknown method");
        return {};
      },
    },
    connected: () => state.connected,
    features: { cards: on("cards"), questions: on("questions"), approvals: on("approvals"), realtime: on("realtime"), toolIcons: on("toolIcons") },
    sessionKey: () => "agent:main:vortex-axis",
    onChange: (c) => void changes.push([c.id, c.state]),
  });
  return { check, calls, changes, state };
}

const states = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.id, c.state]));

describe("what Axis relies on in the gateway", () => {
  it("finds everything working on a gateway that offers it all, and tries what it can", async () => {
    const w = world();
    const report = await w.check.run();
    expect(report.asked).toBe(true);
    expect(states(report.checks)).toEqual({ turns: "ok", cards: "ok", questions: "ok", approvals: "ok", toolIcons: "ok", realtime: "ok" });
    expect(w.calls).toEqual(["agents.list", "sessions.list", "progressCard.get", "question.list", "talk.catalog"]);
    expect(w.changes).toEqual([]);
  });

  it("says what has gone when the gateway stops offering it, once, and again when it is back", async () => {
    const w = world({ events: ALL.events.filter((e) => e !== "progressCard.changed") });
    let report = await w.check.run();
    expect(states(report.checks).cards).toBe("problem");
    expect(report.checks.find((c) => c.id === "cards")!.detail).toMatch(/no longer offers the event progressCard\.changed/);
    expect(states(report.checks).turns).toBe("ok");
    await w.check.run();
    expect(w.changes).toEqual([["cards", "problem"]]);

    w.state.events = ALL.events;
    report = await w.check.run();
    expect(states(report.checks).cards).toBe("ok");
    expect(w.changes).toEqual([["cards", "problem"], ["cards", "ok"]]);
  });

  it("tells a scope that is missing and a call that does not answer apart from each other", async () => {
    let report = await world({ scopes: ["operator.read", "operator.write"] }).check.run();
    expect(report.checks.find((c) => c.id === "questions")).toMatchObject({ state: "problem", detail: expect.stringMatching(/not granted Axis operator\.questions/) });
    expect(report.checks.find((c) => c.id === "approvals")).toMatchObject({ state: "problem" });

    report = await world({ fail: "talk.catalog" }).check.run();
    expect(report.checks.find((c) => c.id === "realtime")).toMatchObject({ state: "problem", detail: expect.stringMatching(/would not answer: unknown method/) });
  });

  it("leaves alone what is switched off, and asks nothing with no gateway", async () => {
    const w = world({ off: ["questions", "realtime"], methods: [], events: [] });
    const report = await w.check.run();
    expect(states(report.checks)).toMatchObject({ questions: "off", realtime: "off", cards: "ok", approvals: "unknown" });
    expect(w.calls).not.toContain("question.list");

    expect(await world({ connected: false }).check.run()).toMatchObject({ asked: false, checks: [] });
  });
});
