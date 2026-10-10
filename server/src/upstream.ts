import type { AudioFormat } from "@vortex-axis/protocol";
import { ChatCompletionsAgent, DEFAULT_GATEWAY_NOTE, DEFAULT_SYSTEM_PROMPT, type Agent } from "./agent.js";
import type { Config } from "./config.js";
import { OpenAiSpeechToText, OpenAiTextToSpeech } from "./speech.js";
import type { Store } from "./store.js";
import { HttpVoiceprintService } from "./voiceprint.js";
import type { Services } from "./turns.js";

/**
 * The upstream settings an admin can change while Axis runs. An empty string
 * means "not set". Values saved here win over the environment, which only
 * supplies the starting point.
 */
export interface RuntimeConfig {
  stt: { url: string; model: string; apiKey: string };
  tts: { url: string; model: string; voice: string; sampleRate: number; apiKey: string };
  /** The voiceprint service: an address answering POST with a recording, as speech/voiceprint.py does. */
  voiceprint: { url: string };
  agent: {
    /** Who answers turns: an OpenClaw gateway, or any OpenAI-style chat endpoint. */
    backend: "gateway" | "openai";
    url: string;
    model: string;
    token: string;
    /** For a chat endpoint only: the system message sent with every turn. Empty means the built-in one. */
    systemPrompt: string;
    /**
     * For an OpenClaw agent only: a note added to the agent's own system prompt.
     * Empty means the built-in one; "-" means send none.
     */
    gatewayNote: string;
  };
}

/** The note an OpenClaw agent is sent: the admin's own, the built-in one, or none at all for "-". */
export function gatewayNoteFor(agent: Pick<RuntimeConfig["agent"], "gatewayNote">): string {
  const own = agent.gatewayNote.trim();
  return own === "-" ? "" : own || DEFAULT_GATEWAY_NOTE;
}

/** The system message a chat endpoint is sent: the admin's own, or the built-in one when none is set. */
export function systemPromptFor(agent: Pick<RuntimeConfig["agent"], "systemPrompt">): string {
  return agent.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
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
    voiceprint: { url: config.voiceprintUrl ?? "" },
    agent: {
      backend: config.agent ? "openai" : "gateway",
      url: config.agent?.url ?? "",
      model: config.agent?.model ?? "",
      token: config.agent?.token ?? "",
      systemPrompt: "",
      gatewayNote: "",
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
    voiceprint: { ...base.voiceprint, ...patch.voiceprint },
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
    if (!["stt", "tts", "voiceprint", "agent"].includes(section)) throw new Error(`unknown section "${section}"`);
    const value = (p as Record<string, unknown>)[section];
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${section} must be an object`);
  }
  checkUrl("stt.url", p.stt?.url);
  checkUrl("tts.url", p.tts?.url);
  checkUrl("voiceprint.url", p.voiceprint?.url);
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
  const prompt = p.agent?.systemPrompt;
  if (prompt !== undefined && (typeof prompt !== "string" || prompt.length > 8000)) {
    throw new Error("agent.systemPrompt must be text of at most 8000 characters");
  }
  const gatewayNote = p.agent?.gatewayNote;
  if (gatewayNote !== undefined && (typeof gatewayNote !== "string" || gatewayNote.length > 4000)) {
    throw new Error("agent.gatewayNote must be text of at most 4000 characters");
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
    voiceprint: { ...saved.voiceprint, ...pick<RuntimeConfig["voiceprint"]>(["url"], p.voiceprint) },
    agent: { ...saved.agent, ...pick<RuntimeConfig["agent"]>(["backend", "url", "model", "token", "systemPrompt", "gatewayNote"], p.agent) },
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
    voiceprint: rc.voiceprint,
    agent: { ...agent, tokenSet: Boolean(token), defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT, defaultGatewayNote: DEFAULT_GATEWAY_NOTE },
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
  services.voiceprint = rc.voiceprint.url ? new HttpVoiceprintService(rc.voiceprint.url) : undefined;
  gatewayAgent.setNote?.(gatewayNoteFor(rc.agent));
  if (rc.agent.backend === "gateway") services.agent = gatewayAgent;
  else {
    services.agent = rc.agent.url
      ? new ChatCompletionsAgent({
          url: rc.agent.url,
          model: rc.agent.model,
          token: rc.agent.token || undefined,
          systemPrompt: systemPromptFor(rc.agent),
          sessionKey,
        })
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

/**
 * Sends one short message to an OpenAI-style chat endpoint, so an address can
 * be tried before it is saved. A field left empty falls back to the saved one,
 * which is how a saved token is used without the page ever having it.
 */
export async function testChatAgent(saved: RuntimeConfig["agent"], typed: { url?: unknown; model?: unknown; token?: unknown; systemPrompt?: unknown }) {
  const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  const url = text(typed.url, saved.url);
  const model = text(typed.model, saved.model);
  const token = text(typed.token, saved.token);
  const report: { ok: boolean; url: string; model: string; firstTextMs?: number; totalMs?: number; reply?: string; error?: string } = {
    ok: false,
    url,
    model,
  };
  if (!url) return { ...report, error: "no chat endpoint given" };
  checkUrl("the chat endpoint", url);
  // The prompt as typed, so a change to it can be tried too; left out, the saved one.
  const systemPrompt = systemPromptFor({ systemPrompt: typeof typed.systemPrompt === "string" ? typed.systemPrompt : saved.systemPrompt });
  const agent = new ChatCompletionsAgent({ url, model, token: token || undefined, systemPrompt });
  const started = Date.now();
  try {
    let reply = "";
    const message = "[from: Test, type: web, location: unknown, can: screen]\nThis is a connection test. Reply with the single word: ready";
    for await (const piece of agent.reply(message, AbortSignal.timeout(30_000))) {
      report.firstTextMs ??= Date.now() - started;
      reply += piece;
      if (reply.length > 400) break;
    }
    report.totalMs = Date.now() - started;
    if (!reply.trim()) throw new Error("the endpoint answered, but with no text. Check the model name and that it streams replies");
    report.reply = reply.trim().slice(0, 200);
    report.ok = true;
  } catch (error) {
    // A failed connection arrives as "fetch failed" with the real reason one or two levels down.
    const e = error as Error & { cause?: { code?: string; message?: string; errors?: { code?: string }[] } };
    const why = e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.cause?.message;
    report.error = e.name === "TimeoutError" ? "no answer within 30 seconds" : why ? `could not connect (${why})` : e.message;
  }
  return report;
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
