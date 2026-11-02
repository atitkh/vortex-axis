import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import {
  ElevenLabsSpeechToText,
  ElevenLabsTextToSpeech,
  resolveApiKey,
  pcmToWav,
} from "../src/speech.js";
import { loadRuntimeConfig, publicRuntimeConfig, saveRuntimeConfig } from "../src/upstream.js";
import { config } from "./harness.js";

const KEY = "sk-secret-value-123";

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

let server: Server;
let base: string;
let seen: Seen[] = [];
let status = 200;
let byPath: Record<string, number> = {};
let reply: Buffer | string = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = byPath[req.url ?? ""] ?? status;
      res.end(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = [];
  status = 200;
  byPath = {};
  reply = "";
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.MY_EL_KEY;
});

const pcm = (ms: number, rate = 16000) => Buffer.alloc((rate * ms * 2) / 1000, 1);
const collect = async (it: AsyncIterable<Buffer>) => Buffer.concat(await Array.fromAsync(it));

describe("resolveApiKey", () => {
  it("uses a saved key, env:NAME, the ELEVENLABS_API_KEY fallback, or none", () => {
    const env = { MY_EL_KEY: "from-name", ELEVENLABS_API_KEY: "from-default" };
    expect(resolveApiKey("plain", "ELEVENLABS_API_KEY", env)).toEqual({ key: "plain", info: { source: "saved" } });
    expect(resolveApiKey("env:MY_EL_KEY", undefined, env)).toEqual({
      key: "from-name",
      info: { source: "env", env: "MY_EL_KEY", present: true },
    });
    expect(resolveApiKey("", "ELEVENLABS_API_KEY", env).key).toBe("from-default");
    expect(resolveApiKey("", undefined, env)).toEqual({ key: undefined, info: { source: "none" } });
    expect(resolveApiKey("", "ELEVENLABS_API_KEY", {}).info).toEqual({ source: "none" });
    expect(resolveApiKey("env:MISSING", undefined, {}).info).toEqual({ source: "env", env: "MISSING", present: false });
  });
});

