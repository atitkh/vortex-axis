import { describe, expect, it } from "vitest";
import { AgentAsks } from "../src/agentasks.js";
import type { AskResult } from "../src/ask.js";

/** A gateway that announces and takes answers, and a person who answers as the test says. */
function world(answer: (input: { question: string; choices: string[]; silent: boolean; signal: AbortSignal }) => Promise<AskResult | undefined> | AskResult | undefined) {
  const listeners: ((event: string, payload: any) => void)[] = [];
  const calls: { method: string; params: any }[] = [];
  const asked: { question: string; choices: string[]; silent: boolean }[] = [];
  const changed: string[] = [];
  const on = { questions: true, approvals: true };
  const pending: any[] = [];
  const asks = new AgentAsks({
    source: {
      onEvent: (listener) => void listeners.push(listener),
      callWatch: async (method, params) => {
        calls.push({ method, params });
        return method === "question.list" ? { questions: pending } : {};
      },
    },
    route: {
      ask: async (input) => {
        asked.push({ question: input.question, choices: input.choices, silent: input.silent });
        return answer(input);
      },
    },
    questions: () => on.questions,
    approvals: () => on.approvals,
    onChange: (sessionKey) => void changed.push(sessionKey),
  });
  const say = async (event: string, payload: unknown) => {
    for (const listener of listeners) listener(event, payload);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return { asks, calls, asked, changed, on, pending, say };
}

const soon = () => Date.now() + 60_000;
const question = (extra: Record<string, unknown> = {}) => ({
  id: "q1",
  sessionKey: "agent:main:discord:channel:1",
  status: "pending",
  expiresAtMs: soon(),
  questions: [{ questionId: "deploy", question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }], ...extra }],
});

describe("what an OpenClaw agent waits on the person for", () => {
  it("puts a question to the person and sends the choice back", async () => {
    const w = world(() => ({ answer: "Yes", how: "tap" }));
    await w.say("question.requested", question());
    expect(w.asked).toEqual([{ question: "Deploy now?", choices: ["Yes", "No"], silent: false }]);
    expect(w.calls).toEqual([{ method: "question.resolve", params: { id: "q1", answers: { answers: { deploy: ["Yes"] } }, resolvedBy: "VorteX Axis" } }]);
    // The session's task was told to look again, and goes on waiting until the gateway says it is settled.
    expect(w.changed).toEqual(["agent:main:discord:channel:1"]);
    expect(w.asks.waitingOn("agent:main:discord:channel:1")).toBe("Deploy now?");
    await w.say("question.resolved", { id: "q1", status: "answered" });
    expect(w.asks.waitingOn("agent:main:discord:channel:1")).toBeUndefined();
    expect(w.changed).toHaveLength(2);
  });

  it("takes the person's own words only where the question does, and leaves the rest to be answered elsewhere", async () => {
    // Said something that is none of the choices: not Axis's to guess.
    let w = world(() => ({ answer: null, said: "maybe later", how: "voice" }));
    await w.say("question.requested", question());
    expect(w.calls).toEqual([]);

    // The same words where the question allows another answer, and where it has no choices at all.
    w = world(() => ({ answer: null, said: "maybe later", how: "voice" }));
    await w.say("question.requested", question({ isOther: true }));
    expect(w.calls[0]!.params.answers).toEqual({ answers: { deploy: ["maybe later"] } });
    w = world(() => ({ answer: null, said: "the blue one", how: "voice" }));
    await w.say("question.requested", question({ options: [] }));
    expect(w.calls[0]!.params.answers).toEqual({ answers: { deploy: ["the blue one"] } });

    // Nobody answered, or nowhere to ask.
    w = world(() => ({ answer: null, timedOut: true }));
    await w.say("question.requested", question());
    w = world(() => undefined);
    await w.say("question.requested", question());
    expect(w.calls).toEqual([]);
  });

  it("never asks for a secret or a pick of several, and nothing when switched off", async () => {
    const w = world(() => ({ answer: "Yes", how: "tap" }));
    await w.say("question.requested", question({ isSecret: true }));
    await w.say("question.requested", { ...question({ multiSelect: true }), id: "q2" });
    w.on.questions = false;
    await w.say("question.requested", { ...question(), id: "q3" });
    expect(w.asked).toEqual([]);
  });

  it("takes its question back when it was answered somewhere else", async () => {
    let signal: AbortSignal | undefined;
    const w = world((input) => {
      signal = input.signal;
      return new Promise<AskResult>((resolve) => input.signal.addEventListener("abort", () => resolve({ answer: null })));
    });
    await w.say("question.requested", question());
    expect(signal?.aborted).toBe(false);
    await w.say("question.resolved", { id: "q1", status: "answered" });
    expect(signal?.aborted).toBe(true);
    expect(w.calls).toEqual([]);
  });

  it("asks what was already waiting when it starts listening", async () => {
    const w = world(() => ({ answer: "No", how: "tap" }));
    w.pending.push(question(), { ...question(), id: "old", status: "answered" });
    await w.say("watch.connected", {});
    expect(w.asked).toHaveLength(1);
    expect(w.calls.map((c) => c.method)).toEqual(["question.list", "question.resolve"]);
  });

  it("offers an approval silently, once only, and lets nothing but a tap allow", async () => {
    const approval = { id: "a1", expiresAtMs: soon(), request: { command: "rm -rf build", sessionKey: "s1" } };
    let w = world(() => ({ answer: "Allow once", how: "tap" }));
    await w.say("exec.approval.requested", approval);
    expect(w.asked).toEqual([{ question: "Run this command? rm -rf build", choices: ["Allow once", "Deny"], silent: true }]);
    expect(w.calls).toEqual([{ method: "exec.approval.resolve", params: { id: "a1", decision: "allow-once" } }]);
    expect(w.asks.waitingOn("s1")).toBe("approve: rm -rf build");

    // Heard, not tapped: a voice cannot allow.
    w = world(() => ({ answer: "Allow once", how: "voice", said: "allow once" }));
    await w.say("exec.approval.requested", approval);
    expect(w.calls).toEqual([]);
    // But it can refuse.
    w = world(() => ({ answer: "Deny", how: "voice", said: "deny" }));
    await w.say("exec.approval.requested", approval);
    expect(w.calls).toEqual([{ method: "exec.approval.resolve", params: { id: "a1", decision: "deny" } }]);

    // A tool's approval goes to its own method; one that can only be allowed for good is left alone.
    w = world(() => ({ answer: "Deny", how: "tap" }));
    await w.say("plugin.approval.requested", { id: "p1", expiresAtMs: soon(), request: { title: "Send an email", description: "to the list" } });
    expect(w.asked[0]!.question).toBe("Allow this? Send an email: to the list");
    expect(w.calls[0]).toEqual({ method: "plugin.approval.resolve", params: { id: "p1", decision: "deny" } });
    await w.say("plugin.approval.requested", { id: "p2", expiresAtMs: soon(), request: { title: "Standing grant", allowedDecisions: ["allow-always", "deny"] } });
    expect(w.asked).toHaveLength(1);

    w.on.approvals = false;
    await w.say("exec.approval.requested", { ...approval, id: "a2" });
    expect(w.asked).toHaveLength(1);
  });
});
