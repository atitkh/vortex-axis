import { describe, expect, it } from "vitest";
import { UPSTREAM_AUDIO_FORMAT, type Capability } from "@vortex-axis/protocol";
import { matchChoice } from "../src/ask.js";
import { createInvokeHandler } from "../src/commands.js";
import type { SpeechToText } from "../src/speech.js";
import { spokenLength } from "../src/timers.js";
import { connect, ctx, newPairedClient, restart, useServer } from "./harness.js";

useServer();

/** The node's command handler, as the gateway link would call it. */
function invoke(command: string, params: Record<string, unknown> = {}) {
  const { hub, store, timers, activity } = ctx.app;
  return createInvokeHandler({ hub, store, timers, activity, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(
    command,
    params,
  ) as Promise<any>;
}

async function device(name: string, capabilities: Capability[] = ["screen", "mic"], type = "board") {
  const identity = await newPairedClient({ capabilities, type, name });
  const client = await connect(identity, { capabilities, type });
  await client.next("status");
  return { identity, client };
}

const hears = (transcript: string): SpeechToText => ({ transcribe: async () => transcript, healthy: async () => true });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("matching a spoken answer to a choice", () => {
  it("takes a choice named in full, the longest when several fit", () => {
    expect(matchChoice("I'd like the green tea, please.", ["Tea", "Green tea", "Coffee"])).toBe("Green tea");
    expect(matchChoice("coffee", ["Tea", "Coffee"])).toBe("Coffee");
    expect(matchChoice("notable", ["No", "Yes"])).toBeUndefined();
  });

  it("understands a position, and plain yes and no", () => {
    expect(matchChoice("The second one.", ["Red", "Blue", "Green"])).toBe("Blue");
    expect(matchChoice("Yeah, go ahead.", ["Yes", "No"])).toBe("Yes");
    expect(matchChoice("Nah.", ["Yes", "No"])).toBe("No");
    expect(matchChoice("maybe later", ["Yes", "No"])).toBeUndefined();
  });
});

describe("vortex.axis.ask", () => {
  it("shows the question, offers the choices and returns the one picked", async () => {
    const { client } = await device("Desk");
    const pending = invoke("vortex.axis.ask", { question: "Lights off?", choices: ["Yes", "No"], client: "Desk" });
    const shown = await client.next("reply.text");
    expect(shown.text).toBe("Lights off?");
    const ask = await client.next("ask");
    expect(ask).toMatchObject({ question: "Lights off?", choices: ["Yes", "No"], timeoutMs: 30_000 });
    client.send({ t: "answer", askId: ask.askId, choice: "No" });
    expect(await pending).toMatchObject({ client: "Desk", answer: "No", how: "tap" });
    expect((await client.next("ask.end")).askId).toBe(ask.askId);
  });

  it("takes a spoken answer and does not pass it to the agent", async () => {
    await restart({}, { stt: hears("Coffee, please.") });
    const { client } = await device("Desk");
    const pending = invoke("vortex.axis.ask", { question: "Tea or coffee?", choices: ["Tea", "Coffee"] });
    await client.next("ask");
    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(Buffer.alloc(3200));
    client.send({ t: "audio.end", turnId: "t1", reason: "silence" });
    expect(await pending).toMatchObject({ answer: "Coffee", said: "Coffee, please.", how: "voice" });
    await client.next("ask.end");
    // No agent is set up; had the words gone to one, the turn would have failed.
    expect(client.received.some((m) => m.t === "error")).toBe(false);
  });

  it("returns the words of an open question, and of an answer that matches nothing", async () => {
    await restart({}, { stt: hears("Call it Bob.") });
    const { client } = await device("Desk");
    const open = invoke("vortex.axis.ask", { question: "What should I call it?" });
    expect((await client.next("ask")).choices).toEqual([]);
    client.send({ t: "text", turnId: "t1", text: "Bob" });
    expect(await open).toMatchObject({ answer: null, said: "Bob", how: "typed" });

    const closed = invoke("vortex.axis.ask", { question: "Red or blue?", choices: ["Red", "Blue"] });
    await client.next("ask", 0, (m) => m.choices.length === 2);
    client.send({ t: "text", turnId: "t2", text: "purple" });
    expect(await closed).toMatchObject({ answer: null, said: "purple", note: expect.stringMatching(/matched none/) });
  });

  it("gives up when nobody answers, and refuses a client that could not answer", async () => {
    const { client } = await device("Desk");
    const { hub } = ctx.app;
    const result = await hub.ask(hub.session((await invoke("vortex.axis.clients")).clients[0].id)!, "Anyone?", ["Yes"], 1000);
    expect(result).toEqual({ answer: null, timedOut: true });
    await client.next("ask.end");

    await device("Speaker", ["speaker"], "plain");
    await expect(invoke("vortex.axis.ask", { question: "Yes?", choices: ["Yes"], client: "Speaker" })).rejects.toThrow(/no microphone/);
    await expect(invoke("vortex.axis.ask", { question: "Pick", choices: ["1", "2", "3", "4", "5", "6", "7"] })).rejects.toThrow(/six/);
  });
});

describe("vortex.axis.timer", () => {
  it("says how long a timer is", () => {
    expect(spokenLength(300)).toBe("5 minute");
    expect(spokenLength(5400)).toBe("1 hour 30 minute");
    expect(spokenLength(45)).toBe("45 second");
  });

  it("sets, lists and cancels timers, and tells the client which is next", async () => {
    const { client } = await device("Desk");
    await client.next("command"); // on connect: no timers
    const set = await invoke("vortex.axis.timer", { action: "set", seconds: 300, label: "pasta", client: "Desk" });
    expect(set.set).toMatchObject({ label: "pasta", client: "Desk", setForSeconds: 300 });
    const told = await client.next("command", 0, (m) => m.params?.count === 1);
    expect(told).toMatchObject({ name: "timer.next", params: { label: "pasta", count: 1 } });
    await invoke("vortex.axis.timer", { action: "set", seconds: 60, client: "Desk" });

    const listed = await invoke("vortex.axis.timer", {});
    expect(listed.timers.map((t: any) => t.label)).toEqual([null, "pasta"]);
    expect(listed.timers[1].secondsLeft).toBeGreaterThan(290);

    const cancelled = await invoke("vortex.axis.timer", { action: "cancel", label: "Pasta" });
    expect(cancelled).toMatchObject({ cancelled: [{ label: "pasta" }], left: 1 });
    await expect(invoke("vortex.axis.timer", { action: "cancel" })).rejects.toThrow(/which timer/);
    expect((await invoke("vortex.axis.timer", { action: "cancel", all: true })).left).toBe(0);
    await expect(invoke("vortex.axis.timer", { action: "set", seconds: 0 })).rejects.toThrow(/how long/);
  });

  it("announces a timer when it is due, and keeps one across a restart", async () => {
    const { identity, client } = await device("Desk");
    await invoke("vortex.axis.timer", { action: "set", seconds: 2, label: "tea", client: "Desk" });
    client.close();
    await restart();
    expect(ctx.app.timers.list()).toHaveLength(1);
    const back = await connect(identity, { capabilities: ["screen", "mic"], type: "board" });
    for (let i = 0; i < 90 && !back.received.some((m) => m.t === "reply.text" && m.final); i++) await pause(50);
    const said = back.received.find((m) => m.t === "reply.text" && m.final) as { text: string };
    expect(said.text).toMatch(/^Your tea timer (is done|finished)/);
    for (let i = 0; i < 40 && ctx.app.timers.list().length; i++) await pause(50);
    expect(ctx.app.timers.list()).toHaveLength(0);
  });
});

describe("vortex.axis.admin", () => {
  it("lists what devices offer, runs an action, renames, and makes a pairing code", async () => {
    const { client } = await device("Desk");
    client.send({ t: "describe", settings: [], actions: [{ name: "chime", label: "Play the chime" }], links: [] });
    for (let i = 0; i < 40; i++) {
      if ((await invoke("vortex.axis.admin")).clients[0].actions.some((a: any) => a.name === "chime")) break;
      await pause(25);
    }
    const listed = await invoke("vortex.axis.admin", { client: "Desk" });
    expect(listed.clients[0]).toMatchObject({ client: "Desk", online: true });

    const running = invoke("vortex.axis.admin", { action: "run", client: "Desk", run: "chime" });
    const command = await client.next("command", 0, (m) => m.name === "chime");
    client.send({ t: "command.result", id: command.id, ok: true, payload: { played: true } });
    expect(await running).toEqual({ client: "Desk", ran: "chime", result: { played: true } });
    await expect(invoke("vortex.axis.admin", { action: "run", client: "Desk", run: "format" })).rejects.toThrow(/does not offer "format"/);

    expect(await invoke("vortex.axis.admin", { action: "rename", client: "Desk", name: "Kitchen" })).toEqual({ client: "Kitchen", was: "Desk" });
    expect((await invoke("vortex.axis.clients")).clients[0].name).toBe("Kitchen");

    const code = await invoke("vortex.axis.admin", { action: "pairing_code" });
    expect(code.code).toMatch(/\S{4,}/);
    expect(code.expiresInMinutes).toBe(1);
  });
});
