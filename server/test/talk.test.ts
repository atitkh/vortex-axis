import { describe, expect, it } from "vitest";
import { UPSTREAM_AUDIO_FORMAT } from "@vortex-axis/protocol";
import type { Agent } from "../src/agent.js";
import type { SpeechToText, TextToSpeech } from "../src/speech.js";
import { RealtimeTalk, TALK_FORMAT, resample } from "../src/talk.js";
import { admin, ready, useServer } from "./harness.js";

/** A gateway's Talk relay, as far as Axis sees it: it takes calls and can be made to say things. */
function relay() {
  const listeners: ((event: string, payload: any) => void)[] = [];
  const calls: { method: string; params: any }[] = [];
  let sessions = 0;
  const source = {
    onEvent: (listener: (event: string, payload: any) => void) => void listeners.push(listener),
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "talk.session.create") {
        const id = `relay-${++sessions}`;
        setTimeout(() => say(id, { type: "ready" }), 1);
        return { relaySessionId: id, sessionId: id, provider: "openai", audio: { inputEncoding: "pcm16", inputSampleRateHz: 24000, outputEncoding: "pcm16", outputSampleRateHz: 24000 } };
      }
      return { ok: true };
    },
  };
  const say = (relaySessionId: string, event: Record<string, unknown>) => {
    for (const listener of listeners) listener("talk.event", { relaySessionId, ...event });
  };
  const appended = () => calls.filter((c) => c.method === "talk.session.appendAudio").reduce((sum, c) => sum + Buffer.from(c.params.audioBase64, "base64").length, 0);
  return { source, calls, say, appended };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const speech = (ms: number, rate = 16000) => Buffer.alloc((rate * 2 * ms) / 1000, 3);

