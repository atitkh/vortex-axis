import { describe, expect, it } from "vitest";
import type { Capability } from "@vortex-axis/protocol";
import type { Agent } from "../src/agent.js";
import { createInvokeHandler } from "../src/commands.js";
import type { TextToSpeech } from "../src/speech.js";
import { admin, connect, ctx, newPairedClient, useServer } from "./harness.js";

/** What the agent was asked, and what it answers. During a task it may also try something on a computer. */
const asked: string[] = [];
let answer = ["The build passed."];
let during: (() => Promise<void>) | undefined;

const agent: Agent = {
  reply: (message) =>
    (async function* () {
      asked.push(message);
      await during?.();
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
  answer = ["The build passed."];
  during = undefined;
  return { agent, tts };
});

function invoke(command: string, params: Record<string, unknown> = {}) {
  const { hub, store, timers, delivery, activity, desktops } = ctx.app as any;
  return createInvokeHandler({ hub, store, timers, delivery, activity, desktops, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(command, params) as Promise<any>;
}

async function device(name: string, capabilities: Capability[], type = "board") {
  const identity = await newPairedClient({ capabilities, type, name });
  const client = await connect(identity, { capabilities, type });
  await client.next("status");
  return client;
}

/** Plays out whatever the device is told to speak, as a device does. */
async function hearOut(client: Awaited<ReturnType<typeof device>>, from = 0) {
  const start = await client.next("speak.start", from);
  await client.next("speak.end", from, (m) => m.turnId === start.turnId);
  client.send({ t: "playback", turnId: start.turnId, state: "finished" });
  return start.turnId;
}

describe("a timer that does something", () => {
  it("gives the agent the task when it is due and speaks its answer, without ringing", async () => {
    const desk = await device("Desk", ["screen", "speaker", "mic"]);
    const set = await invoke("vortex.axis.timer", { action: "set", seconds: 1, label: "build", then: "Check whether the build finished and say so.", client: "Desk" });
    expect(set.set).toMatchObject({ label: "build", then: "Check whether the build finished and say so.", mayAct: false });
    expect(set.asked).toBeUndefined();
    expect((await admin("GET", "/admin/now")).body.timers[0]).toMatchObject({ task: "Check whether the build finished and say so.", mayAct: false });

    const turn = await hearOut(desk);
    expect(turn).toMatch(/^task-/);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("scheduled task");
    expect(asked[0]).toContain("may look but not click");
    expect(asked[0]).toContain("Check whether the build finished and say so.");
    // The answer says first what it is about: it comes when nobody is asking.
    expect(spoken.join(" ")).toBe("About build: The build passed.");
    expect(await desk.next("reply.text", 0, (m) => m.final)).toMatchObject({ text: "About build: The build passed." });
    // No "your timer is done", and it is off the list.
    expect(spoken.join(" ")).not.toMatch(/timer/);
    expect(ctx.app.timers.list()).toHaveLength(0);
  });

  it("keeps computers look-only while a task runs, unless the person allowed it when Axis asked", async () => {
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true });
    const desk = await device("Desk", ["screen", "speaker", "mic"]);
    const pc = await device("Desk PC", ["desktop"], "windows-desktop");

    // Not allowed: the agent's click during the task is refused before the computer hears of it; a look is not.
    let refused = "";
    during = async () => {
      refused = await invoke("vortex.axis.desktop", { action: "click", x: 5, y: 5 }).then(() => "", (e: Error) => e.message);
      const looking = invoke("vortex.axis.desktop", { action: "look" });
      const look = await pc.next("command", 0, (m) => m.name === "desktop.look");
      pc.send({ t: "command.result", id: look.id, ok: true, data: { elements: [] } });
      await looking;
    };
    await invoke("vortex.axis.timer", { action: "set", seconds: 1, label: "tidy", then: "Close the old tabs.", client: "Desk" });
    const first = await hearOut(desk);
    expect(refused).toMatch(/not now: the scheduled task "tidy" was not allowed to act/);
    // Afterwards (once the turn has wound up) the computer can be used again.
    during = undefined;
    await new Promise((r) => setTimeout(r, 400));
    const clicking = invoke("vortex.axis.desktop", { action: "click", x: 5, y: 5 });
    const click = await pc.next("command", 0, (m) => m.name === "desktop.click");
    pc.send({ t: "command.result", id: click.id, ok: true, payload: { x: 5, y: 5, how: "mouse" } });
    await clicking;

    // Asked for: Axis puts the question to the person itself, and their "Allow" is what counts.
    const mark = desk.received.length;
    const setting = invoke("vortex.axis.timer", { action: "set", seconds: 1, label: "send", then: "Press Send in the open draft.", act: true, client: "Desk" });
    // The question is spoken first; once it has been heard the choices show, and the person taps one.
    await hearOut(desk, mark);
    const question = await desk.next("ask");
    expect(question).toMatchObject({ question: expect.stringMatching(/may it click and type on your computer/), choices: ["Allow", "Look only"] });
    desk.send({ t: "answer", askId: question.askId, choice: "Allow" });
    const set = await setting;
    expect(set).toMatchObject({ asked: "allowed", set: { mayAct: true } });
    let acted = "";
    during = async () => {
      const going = invoke("vortex.axis.desktop", { action: "click", x: 9, y: 9 });
      const c = await pc.next("command", 0, (m) => m.name === "desktop.click" && m.params?.x === 9);
      pc.send({ t: "command.result", id: c.id, ok: true, payload: { x: 9, y: 9, how: "mouse" } });
      acted = (await going).done;
    };
    await desk.next("speak.start", mark, (m) => m.turnId.startsWith("task-") && m.turnId !== first);
    expect(acted).toBe("click");
    expect(asked.at(-1)).toContain("allowed this task to click and type");
  });

  it("says nothing at all when the agent has nothing to tell, and names an unlabelled task by what was asked", async () => {
    const desk = await device("Desk", ["screen", "speaker", "mic"]);
    answer = ["NO_REPLY"];
    await invoke("vortex.axis.timer", { action: "set", seconds: 1, label: "watch", then: "Say something only if the build failed.", client: "Desk" });
    await desk.next("reply.text", 0, (m) => m.final && m.turnId.startsWith("task-"));
    expect(spoken).toEqual([]);

    answer = ["Still running."];
    await invoke("vortex.axis.timer", { action: "set", seconds: 1, then: "Check whether the long download has finished yet and tell me.", client: "Desk" });
    await hearOut(desk);
    expect(spoken.join(" ")).toMatch(/^About Check whether the long download has…: Still running\.$/);
  });

  it("stays look-only when the person says so or says nothing, and refuses a task that is too long", async () => {
    const desk = await device("Desk", ["screen", "speaker", "mic"]);
    const setting = invoke("vortex.axis.timer", { action: "set", seconds: 600, then: "Do the thing.", act: true, client: "Desk" });
    await hearOut(desk);
    const question = await desk.next("ask");
    desk.send({ t: "answer", askId: question.askId, choice: "Look only" });
    expect(await setting).toMatchObject({ asked: "look only", set: { mayAct: false }, note: expect.stringMatching(/look-only/) });
    await expect(invoke("vortex.axis.timer", { action: "set", seconds: 60, then: "x".repeat(1001), client: "Desk" })).rejects.toThrow(/at most 1000/);
    // A plain timer is still a plain timer.
    expect((await invoke("vortex.axis.timer", { action: "set", seconds: 60, label: "tea", client: "Desk" })).set.then).toBeUndefined();
  });
});
