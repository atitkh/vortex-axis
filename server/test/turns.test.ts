import { describe, expect, it } from "vitest";
import { UPSTREAM_AUDIO_FORMAT, type AudioFormat } from "@vortex-axis/protocol";
import type { Agent } from "../src/agent.js";
import type { SpeechToText, TextToSpeech } from "../src/speech.js";
import { admin, ready, restart, useServer } from "./harness.js";

/** Stand-ins for the upstream services, recording what they were asked. */
class Fakes {
  heard: { bytes: number; format: AudioFormat }[] = [];
  asked: string[] = [];
  spoken: { text: string; voice: string | undefined }[] = [];
  transcript = "what time is it";
  reply: string[] = ["It is eight o'clock. ", "Time for ", "a break."];
  /** Bytes of audio produced per sentence. */
  audioBytes = 1000;
  agentDelayMs = 0;
  failAgent = false;

  stt: SpeechToText = {
    transcribe: async (pcm, format) => {
      this.heard.push({ bytes: pcm.length, format });
      return this.transcript;
    },
    healthy: async () => true,
  };

  tts: TextToSpeech = {
    format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
    synthesize: (text, options) => {
      const self = this;
      return (async function* () {
        self.spoken.push({ text, voice: options.voice });
        // Deliberately odd-sized chunks, to exercise frame assembly.
        const total = Buffer.alloc(self.audioBytes, 1);
        for (let at = 0; at < total.length; at += 333) yield total.subarray(at, at + 333);
      })();
    },
    healthy: async () => true,
  };

  agent: Agent = {
    reply: (message, signal) => {
      const self = this;
      return (async function* () {
        self.asked.push(message);
        if (self.failAgent) throw new Error("agent answered HTTP 502");
        for (const piece of self.reply) {
          if (self.agentDelayMs) await new Promise((r) => setTimeout(r, self.agentDelayMs));
          if (signal?.aborted) return;
          yield piece;
        }
      })();
    },
    healthy: async () => true,
  };

  services() {
    return { stt: this.stt, tts: this.tts, agent: this.agent };
  }
}

let fakes: Fakes;
useServer(() => {
  fakes = new Fakes();
  return fakes.services();
});

const pcm = (ms: number) => Buffer.alloc((16000 * 2 * ms) / 1000, 2);

