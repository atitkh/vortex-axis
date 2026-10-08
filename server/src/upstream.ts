import type { AudioFormat } from "@vortex-axis/protocol";
import { ChatCompletionsAgent, type Agent } from "./agent.js";
import type { Config } from "./config.js";
import { OpenAiSpeechToText, OpenAiTextToSpeech } from "./speech.js";
import type { Store } from "./store.js";
import type { Services } from "./turns.js";

/**
 * The upstream settings an admin can change while Axis runs. An empty string
 * means "not set". Values saved here win over the environment, which only
 * supplies the starting point.
 */
export interface RuntimeConfig {
  stt: { url: string; model: string; apiKey: string };
  tts: { url: string; model: string; voice: string; sampleRate: number; apiKey: string };
  agent: {
    /** Who answers turns: an OpenClaw gateway, or any OpenAI-style chat endpoint. */
    backend: "gateway" | "openai";
    url: string;
    model: string;
    token: string;
  };
}

const META_KEY = "upstream_config";

type Patch = { [K in keyof RuntimeConfig]?: Partial<RuntimeConfig[K]> };

function fromEnvironment(config: Config): RuntimeConfig {
  return {
    stt: { url: config.stt?.url ?? "", model: config.stt?.model ?? "whisper-1", apiKey: config.stt?.apiKey ?? "" },
    tts: {
      url: config.tts?.url ?? "",
      model: config.tts?.model ?? "tts-1",
      voice: config.tts?.voice ?? "",
      sampleRate: config.tts?.sampleRate ?? 24000,
      apiKey: config.tts?.apiKey ?? "",
    },
    agent: {
      backend: config.agent ? "openai" : "gateway",
      url: config.agent?.url ?? "",
      model: config.agent?.model ?? "",
      token: config.agent?.token ?? "",
    },
  };
}

export function loadRuntimeConfig(store: Store, config: Config): RuntimeConfig {
  const base = fromEnvironment(config);
  const saved = store.getMeta(META_KEY);
  if (!saved) return base;
  const patch = JSON.parse(saved) as Patch;
  return {
    stt: { ...base.stt, ...patch.stt },
    tts: { ...base.tts, ...patch.tts },
    agent: { ...base.agent, ...patch.agent },
  };
}

function checkUrl(name: string, value: unknown): void {
  if (value === undefined || value === "") return;
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid address`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} must start with http:// or https://`);
}

function checkText(name: string, value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || value.length > 512)) throw new Error(`${name} must be short text`);
}

/**
 * Saves a change to the runtime settings and returns the result. A field left
 * out of the patch keeps its value, which is how secrets survive an edit made
 * from a page that never received them.
 */
