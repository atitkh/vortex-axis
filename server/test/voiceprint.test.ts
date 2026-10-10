import { describe, expect, it } from "vitest";
import { UPSTREAM_AUDIO_FORMAT } from "@vortex-axis/protocol";
import type { Agent, AgentRoute } from "../src/agent.js";
import type { SpeechToText, TextToSpeech } from "../src/speech.js";
import { Store } from "../src/store.js";
import { DEFAULT_GUEST_NOTE, Voiceprints, cosine, type VoiceprintService } from "../src/voiceprint.js";
import { admin, ready, useServer } from "./harness.js";

/**
 * A voiceprint service that reads the voice off the recording: every sample of
 * a recording holds one number, and that number picks the direction of the
 * voiceprint. Two recordings filled with the same number are the same voice.
 */
const DIRECTIONS: Record<number, number[]> = {
  1: [1, 0, 0],
  2: [0, 1, 0],
  // Close to voice 1 but not the same: lands between the cut-offs.
  3: [0.5, 0.86, 0],
};
const fakeService = (calls: { n: number } = { n: 0 }): VoiceprintService => ({
  embed: async (pcm) => {
    calls.n++;
    const which = pcm.readInt16LE(0);
    const dir = DIRECTIONS[which];
    if (!dir) throw new Error("too short to tell a voice from");
    return { embedding: Float32Array.from(dir), seconds: pcm.length / 32000 };
  },
  healthy: async () => true,
});
const voice = (which: number, ms = 1500) => {
  const pcm = Buffer.alloc((16000 * 2 * ms) / 1000);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(which, i);
  return pcm;
};
const F = UPSTREAM_AUDIO_FORMAT;

describe("voiceprints", () => {
  const setup = () => {
    const store = new Store(":memory:");
    const voices = new Voiceprints({ store, service: fakeService, sessionKey: "voice" });
    return { store, voices };
  };

  it("compares by direction", () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 3]))).toBeCloseTo(0);
  });

  it("tells a taught voice, a guest and an unsure one apart", async () => {
    const { voices } = setup();
    voices.saveSettings({ enabled: true });
    const owner = voices.addVoice("Sam");
    await voices.teach(owner.id, voice(1), F);
    expect(voices.voices()).toMatchObject([{ name: "Sam", samples: 1 }]);

    const known = await voices.identify(voice(1), F, { turnId: "a", clientId: "c" });
    expect(known).toMatchObject({ verdict: "known", name: "Sam", score: 1, as: "known" });
    const guest = await voices.identify(voice(2), F, { turnId: "b", clientId: "c" });
    expect(guest).toMatchObject({ verdict: "guest", as: "guest" });
    const unsure = await voices.identify(voice(3), F, { turnId: "c", clientId: "c" });
    expect(unsure).toMatchObject({ verdict: "unsure", name: "Sam", as: "known" });

    // Unsure voices can be taken for guests instead.
    voices.saveSettings({ unsure: "guest" });
    expect((await voices.identify(voice(3), F, { turnId: "d", clientId: "c" })).as).toBe("guest");

    expect(Voiceprints.label(known)).toBe("voice: Sam");
    expect(Voiceprints.label(guest)).toBe("voice: guest");
  });

  it("never takes anybody for a guest before a voice is taught, and keeps the turn to teach from", async () => {
    const { voices } = setup();
    voices.saveSettings({ enabled: true, unsure: "guest", guests: "decline" });
    const first = await voices.identify(voice(1), F, { turnId: "t1", clientId: "c" });
    expect(first).toMatchObject({ verdict: "unsure", untaught: true, as: "known" });
    expect(Voiceprints.label(first)).toBeUndefined();
    expect(voices.routeFor(first)).toEqual({});

    const owner = voices.addVoice("Sam");
    expect(voices.recent().map((r) => r.turnId)).toEqual(["t1"]);
    voices.teachFromTurn(owner.id, "t1");
    expect((await voices.identify(voice(1), F, { turnId: "t2", clientId: "c" })).verdict).toBe("known");
    expect(() => voices.teachFromTurn(owner.id, "gone")).toThrow(/no longer held/);
  });

  it("a service that fails gives unsure, which the unsure rule decides", async () => {
    const { voices } = setup();
    voices.saveSettings({ enabled: true, unsure: "guest" });
    await voices.teach(voices.addVoice("Sam").id, voice(1), F);
    const failed = await voices.identify(voice(9), F, { turnId: "x", clientId: "c" });
    expect(failed).toMatchObject({ verdict: "unsure", as: "guest", error: "too short to tell a voice from" });
  });

  it("routes a guest by the settings", async () => {
    const { voices } = setup();
    const guest = { verdict: "guest" as const, as: "guest" as const, ms: 1 };
    expect(voices.routeFor(guest)).toEqual({});
    voices.saveSettings({ guests: "guest" });
    expect(voices.routeFor(guest)).toEqual({ route: { sessionKey: "voice-guest", note: DEFAULT_GUEST_NOTE } });
    voices.saveSettings({ guests: "agent", guestAgent: "helper", guestNote: "Be brief." });
    expect(voices.routeFor(guest)).toEqual({ route: { agentId: "helper", sessionKey: "voice-guest", note: "Be brief." } });
    voices.saveSettings({ guests: "decline", declineText: "Not you." });
    expect(voices.routeFor(guest)).toEqual({ decline: "Not you." });
    expect(voices.routeFor({ verdict: "known", name: "Sam", as: "known", ms: 1 })).toEqual({});
  });

  it("refuses settings that make no sense", () => {
    const { voices } = setup();
    expect(() => voices.saveSettings({ knownAt: 0.3, guestBelow: 0.5 })).toThrow(/cut-off/);
    expect(() => voices.saveSettings({ guests: "agent", guestAgent: "" })).toThrow(/agent/);
    expect(() => voices.saveSettings({ nonsense: 1 })).toThrow(/unknown/);
    expect(() => voices.addVoice(" ")).toThrow();
    voices.addVoice("Sam");
    expect(() => voices.addVoice("sam")).toThrow(/already/);
  });
});