describe("a voice turn", () => {
  it("goes from audio to a spoken reply", async () => {
    const { client } = await ready(["mic", "speaker", "screen"], { name: "Desk" });

    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(pcm(300));
    client.sendAudio(pcm(200));
    client.send({ t: "audio.end", turnId: "t1", reason: "silence" });

    await client.next("speak.end");
    client.send({ t: "playback", turnId: "t1", state: "finished" });
    await client.turn("t1", "idle");

    expect(fakes.heard).toEqual([{ bytes: pcm(500).length, format: UPSTREAM_AUDIO_FORMAT }]);
    expect(fakes.asked).toEqual(["[from: Desk, type: web, room: unknown, can: mic+speaker+screen]\nwhat time is it"]);
    expect(fakes.spoken.map((s) => s.text)).toEqual(["It is eight o'clock.", "Time for a break."]);

    const turnStates = client.received.filter((m) => m.t === "turn").map((m) => (m as { state: string }).state);
    expect(turnStates).toEqual(["listening", "transcribing", "thinking", "speaking", "idle"]);

    expect((await client.next("transcript")).text).toBe("what time is it");
    const replies = client.received.filter((m) => m.t === "reply.text");
    expect(replies).toEqual([
      { t: "reply.text", turnId: "t1", text: "It is eight o'clock.", final: false },
      { t: "reply.text", turnId: "t1", text: "Time for a break.", final: false },
      { t: "reply.text", turnId: "t1", text: "It is eight o'clock. Time for a break.", final: true },
    ]);

    expect((await client.next("speak.start")).format.sampleRate).toBe(24000);
    expect(Buffer.concat(client.audio).length).toBe(2000);
  });

  it("starts speaking before the agent has finished", async () => {
    fakes.agentDelayMs = 120;
    const { client } = await ready();
    client.send({ t: "text", turnId: "t1", text: "hello" });
    await client.next("speak.end");

    const order = client.timeline.map((m) => m.t);
    const firstAudio = order.indexOf("<audio>");
    const secondPiece = order.lastIndexOf("reply.text", order.lastIndexOf("reply.text") - 1);
    expect(firstAudio).toBeGreaterThan(-1);
    expect(firstAudio).toBeLessThan(secondPiece);
  });

  it("respects the client's frame size and never splits a sample", async () => {
    const { client } = await ready(["mic", "speaker"], { hello: { maxFrameBytes: 513 } });
    client.send({ t: "text", turnId: "t1", text: "hello" });
    await client.next("speak.end");

    expect(client.audio.every((frame) => frame.length <= 512 && frame.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(client.audio).length).toBe(2000);
  });

  it("paces speech to what the client can buffer", async () => {
    fakes.reply = ["One sentence that is long enough."];
    fakes.audioBytes = 48000; // one second at 24 kHz
    const { client } = await ready(["mic", "speaker"], { hello: { audioBufferMs: 200, maxFrameBytes: 4800 } });

    client.send({ t: "text", turnId: "t1", text: "hello" });
    await client.next("speak.end");

    const frames = client.timeline.filter((m) => m.t === "<audio>") as { at: number }[];
    const span = frames[frames.length - 1]!.at - frames[0]!.at;
    // One second of audio with a 200 ms allowance takes about 700 ms to send.
    expect(span).toBeGreaterThan(500);
    expect(span).toBeLessThan(1500);
  });

  it("uses the client's voice setting", async () => {
    const { identity, client } = await ready();
    await admin("PATCH", "/admin/settings/global", { values: { voice: "nova" } });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { voice: "echo", room: "office" } });

    client.send({ t: "text", turnId: "t1", text: "hello" });
    await client.next("speak.end");

    expect(fakes.spoken[0]!.voice).toBe("echo");
    expect(fakes.asked[0]).toContain("room: office");
  });

  it("gives a client without a screen audio only", async () => {
    const { client } = await ready(["mic", "speaker"]);
    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(pcm(100));
    client.send({ t: "audio.end", turnId: "t1", reason: "silence" });
    await client.next("speak.end");

    expect(client.types()).not.toContain("transcript");
    expect(client.types()).not.toContain("reply.text");
    expect(client.audio.length).toBeGreaterThan(0);
  });

  it("gives a client without a speaker text only", async () => {
    const { client } = await ready(["screen", "buttons"]);
    client.send({ t: "text", turnId: "t1", text: "hello" });
    await client.turn("t1", "idle");

    expect(client.types()).not.toContain("speak.start");
    expect(client.audio).toEqual([]);
    expect(fakes.spoken).toEqual([]);
    expect((await client.next("reply.text", 0, (m) => m.final)).text).toBe("It is eight o'clock. Time for a break.");
  });

  it("stays silent when the agent answers NO_REPLY, even if it arrives in pieces", async () => {
    fakes.reply = ["NO", "_RE", "PLY"];
    const { client } = await ready(["mic", "speaker", "screen"]);
    client.send({ t: "text", turnId: "t1", text: "hello" });
    await client.turn("t1", "idle");

    expect(fakes.spoken).toEqual([]);
    expect(client.types()).not.toContain("speak.start");
    expect((await client.next("reply.text", 0, (m) => m.final)).text).toBe("");
  });

  it("stays silent when the agent answers nothing at all", async () => {
    fakes.reply = [];
    const { client } = await ready(["speaker", "screen"]);
    client.send({ t: "text", turnId: "t1", text: "hello" });
    await client.turn("t1", "idle");
    expect(fakes.spoken).toEqual([]);
  });

  it("speaks a reply that merely starts like NO_REPLY", async () => {
    fakes.reply = ["No ", "problem. ", "Done."];
    const { client } = await ready(["speaker", "screen"]);
    client.send({ t: "text", turnId: "t1", text: "hello" });
    await client.next("speak.end");
    expect(fakes.spoken.map((s) => s.text).join(" ")).toContain("No problem.");
  });

  it("goes idle when nothing was said", async () => {
    fakes.transcript = "";
    const { client } = await ready();
    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(pcm(100));
    client.send({ t: "audio.end", turnId: "t1", reason: "silence" });

    expect((await client.turn("t1", "idle")).detail).toBe("no speech heard");
    expect(fakes.asked).toEqual([]);
  });

  it("drops a cancelled capture", async () => {
    const { client } = await ready();
    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(pcm(100));
    client.send({ t: "audio.end", turnId: "t1", reason: "cancel" });
    await client.turn("t1", "idle");
    expect(fakes.heard).toEqual([]);
  });

  it("cuts an utterance off at the limit", async () => {
    await restart({ maxUtteranceMs: 250 });
    const { client } = await ready();
    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    for (let i = 0; i < 5; i++) client.sendAudio(pcm(100));
    client.send({ t: "audio.end", turnId: "t1", reason: "max" });
    await client.next("speak.end");
    expect(fakes.heard[0]!.bytes).toBe(pcm(250).length);
  });

  it("refuses audio from a client without a mic", async () => {
    const { client } = await ready(["speaker"]);
    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    expect((await client.next("error")).code).toBe("not_supported");
  });
});

