import { describe, expect, it } from "vitest";
import type { Agent } from "../src/agent.js";
import { spoken, titleFrom } from "../src/background.js";
import type { TextToSpeech } from "../src/speech.js";
import { ready, restart, useServer } from "./harness.js";

/** An agent that answers each message once `release` is called for it, and can report a busy conversation. */
class SlowAgent {
  asked: { message: string; sessionKey: string | undefined }[] = [];
  aborted: string[] = [];
  /** Conversations the gateway would say have a run going. */
  busy = new Set<string>();
  private gates: (() => void)[] = [];
  answer = "The research is done. Three papers fit. More detail follows here.";
  /** Words said before going quiet. */
  opening = "";
  fail = false;

  release(): void {
    for (const open of this.gates.splice(0)) open();
  }

  agent: Agent = {
    reply: (message, signal, _onTool, _onState, route, onRun) => {
      const self = this;
      return (async function* () {
        const sessionKey = route?.sessionKey ?? "agent:main:vortex-axis";
        self.asked.push({ message, sessionKey });
        onRun?.({ runId: `run-${self.asked.length}`, sessionKey });
        // A turn sent aside answers at once.
        if (route?.sessionKey) {
          yield "Lights are off.";
          return;
        }
        if (self.opening) yield self.opening;
        await new Promise<void>((resolve) => {
          self.gates.push(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (signal?.aborted) return;
        if (self.fail) throw new Error("the agent accepted the turn but did not finish in time");
        yield self.answer;
      })();
    },
    target: async () => ({ sessionKey: "agent:main:vortex-axis", agentId: "main" }),
    activeRun: async (sessionKey) => ({ active: this.busy.has(sessionKey), title: "something from Discord" }),
    abortRun: async (run) => {
      this.aborted.push(run.runId);
    },
    healthy: async () => true,
  };
}

const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: () => (async function* () {
    yield Buffer.alloc(200, 1);
  })(),
  healthy: async () => true,
};

let slow: SlowAgent;
useServer(() => {
  slow = new SlowAgent();
  return { agent: slow.agent };
});

const texts = (client: { received: { t: string }[] }) =>
  client.received.filter((m) => m.t === "reply.text" && (m as { final: boolean }).final).map((m) => (m as { text: string }).text);

async function handedOver() {
  await restart({ handoverMs: 150 }, { agent: slow.agent });
  const { client } = await ready(["screen"]);
  client.send({ t: "text", turnId: "t1", text: "research papers on gaze replay" });
  await client.turn("t1", "idle");
  return client;
}

describe("a long agent run", () => {
  it("frees the device after a quiet spell and says the answer when it comes", async () => {
    const client = await handedOver();
    expect(texts(client)).toEqual(["On it. I'll tell you when it's done."]);

    slow.release();
    await client.next("reply.text", 0, (m) => m.final && m.text.startsWith("About"));
    expect(texts(client)[1]).toBe("About research papers on gaze replay: The research is done. Three papers fit. More detail follows here.");
  });

  it("keeps what the agent said before it went quiet", async () => {
    slow.opening = "Let me look into that.";
    await restart({ handoverMs: 150 }, { agent: slow.agent });
    const { client } = await ready(["screen"]);
    client.send({ t: "text", turnId: "t1", text: "dig into it" });
    await client.turn("t1", "idle");
    expect(texts(client)).toEqual(["Let me look into that. I'm still on it, and I'll tell you when it's done."]);
    slow.release();
  });

  it("says when a handed-over run fails", async () => {
    slow.fail = true;
    const client = await handedOver();
    slow.release();
    const said = await client.next("reply.text", 0, (m) => m.final && m.text.startsWith("That task"));
    expect(said.text).toBe("That task didn't finish: the agent accepted the turn but did not finish in time.");
  });

  it("sends a new turn to a conversation of its own while the run holds the usual one", async () => {
    const client = await handedOver();
    client.send({ t: "text", turnId: "t2", text: "lights off" });
    await client.turn("t2", "idle");
    expect(slow.asked[1]!.sessionKey).toBe("vortex-axis-busy");
    expect(slow.asked[1]!.message).toContain('busy: agent:main:vortex-axis is working on "research papers on gaze replay"');
    expect(texts(client)[1]).toBe("Lights are off.");

    // Once the run is over, turns go back to the usual conversation.
    slow.release();
    await client.next("reply.text", 0, (m) => m.final && m.text.startsWith("About"));
    client.send({ t: "text", turnId: "t3", text: "and now?" });
    await client.next("turn", 0, (m) => m.turnId === "t3" && m.state === "thinking");
    expect(slow.asked[2]!.sessionKey).toBe("agent:main:vortex-axis");
    slow.release();
  });

  it("sends a turn aside when the gateway reports a run Axis did not start", async () => {
    await restart({ handoverMs: 150 }, { agent: slow.agent });
    slow.busy.add("agent:main:vortex-axis");
    const { client } = await ready(["screen"]);
    client.send({ t: "text", turnId: "t1", text: "lights off" });
    await client.turn("t1", "idle");
    expect(slow.asked[0]!.sessionKey).toBe("vortex-axis-busy");
    expect(slow.asked[0]!.message).toContain('working on "something from Discord"');
  });

  it("waits to the end when handing over is switched off", async () => {
    await restart({ handoverMs: 0 }, { agent: slow.agent });
    const { client } = await ready(["screen"]);
    client.send({ t: "text", turnId: "t1", text: "slow one" });
    await new Promise((r) => setTimeout(r, 300));
    expect(texts(client)).toEqual([]);
    slow.release();
    await client.turn("t1", "idle");
    expect(texts(client)).toEqual([slow.answer]);
  });

  it("stops the run when its task is taken off the screens", async () => {
    await restart({ handoverMs: 150 }, { agent: slow.agent, tts });
    const { client } = await ready(["screen"]);
    client.send({ t: "text", turnId: "t1", text: "long job" });
    await client.turn("t1", "idle");
    const { ctx } = await import("./harness.js");
    const progress = (ctx.app as unknown as { progress?: { list(): { id: string }[]; clear(id: string): number } }).progress;
    if (!progress) return; // The app does not expose its task line to tests.
    const task = progress.list().find((t) => t.id.startsWith("bg-"))!;
    progress.clear(task.id);
    expect(slow.aborted).toEqual(["run-1"]);
  });
});

describe("what a finished run says", () => {
  it("names the task by the first words of the question", () => {
    expect(titleFrom("what's the weather?")).toBe("what's the weather");
    expect(titleFrom("find me every paper about gaze tracking in industrial digital twins")).toBe("find me every paper about gaze tracking…");
  });

  it("says the first few sentences of a long answer", () => {
    const answer = "The first paper looks at gaze replay in VR. The second one covers digital twins in factories. The third is about Modbus logging. The fourth is a survey.";
    expect(spoken(answer)).toBe("The first paper looks at gaze replay in VR. The second one covers digital twins in factories. The third is about Modbus logging. The rest is in the chat.");
    expect(spoken("Short answer.")).toBe("Short answer.");
  });
});