describe("realtime voice through the gateway's Talk relay", () => {
  it("changes the sample rate of sound", () => {
    expect(resample(speech(1000), 16000, 24000).length).toBe(48000);
    expect(resample(speech(1000, 24000), 24000, 24000).length).toBe(48000);
    const ramp = Buffer.from(new Int16Array([0, 300, 600]).buffer);
    expect([...new Int16Array(resample(ramp, 2, 4).buffer)].slice(0, 4)).toEqual([0, 150, 300, 450]);
  });

  it("sends an utterance with quiet after it and plays back the answer", async () => {
    const r = relay();
    const talk = new RealtimeTalk({ source: r.source, sessionKey: () => "agent:main:vortex-axis", settleMs: 20 });
    const audio: Buffer[] = [], texts: string[] = [];
    let heard = "";
    const turn = talk.converse("c1", speech(1000), UPSTREAM_AUDIO_FORMAT, {
      signal: new AbortController().signal,
      onHeard: (text) => (heard = text),
      onText: (text) => void texts.push(text),
      onAudio: (chunk) => void audio.push(chunk),
    });
    await tick(30);
    expect(r.calls[0]).toMatchObject({ method: "talk.session.create", params: { sessionKey: "agent:main:vortex-axis", mode: "realtime", transport: "gateway-relay", brain: "agent-consult" } });
    // One second at 16 kHz is 48000 bytes at 24 kHz, and 0.9 s of quiet after it is 43200 more.
    expect(r.appended()).toBe(48000 + 43200);

    r.say("relay-1", { type: "transcript", role: "user", text: "what is two plus two", final: true });
    r.say("relay-1", { type: "responseStarted" });
    r.say("relay-1", { type: "transcript", role: "assistant", text: "Two plus", final: false });
    r.say("relay-1", { type: "audio", audioBase64: Buffer.alloc(480, 1).toString("base64") });
    r.say("relay-1", { type: "mark", markName: "m1" });
    r.say("relay-1", { type: "transcript", role: "assistant", text: "Two plus two is four.", final: true });
    r.say("relay-1", { type: "audioDone" });
    expect(await turn).toEqual({ heard: "what is two plus two", said: "Two plus two is four.", answered: true });
    expect(heard).toBe("what is two plus two");
    expect(texts).toEqual(["Two plus", "Two plus two is four."]);
    expect(Buffer.concat(audio).length).toBe(480);
    expect(r.calls.some((c) => c.method === "talk.session.acknowledgeMark" && c.params.markName === "m1")).toBe(true);

    // The session is kept for the next thing said.
    const again = talk.converse("c1", speech(200), UPSTREAM_AUDIO_FORMAT, { signal: new AbortController().signal });
    await tick(30);
    r.say("relay-1", { type: "responseStarted" });
    r.say("relay-1", { type: "audio", audioBase64: Buffer.alloc(2).toString("base64") });
    r.say("relay-1", { type: "audioDone" });
    await again;
    expect(r.calls.filter((c) => c.method === "talk.session.create")).toHaveLength(1);
    talk.stop();
    expect(r.calls.at(-1)).toMatchObject({ method: "talk.session.close", params: { sessionId: "relay-1" } });
  });

  it("gets the agent to do the work the model hands it, and gives up on nothing heard", async () => {
    const r = relay();
    const talk = new RealtimeTalk({ source: r.source, settleMs: 20, firstAnswerMs: 40 });
    const asked: string[] = [];
    let answer!: (text: string) => void;
    const turn = talk.converse("c1", speech(200), UPSTREAM_AUDIO_FORMAT, {
      signal: new AbortController().signal,
      consult: (work) => {
        expect(work).toMatchObject({ callId: "t1", relaySessionId: "relay-1", args: { question: "Are the lights on?" } });
        asked.push(work.question);
        return new Promise<string>((resolve) => (answer = resolve));
      },
    });
    await tick(30);
    // The model says it is checking, and asks.
    r.say("relay-1", { type: "responseStarted" });
    r.say("relay-1", { type: "toolCall", callId: "t1", name: "openclaw_agent_consult", args: { question: "Are the lights on?", context: "Asked at the desk." } });
    r.say("relay-1", { type: "audio", audioBase64: Buffer.alloc(2).toString("base64") });
    r.say("relay-1", { type: "audioDone" });
    // Its first answer is over, but the agent's is still to come: the turn is not.
    let over = false;
    void turn.then(() => (over = true));
    await tick(60);
    expect(over).toBe(false);
    expect(asked).toEqual(["Are the lights on?\n\nContext:\nAsked at the desk."]);

    answer("The lights are on.");
    await tick();
    expect(r.calls.find((c) => c.method === "talk.session.submitToolResult")?.params).toEqual({ sessionId: "relay-1", callId: "t1", result: { result: "The lights are on." } });
    // The model then says it, and that ends the turn.
    r.say("relay-1", { type: "responseStarted" });
    r.say("relay-1", { type: "transcript", role: "assistant", text: "Your lights are on.", final: true });
    r.say("relay-1", { type: "audioDone" });
    expect((await turn).said).toBe("Your lights are on.");

    // A tool nobody here can run is refused at once, so the model is not left waiting.
    const other = talk.converse("c1", speech(100), UPSTREAM_AUDIO_FORMAT, { signal: new AbortController().signal });
    await tick(30);
    r.say("relay-1", { type: "toolCall", callId: "t2", name: "describe_view" });
    await tick();
    expect(r.calls.at(-1)?.params).toMatchObject({ callId: "t2", result: { error: expect.stringMatching(/not available/) } });
    // And sound the model makes nothing of gets no answer: the turn ends by itself.
    expect(await other).toMatchObject({ answered: false });
    talk.stop();
  });

  it("takes back the answer when the turn is interrupted, and drops a session that fails", async () => {
    const r = relay();
    const talk = new RealtimeTalk({ source: r.source, settleMs: 20 });
    const abort = new AbortController();
    const turn = talk.converse("c1", speech(100), UPSTREAM_AUDIO_FORMAT, { signal: abort.signal });
    await tick(30);
    r.say("relay-1", { type: "responseStarted" });
    abort.abort();
    await turn;
    expect(r.calls.some((c) => c.method === "talk.session.cancelOutput")).toBe(true);

    const failing = talk.converse("c1", speech(100), UPSTREAM_AUDIO_FORMAT, { signal: new AbortController().signal });
    await tick(30);
    r.say("relay-1", { type: "error", message: "provider went away" });
    await expect(failing).rejects.toThrow("provider went away");
    expect(r.calls.some((c) => c.method === "talk.session.close")).toBe(true);
    talk.stop();
  });
});

