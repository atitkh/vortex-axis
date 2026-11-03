import { AUDIO_TAGS_SETTINGS, effectiveAudioTags, type AudioTagsSetting } from "./audiotags.js";
import { randomBytes } from "node:crypto";
import type { AudioFormat } from "@vortex-axis/protocol";
import { ChatCompletionsAgent, DEFAULT_AUDIO_TAGS_NOTE, DEFAULT_GATEWAY_NOTE, DEFAULT_SYSTEM_PROMPT, type Agent } from "./agent.js";
import type { Config } from "./config.js";
import {
  ELEVENLABS_KEY_ENV,
  ElevenLabsSpeechToText,
  ElevenLabsTextToSpeech,
  OpenAiSpeechToText,
  OpenAiTextToSpeech,
  resolveApiKey,
  SPEECH_KINDS,
  type SpeechKind,
  type SpeechToText,
  type TextToSpeech,
} from "./speech.js";
import { FallbackSpeechToText, FallbackTextToSpeech, type SpeechLevel } from "./fallback.js";
import type { Store } from "./store.js";
import { HttpVoiceprintService } from "./voiceprint.js";
import type { Services } from "./turns.js";

/**
 * The upstream settings an admin can change while Axis runs. An empty string
 * means "not set". Values saved here win over the environment, which only
 * supplies the starting point.
 */
export interface RuntimeConfig {
  /**
   * Speech recognition endpoints, tried in rank order (the order of `entries`), with a failed one
   * left out for `cooldownSeconds`. An empty list means recognition is off.
   */
  stt: { entries: SttEntry[]; cooldownSeconds: number };
  /** Speech synthesis endpoints, as `stt`. */
  tts: { entries: TtsEntry[]; cooldownSeconds: number };
  speech: {
    /** A turn whose realtime voice cannot be reached before it says anything is answered the local way instead. */
    realtimeFallback: boolean;
  };
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
    /**
     * Added to either note while the top-ranked synthesis voice acts on audio tags.
     * Empty means the built-in one; "-" means send none.
     */
    audioTagsNote: string;
  };
}

/** The audio-tags paragraph: the admin's own, the built-in one, or none for "-". Only asked for while tags are in use. */
function audioTagsNoteFor(agent: { audioTagsNote?: string }): string {
  const own = (agent.audioTagsNote ?? "").trim();
  return own === "-" ? "" : own || DEFAULT_AUDIO_TAGS_NOTE;
}

/**
 * The note an OpenClaw agent is sent: the admin's own, the built-in one, or none at all for "-",
 * with the audio-tags paragraph after it while `tagsActive`.
 */
export function gatewayNoteFor(agent: Pick<RuntimeConfig["agent"], "gatewayNote" | "audioTagsNote">, tagsActive = false): string {
  const own = agent.gatewayNote.trim();
  const note = own === "-" ? "" : own || DEFAULT_GATEWAY_NOTE;
  return tagsActive ? [note, audioTagsNoteFor(agent)].filter(Boolean).join("\n\n") : note;
}

/** The system message a chat endpoint is sent: the admin's own, or the built-in one when none is set, plus the audio-tags paragraph while `tagsActive`. */
export function systemPromptFor(agent: Pick<RuntimeConfig["agent"], "systemPrompt"> & { audioTagsNote?: string }, tagsActive = false): string {
  const prompt = agent.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
  return tagsActive ? [prompt, audioTagsNoteFor(agent)].filter(Boolean).join("\n\n") : prompt;
}

const META_KEY = "upstream_config";

/**
 * One speech recognition endpoint in the ranked list. `kind` is "openai" (an OpenAI-style endpoint,
 * the default and what a config saved before kinds existed means) or "elevenlabs". `apiKey` may be
 * `env:NAME` to read that variable. `id` is stable: the admin page names entries by it.
 */
export interface SttEntry {
  id: string;
  enabled: boolean;
  label: string;
  kind: SpeechKind;
  url: string;
  model: string;
  apiKey: string;
}

