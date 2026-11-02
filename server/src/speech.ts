import type { AudioFormat } from "@vortex-axis/protocol";
import { drain } from "./drain.js";

export interface SpeechToText {
  /** Turns one utterance into text. Returns an empty string when nothing was said. */
  transcribe(pcm: Buffer, format: AudioFormat, signal?: AbortSignal): Promise<string>;
  healthy(): Promise<boolean>;
}

export interface TextToSpeech {
  /** Format of the audio `synthesize` yields. */
  readonly format: AudioFormat;
  /** Yields raw PCM for the text as the service produces it. */
  synthesize(text: string, options: { voice?: string | undefined }, signal?: AbortSignal): AsyncIterable<Buffer>;
  healthy(): Promise<boolean>;
}

export interface SpeechEndpoint {
  /** Full URL of the endpoint, for example http://host:8000/v1/audio/speech. */
  url: string;
  model: string;
  apiKey?: string | undefined;
}

/** Which service speaks: an OpenAI-style endpoint, or ElevenLabs. */
export type SpeechKind = "openai" | "elevenlabs";
export const SPEECH_KINDS: readonly SpeechKind[] = ["openai", "elevenlabs"];

/** Where ElevenLabs keys come from when the saved one is empty. */
export const ELEVENLABS_KEY_ENV = "ELEVENLABS_API_KEY";
export const ELEVENLABS_BASE = "https://api.elevenlabs.io";

export interface KeySource {
  source: "saved" | "env" | "none";
  /** The environment variable the key is read from, when `source` is "env". */
  env?: string;
  /** For "env": whether that variable holds a value right now. */
  present?: boolean;
}

/**
 * Finds the API key to use now. A saved `env:NAME` reads that variable; a saved key is used as it
 * is; an empty one falls back to `fallbackEnv` when given. Read at call time, so the plaintext key
 * need never be saved. Never log or return `key`.
 */
export function resolveApiKey(
  saved: string | undefined,
  fallbackEnv?: string,
  env: NodeJS.ProcessEnv = process.env,
): { key: string | undefined; info: KeySource } {
  const text = (saved ?? "").trim();
  const named = /^env:(.+)$/.exec(text)?.[1]?.trim();
  const name = named ?? (text ? undefined : fallbackEnv);
  if (name) {
    const key = env[name]?.trim() || undefined;
    if (!named && !key) return { key: undefined, info: { source: "none" } };
    return { key, info: { source: "env", env: name, present: key !== undefined } };
  }
  return text ? { key: text, info: { source: "saved" } } : { key: undefined, info: { source: "none" } };
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  const key = resolveApiKey(apiKey).key;
  return key ? { authorization: `Bearer ${key}` } : {};
}

function elevenLabsHeaders(apiKey: string | undefined): Record<string, string> {
  const key = resolveApiKey(apiKey, ELEVENLABS_KEY_ENV).key;
  return key ? { "xi-api-key": key } : {};
}

function elevenLabsBase(url: string | undefined): string {
  return (url?.trim() || ELEVENLABS_BASE).replace(/\/+$/, "");
}