// --- a whole turn, with a device set to it ----------------------------------------------------

const stt: SpeechToText = { transcribe: async () => "local words", healthy: async () => true };
const tts: TextToSpeech = { format: TALK_FORMAT, synthesize: () => (async function* () { yield Buffer.alloc(480, 1); })(), healthy: async () => true };
const agent: Agent = { reply: () => (async function* () { yield "Local answer."; })(), healthy: async () => true };
const asked: string[] = [];
/** When set, the voice comes as a first piece, a silence of this long, and then a second of sound all at once. */
let gapMs = 0;
const talk = {
  format: TALK_FORMAT,
  converse: async (clientId: string, _pcm: Buffer, _format: unknown, handlers: any) => {
    asked.push(clientId);
    if (gapMs) {
      await handlers.onAudio?.(Buffer.alloc(4800, 1));
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      await handlers.onAudio?.(Buffer.alloc(48000, 1));
      return { heard: "", said: "", answered: true };
    }
    handlers.onHeard?.("what time is it");
    handlers.onText?.("It is");
    await handlers.onAudio?.(Buffer.alloc(960, 1));
    handlers.onText?.("It is eight.");
    return { heard: "what time is it", said: "It is eight.", answered: true };
  },
  stop: () => undefined,
} as unknown as RealtimeTalk;
useServer(() => ({ stt, tts, agent, talk }));

describe("a device set to realtime voice", () => {
  it("is answered by the realtime model, and one that is not set to it by Axis's own chain", async () => {
    const { client, identity } = await ready(["mic", "speaker", "screen"], { name: "Desk" });
    const speak = async (turnId: string) => {
      client.send({ t: "audio.start", turnId, format: UPSTREAM_AUDIO_FORMAT });
      client.sendAudio(Buffer.alloc(3200, 2));
      client.send({ t: "audio.end", turnId, reason: "silence" });
      await client.next("speak.end", 0, (m) => m.turnId === turnId);
      client.send({ t: "playback", turnId, state: "finished" });
      await client.turn(turnId, "idle");
    };

    await speak("t1");
    expect((await client.next("reply.text", 0, (m) => m.turnId === "t1" && m.final)).text).toBe("Local answer.");
    expect(asked).toEqual([]);

    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { voiceMode: "realtime" } });
    await speak("t2");
    expect((await client.next("transcript", 0, (m) => m.turnId === "t2")).text).toBe("what time is it");
    expect((await client.next("reply.text", 0, (m) => m.turnId === "t2" && m.final)).text).toBe("It is eight.");
    expect(client.received.filter((m) => m.t === "reply.text" && m.turnId === "t2" && !m.final).map((m) => m.text)).toEqual(["It is", " eight."]);
    expect(asked).toEqual([identity.clientId]);
    expect(client.received.filter((m) => m.t === "turn" && m.turnId === "t2").map((m) => m.state)).toEqual(["listening", "thinking", "speaking", "idle"]);
  });

  it("still paces the voice to the device's buffer after a gap in it", async () => {
    gapMs = 1000;
    const { client, identity } = await ready(["mic", "speaker"], { hello: { audioBufferMs: 200, maxFrameBytes: 4800 } });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { voiceMode: "realtime" } });
    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(Buffer.alloc(3200, 2));
    client.send({ t: "audio.end", turnId: "t1", reason: "silence" });
    await client.next("speak.end");
    gapMs = 0;
    const frames = client.timeline.filter((m) => m.t === "<audio>") as { at: number }[];
    // A second of sound came after the gap. The gap is not room in the device's buffer: with 200 ms of
    // allowance that second takes most of a second to send. Counted as room, it went out in an instant.
    const afterGap = frames[frames.length - 1]!.at - frames[1]!.at;
    expect(afterGap).toBeGreaterThan(500);
  });
});