/** One speech synthesis endpoint. For ElevenLabs the sample rate is fixed at 24000 and `sampleRate` is ignored. */
export interface TtsEntry extends SttEntry {
  voice: string;
  sampleRate: number;
  /** Output volume trim in percent, 10 to 100; 100 leaves the audio untouched. Applied to this entry's audio only. */
  gain: number;
  /** "auto": send audio tags ([whispers]) where the model acts on them; "off": never. See audiotags.ts. */
  audioTags: AudioTagsSetting;
}

/**
 * Whether audio tags are in use: the voice that normally speaks, the first enabled entry that can
 * work, is one that acts on them. A fallback entry never turns them on, since it may not be the one heard.
 */
export function audioTagsActive(entries: TtsEntry[]): boolean {
  const top = entries.find((entry) => entry.enabled && ttsFor(entry));
  return Boolean(top && effectiveAudioTags(top));
}

/** At most this many entries per service. */
export const MAX_SPEECH_ENTRIES = 8;
export const DEFAULT_COOLDOWN_SECONDS = 60;
/**
 * The id of the entry made from the environment (`AXIS_STT_*`, `AXIS_TTS_*`) or from a config saved
 * before lists existed. Fixed, so that entry keeps its id across loads without being written back;
 * missing fields of it still come from the environment, as they did before.
 */
export const MAIN_ENTRY_ID = "main";

const STT_FIELDS = ["kind", "url", "model", "apiKey"] as const;
const TTS_FIELDS = ["kind", "url", "model", "voice", "sampleRate", "gain", "apiKey", "audioTags"] as const;
const ENTRY_FIELDS = ["enabled", "label"] as const;

/** An entry as stored: its id and only the fields that were ever set. */
type StoredEntry = { id: string } & Partial<Omit<TtsEntry, "id">>;
type StoredService = { entries: StoredEntry[]; cooldownSeconds?: number };
/** What is kept under META_KEY. `stt`/`tts` may still be in the shape saved before lists: one partial entry. */
interface Stored {
  stt?: StoredService | Partial<RuntimeConfig["stt"]["entries"][number]>;
  tts?: StoredService | Partial<TtsEntry>;
  speech?: Partial<RuntimeConfig["speech"]>;
  voiceprint?: Partial<RuntimeConfig["voiceprint"]>;
  agent?: Partial<RuntimeConfig["agent"]>;
}

function envDefaults(config: Config) {
  return {
    stt: { kind: "openai" as SpeechKind, url: config.stt?.url ?? "", model: config.stt?.model ?? "whisper-1", apiKey: config.stt?.apiKey ?? "" },
    tts: {
      kind: "openai" as SpeechKind,
      url: config.tts?.url ?? "",
      model: config.tts?.model ?? "tts-1",
      voice: config.tts?.voice ?? "",
      sampleRate: config.tts?.sampleRate ?? 24000,
      gain: 100,
      apiKey: config.tts?.apiKey ?? "",
      audioTags: "auto" as AudioTagsSetting,
    },
  };
}

const BLANK_STT = { kind: "openai" as SpeechKind, url: "", model: "whisper-1", apiKey: "" };
const BLANK_TTS = { kind: "openai" as SpeechKind, url: "", model: "tts-1", voice: "", sampleRate: 24000, gain: 100, apiKey: "", audioTags: "auto" as AudioTagsSetting };

function newEntryId(taken: Set<string>): string {
  for (;;) {
    const id = randomBytes(6).toString("base64url");
    if (!taken.has(id)) return id;
  }
}

/** The stored list of a service, whichever shape it was saved in. Nothing saved: one entry from the environment. */
function storedService(saved: Stored["stt"] | Stored["tts"]): StoredService {
  if (saved && Array.isArray((saved as StoredService).entries)) return saved as StoredService;
  // Saved before lists (or never saved): that one object is entry #1, enabled, on top of the environment.
  return { entries: [{ ...(saved as Partial<TtsEntry> | undefined), id: MAIN_ENTRY_ID }] };
}

function loadEntries<T extends SttEntry>(stored: StoredService, fromEnv: Omit<T, "id" | "enabled" | "label">, blank: Omit<T, "id" | "enabled" | "label">): T[] {
  return stored.entries.map((entry) => ({
    enabled: true,
    label: "",
    ...(entry.id === MAIN_ENTRY_ID ? fromEnv : blank),
    ...entry,
  })) as T[];
}