describe("a spoken turn with voices told apart", () => {
  let asked: { message: string; route: AgentRoute | undefined }[];
  let spoken: string[];
  let calls: { n: number };
  useServer(() => {
    asked = [];
    spoken = [];
    calls = { n: 0 };
    const stt: SpeechToText = { transcribe: async () => "what's on my calendar", healthy: async () => true };
    const tts: TextToSpeech = {
      format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
      synthesize: (text) =>
        (async function* () {
          spoken.push(text);
          yield Buffer.alloc(480);
        })(),
      healthy: async () => true,
    };
    const agent: Agent = {
      reply: (message, _signal, _onTool, _onState, route) =>
        (async function* () {
          asked.push({ message, route });
          yield "Nothing today.";
        })(),
      healthy: async () => true,
    };
    return { stt, tts, agent, voiceprint: fakeService(calls) };
  });

  const talk = async (client: Awaited<ReturnType<typeof ready>>["client"], turnId: string, which: number) => {
    client.send({ t: "audio.start", turnId, format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(voice(which, 600));
    client.send({ t: "audio.end", turnId, reason: "silence" });
    await client.next("speak.end", 0, (m) => m.turnId === turnId);
    client.send({ t: "playback", turnId, state: "finished" });
    await client.turn(turnId, "idle");
  };

  it("does nothing while switched off", async () => {
    const { client } = await ready(["mic", "speaker"], { name: "Desk" });
    await talk(client, "t1", 2);
    expect(calls.n).toBe(0);
    expect(asked[0]!.message).not.toContain("voice:");
  });

  it("labels the voice, teaches from a turn, and sends a guest elsewhere", async () => {
    const { client } = await ready(["mic", "speaker"], { name: "Desk" });
    expect((await admin("PATCH", "/admin/voices", { enabled: true, guests: "guest" })).status).toBe(200);

    // Nothing taught yet: the turn goes as ever, and is kept to teach from.
    await talk(client, "t1", 1);
    expect(asked[0]).toEqual({ message: "[from: Desk, type: web, location: unknown, can: mic+speaker]\nwhat's on my calendar", route: undefined });
    const listed = (await admin("GET", "/admin/voices")).body;
    expect(listed.recent).toMatchObject([{ turnId: "t1", client: "Desk" }]);

    const created = (await admin("POST", "/admin/voices", { name: "Sam" })).body as { id: number };
    expect((await admin("POST", `/admin/voices/${created.id}/samples`, { turnId: "t1" })).status).toBe(201);

    await talk(client, "t2", 1);
    expect(asked[1]).toEqual({ message: "[from: Desk, type: web, location: unknown, can: mic+speaker, voice: Sam]\nwhat's on my calendar", route: undefined });

    await talk(client, "t3", 2);
    expect(asked[2]!.message).toContain("voice: guest]");
    expect(asked[2]!.route).toEqual({ sessionKey: "vortex-axis-guest", note: DEFAULT_GUEST_NOTE });

    // Turned away: no agent is asked, and the device says so.
    await admin("PATCH", "/admin/voices", { guests: "decline", declineText: "I only answer Sam." });
    await talk(client, "t4", 2);
    expect(asked).toHaveLength(3);
    expect(spoken.at(-1)).toBe("I only answer Sam.");

    const turns = (await admin("GET", "/admin/activity")).body as { turns?: { speaker?: string }[] };
    expect(JSON.stringify(turns)).toContain('"speaker":"guest"');
  });

  it("teaches from a recording made on the admin page", async () => {
    const created = (await admin("POST", "/admin/voices", { name: "Sam" })).body as { id: number };
    const res = await fetch(`${(await import("./harness.js")).ctx.base}/admin/voices/${created.id}/samples?rate=16000`, {
      method: "POST",
      headers: { authorization: `Bearer test-admin-token`, "content-type": "application/octet-stream" },
      body: voice(1, 2000),
    });
    expect(res.status).toBe(201);
    const voicesNow = (await admin("GET", "/admin/voices")).body.voices as { name: string; samples: number; list: unknown[] }[];
    expect(voicesNow).toMatchObject([{ name: "Sam", samples: 1 }]);
  });
});
