import type { AudioFormat } from "@vortex-axis/protocol";
import { stripAudioTags } from "./audiotags.js";
import { scale } from "./talk.js";
import type { SpeechToText, TextToSpeech } from "./speech.js";

/** How long one synthesis entry may take to send its first audio before the next one is tried. */
export const TTS_FIRST_CHUNK_MS = 8_000;
/** How long one recognition entry may take to answer before the next one is tried. */
export const STT_ATTEMPT_MS = 15_000;

/** One endpoint in a ranked list: its stable id, label, place in the configured list (1-based) and client. */
export interface RankedEntry<S> {
  id: string;
  label: string;
  rank: number;
  /** What the client was built from; state carried over a reload only while this is unchanged. */
  fingerprint?: string;
  /** For synthesis: the voice acts on audio tags ([whispers]) in the text it is given. */
  audioTags?: boolean;
  /** For synthesis: output volume trim in percent (10..100); absent or 100 leaves the audio untouched. */
  gain?: number;
  service: S;
}

interface EntryState {
  /** Last known: true after a success or a good health check, false after a failure; undefined before either. */
  up: boolean | undefined;
  /** Left out of the order until then (epoch ms). */
  downUntil?: number;
  lastError?: string;
}

/** What the admin page is told about one entry. */
export interface EntryStatus {
  id: string;
  rank: number;
  label: string;
  up: boolean | "unknown";
  downUntil?: number;
  lastError?: string;
  /** The entry that served the most recent request. */
  active: boolean;
}

/** "ok": the top entry works; "degraded": a lower-ranked one is serving; "down": none can. */
export type SpeechLevel = "ok" | "degraded" | "down";

export interface FallbackOptions {
  cooldownSeconds: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Per-attempt time limit, for tests; the constants above otherwise. */
  attemptMs?: number;
  /** Audio tags are in use: text goes to an entry that cannot act on them with the tags taken out. Off: text goes through untouched. */
  audioTags?: boolean;
  /** State of the previous wrapper's entries, by id, so a reload does not forget what was down. */
  carry?: Map<string, { fingerprint?: string | undefined; state: EntryState }>;
}

/** Error text safe to log and show: the message only (the clients never put a key in one). */
/** A time limit as said in a log line. */
const within = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

abstract class Fallback<S extends { healthy(): Promise<boolean> }> {
  protected readonly states: EntryState[];
  protected readonly now: () => number;
  protected readonly log: (line: string) => void;
  private activeId: string | undefined;

  constructor(
    protected readonly entries: RankedEntry<S>[],
    protected readonly options: FallbackOptions,
    private readonly what: string,
  ) {
    if (!entries.length) throw new Error(`${what}: no entries`);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.states = entries.map((entry) => {
      const kept = options.carry?.get(entry.id);
      return kept && kept.fingerprint === entry.fingerprint ? { ...kept.state } : { up: undefined };
    });
  }

  protected name(i: number): string {
    const entry = this.entries[i]!;
    return `#${entry.rank}${entry.label ? ` "${entry.label}"` : ""}`;
  }

  private cooling(i: number): boolean {
    const until = this.states[i]!.downUntil;
    return until !== undefined && until > this.now();
  }

  /** Entries to try in order: those not cooling down first, then (once, as a last resort) the rest. */
  protected order(): number[] {
    const all = this.entries.map((_, i) => i);
    return [...all.filter((i) => !this.cooling(i)), ...all.filter((i) => this.cooling(i))];
  }

  protected succeeded(i: number): void {
    const state = this.states[i]!;
    state.up = true;
    delete state.downUntil;
    this.activeId = this.entries[i]!.id;
  }

  protected failed(i: number, error: unknown, next: number | undefined): void {
    const state = this.states[i]!;
    state.up = false;
    state.downUntil = this.now() + this.options.cooldownSeconds * 1000;
    state.lastError = reason(error);
    this.log(
      `${this.what}: ${this.name(i)} failed (${state.lastError})${next === undefined ? "" : `, trying ${this.name(next)}`}; left out for ${this.options.cooldownSeconds} s`,
    );
  }

  /** Any entry answers. Checks them all, so a recovered entry is noticed and its cool-down ends early. */
  async healthy(): Promise<boolean> {
    const results = await Promise.all(this.entries.map((entry) => entry.service.healthy().catch(() => false)));
    results.forEach((ok, i) => {
      const state = this.states[i]!;
      state.up = ok;
      if (ok) delete state.downUntil;
    });
    return results.some(Boolean);
  }

  level(): SpeechLevel {
    const usable = (i: number) => !this.cooling(i) && this.states[i]!.up !== false;
    if (usable(0)) return "ok";
    return this.entries.some((_, i) => usable(i)) ? "degraded" : "down";
  }

  status(): EntryStatus[] {
    return this.entries.map((entry, i) => {
      const state = this.states[i]!;
      return {
        id: entry.id,
        rank: entry.rank,
        label: entry.label,
        up: state.up ?? "unknown",
        ...(this.cooling(i) ? { downUntil: state.downUntil! } : {}),
        ...(state.lastError ? { lastError: state.lastError } : {}),
        active: entry.id === this.activeId,
      };
    });
  }

  /** The entries' state, for the wrapper built after a reload. */
  carry(): NonNullable<FallbackOptions["carry"]> {
    return new Map(this.entries.map((entry, i) => [entry.id, { fingerprint: entry.fingerprint, state: { ...this.states[i]! } }]));
  }
}

/**
 * Speech recognition over ranked entries. An error or a timeout moves on to the next entry with the
 * same audio; an empty transcript is an answer (nothing was said), not a failure.
 */