export function loadRuntimeConfig(store: Store, config: Config): RuntimeConfig {
  const env = envDefaults(config);
  const saved = JSON.parse(store.getMeta(META_KEY) ?? "{}") as Stored;
  const stt = storedService(saved.stt);
  const tts = storedService(saved.tts);
  return {
    stt: { entries: loadEntries<SttEntry>(stt, env.stt, BLANK_STT), cooldownSeconds: stt.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS },
    tts: { entries: loadEntries<TtsEntry>(tts, env.tts, BLANK_TTS), cooldownSeconds: tts.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS },
    speech: { realtimeFallback: true, ...saved.speech },
    voiceprint: { url: config.voiceprintUrl ?? "", ...saved.voiceprint },
    agent: {
      backend: config.agent ? "openai" : "gateway",
      url: config.agent?.url ?? "",
      model: config.agent?.model ?? "",
      token: config.agent?.token ?? "",
      systemPrompt: "",
      gatewayNote: "",
      audioTagsNote: "",
      ...saved.agent,
    },
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

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The checks one speech entry's fields get, whether sent alone (the old shape) or in a list. */
function checkEntry(name: string, e: Record<string, unknown>, tts: boolean): void {
  checkUrl(`${name}.url`, e.url);
  if (e.kind !== undefined && !SPEECH_KINDS.includes(e.kind as SpeechKind)) throw new Error(`${name}.kind must be "openai" or "elevenlabs"`);
  if (typeof e.apiKey === "string" && e.apiKey.startsWith("env:") && !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(e.apiKey.trim())) {
    throw new Error(`${name}.apiKey must be env: followed by a variable name, such as env:ELEVENLABS_API_KEY`);
  }
  for (const field of ["model", "apiKey", ...(tts ? ["voice"] : [])]) checkText(`${name}.${field}`, e[field]);
  if (e.enabled !== undefined && typeof e.enabled !== "boolean") throw new Error(`${name}.enabled must be true or false`);
  if (e.label !== undefined && (typeof e.label !== "string" || e.label.length > 80)) throw new Error(`${name}.label must be text of at most 80 characters`);
  if (e.id !== undefined && (typeof e.id !== "string" || e.id.length > 64)) throw new Error(`${name}.id must be short text`);
  if (tts && e.audioTags !== undefined && !AUDIO_TAGS_SETTINGS.includes(e.audioTags as AudioTagsSetting)) {
    throw new Error(`${name}.audioTags must be "auto" or "off"`);
  }
  const rate = e.sampleRate;
  if (tts && rate !== undefined && (!Number.isInteger(rate) || (rate as number) < 8000 || (rate as number) > 48000)) {
    throw new Error(`${name}.sampleRate must be a whole number from 8000 to 48000`);
  }
  const gain = e.gain;
  if (tts && gain !== undefined && (!Number.isInteger(gain) || (gain as number) < 10 || (gain as number) > 100)) {
    throw new Error(`${name}.gain must be a whole number from 10 to 100`);
  }
}

const pick = <T extends object>(allowed: readonly string[], from: Record<string, unknown> | undefined): Partial<T> => {
  const out: Record<string, unknown> = {};
  for (const key of allowed) if (from && from[key] !== undefined) out[key] = from[key];
  return out as Partial<T>;
};

/**
 * Applies a patch to one service's stored list. The patch is one of:
 * - `{ entries: [...] }`: the whole ordered list. An entry naming a saved `id` keeps every field it
 *   leaves out (so its key survives); one with no id or an unknown one is new and gets an id; a saved
 *   entry not in the list is deleted. An empty list switches the service off.
 * - the fields of one entry (the shape before lists): they change entry #1, made if there is none.
 * Either may carry `cooldownSeconds`.
 */
function patchService(which: "stt" | "tts", saved: StoredService, patch: Record<string, unknown>): StoredService {
  const tts = which === "tts";
  const fields = [...ENTRY_FIELDS, ...(tts ? TTS_FIELDS : STT_FIELDS)];
  const next: StoredService = { ...saved, entries: saved.entries.map((e) => ({ ...e })) };
  const cooldown = patch.cooldownSeconds;
  if (cooldown !== undefined) {
    if (!Number.isInteger(cooldown) || (cooldown as number) < 5 || (cooldown as number) > 3600) {
      throw new Error(`${which}.cooldownSeconds must be a whole number from 5 to 3600`);
    }
    next.cooldownSeconds = cooldown as number;
  }
  const single = Object.keys(patch).filter((key) => key !== "cooldownSeconds" && key !== "entries");
  if (patch.entries !== undefined) {
    if (single.length) throw new Error(`${which}: send entries or the fields of one entry, not both`);
    if (!Array.isArray(patch.entries)) throw new Error(`${which}.entries must be a list`);
    if (patch.entries.length > MAX_SPEECH_ENTRIES) throw new Error(`${which}.entries holds at most ${MAX_SPEECH_ENTRIES} entries`);
    const old = new Map(saved.entries.map((e) => [e.id, e]));
    const seen = new Set<string>();
    const taken = new Set(saved.entries.map((e) => e.id));
    next.entries = patch.entries.map((entry, i) => {
      if (!isObject(entry)) throw new Error(`${which}.entries[${i}] must be an object`);
      checkEntry(`${which}.entries[${i}]`, entry, tts);
      const id = typeof entry.id === "string" && entry.id ? entry.id : undefined;
      if (id && seen.has(id)) throw new Error(`${which}.entries[${i}].id is in the list twice`);
      const before = id ? old.get(id) : undefined;
      const keep = before ? before.id : newEntryId(taken);
      seen.add(keep);
      taken.add(keep);
      return { ...before, ...pick<StoredEntry>(fields, entry), id: keep };
    });
    return next;
  }
  if (single.length) {
    checkEntry(which, patch, tts);
    const first = next.entries[0] ?? { id: newEntryId(new Set()) };
    next.entries[0] = { ...first, ...pick<StoredEntry>(fields, patch) };
  }
  return next;
}

/**
 * Saves a change to the runtime settings and returns the result. A field left out of the patch keeps
 * its value, which is how secrets survive an edit made from a page that never received them.
 */
export function saveRuntimeConfig(store: Store, config: Config, patch: unknown): RuntimeConfig {
  if (!isObject(patch)) throw new Error("body must be an object");
  const p = patch as { [K in keyof Stored]?: Record<string, unknown> };
  for (const section of Object.keys(p)) {
    if (!["stt", "tts", "speech", "voiceprint", "agent"].includes(section)) throw new Error(`unknown section "${section}"`);
    if (!isObject((p as Record<string, unknown>)[section])) throw new Error(`${section} must be an object`);
  }
  checkUrl("voiceprint.url", p.voiceprint?.url);
  checkUrl("agent.url", p.agent?.url);
  for (const [name, value] of [
    ["agent.model", p.agent?.model],
    ["agent.token", p.agent?.token],
  ] as const) {
    checkText(name, value);
  }
  const prompt = p.agent?.systemPrompt;
  if (prompt !== undefined && (typeof prompt !== "string" || prompt.length > 8000)) {
    throw new Error("agent.systemPrompt must be text of at most 8000 characters");
  }
  const gatewayNote = p.agent?.gatewayNote;
  if (gatewayNote !== undefined && (typeof gatewayNote !== "string" || gatewayNote.length > 4000)) {
    throw new Error("agent.gatewayNote must be text of at most 4000 characters");
  }
  const tagsNote = p.agent?.audioTagsNote;
  if (tagsNote !== undefined && (typeof tagsNote !== "string" || tagsNote.length > 4000)) {
    throw new Error("agent.audioTagsNote must be text of at most 4000 characters");
  }
  const backend = p.agent?.backend;
  if (backend !== undefined && backend !== "gateway" && backend !== "openai") {
    throw new Error('agent.backend must be "gateway" or "openai"');
  }
  const fallback = p.speech?.realtimeFallback;
  if (fallback !== undefined && typeof fallback !== "boolean") throw new Error("speech.realtimeFallback must be true or false");

  const saved = JSON.parse(store.getMeta(META_KEY) ?? "{}") as Stored;
  const next: Stored = {
    // Always written in the list shape, which is how a config saved before lists moves over.
    stt: patchService("stt", storedService(saved.stt), p.stt ?? {}),
    tts: patchService("tts", storedService(saved.tts), p.tts ?? {}),
    speech: { ...saved.speech, ...pick<RuntimeConfig["speech"]>(["realtimeFallback"], p.speech) },
    voiceprint: { ...saved.voiceprint, ...pick<RuntimeConfig["voiceprint"]>(["url"], p.voiceprint) },
    agent: { ...saved.agent, ...pick<RuntimeConfig["agent"]>(["backend", "url", "model", "token", "systemPrompt", "gatewayNote", "audioTagsNote"], p.agent) },
  };
  store.setMeta(META_KEY, JSON.stringify(next));
  return loadRuntimeConfig(store, config);
}

/** Where an entry's key comes from, never the key: "saved", "env" (with the variable's name) or "none". */
function publicEntry<T extends SttEntry>(entry: T) {
  const { apiKey, ...rest } = entry;
  return { ...rest, apiKeySet: Boolean(apiKey), keySource: resolveApiKey(apiKey, entry.kind === "elevenlabs" ? ELEVENLABS_KEY_ENV : undefined).info };
}

/**
 * The settings as shown to an admin: secrets are reported as set or not, never returned. Each
 * service also carries entry #1's fields at its top level, as before lists, for pages that edit one.
 */
export function publicRuntimeConfig(rc: RuntimeConfig) {
  const { token, ...agent } = rc.agent;
  const flat = <T extends SttEntry>(entries: T[], blank: Omit<T, "id" | "enabled" | "label">) => {
    const { id: _id, enabled: _enabled, label: _label, ...first } = publicEntry({ id: "", enabled: true, label: "", ...blank, ...entries[0] } as T);
    return first;
  };
  return {
    stt: { ...flat(rc.stt.entries, BLANK_STT), entries: rc.stt.entries.map(publicEntry), cooldownSeconds: rc.stt.cooldownSeconds },
    tts: { ...flat(rc.tts.entries, BLANK_TTS), entries: rc.tts.entries.map(publicEntry), cooldownSeconds: rc.tts.cooldownSeconds },
    speech: rc.speech,
    voiceprint: rc.voiceprint,
    agent: { ...agent, tokenSet: Boolean(token), defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT, defaultGatewayNote: DEFAULT_GATEWAY_NOTE, defaultAudioTagsNote: DEFAULT_AUDIO_TAGS_NOTE },
  };
}

/** One recognition entry's client, or nothing when it cannot work (an OpenAI-style one with no address). */
export function sttFor(stt: SttEntry): SpeechToText | undefined {
  // ElevenLabs has a default address, so it needs no url to be on. The OpenAI starting models mean "its default".
  if (stt.kind === "elevenlabs") return new ElevenLabsSpeechToText({ url: stt.url, model: stt.model === "whisper-1" ? "" : stt.model, apiKey: stt.apiKey });
  return stt.url ? new OpenAiSpeechToText({ url: stt.url, model: stt.model, apiKey: stt.apiKey || undefined }) : undefined;
}

/** One synthesis entry's client, or nothing when it cannot work. */
export function ttsFor(tts: TtsEntry): TextToSpeech | undefined {
  if (tts.kind === "elevenlabs") {
    return new ElevenLabsTextToSpeech({ url: tts.url, model: tts.model === "tts-1" ? "" : tts.model, voice: tts.voice, apiKey: tts.apiKey });
  }
  return tts.url
    ? new OpenAiTextToSpeech({ url: tts.url, model: tts.model, sampleRate: tts.sampleRate, voice: tts.voice || undefined, apiKey: tts.apiKey || undefined })
    : undefined;
}

/** What an entry's client was built from, so its up/down state can outlive a reload that did not change it. */
const fingerprint = (entry: SttEntry) => JSON.stringify(entry);

/**
 * Rebuilds the upstream clients in place, so turns already wired to `services` see the change.
 * Speech recognition and synthesis are the enabled entries that can work, in rank order, behind a
 * wrapper that fails over between them; none of them means the service is off.
 */
export function applyRuntimeConfig(
  services: Services,
  rc: RuntimeConfig,
  gatewayAgent: Agent,
  sessionKey: string,
  log?: (line: string) => void,
): void {
  const build = <E extends SttEntry, S>(entries: E[], make: (entry: E) => S | undefined) =>
    entries.flatMap((entry, i) => {
      const service = entry.enabled ? make(entry) : undefined;
      return service ? [{ id: entry.id, label: entry.label, rank: i + 1, fingerprint: fingerprint(entry), service }] : [];
    });
  const stt = build(rc.stt.entries, sttFor);
  const tts = build(rc.tts.entries, ttsFor).map((entry) => ({ ...entry, audioTags: effectiveAudioTags(rc.tts.entries.find((e) => e.id === entry.id)!), gain: rc.tts.entries.find((e) => e.id === entry.id)!.gain }));
  const tags = audioTagsActive(rc.tts.entries);
  const before = { stt: services.stt instanceof FallbackSpeechToText ? services.stt : undefined, tts: services.tts instanceof FallbackTextToSpeech ? services.tts : undefined };
  services.stt = stt.length
    ? new FallbackSpeechToText(stt, { cooldownSeconds: rc.stt.cooldownSeconds, ...(log ? { log } : {}), ...(before.stt ? { carry: before.stt.carry() } : {}) })
    : undefined;
  services.tts = tts.length
    ? new FallbackTextToSpeech(tts, { cooldownSeconds: rc.tts.cooldownSeconds, ...(tags ? { audioTags: true } : {}), ...(log ? { log } : {}), ...(before.tts ? { carry: before.tts.carry() } : {}) })
    : undefined;
  services.voiceprint = rc.voiceprint.url ? new HttpVoiceprintService(rc.voiceprint.url) : undefined;
  services.audioTags = tags;
  gatewayAgent.setNote?.(gatewayNoteFor(rc.agent, tags));
  if (rc.agent.backend === "gateway") services.agent = gatewayAgent;
  else {
    services.agent = rc.agent.url
      ? new ChatCompletionsAgent({
          url: rc.agent.url,
          model: rc.agent.model,
          token: rc.agent.token || undefined,
          systemPrompt: systemPromptFor(rc.agent, tags),
          sessionKey,
        })
      : undefined;
  }
}

/** How a speech service stands: "ok", "degraded" (a lower-ranked entry is serving), "down", or "off" with no entry that can work. */
export function speechLevel(service: SpeechToText | TextToSpeech | undefined): SpeechLevel | "off" | "unknown" {
  if (!service) return "off";
  return service instanceof FallbackSpeechToText || service instanceof FallbackTextToSpeech ? service.level() : "unknown";
}

/**
 * Every configured speech entry in rank order with its live state, for the admin page.
 * `usable` is false for an entry that is switched off or cannot work (an OpenAI-style one with no address).
 */
export function speechStatus(rc: RuntimeConfig, services: Services) {
  const one = (entries: SttEntry[], service: SpeechToText | TextToSpeech | undefined, cooldownSeconds: number) => {
    const live = new Map(
      (service instanceof FallbackSpeechToText || service instanceof FallbackTextToSpeech ? service.status() : []).map((s) => [s.id, s]),
    );
    return {
      state: speechLevel(service),
      cooldownSeconds,
      entries: entries.map((entry, i) => {
        const s = live.get(entry.id);
        return {
          id: entry.id,
          rank: i + 1,
          label: entry.label,
          kind: entry.kind,
          enabled: entry.enabled,
          usable: Boolean(s),
          up: s?.up ?? ("unknown" as const),
          ...(s?.downUntil !== undefined ? { downUntil: s.downUntil } : {}),
          ...(s?.lastError ? { lastError: s.lastError } : {}),
          active: s?.active ?? false,
        };
      }),
    };
  };
  return {
    stt: one(rc.stt.entries, services.stt, rc.stt.cooldownSeconds),
    tts: one(rc.tts.entries, services.tts, rc.tts.cooldownSeconds),
    realtimeFallback: rc.speech.realtimeFallback,
  };
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