describe("stopping", () => {
  it("stops a reply when the client interrupts", async () => {
    fakes.agentDelayMs = 100;
    fakes.reply = ["First sentence here. ", "Second sentence here. ", "Third sentence here. ", "Fourth one."];
    const { client } = await ready();
    client.send({ t: "text", turnId: "t1", text: "hello" });
    await client.next("speak.start");
    client.send({ t: "interrupt" });
    await client.turn("t1", "idle");

    const spokenAtInterrupt = fakes.spoken.length;
    await new Promise((r) => setTimeout(r, 450));
    expect(fakes.spoken.length).toBe(spokenAtInterrupt);
    expect(client.types()).not.toContain("speak.end");
    expect(client.types()).not.toContain("stop");
  });

  it("tells the client to stop when a new turn replaces a running one", async () => {
    fakes.agentDelayMs = 100;
    const { client } = await ready();
    client.send({ t: "text", turnId: "t1", text: "first" });
    await client.next("speak.start");
    client.send({ t: "text", turnId: "t2", text: "second" });

    expect((await client.next("stop")).turnId).toBe("t1");
    await client.next("speak.end", 0, (m) => m.turnId === "t2");
    expect(client.received.some((m) => m.t === "speak.end" && m.turnId === "t1")).toBe(false);
  });

  it("waits for the client to finish playing before going idle", async () => {
    const { client } = await ready();
    client.send({ t: "text", turnId: "t1", text: "hello" });
    await client.next("speak.end");
    await new Promise((r) => setTimeout(r, 150));
    expect(client.received.some((m) => m.t === "turn" && m.state === "idle")).toBe(false);

    client.send({ t: "playback", turnId: "t1", state: "finished" });
    await client.turn("t1", "idle");
  });
});

describe("failures", () => {
  it("reports an agent failure as an error", async () => {
    fakes.failAgent = true;
    const { client } = await ready();
    client.send({ t: "text", turnId: "t1", text: "hello" });

    expect((await client.turn("t1", "error")).detail).toBe("agent answered HTTP 502");
    expect((await client.next("error")).code).toBe("upstream_down");
  });

  it("says which part is missing when nothing is set up", async () => {
    await restart({}, {});
    const { client } = await ready();
    client.send({ t: "text", turnId: "t1", text: "hello" });
    expect((await client.turn("t1", "error")).detail).toBe("not connected to OpenClaw");

    client.send({ t: "audio.start", turnId: "t2", format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(pcm(100));
    client.send({ t: "audio.end", turnId: "t2", reason: "silence" });
    expect((await client.turn("t2", "error")).detail).toBe("speech recognition is not set up");
  });

  it("reports upstream health to clients", async () => {
    await restart({ healthIntervalMs: 40 }, { agent: fakes.agent, stt: fakes.stt });
    const { client } = await ready();
    const status = await client.next("status", 0, (m) => m.upstream.openclaw === "up");
    expect(status.upstream).toEqual({ openclaw: "up", stt: "up", tts: "down" });
  });
});

describe("wake arbitration", () => {
  it("grants a lone client at once", async () => {
    const { client } = await ready();
    const sent = Date.now();
    client.send({ t: "wake", wakeId: "w1", score: 0.9, level: 0.5 });
    expect((await client.next("wake.result")).granted).toBe(true);
    expect(Date.now() - sent).toBeLessThan(50);
  });

  it("grants the best-scoring client and stands the other down", async () => {
    const near = await ready(["mic", "speaker"], { name: "Near" });
    const far = await ready(["mic", "speaker"], { name: "Far" });

    far.client.send({ t: "wake", wakeId: "wf", score: 0.7, level: 0.9 });
    near.client.send({ t: "wake", wakeId: "wn", score: 0.95, level: 0.3 });

    expect(await near.client.next("wake.result")).toMatchObject({ wakeId: "wn", granted: true });
    expect(await far.client.next("wake.result")).toMatchObject({ wakeId: "wf", granted: false });
  });

  it("breaks a tie on loudness", async () => {
    const a = await ready(["mic"], { name: "A" });
    const b = await ready(["mic"], { name: "B" });
    a.client.send({ t: "wake", wakeId: "wa", score: 0.8, level: 0.2 });
    b.client.send({ t: "wake", wakeId: "wb", score: 0.8, level: 0.6 });
    expect((await b.client.next("wake.result")).granted).toBe(true);
    expect((await a.client.next("wake.result")).granted).toBe(false);
  });

  it("only accepts audio for a wake that was granted", async () => {
    const winner = await ready(["mic", "speaker"], { name: "Winner" });
    const loser = await ready(["mic", "speaker"], { name: "Loser" });
    winner.client.send({ t: "wake", wakeId: "w1", score: 0.9, level: 0.5 });
    loser.client.send({ t: "wake", wakeId: "w2", score: 0.4, level: 0.5 });
    await winner.client.next("wake.result");
    await loser.client.next("wake.result");

    loser.client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT, wakeId: "w2" });
    expect((await loser.client.next("error")).code).toBe("busy");

    winner.client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT, wakeId: "w1" });
    await winner.client.turn("t1", "listening");
  });

  it("ignores clients without a mic when counting listeners", async () => {
    await ready(["screen"], { name: "Screen" });
    const { client } = await ready(["mic"], { name: "Mic" });
    const sent = Date.now();
    client.send({ t: "wake", wakeId: "w1", score: 0.9, level: 0.5 });
    await client.next("wake.result");
    expect(Date.now() - sent).toBeLessThan(50);
  });
});

