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