export function saveRuntimeConfig(store: Store, config: Config, patch: unknown): RuntimeConfig {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("body must be an object");
  const p = patch as Patch;
  for (const section of Object.keys(p)) {
    if (!["stt", "tts", "agent"].includes(section)) throw new Error(`unknown section "${section}"`);
    const value = (p as Record<string, unknown>)[section];
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${section} must be an object`);
  }
  checkUrl("stt.url", p.stt?.url);
  checkUrl("tts.url", p.tts?.url);
  checkUrl("agent.url", p.agent?.url);
  for (const [name, value] of [
    ["stt.model", p.stt?.model],
    ["stt.apiKey", p.stt?.apiKey],
    ["tts.model", p.tts?.model],
    ["tts.voice", p.tts?.voice],
    ["tts.apiKey", p.tts?.apiKey],
    ["agent.model", p.agent?.model],
    ["agent.token", p.agent?.token],
  ] as const) {
    checkText(name, value);
  }
  const rate = p.tts?.sampleRate;
  if (rate !== undefined && (!Number.isInteger(rate) || rate < 8000 || rate > 48000)) {
    throw new Error("tts.sampleRate must be a whole number from 8000 to 48000");
  }
  const backend = p.agent?.backend;
  if (backend !== undefined && backend !== "gateway" && backend !== "openai") {
    throw new Error('agent.backend must be "gateway" or "openai"');
  }

  const pick = <T extends object>(allowed: readonly (keyof T)[], from: Partial<T> | undefined): Partial<T> => {
    const out: Partial<T> = {};
    for (const key of allowed) if (from && from[key] !== undefined) out[key] = from[key];
    return out;
  };
  const saved = JSON.parse(store.getMeta(META_KEY) ?? "{}") as Patch;
  const next: Patch = {
    stt: { ...saved.stt, ...pick<RuntimeConfig["stt"]>(["url", "model", "apiKey"], p.stt) },
    tts: { ...saved.tts, ...pick<RuntimeConfig["tts"]>(["url", "model", "voice", "sampleRate", "apiKey"], p.tts) },
    agent: { ...saved.agent, ...pick<RuntimeConfig["agent"]>(["backend", "url", "model", "token"], p.agent) },
  };
  store.setMeta(META_KEY, JSON.stringify(next));
  return loadRuntimeConfig(store, config);
}

/** The settings as shown to an admin: secrets are reported as set or not, never returned. */
export function publicRuntimeConfig(rc: RuntimeConfig) {
  const { apiKey: sttKey, ...stt } = rc.stt;
  const { apiKey: ttsKey, ...tts } = rc.tts;
  const { token, ...agent } = rc.agent;
  return {
    stt: { ...stt, apiKeySet: Boolean(sttKey) },
    tts: { ...tts, apiKeySet: Boolean(ttsKey) },
    agent: { ...agent, tokenSet: Boolean(token) },
  };
}

/** Rebuilds the upstream clients in place, so turns already wired to `services` see the change. */
export function applyRuntimeConfig(
  services: Services,
  rc: RuntimeConfig,
  gatewayAgent: Agent,
  sessionKey: string,
): void {
  services.stt = rc.stt.url ? new OpenAiSpeechToText({ ...rc.stt, apiKey: rc.stt.apiKey || undefined }) : undefined;
  services.tts = rc.tts.url
    ? new OpenAiTextToSpeech({ ...rc.tts, voice: rc.tts.voice || undefined, apiKey: rc.tts.apiKey || undefined })
    : undefined;
  if (rc.agent.backend === "gateway") services.agent = gatewayAgent;
  else {
    services.agent = rc.agent.url
      ? new ChatCompletionsAgent({ url: rc.agent.url, model: rc.agent.model, token: rc.agent.token || undefined, sessionKey })
      : undefined;
  }
}

/** Converts mono 16-bit PCM to another sample rate by linear interpolation. */
export function resample(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to) return pcm;
  const input = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  const output = new Int16Array(Math.floor((input.length * to) / from));
  const step = from / to;
  for (let i = 0; i < output.length; i++) {
    const at = i * step;
    const a = Math.floor(at);
    const frac = at - a;
    output[i] = Math.round(input[a]! * (1 - frac) + (input[a + 1] ?? input[a]!) * frac);
  }
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
}

const TEST_SENTENCE = "Testing, one two three.";
const STT_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };

/**
 * Exercises the speech services for real: synthesizes a sentence, then has
 * speech recognition transcribe that audio. Reports what happened and how long
 * each step took.
 */
export async function testServices(services: Services) {
  const report: {
    tts: { ok: boolean; firstAudioMs?: number; totalMs?: number; audioSeconds?: number; error?: string };
    stt: { ok: boolean; ms?: number; heard?: string; error?: string };
    agent: { ok: boolean };
    said: string;
  } = { tts: { ok: false }, stt: { ok: false }, agent: { ok: false }, said: TEST_SENTENCE };

  report.agent.ok = services.agent ? await services.agent.healthy().catch(() => false) : false;

  let audio: Buffer | undefined;
  if (!services.tts) report.tts.error = "not set";
  else {
    try {
      const started = Date.now();
      const chunks: Buffer[] = [];
      let first: number | undefined;
      for await (const chunk of services.tts.synthesize(TEST_SENTENCE, {}, AbortSignal.timeout(30_000))) {
        first ??= Date.now() - started;
        chunks.push(chunk);
      }
      audio = Buffer.concat(chunks);
      if (audio.length === 0) throw new Error("the service returned no audio");
      report.tts = {
        ok: true,
        firstAudioMs: first ?? 0,
        totalMs: Date.now() - started,
        audioSeconds: Math.round((audio.length / 2 / services.tts.format.sampleRate) * 100) / 100,
      };
    } catch (error) {
      report.tts.error = (error as Error).message;
    }
  }

  if (!services.stt) report.stt.error = "not set";
  else if (!audio || !services.tts) {
    // Without audio to transcribe, the best check left is whether it answers at all.
    report.stt.ok = await services.stt.healthy().catch(() => false);
    if (!report.stt.ok) report.stt.error = "the service does not answer";
  } else {
    try {
      const started = Date.now();
      const even = audio.subarray(0, audio.length - (audio.length % 2));
      const heard = await services.stt.transcribe(
        resample(Buffer.from(even), services.tts.format.sampleRate, STT_FORMAT.sampleRate),
        STT_FORMAT,
        AbortSignal.timeout(60_000),
      );
      report.stt = { ok: true, ms: Date.now() - started, heard };
    } catch (error) {
      report.stt.error = (error as Error).message;
    }
  }
  return report;
}
