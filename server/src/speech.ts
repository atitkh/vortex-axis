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

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
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
