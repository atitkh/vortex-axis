import { describe, expect, it } from "vitest";
import type { AudioFormat } from "@vortex-axis/protocol";
import { FallbackSpeechToText, FallbackTextToSpeech, StreamResampler, type RankedEntry } from "../src/fallback.js";
import type { SpeechToText, TextToSpeech } from "../src/speech.js";
import { Store } from "../src/store.js";
import type { Services } from "../src/turns.js";
import {
  applyRuntimeConfig,
  loadRuntimeConfig,
  MAIN_ENTRY_ID,
  publicRuntimeConfig,
  resample,
  saveRuntimeConfig,
} from "../src/upstream.js";
import type { Agent } from "../src/agent.js";
import { config } from "./harness.js";

const pcm = (rate: number): AudioFormat => ({ encoding: "pcm_s16le", sampleRate: rate, channels: 1 });
const FORMAT = pcm(16000);

/** A synthesis stand-in: what it does when asked, and what it was asked. */
function fakeTts(behaviour: "ok" | "fail" | "hang" | "failMidClip", rate = 24000, healthy = true) {
  const calls: { text: string; voice: string | undefined }[] = [];
  const service: TextToSpeech = {
    format: pcm(rate),
    async *synthesize(text, options, signal) {
      calls.push({ text, voice: options.voice });
      if (behaviour === "fail") throw new Error("speech synthesis answered HTTP 500");
      if (behaviour === "hang") {
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      yield Buffer.alloc(rate / 50, 1); // 10 ms
      if (behaviour === "failMidClip") throw new Error("connection reset");
      yield Buffer.alloc(rate / 50, 2);
    },
    healthy: async () => healthy,
  };
  return { service, calls };
}

function fakeStt(behaviour: "ok" | "fail" | "hang" | "empty", healthy = true) {
  const seen: Buffer[] = [];
  const service: SpeechToText = {
    async transcribe(audio, _format, signal) {
      seen.push(audio);
      if (behaviour === "fail") throw new Error("speech recognition answered HTTP 503");
      if (behaviour === "hang") {
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      return behaviour === "empty" ? "" : "hello there";
    },
    healthy: async () => healthy,
  };
  return { service, seen };
}

const ranked = <S>(services: S[]): RankedEntry<S>[] => services.map((service, i) => ({ id: `e${i + 1}`, label: `entry ${i + 1}`, rank: i + 1, service }));

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("speech synthesis over ranked entries", () => {
  it("fails over before the first audio, logs it without a key, and marks the entry down", async () => {
    const a = fakeTts("fail");
    const b = fakeTts("ok");
    const lines: string[] = [];
    const tts = new FallbackTextToSpeech(ranked([a.service, b.service]), { cooldownSeconds: 60, log: (l) => lines.push(l) });
    const audio = await collect(tts.synthesize("Hello.", {}));
    expect(audio.length).toBe(960); // two 10 ms chunks at 24 kHz
    expect(b.calls).toHaveLength(1);
    expect(lines[0]).toMatch(/speech synthesis: #1 "entry 1" failed \(speech synthesis answered HTTP 500\), trying #2 "entry 2"/);
    expect(tts.status().map((s) => [s.id, s.up, s.active])).toEqual([["e1", false, false], ["e2", true, true]]);
    expect(tts.level()).toBe("degraded");
  });

  it("moves on when the first audio does not come in time", async () => {
    const a = fakeTts("hang");
    const b = fakeTts("ok");
    const tts = new FallbackTextToSpeech(ranked([a.service, b.service]), { cooldownSeconds: 60, attemptMs: 50 });
    const started = Date.now();
    expect((await collect(tts.synthesize("Hi.", {}))).length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(tts.status()[0]!.lastError).toBe("no audio within 50 ms");
  });

  it("never switches entries in the middle of a clip", async () => {
    const a = fakeTts("failMidClip");
    const b = fakeTts("ok");
    const tts = new FallbackTextToSpeech(ranked([a.service, b.service]), { cooldownSeconds: 60 });
    const got: Buffer[] = [];
    await expect(
      (async () => {
        for await (const chunk of tts.synthesize("Hello.", {})) got.push(chunk);
      })(),
    ).rejects.toThrow("connection reset");
    expect(got).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    // The next clip starts on the next entry.
    await collect(tts.synthesize("Again.", {}));
    expect(b.calls).toHaveLength(1);
  });

  it("keeps the top entry's format, converting another entry's audio as it streams", async () => {
    const a = fakeTts("fail", 24000);
    const b = fakeTts("ok", 16000);
    const tts = new FallbackTextToSpeech(ranked([a.service, b.service]), { cooldownSeconds: 60 });
    expect(tts.format.sampleRate).toBe(24000);
    const audio = await collect(tts.synthesize("Hi.", {}));
    // 20 ms at 16 kHz is 320 samples; at 24 kHz about 480 (less the one sample held for the next chunk).
    expect(audio.length / 2).toBeGreaterThanOrEqual(476);
    expect(audio.length / 2).toBeLessThanOrEqual(480);
  });

  it("gives a device's own voice to the top entry only", async () => {
    const a = fakeTts("fail");
    const b = fakeTts("ok");
    const tts = new FallbackTextToSpeech(ranked([a.service, b.service]), { cooldownSeconds: 60 });
    await collect(tts.synthesize("Hi.", { voice: "nova" }));
    expect(a.calls[0]!.voice).toBe("nova");
    expect(b.calls[0]!.voice).toBeUndefined();
  });

  it("leaves a failed entry out for the cool-down, then tries it again; success clears it", async () => {
    let now = 1_000_000;
    let fail = true;
    const aCalls: number[] = [];
    const a: TextToSpeech = {
      format: pcm(24000),
      async *synthesize() {
        aCalls.push(now);
        if (fail) throw new Error("down");
        yield Buffer.alloc(10);
      },
      healthy: async () => !fail,
    };
    const b = fakeTts("ok");
    const tts = new FallbackTextToSpeech(ranked([a, b.service]), { cooldownSeconds: 60, now: () => now });
    await collect(tts.synthesize("1", {}));
    expect(tts.status()[0]!.downUntil).toBe(now + 60_000);
    await collect(tts.synthesize("2", {}));
    expect(aCalls).toHaveLength(1); // skipped while cooling
    now += 61_000;
    fail = false;
    await collect(tts.synthesize("3", {}));
    expect(aCalls).toHaveLength(2);
    expect(tts.status()[0]).toMatchObject({ up: true, active: true });
    expect(tts.status()[0]!.downUntil).toBeUndefined();
    expect(tts.level()).toBe("ok");
  });

  it("tries every entry once more when all are down, then throws the last error", async () => {
    let now = 0;
    const a = fakeTts("fail");
    const b: TextToSpeech = { ...fakeTts("fail").service, synthesize: () => (async function* (): AsyncIterable<Buffer> { throw new Error("b is down"); })() };
    const tts = new FallbackTextToSpeech(ranked([a.service, b]), { cooldownSeconds: 60, now: () => now });
    await expect(collect(tts.synthesize("1", {}))).rejects.toThrow("b is down");
    expect(tts.level()).toBe("down");
    // Both cooling: still tried, in rank order, once.
    now += 1000;
    await expect(collect(tts.synthesize("2", {}))).rejects.toThrow("b is down");
    expect(a.calls).toHaveLength(2);
  });

  it("stops at once when the caller does, without blaming the entry", async () => {
    const a = fakeTts("hang");
    const b = fakeTts("ok");
    const tts = new FallbackTextToSpeech(ranked([a.service, b.service]), { cooldownSeconds: 60 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    await expect(collect(tts.synthesize("Hi.", {}, stop.signal))).rejects.toThrow("aborted");
    expect(b.calls).toHaveLength(0);
    expect(tts.status()[0]!.up).toBe("unknown");
  });

  it("is healthy while any entry is, and a good check ends a cool-down early", async () => {
    let now = 0;
    const a = fakeTts("fail", 24000, false);
    const b = fakeTts("ok", 24000, true);
    const tts = new FallbackTextToSpeech(ranked([a.service, b.service]), { cooldownSeconds: 60, now: () => now });
    expect(await tts.healthy()).toBe(true);
    expect(tts.level()).toBe("degraded");
    const none = new FallbackTextToSpeech(ranked([fakeTts("ok", 24000, false).service]), { cooldownSeconds: 60 });
    expect(await none.healthy()).toBe(false);
    expect(none.level()).toBe("down");

    const flaky = fakeTts("fail", 24000, true);
    const tts2 = new FallbackTextToSpeech(ranked([flaky.service, b.service]), { cooldownSeconds: 60, now: () => now });
    await collect(tts2.synthesize("x", {}));
    expect(tts2.status()[0]!.downUntil).toBeDefined();
    await tts2.healthy();
    expect(tts2.status()[0]!.downUntil).toBeUndefined();
    expect(tts2.level()).toBe("ok");
  });
});

describe("speech recognition over ranked entries", () => {
  it("sends the same audio to the next entry when one fails", async () => {
    const a = fakeStt("fail");
    const b = fakeStt("ok");
    const stt = new FallbackSpeechToText(ranked([a.service, b.service]), { cooldownSeconds: 60 });
    const audio = Buffer.alloc(3200, 7);
    expect(await stt.transcribe(audio, FORMAT)).toBe("hello there");
    expect(b.seen[0]).toBe(audio);
    expect(stt.status().map((s) => s.active)).toEqual([false, true]);
  });

  it("takes an empty transcript as an answer, not a failure", async () => {
    const a = fakeStt("empty");
    const b = fakeStt("ok");
    const stt = new FallbackSpeechToText(ranked([a.service, b.service]), { cooldownSeconds: 60 });
    expect(await stt.transcribe(Buffer.alloc(320), FORMAT)).toBe("");
    expect(b.seen).toHaveLength(0);
    expect(stt.status()[0]!.up).toBe(true);
  });

  it("times out a slow entry, and respects the caller's stop", async () => {
    const stt = new FallbackSpeechToText(ranked([fakeStt("hang").service, fakeStt("ok").service]), { cooldownSeconds: 60, attemptMs: 50 });
    expect(await stt.transcribe(Buffer.alloc(320), FORMAT)).toBe("hello there");
    expect(stt.status()[0]!.lastError).toMatch(/no answer within/);

    const b = fakeStt("ok");
    const stopped = new FallbackSpeechToText(ranked([fakeStt("hang").service, b.service]), { cooldownSeconds: 60 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    await expect(stopped.transcribe(Buffer.alloc(320), FORMAT, stop.signal)).rejects.toThrow();
    expect(b.seen).toHaveLength(0);
  });

  it("throws the last error when every entry fails", async () => {
    const stt = new FallbackSpeechToText(ranked([fakeStt("fail").service, fakeStt("fail").service]), { cooldownSeconds: 60 });
    await expect(stt.transcribe(Buffer.alloc(320), FORMAT)).rejects.toThrow("HTTP 503");
    expect(stt.level()).toBe("down");
  });
});

/** A synthesis stand-in that yields the given chunks. */
function chunkTts(chunks: Buffer[], rate = 16000): TextToSpeech {
  return { format: pcm(rate), async *synthesize() { for (const c of chunks) yield c; }, healthy: async () => true };
}
const samples = (...v: number[]) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => b.writeInt16LE(x, i * 2)); return b; };
const drain = async (t: TextToSpeech) => { const out: Buffer[] = []; for await (const c of t.synthesize("x", {})) out.push(c); return Buffer.concat(out); };
const gained = (chunks: Buffer[], gain?: number, rate = 16000) =>
  new FallbackTextToSpeech([{ id: "a", label: "", rank: 1, service: chunkTts(chunks, rate), ...(gain === undefined ? {} : { gain }) }], { cooldownSeconds: 60 });

describe("per-entry volume trim", () => {
  const clip = samples(0, 1000, -1000, 32767, -32768, 3, -3);
  it("leaves the audio byte-identical at 100 and when unset, odd chunks included", async () => {
    const chunks = [clip.subarray(0, 5), clip.subarray(5, 6), clip.subarray(6)];
    for (const g of [undefined, 100]) {
      const out: Buffer[] = [];
      for await (const c of gained(chunks, g).synthesize("x", {})) out.push(c);
      expect(out.map((c) => c.length)).toEqual([5, 1, 8]);
      expect(Buffer.concat(out).equals(clip)).toBe(true);
    }
  });
  it("halves amplitude with rounding, and stays inside int16", async () => {
    const out = await drain(gained([clip], 50));
    const got = Array.from({ length: out.length / 2 }, (_, i) => out.readInt16LE(i * 2));
    expect(got).toEqual([0, 500, -500, 16384, -16384, 2, -1]); // Math.round: 1.5 -> 2, -1.5 -> -1
  });
  it("gives the same output cut at odd byte boundaries as in one piece", async () => {
    const whole = await drain(gained([clip], 30));
    const cut = await drain(gained([clip.subarray(0, 3), clip.subarray(3, 4), clip.subarray(4, 11), clip.subarray(11)], 30));
    expect(cut.equals(whole)).toBe(true);
  });
  it("trims each entry on its own when one fails before audio", async () => {
    const bad = fakeTts("fail", 16000).service;
    const mk = (gains: [number, number]) => new FallbackTextToSpeech([
      { id: "a", label: "", rank: 1, service: bad, gain: gains[0] },
      { id: "b", label: "", rank: 2, service: chunkTts([clip]), gain: gains[1] },
    ], { cooldownSeconds: 60 });
    expect((await drain(mk([50, 100]))).equals(clip)).toBe(true);
    expect((await drain(mk([100, 50]))).readInt16LE(2)).toBe(500);
    const first = new FallbackTextToSpeech([
      { id: "a", label: "", rank: 1, service: chunkTts([clip]), gain: 50 },
      { id: "b", label: "", rank: 2, service: chunkTts([clip]), gain: 100 },
    ], { cooldownSeconds: 60 });
    expect((await drain(first)).readInt16LE(2)).toBe(500);
  });
  it("trims before resampling a fallback entry to the wrapper's rate", async () => {
    const loud = samples(...Array.from({ length: 40 }, () => 20000));
    const top = chunkTts([], 16000);
    const w = new FallbackTextToSpeech([
      { id: "a", label: "", rank: 1, service: { ...top, synthesize: async function* () { throw new Error("down"); } }, },
      { id: "b", label: "", rank: 2, service: chunkTts([loud], 8000), gain: 50 },
    ], { cooldownSeconds: 60 });
    const out = await drain(w);
    expect(out.length).toBeGreaterThan(loud.length);
    for (let i = 0; i < out.length; i += 2) expect(out.readInt16LE(i)).toBe(10000);
  });
});

describe("volume trim settings", () => {
  const fresh = () => ({ store: new Store(":memory:"), cfg: config({}) });
  it("accepts 10 and 100, rejects the rest", () => {
    const { store, cfg } = fresh();
    for (const g of [10, 100]) expect(() => saveRuntimeConfig(store, cfg, { tts: { entries: [{ gain: g }] } })).not.toThrow();
    for (const g of [9, 101, 50.5, "abc"]) expect(() => saveRuntimeConfig(store, cfg, { tts: { entries: [{ gain: g }] } })).toThrow(/gain must be a whole number from 10 to 100/);
    expect(() => saveRuntimeConfig(store, cfg, { tts: { gain: 5 } })).toThrow(/tts.gain/);
  });
  it("keeps the saved gain when a patch omits it, and loads old entries as 100", () => {
    const { store, cfg } = fresh();
    expect(loadRuntimeConfig(store, cfg).tts.entries[0]!.gain).toBe(100);
    saveRuntimeConfig(store, cfg, { tts: { entries: [{ id: MAIN_ENTRY_ID, gain: 60 }, { url: "http://b/", gain: 80 }] } });
    let rc = loadRuntimeConfig(store, cfg);
    expect(rc.tts.entries.map((e) => e.gain)).toEqual([60, 80]);
    saveRuntimeConfig(store, cfg, { tts: { entries: rc.tts.entries.map((e) => ({ id: e.id, label: "x" })) } });
    rc = loadRuntimeConfig(store, cfg);
    expect(rc.tts.entries.map((e) => e.gain)).toEqual([60, 80]);
    saveRuntimeConfig(store, cfg, { tts: { voice: "v" } }); // old single-entry shape
    expect(loadRuntimeConfig(store, cfg).tts.entries[0]!.gain).toBe(60);
    expect(publicRuntimeConfig(rc).tts.entries.map((e: { gain: number }) => e.gain)).toEqual([60, 80]);
  });
});

describe("the streaming resampler", () => {
  it("gives what converting the whole clip at once gives, however it is cut", () => {
    const whole = Buffer.alloc(2000);
    for (let i = 0; i < 1000; i++) whole.writeInt16LE(Math.round(Math.sin(i / 10) * 10000), i * 2);
    const r = new StreamResampler(16000, 24000);
    const pieces = [whole.subarray(0, 333), whole.subarray(333, 1001), whole.subarray(1001)];
    const streamed = Buffer.concat(pieces.map((p) => r.push(p)));
    const once = resample(whole, 16000, 24000);
    // The last sample or two wait for audio that never comes: a few samples short at the very end.
    expect(once.length - streamed.length).toBeGreaterThanOrEqual(0);
    expect(once.length - streamed.length).toBeLessThanOrEqual(8);
    for (let i = 0; i < streamed.length / 2 - 1; i++) expect(Math.abs(streamed.readInt16LE(i * 2) - once.readInt16LE(i * 2))).toBeLessThanOrEqual(1);
  });
});

describe("ranked speech settings", () => {
  const fresh = (overrides: Parameters<typeof config>[0] = {}) => ({ store: new Store(":memory:"), cfg: config(overrides) });

  it("starts from one entry made from the environment, enabled, with a 60 s cool-down and realtime fallback on", () => {
    const { store, cfg } = fresh({ stt: { url: "http://env/stt", model: "whisper-1", apiKey: "env-secret" } as never });
    const rc = loadRuntimeConfig(store, cfg);
    expect(rc.stt.entries).toEqual([{ id: MAIN_ENTRY_ID, enabled: true, label: "", kind: "openai", url: "http://env/stt", model: "whisper-1", apiKey: "env-secret" }]);
    expect(rc.stt.cooldownSeconds).toBe(60);
    expect(rc.tts.entries).toHaveLength(1);
    expect(rc.speech.realtimeFallback).toBe(true);
  });

  it("loads a config saved before lists as entry #1, and saves it back as a list", () => {
    const { store, cfg } = fresh({ tts: { url: "http://env/tts", model: "tts-1", sampleRate: 22050 } as never });
    store.setMeta("upstream_config", JSON.stringify({ stt: { kind: "elevenlabs", apiKey: "old-key" }, tts: { voice: "nova" }, agent: { model: "m" } }));
    let rc = loadRuntimeConfig(store, cfg);
    expect(rc.stt.entries).toEqual([{ id: MAIN_ENTRY_ID, enabled: true, label: "", kind: "elevenlabs", url: "", model: "whisper-1", apiKey: "old-key" }]);
    // Fields it never saved still come from the environment.
    expect(rc.tts.entries[0]).toMatchObject({ id: MAIN_ENTRY_ID, url: "http://env/tts", voice: "nova", sampleRate: 22050 });
    expect(rc.agent.model).toBe("m");

    rc = saveRuntimeConfig(store, cfg, { speech: { realtimeFallback: false } });
    const stored = JSON.parse(store.getMeta("upstream_config")!);
    expect(stored.stt.entries[0]).toEqual({ id: MAIN_ENTRY_ID, kind: "elevenlabs", apiKey: "old-key" });
    expect(rc.stt.entries[0]!.apiKey).toBe("old-key");
    expect(rc.tts.entries[0]!.url).toBe("http://env/tts");
    expect(rc.speech.realtimeFallback).toBe(false);
  });

  it("takes the whole list: reorders, adds with a new id, deletes, and keeps each entry's key by id", () => {
    const { store, cfg } = fresh();
    let rc = saveRuntimeConfig(store, cfg, { tts: { url: "http://one/tts", apiKey: "key-one" } });
    rc = saveRuntimeConfig(store, cfg, {
      tts: { entries: [{ id: MAIN_ENTRY_ID }, { label: "Cloud", kind: "elevenlabs", voice: "v1", apiKey: "key-two" }], cooldownSeconds: 30 },
    });
    const second = rc.tts.entries[1]!;
    expect(second.id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(second).toMatchObject({ label: "Cloud", kind: "elevenlabs", voice: "v1", apiKey: "key-two", enabled: true });
    expect(rc.tts.entries[0]).toMatchObject({ url: "http://one/tts", apiKey: "key-one" });
    expect(rc.tts.cooldownSeconds).toBe(30);

    // Reordered and the first switched off, keys not sent: both kept.
    rc = saveRuntimeConfig(store, cfg, { tts: { entries: [{ id: second.id, voice: "v2" }, { id: MAIN_ENTRY_ID, enabled: false }] } });
    expect(rc.tts.entries.map((e) => [e.id, e.apiKey, e.enabled])).toEqual([[second.id, "key-two", true], [MAIN_ENTRY_ID, "key-one", false]]);
    expect(rc.tts.entries[0]!.voice).toBe("v2");

    // An unknown id is a new entry; one left out is gone.
    rc = saveRuntimeConfig(store, cfg, { tts: { entries: [{ id: "made-up", url: "http://three/tts" }, { id: second.id }] } });
    expect(rc.tts.entries).toHaveLength(2);
    expect(rc.tts.entries[0]!.id).not.toBe("made-up");
    expect(rc.tts.entries[0]!.apiKey).toBe("");
    expect(rc.tts.entries.some((e) => e.id === MAIN_ENTRY_ID)).toBe(false);

    // Empty: the service is off.
    rc = saveRuntimeConfig(store, cfg, { tts: { entries: [] } });
    expect(rc.tts.entries).toEqual([]);
    const services: Services = {};
    applyRuntimeConfig(services, rc, { reply: async function* () {}, healthy: async () => true } as unknown as Agent, "main");
    expect(services.tts).toBeUndefined();
  });

  it("lets the one-entry shape edit entry #1, making it when there is none", () => {
    const { store, cfg } = fresh();
    let rc = saveRuntimeConfig(store, cfg, { stt: { entries: [{ url: "http://a/stt", apiKey: "ka" }, { url: "http://b/stt" }] } });
    const ids = rc.stt.entries.map((e) => e.id);
    rc = saveRuntimeConfig(store, cfg, { stt: { model: "parakeet" } });
    expect(rc.stt.entries.map((e) => e.id)).toEqual(ids);
    expect(rc.stt.entries[0]).toMatchObject({ url: "http://a/stt", model: "parakeet", apiKey: "ka" });
    expect(rc.stt.entries[1]!.model).toBe("whisper-1");

    saveRuntimeConfig(store, cfg, { stt: { entries: [] } });
    rc = saveRuntimeConfig(store, cfg, { stt: { kind: "elevenlabs" } });
    expect(rc.stt.entries).toHaveLength(1);
    expect(rc.stt.entries[0]).toMatchObject({ kind: "elevenlabs", enabled: true });
  });

  it("refuses what it cannot use", () => {
    const { store, cfg } = fresh();
    const bad = (patch: unknown, why: RegExp) => expect(() => saveRuntimeConfig(store, cfg, patch)).toThrow(why);
    bad({ tts: { entries: Array.from({ length: 9 }, () => ({})) } }, /at most 8/);
    bad({ tts: { entries: [{ url: "ftp://x" }] } }, /tts.entries\[0\].url/);
    bad({ tts: { entries: [{ sampleRate: 5 }] } }, /sampleRate/);
    bad({ stt: { entries: [{ kind: "nope" }] } }, /stt.entries\[0\].kind/);
    bad({ stt: { entries: [{ enabled: "yes" }] } }, /enabled/);
    bad({ stt: { entries: "x" } }, /must be a list/);
    bad({ stt: { entries: [5] } }, /must be an object/);
    bad({ stt: { entries: [{ id: MAIN_ENTRY_ID }, { id: MAIN_ENTRY_ID }] } }, /twice/);
    bad({ stt: { entries: [], url: "http://x/" } }, /not both/);
    bad({ stt: { cooldownSeconds: 2 } }, /cooldownSeconds/);
    bad({ tts: { cooldownSeconds: 3601 } }, /cooldownSeconds/);
    bad({ speech: { realtimeFallback: "on" } }, /realtimeFallback/);
    bad({ stt: { entries: [{ label: "x".repeat(81) }] } }, /label/);
  });

  it("never shows a key, and still shows entry #1 the way a one-entry page reads it", () => {
    const { store, cfg } = fresh();
    const rc = saveRuntimeConfig(store, cfg, {
      tts: { entries: [{ url: "http://a/tts", apiKey: "secret-a", voice: "nova" }, { kind: "elevenlabs", apiKey: "env:MY_KEY", label: "Cloud" }] },
    });
    const shown = publicRuntimeConfig(rc);
    const text = JSON.stringify(shown);
    expect(text).not.toContain("secret-a");
    expect(text).not.toContain("\"apiKey\"");
    expect(shown.tts).toMatchObject({ kind: "openai", url: "http://a/tts", voice: "nova", apiKeySet: true, keySource: { source: "saved" }, cooldownSeconds: 60 });
    expect(shown.tts.entries[1]).toMatchObject({ label: "Cloud", apiKeySet: true, keySource: { source: "env", env: "MY_KEY" } });
    expect(shown.speech).toEqual({ realtimeFallback: true });
  });

  it("builds only the enabled entries that can work, in rank order", () => {
    const { store, cfg } = fresh();
    const rc = saveRuntimeConfig(store, cfg, {
      stt: { entries: [{ url: "" }, { url: "http://b/stt", enabled: false }, { url: "http://c/stt", label: "C" }] },
    });
    const services: Services = {};
    applyRuntimeConfig(services, rc, { reply: async function* () {}, healthy: async () => true } as unknown as Agent, "main");
    expect(services.stt).toBeInstanceOf(FallbackSpeechToText);
    expect((services.stt as FallbackSpeechToText).status().map((s) => [s.rank, s.label])).toEqual([[3, "C"]]);
  });
});