export class FallbackSpeechToText extends Fallback<SpeechToText> implements SpeechToText {
  constructor(entries: RankedEntry<SpeechToText>[], options: FallbackOptions) {
    super(entries, options, "speech recognition");
  }

  async transcribe(pcm: Buffer, format: AudioFormat, signal?: AbortSignal): Promise<string> {
    const order = this.order();
    const limit = this.options.attemptMs ?? STT_ATTEMPT_MS;
    let last: unknown;
    for (const [at, i] of order.entries()) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(limit);
      try {
        const text = await this.entries[i]!.service.transcribe(pcm, format, signal ? AbortSignal.any([signal, timeout]) : timeout);
        this.succeeded(i);
        return text;
      } catch (error) {
        // Stopped by the caller: not the entry's fault, and nothing more to try.
        if (signal?.aborted) throw error;
        last = timeout.aborted ? new Error(`no answer within ${within(limit)}`) : error;
        this.failed(i, last, order[at + 1]);
      }
    }
    throw last;
  }
}

/**
 * Speech synthesis over ranked entries. An entry that fails or sends no audio within the first-chunk
 * limit is passed over for the next; once audio has started, a clip is never switched to another
 * entry (a failure then ends it, as with one service). The format is the top entry's: audio from an
 * entry with another sample rate is converted as it streams, so a player started on this format
 * never has to change.
 */
export class FallbackTextToSpeech extends Fallback<TextToSpeech> implements TextToSpeech {
  readonly format: AudioFormat;

  constructor(entries: RankedEntry<TextToSpeech>[], options: FallbackOptions) {
    super(entries, options, "speech synthesis");
    this.format = entries[0]!.service.format;
  }

  async *synthesize(text: string, options: { voice?: string | undefined }, signal?: AbortSignal): AsyncIterable<Buffer> {
    const order = this.order();
    const limit = this.options.attemptMs ?? TTS_FIRST_CHUNK_MS;
    let last: unknown;
    for (const [at, i] of order.entries()) {
      if (signal?.aborted) return;
      const entry = this.entries[i]!;
      const stop = new AbortController();
      const onAbort = () => stop.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      // A device's own voice is chosen among the top entry's voices; any other entry speaks in its own.
      const said = this.options.audioTags && !entry.audioTags ? stripAudioTags(text) : text;
      const iterator = entry.service.synthesize(said, i === 0 ? options : {}, stop.signal)[Symbol.asyncIterator]();
      let first: IteratorResult<Buffer>;
      let timer: NodeJS.Timeout | undefined;
      try {
        const next = iterator.next();
        next.catch(() => undefined);
        first = await Promise.race([
          next,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              stop.abort();
              reject(new Error(`no audio within ${within(limit)}`));
            }, limit);
          }),
        ]);
      } catch (error) {
        signal?.removeEventListener("abort", onAbort);
        stop.abort();
        void iterator.return?.()?.catch(() => undefined);
        if (signal?.aborted) throw error;
        last = error;
        this.failed(i, error, order[at + 1]);
        continue;
      } finally {
        clearTimeout(timer);
      }
      // Audio has begun (or the entry finished with none): this entry has the clip.
      this.succeeded(i);
      const convert = entry.service.format.sampleRate === this.format.sampleRate ? undefined : new StreamResampler(entry.service.format.sampleRate, this.format.sampleRate);
      let done = first.done;
      // This entry's trim comes first, so it applies at the entry's own rate and a clip is trimmed once.
      const odd: { byte?: number | undefined } = {};
      const level = entry.gain !== undefined && entry.gain < 100 ? entry.gain / 100 : undefined;
      const shape = (chunk: Buffer): Buffer => {
        const trimmed = level === undefined ? chunk : scale(chunk, level, odd);
        return convert ? convert.push(trimmed) : trimmed;
      };
      try {
        if (!first.done) {
          const out = shape(first.value);
          if (out.length || level === undefined) yield out;
        }
        while (!done) {
          const step = await iterator.next();
          done = step.done;
          if (!step.done) {
            const out = shape(step.value);
            if (out.length || level === undefined) yield out;
          }
        }
      } catch (error) {
        if (!signal?.aborted) this.failed(i, error, undefined);
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (!done) {
          stop.abort();
          void iterator.return?.()?.catch(() => undefined);
        }
      }
      return;
    }
    throw last;
  }
}

/** Mono 16-bit PCM from one sample rate to another, by linear interpolation, chunk by chunk without seams. */
export class StreamResampler {
  private readonly step: number;
  /** Where the next output sample falls, in input samples from `last`. */
  private at = 0;
  private last: number | undefined;
  private odd: Buffer | undefined;

  constructor(from: number, to: number) {
    this.step = from / to;
  }

  push(chunk: Buffer): Buffer {
    let data = this.odd ? Buffer.concat([this.odd, chunk]) : chunk;
    this.odd = undefined;
    if (data.length % 2) {
      this.odd = Buffer.from(data.subarray(data.length - 1));
      data = data.subarray(0, data.length - 1);
    }
    const input: number[] = this.last === undefined ? [] : [this.last];
    for (let o = 0; o < data.length; o += 2) input.push(data.readInt16LE(o));
    const out: number[] = [];
    // Each output sample needs the input samples on both sides of it; the last one waits for the next chunk.
    while (Math.floor(this.at) < input.length - 1) {
      const a = Math.floor(this.at);
      const frac = this.at - a;
      out.push(Math.round(input[a]! * (1 - frac) + input[a + 1]! * frac));
      this.at += this.step;
    }
    if (input.length) {
      this.last = input[input.length - 1];
      this.at -= input.length - 1;
    }
    const buffer = Buffer.alloc(out.length * 2);
    out.forEach((sample, k) => buffer.writeInt16LE(sample, k * 2));
    return buffer;
  }
}