describe("ElevenLabs text to speech", () => {
  it("posts to the voice path asking for pcm_24000 and yields the audio", async () => {
    reply = Buffer.from([1, 2, 3, 4]);
    const tts = new ElevenLabsTextToSpeech({ url: `${base}/`, voice: "a b/c", apiKey: KEY });
    expect(tts.format).toEqual({ encoding: "pcm_s16le", sampleRate: 24000, channels: 1 });
    expect([...(await collect(tts.synthesize("hello", {})))]).toEqual([1, 2, 3, 4]);
    const r = seen[0]!;
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/v1/text-to-speech/a%20b%2Fc?output_format=pcm_24000");
    expect(r.headers["xi-api-key"]).toBe(KEY);
    expect(r.headers.authorization).toBeUndefined();
    expect(r.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(r.body.toString())).toEqual({ text: "hello", model_id: "eleven_flash_v2_5" });
  });

  it("prefers the per-request voice and the configured model, and reads the key from the environment", async () => {
    process.env.MY_EL_KEY = "env-key";
    const tts = new ElevenLabsTextToSpeech({ url: base, voice: "default", model: "eleven_v3", apiKey: "env:MY_EL_KEY" });
    await collect(tts.synthesize("x", { voice: "other" }));
    expect(seen[0]!.url).toContain("/v1/text-to-speech/other?");
    expect(seen[0]!.headers["xi-api-key"]).toBe("env-key");
    expect(JSON.parse(seen[0]!.body.toString()).model_id).toBe("eleven_v3");
  });

  it("falls back to ELEVENLABS_API_KEY when the saved key is empty", async () => {
    process.env.ELEVENLABS_API_KEY = "fallback";
    await collect(new ElevenLabsTextToSpeech({ url: base, voice: "v", apiKey: "" }).synthesize("x", {}));
    expect(seen[0]!.headers["xi-api-key"]).toBe("fallback");
  });

  it("needs a voice id and reports an error status without the key", async () => {
    await expect(collect(new ElevenLabsTextToSpeech({ url: base, apiKey: KEY }).synthesize("x", {}))).rejects.toThrow(/voice id/);
    expect(seen).toHaveLength(0);
    status = 401;
    const failing = collect(new ElevenLabsTextToSpeech({ url: base, voice: "v", apiKey: KEY }).synthesize("x", {}));
    await expect(failing).rejects.toThrow("speech synthesis answered HTTP 401");
    await failing.catch((e: Error) => expect(e.message).not.toContain(KEY));
  });

  it("checks health with GET /v1/user: 2xx healthy; 5xx and no key unhealthy", async () => {
    const tts = new ElevenLabsTextToSpeech({ url: base, voice: "v", apiKey: KEY });
    expect(await tts.healthy()).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("/v1/user");
    expect(seen[0]!.headers["xi-api-key"]).toBe(KEY);
    status = 503;
    expect(await tts.healthy()).toBe(false);
    seen = [];
    expect(await new ElevenLabsSpeechToText({ url: base }).healthy()).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("on 401/403 from /v1/user asks /v1/voices: 2xx there is healthy, 401 or 403 there is not", async () => {
    const stt = new ElevenLabsSpeechToText({ url: base, apiKey: KEY });
    byPath = { "/v1/user": 401, "/v1/voices": 200 };
    expect(await stt.healthy()).toBe(true);
    expect(seen.map((r) => r.url)).toEqual(["/v1/user", "/v1/voices"]);
    byPath = { "/v1/user": 403, "/v1/voices": 401 };
    expect(await stt.healthy()).toBe(false);
    byPath = { "/v1/user": 401, "/v1/voices": 503 };
    expect(await stt.healthy()).toBe(false);
    byPath = { "/v1/user": 404 };
    seen = [];
    expect(await stt.healthy()).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

describe("ElevenLabs speech to text", () => {
  const field = (body: Buffer, name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body.toString("latin1"))?.[1];

  it("sends 16 kHz mono as raw pcm_s16le_16 and returns the text", async () => {
    reply = JSON.stringify({ text: " hi there ", language_code: "eng" });
    const stt = new ElevenLabsSpeechToText({ url: base, apiKey: KEY });
    expect(await stt.transcribe(pcm(500), { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 })).toBe("hi there");
    const r = seen[0]!;
    expect(r.url).toBe("/v1/speech-to-text");
    expect(r.headers["xi-api-key"]).toBe(KEY);
    expect(r.headers["content-type"]).toMatch(/^multipart\/form-data/);
    expect(field(r.body, "model_id")).toBe("scribe_v2");
    expect(field(r.body, "file_format")).toBe("pcm_s16le_16");
    expect(r.body.includes(pcm(500))).toBe(true);
  });

  it("sends other rates as a WAV with file_format=other", async () => {
    reply = JSON.stringify({ text: "x" });
    const format = { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 } as const;
    const audio = pcm(300, 24000);
    await new ElevenLabsSpeechToText({ url: base, model: "scribe_v1", apiKey: KEY }).transcribe(audio, format);
    expect(field(seen[0]!.body, "file_format")).toBe("other");
    expect(field(seen[0]!.body, "model_id")).toBe("scribe_v1");
    expect(seen[0]!.body.includes(pcmToWav(audio, format))).toBe(true);
  });

  it("skips clips under 100 ms and throws on an error status without the key", async () => {
    const stt = new ElevenLabsSpeechToText({ url: base, apiKey: KEY });
    const format = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } as const;
    expect(await stt.transcribe(pcm(90), format)).toBe("");
    expect(seen).toHaveLength(0);
    status = 422;
    const failing = stt.transcribe(pcm(500), format);
    await expect(failing).rejects.toThrow("speech recognition answered HTTP 422");
    await failing.catch((e: Error) => expect(e.message).not.toContain(KEY));
  });
});

describe("runtime config kinds", () => {
  const fresh = () => ({ store: new Store(":memory:"), cfg: config() });

  it("defaults to openai and keeps a saved config without a kind working", () => {
    const { store, cfg } = fresh();
    store.setMeta("upstream_config", JSON.stringify({ stt: { url: "http://x/v1/audio/transcriptions", model: "m" }, tts: { url: "http://x/v1/audio/speech" } }));
    const rc = loadRuntimeConfig(store, cfg);
    expect(rc.stt).toMatchObject({ kind: "openai", url: "http://x/v1/audio/transcriptions", model: "m" });
    expect(rc.tts).toMatchObject({ kind: "openai", url: "http://x/v1/audio/speech" });
  });

  it("validates kind and env: key names, and a patch without kind keeps it", () => {
    const { store, cfg } = fresh();
    expect(() => saveRuntimeConfig(store, cfg, { stt: { kind: "nope" } })).toThrow(/stt.kind/);
    expect(() => saveRuntimeConfig(store, cfg, { tts: { kind: 5 } })).toThrow(/tts.kind/);
    expect(() => saveRuntimeConfig(store, cfg, { tts: { apiKey: "env:bad name" } })).toThrow(/env:/);
    saveRuntimeConfig(store, cfg, { stt: { kind: "elevenlabs", model: "scribe_v2" }, tts: { kind: "elevenlabs", voice: "abc" } });
    const rc = saveRuntimeConfig(store, cfg, { stt: { model: "scribe_v1" } });
    expect(rc.stt).toMatchObject({ kind: "elevenlabs", model: "scribe_v1" });
    expect(rc.tts).toMatchObject({ kind: "elevenlabs", voice: "abc" });
  });

  it("reports where a key comes from and never the key", () => {
    const { store, cfg } = fresh();
    const show = (rc: ReturnType<typeof loadRuntimeConfig>) => JSON.stringify(publicRuntimeConfig(rc));
    let rc = saveRuntimeConfig(store, cfg, { tts: { kind: "elevenlabs", apiKey: KEY }, stt: { kind: "elevenlabs" } });
    expect(publicRuntimeConfig(rc).tts.keySource).toEqual({ source: "saved" });
    expect(publicRuntimeConfig(rc).stt.keySource).toEqual({ source: "none" });
    expect(show(rc)).not.toContain(KEY);
    process.env.ELEVENLABS_API_KEY = KEY;
    expect(publicRuntimeConfig(rc).stt.keySource).toEqual({ source: "env", env: "ELEVENLABS_API_KEY", present: true });
    rc = saveRuntimeConfig(store, cfg, { tts: { apiKey: "env:MY_EL_KEY" } });
    expect(publicRuntimeConfig(rc).tts.keySource).toEqual({ source: "env", env: "MY_EL_KEY", present: false });
    expect(show(rc)).not.toContain(KEY);
    expect(store.getMeta("upstream_config")).not.toContain("ELEVENLABS_API_KEY\":\"" + KEY);
  });
});