/** Wraps mono 16-bit PCM in a 44-byte WAV header, which is what transcription services accept. */
export function pcmToWav(pcm: Buffer, format: AudioFormat): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * format.channels * 2, 28);
  header.writeUInt16LE(format.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Checks a service is reachable by asking for its model list. Any HTTP answer counts. */
async function reachable(endpointUrl: string, apiKey: string | undefined): Promise<boolean> {
  try {
    const url = new URL("/v1/models", endpointUrl);
    const res = await fetch(url, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(3000) });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * One message said on several devices at once is made once. A share is handed to every device's
 * turn; the first to ask for a sentence in a voice has it made, and the rest play the same audio,
 * from the start, as it comes. So devices in one room start together, and the speech service,
 * which makes one sentence at a time, is not asked for the same thing over and over.
 */
export class SpeechShare {
  private readonly bound = new WeakMap<TextToSpeech, TextToSpeech>();

  /** `tts`, made to share its audio among everybody using this share. */
  for(tts: TextToSpeech): TextToSpeech {
    let shared = this.bound.get(tts);
    if (!shared) {
      shared = new SharedSpeech(tts);
      this.bound.set(tts, shared);
    }
    return shared;
  }
}

interface Clip {
  chunks: Buffer[];
  done: boolean;
  error?: Error;
  waiting: (() => void)[];
}

class SharedSpeech implements TextToSpeech {
  readonly format: AudioFormat;
  private readonly clips = new Map<string, Clip>();

  constructor(private readonly tts: TextToSpeech) {
    this.format = tts.format;
  }

  synthesize(text: string, options: { voice?: string | undefined }, signal?: AbortSignal): AsyncIterable<Buffer> {
    const key = `${options.voice ?? ""}\u0000${text}`;
    let clip = this.clips.get(key);
    if (!clip) {
      clip = { chunks: [], done: false, waiting: [] };
      this.clips.set(key, clip);
      void this.make(clip, text, options);
    }
    return this.read(clip, signal);
  }

  healthy(): Promise<boolean> {
    return this.tts.healthy();
  }

  /** Made once, whoever stops listening: one device being stopped must not cut the others off. */
  private async make(clip: Clip, text: string, options: { voice?: string | undefined }): Promise<void> {
    const wake = () => clip.waiting.splice(0).forEach((resolve) => resolve());
    try {
      for await (const chunk of this.tts.synthesize(text, options, AbortSignal.timeout(120_000))) {
        clip.chunks.push(chunk);
        wake();
      }
    } catch (error) {
      clip.error = error as Error;
    } finally {
      clip.done = true;
      wake();
    }
  }

  private async *read(clip: Clip, signal?: AbortSignal): AsyncIterable<Buffer> {
    let next = 0;
    for (;;) {
      if (signal?.aborted) return;
      if (next < clip.chunks.length) {
        yield clip.chunks[next++]!;
        continue;
      }
      if (clip.error) throw clip.error;
      if (clip.done) return;
      await new Promise<void>((resolve) => {
        clip.waiting.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
}

/** Speech recognition through an OpenAI-style `/v1/audio/transcriptions` endpoint. */
export class OpenAiSpeechToText implements SpeechToText {
  constructor(private readonly endpoint: SpeechEndpoint) {}

  async transcribe(pcm: Buffer, format: AudioFormat, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.set("model", this.endpoint.model);
    form.set("response_format", "json");
    form.set("file", new Blob([new Uint8Array(pcmToWav(pcm, format))], { type: "audio/wav" }), "audio.wav");

    const res = await fetch(this.endpoint.url, {
      method: "POST",
      headers: authHeaders(this.endpoint.apiKey),
      body: form,
      signal: signal ?? null,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`speech recognition answered HTTP ${res.status}`);
    try {
      const parsed = JSON.parse(body) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text.trim() : "";
    } catch {
      return body.trim(); // some services answer with plain text
    }
  }

  healthy(): Promise<boolean> {
    return reachable(this.endpoint.url, this.endpoint.apiKey);
  }
}

/** Speech synthesis through an OpenAI-style `/v1/audio/speech` endpoint, asking for raw PCM. */
export class OpenAiTextToSpeech implements TextToSpeech {
  readonly format: AudioFormat;

  constructor(
    private readonly endpoint: SpeechEndpoint & { voice?: string | undefined; sampleRate: number },
  ) {
    this.format = { encoding: "pcm_s16le", sampleRate: endpoint.sampleRate, channels: 1 };
  }

  async *synthesize(
    text: string,
    options: { voice?: string | undefined },
    signal?: AbortSignal,
  ): AsyncIterable<Buffer> {
    const voice = options.voice ?? this.endpoint.voice;
    const res = await fetch(this.endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(this.endpoint.apiKey) },
      body: JSON.stringify({
        model: this.endpoint.model,
        input: text,
        response_format: "pcm",
        ...(voice ? { voice } : {}),
      }),
      signal: signal ?? null,
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(`speech synthesis answered HTTP ${res.status}`);
    }
    // Read at once, played at real-time pace: see drain() for why the two are kept apart.
    for await (const chunk of drain(res.body)) yield Buffer.from(chunk);
  }

  healthy(): Promise<boolean> {
    return reachable(this.endpoint.url, this.endpoint.apiKey);
  }
}

/** ElevenLabs raw PCM at 24 kHz, 16-bit mono: `output_format=pcm_24000`. */
const ELEVENLABS_PCM: AudioFormat = { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 };

/** The API refuses audio shorter than 100 ms; below this nothing is sent. */
const ELEVENLABS_MIN_MS = 100;

/** Checks ElevenLabs is reachable: an authenticated model list. Any answer below 500 counts. */
async function elevenLabsReachable(url: string | undefined, apiKey: string | undefined): Promise<boolean> {
  try {
    const res = await fetch(`${elevenLabsBase(url)}/v1/models`, {
      headers: elevenLabsHeaders(apiKey),
      signal: AbortSignal.timeout(3000),
    });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

export interface ElevenLabsEndpoint {
  /** Base address; empty means https://api.elevenlabs.io. Regional hosts work, for example https://api.us.elevenlabs.io. */
  url?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
}

/** Speech recognition through ElevenLabs Scribe, `POST /v1/speech-to-text`. */
export class ElevenLabsSpeechToText implements SpeechToText {
  constructor(private readonly endpoint: ElevenLabsEndpoint) {}

  async transcribe(pcm: Buffer, format: AudioFormat, signal?: AbortSignal): Promise<string> {
    if ((pcm.length / 2 / format.sampleRate) * 1000 < ELEVENLABS_MIN_MS) return "";
    const raw = format.sampleRate === 16000 && format.channels === 1;
    const form = new FormData();
    form.set("model_id", this.endpoint.model || "scribe_v2");
    form.set("file_format", raw ? "pcm_s16le_16" : "other");
    form.set(
      "file",
      raw
        ? new Blob([new Uint8Array(pcm)], { type: "audio/pcm" })
        : new Blob([new Uint8Array(pcmToWav(pcm, format))], { type: "audio/wav" }),
      raw ? "audio.pcm" : "audio.wav",
    );
    const res = await fetch(`${elevenLabsBase(this.endpoint.url)}/v1/speech-to-text`, {
      method: "POST",
      headers: elevenLabsHeaders(this.endpoint.apiKey),
      body: form,
      signal: signal ?? null,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`speech recognition answered HTTP ${res.status}`);
    try {
      const parsed = JSON.parse(body) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text.trim() : "";
    } catch {
      return "";
    }
  }

  healthy(): Promise<boolean> {
    return elevenLabsReachable(this.endpoint.url, this.endpoint.apiKey);
  }
}

/** Speech synthesis through ElevenLabs, `POST /v1/text-to-speech/{voice_id}`, asking for 24 kHz PCM. */
export class ElevenLabsTextToSpeech implements TextToSpeech {
  readonly format: AudioFormat = ELEVENLABS_PCM;

  constructor(private readonly endpoint: ElevenLabsEndpoint & { voice?: string | undefined }) {}

  async *synthesize(
    text: string,
    options: { voice?: string | undefined },
    signal?: AbortSignal,
  ): AsyncIterable<Buffer> {
    const voice = (options.voice ?? this.endpoint.voice)?.trim();
    if (!voice) throw new Error("ElevenLabs needs a voice id: set a default voice on the Speech page");
    const url = `${elevenLabsBase(this.endpoint.url)}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_24000`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...elevenLabsHeaders(this.endpoint.apiKey) },
      body: JSON.stringify({ text, model_id: this.endpoint.model || "eleven_flash_v2_5" }),
      signal: signal ?? null,
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(`speech synthesis answered HTTP ${res.status}`);
    }
    for await (const chunk of drain(res.body)) yield Buffer.from(chunk);
  }

  healthy(): Promise<boolean> {
    return elevenLabsReachable(this.endpoint.url, this.endpoint.apiKey);
  }
}