describe("the activity log of turns", () => {
  const activity = async (query = "") => (await admin("GET", `/admin/activity?hours=1${query}`)).body;

  it("keeps a spoken turn's timings and outcome, but not its words", async () => {
    const { identity, client } = await ready(["mic", "speaker", "screen"], { name: "Desk" });
    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(pcm(500));
    client.send({ t: "audio.end", turnId: "t1", reason: "silence" });
    await client.next("speak.end");
    client.send({ t: "playback", turnId: "t1", state: "finished" });
    await client.turn("t1", "idle");

    const body = await activity();
    expect(body.turns).toMatchObject({ count: 1, answered: 1, heard: 1 });
    const [turn] = body.recentTurns;
    expect(turn).toMatchObject({ clientId: identity.clientId, clientName: "Desk", kind: "voice", outcome: "answered", heard: true, speechMs: 500 });
    expect(turn.sttMs).toBeGreaterThanOrEqual(0);
    expect(turn.agentMs).toBeGreaterThanOrEqual(0);
    expect(turn.firstAudioMs).toBeGreaterThanOrEqual(turn.agentMs);
    expect(JSON.stringify(body)).not.toMatch(/what time is it|eight o'clock/);
  });

  it("tells a silent reply, a failure and an interruption apart", async () => {
    const { client } = await ready(["mic", "speaker", "screen"]);
    fakes.reply = ["NO_REPLY"];
    client.send({ t: "text", turnId: "t1", text: "hush" });
    await client.turn("t1", "idle");

    fakes.failAgent = true;
    client.send({ t: "text", turnId: "t2", text: "hello" });
    await client.turn("t2", "error");

    fakes.failAgent = false;
    fakes.reply = ["One. ", "Two. ", "Three."];
    fakes.agentDelayMs = 100;
    client.send({ t: "text", turnId: "t3", text: "count" });
    await client.next("speak.start");
    client.send({ t: "interrupt", turnId: "t3" });
    await client.turn("t3", "idle");
    await new Promise((r) => setTimeout(r, 50));

    const body = await activity();
    expect(body.recentTurns.map((t: { outcome: string }) => t.outcome)).toEqual(["interrupted", "failed", "silent"]);
    expect(body.events.some((e: { text: string }) => /failed: agent answered HTTP 502/.test(e.text))).toBe(true);
  });

  it("records connections and settings changes, and filters by client", async () => {
    const { identity, client } = await ready(["speaker"], { name: "Kitchen" });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 40 } });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: null } });
    client.close();
    await new Promise((r) => setTimeout(r, 100));

    const body = await activity(`&client=${identity.clientId}`);
    const texts = body.events.map((e: { text: string }) => e.text).reverse();
    expect(texts).toEqual([
      "Kitchen paired (web)",
      "Kitchen connected (web 0.1.0)",
      "Kitchen: volume unset → 40",
      "Kitchen: volume back to shared (was 40)",
      "Kitchen disconnected",
    ]);
    expect(body.clients).toHaveLength(1);
    // Unknown before this Axis started, offline until the client connected, online, then offline.
    expect(body.clients[0].segments.map((s: { state: string }) => s.state)).toEqual(["unknown", "offline", "online", "offline"]);
    expect((await admin("GET", "/admin/activity?client=c_nobody")).status).toBe(404);
    expect((await admin("GET", "/admin/activity?hours=-1")).status).toBe(400);
  });
});
