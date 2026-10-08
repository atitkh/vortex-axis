import type { AudioFormat, ClientMessage, ErrorCode, ScalarMap, ServerMessage } from "@vortex-axis/protocol";
import type { Agent } from "./agent.js";
import type { Session } from "./hub.js";
import { SentenceSplitter } from "./sentences.js";
import type { SpeechToText, TextToSpeech } from "./speech.js";
import type { TurnRecord } from "./store.js";
import { WakeArbiter } from "./wake.js";

/** The upstream services a turn needs. Any of them may be missing. */
export interface Services {
  stt?: SpeechToText | undefined;
  tts?: TextToSpeech | undefined;
  agent?: Agent | undefined;
}

/** What the turn logic needs from the hub. */
export interface TurnPort {
  send(session: Session, message: ServerMessage): void;
  sendBinary(session: Session, data: Buffer): void;
  sessions(): Iterable<Session>;
  session(clientId: string): Session | undefined;
  settings(session: Session): ScalarMap;
}

export interface TurnOptions {
  services: Services;
  /** How long wake arbitration waits for other clients. */
  wakeWindowMs: number;
  /** Longest utterance accepted. Audio past this is dropped. */
  maxUtteranceMs: number;
  /** Extra time allowed for a client to report that playback finished. */
  playbackGraceMs?: number;
  /** Told about every turn once it ends: timings and outcome, never the words. */
  record?: (turn: TurnRecord, session: Session) => void;
}

type TurnMessage = Extract<
  ClientMessage,
  { t: "wake" | "audio.start" | "audio.end" | "text" | "interrupt" | "playback" }
>;

interface Capture {
  turnId: string;
  format: AudioFormat;
  chunks: Buffer[];
  bytes: number;
  maxBytes: number;
}

interface ActiveTurn {
  turnId: string;
  abort: AbortController;
  /** Resolves when the turn is over, however it ended. */
  finished: Promise<void>;
  /** Resolves when the client reports that playback ended. */
  playbackDone?: (() => void) | undefined;
  /** Set once the client confirms it played the audio to the end. */
  heard?: boolean;
}

class TurnFailure extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

/** Replies that mean "the agent has nothing to say". They are neither shown nor spoken. */
const SILENT_REPLIES = ["NO_REPLY", "HEARTBEAT_OK"];

/** True while `text` could still turn out to be a silent reply, or is a complete one. Empty text counts. */
function mayBeSilent(text: string): boolean {
  const word = text.trim().toUpperCase();
  return SILENT_REPLIES.some((silent) => silent.startsWith(word));
}

function isSilent(text: string): boolean {
  const word = text.trim().toUpperCase();
  return word === "" || SILENT_REPLIES.includes(word);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Sends speech to one client: cuts it into frames the client can receive and
 * holds back so the client is never sent more audio than it can buffer.
 */
class Speaker {
  private carry: Buffer = Buffer.alloc(0);
  private startedAt = 0;
  private sentMs = 0;
  started = false;

  constructor(
    private readonly port: TurnPort,
    private readonly session: Session,
    private readonly turnId: string,
    private readonly format: AudioFormat,
    private readonly signal: AbortSignal,
  ) {}

  private get bytesPerMs(): number {
    return (this.format.sampleRate * this.format.channels * 2) / 1000;
  }

  /** Audio sent but not yet due to have been played, in milliseconds. */
  aheadMs(): number {
    return this.started ? Math.max(0, this.sentMs - (Date.now() - this.startedAt)) : 0;
  }

  async write(chunk: Buffer): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.startedAt = Date.now();
      this.port.send(this.session, { t: "speak.start", turnId: this.turnId, format: this.format });
      this.port.send(this.session, { t: "turn", turnId: this.turnId, state: "speaking" });
    }
    const frameBytes = Math.max(2, this.session.maxFrameBytes - (this.session.maxFrameBytes % 2));
    let data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    while (data.length >= frameBytes) {
      await this.sendFrame(data.subarray(0, frameBytes));
      if (this.signal.aborted) return;
      data = data.subarray(frameBytes);
    }
    this.carry = Buffer.from(data);
  }

  /**
   * Sends what is left of a sentence without waiting for a full frame, so its
   * last sound is not held back until the next sentence arrives. A stray half
   * sample is kept for the next write.
   */
  async flush(): Promise<void> {
    const even = this.carry.length - (this.carry.length % 2);
    const rest = this.carry.subarray(0, even);
    this.carry = Buffer.from(this.carry.subarray(even));
    if (rest.length && !this.signal.aborted) await this.sendFrame(rest);
  }

  private async sendFrame(frame: Buffer): Promise<void> {
    const over = this.aheadMs() - this.session.audioBufferMs;
    if (over > 0) await sleep(over, this.signal);
    if (this.signal.aborted) return;
    this.port.sendBinary(this.session, frame);
    this.sentMs += frame.length / this.bytesPerMs;
  }
}

/** Runs wake arbitration and voice and text turns for every connected client. */
export class TurnManager {
  private readonly captures = new Map<string, Capture>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly wake: WakeArbiter;
  private readonly services: Services;
  private readonly playbackGraceMs: number;
  private lastInput: { clientId: string; at: number } | undefined;
  private sayCount = 0;

  constructor(private readonly port: TurnPort, private readonly options: TurnOptions) {
    this.services = options.services;
    this.playbackGraceMs = options.playbackGraceMs ?? 5000;
    this.wake = new WakeArbiter({
      windowMs: options.wakeWindowMs,
      listeners: () => [...port.sessions()].filter((s) => s.client.capabilities.includes("mic")).length,
      decide: (report, granted) => {
        const session = port.session(report.clientId);
        if (session) port.send(session, { t: "wake.result", wakeId: report.wakeId, granted });
      },
    });
  }

  handle(session: Session, message: TurnMessage): void {
    const id = session.client.id;
    switch (message.t) {
      case "wake":
        if (!this.requireMic(session)) return;
        this.wake.report({ clientId: id, wakeId: message.wakeId, score: message.score, level: message.level });
        return;

      case "audio.start": {
        if (!this.requireMic(session)) return;
        this.lastInput = { clientId: id, at: Date.now() };
        if (message.wakeId !== undefined && !this.wake.consume(id, message.wakeId)) {
          this.port.send(session, { t: "error", code: "busy", message: "that wake was not granted" });
          return;
        }
        this.cancelActive(session, true);
        const bytesPerMs = (message.format.sampleRate * 2) / 1000;
        this.captures.set(id, {
          turnId: message.turnId,
          format: message.format,
          chunks: [],
          bytes: 0,
          maxBytes: Math.floor(this.options.maxUtteranceMs * bytesPerMs),
        });
        this.port.send(session, { t: "turn", turnId: message.turnId, state: "listening" });
        return;
      }

      case "audio.end": {
        const capture = this.captures.get(id);
        if (!capture || capture.turnId !== message.turnId) return;
        this.captures.delete(id);
        if (message.reason === "cancel" || capture.bytes === 0) {
          this.port.send(session, { t: "turn", turnId: capture.turnId, state: "idle" });
          return;
        }
        void this.run(session, capture.turnId, { pcm: Buffer.concat(capture.chunks), format: capture.format });
        return;
      }

      case "text":
        this.lastInput = { clientId: id, at: Date.now() };
        this.captures.delete(id);
        this.cancelActive(session, true);
        void this.run(session, message.turnId, { text: message.text });
        return;

      case "interrupt": {
        const capture = this.captures.get(id);
        if (capture && (message.turnId === undefined || message.turnId === capture.turnId)) {
          this.captures.delete(id);
          this.port.send(session, { t: "turn", turnId: capture.turnId, state: "idle" });
        }
        const turn = this.active.get(id);
        if (turn && (message.turnId === undefined || message.turnId === turn.turnId)) {
          this.cancelActive(session, false);
        }
        return;
      }

      case "playback": {
        const turn = this.active.get(id);
        if (!turn || turn.turnId !== message.turnId) return;
        if (message.state === "stopped") this.cancelActive(session, false);
        else if (message.state === "finished") {
          turn.heard = true;
          turn.playbackDone?.();
        } else if (message.state === "blocked") {
          // The client cannot make sound. There is nothing to wait for.
          turn.playbackDone?.();
        }
        return;
      }
    }
  }

  /** A binary frame from a client: microphone audio for its open capture. */
  handleAudio(session: Session, data: Buffer): void {
    const capture = this.captures.get(session.client.id);
    if (!capture || capture.bytes >= capture.maxBytes) return;
    const room = capture.maxBytes - capture.bytes;
    const chunk = data.length > room ? data.subarray(0, room - (room % 2)) : data;
    capture.chunks.push(Buffer.from(chunk));
    capture.bytes += chunk.length;
  }

  /** The client that most recently gave input, if that was within `withinMs`. */
  recentInput(withinMs: number): string | undefined {
    if (!this.lastInput || Date.now() - this.lastInput.at > withinMs) return undefined;
    return this.lastInput.clientId;
  }

  /** True while the client is recording or a turn of its own is running. */
  busy(session: Session): boolean {
    return this.captures.has(session.client.id) || this.active.has(session.client.id);
  }

  /**
   * Says something the agent started, with no input from the client. Waits up
   * to `waitMs` behind a live conversation, then resolves once the client has
   * played or shown it. `heard` is true only when the client confirmed that it
   * played the audio to the end.
   */
  async say(session: Session, text: string, waitMs = 20_000): Promise<{ heard: boolean }> {
    const deadline = Date.now() + waitMs;
    while (this.busy(session)) {
      if (Date.now() > deadline) throw new Error(`${session.client.name} is busy with a conversation`);
      await Promise.race([this.active.get(session.client.id)?.finished, new Promise((r) => setTimeout(r, 250))]);
    }
    const outcome = { heard: false };
    const failure = await this.run(session, `say-${++this.sayCount}`, { say: text }, outcome);
    if (failure) throw new Error(failure);
    return outcome;
  }

  /** Forgets a client that disconnected. */
  drop(session: Session): void {
    const id = session.client.id;
    this.captures.delete(id);
    this.active.get(id)?.abort.abort();
    this.active.delete(id);
    this.wake.forget(id);
  }

  stop(): void {
    this.wake.stop();
    for (const turn of this.active.values()) turn.abort.abort();
    this.active.clear();
    this.captures.clear();
  }

  private requireMic(session: Session): boolean {
    if (session.client.capabilities.includes("mic")) return true;
    this.port.send(session, { t: "error", code: "not_supported", message: "this client has no mic capability" });
    return false;
  }

  /**
   * Ends the client's running turn. `tellClient` is set when Axis started the
   * cancellation, so the client knows to stop playing and drop buffered audio.
   */
  private cancelActive(session: Session, tellClient: boolean): void {
    const turn = this.active.get(session.client.id);
    if (!turn) return;
    this.active.delete(session.client.id);
    turn.abort.abort();
    turn.playbackDone?.();
    if (tellClient) this.port.send(session, { t: "stop", turnId: turn.turnId });
    this.port.send(session, { t: "turn", turnId: turn.turnId, state: "idle" });
  }

  private header(session: Session): string {
    const settings = this.port.settings(session);
    const room = typeof settings.room === "string" && settings.room ? settings.room : "unknown";
    const { name, type, capabilities } = session.client;
    return `[from: ${name}, type: ${type}, room: ${room}, can: ${capabilities.join("+") || "nothing"}]`;
  }

  /** Runs one turn. Resolves with a failure message, or undefined when it went through. */
  private async run(
    session: Session,
    turnId: string,
    input: { pcm: Buffer; format: AudioFormat } | { text: string } | { say: string },
    outcome?: { heard: boolean },
  ): Promise<string | undefined> {
    const id = session.client.id;
    // Timings for the activity log, filled in as the turn goes.
    const started = Date.now();
    const record: TurnRecord = {
      at: started,
      clientId: id,
      kind: "say" in input ? "say" : "pcm" in input ? "voice" : "text",
      outcome: "answered",
      totalMs: 0,
      heard: false,
      ...("pcm" in input ? { speechMs: Math.round(input.pcm.length / ((input.format.sampleRate * 2) / 1000)) } : {}),
    };
    let finish!: () => void;
    const turn: ActiveTurn = {
      turnId,
      abort: new AbortController(),
      finished: new Promise<void>((resolve) => (finish = resolve)),
    };
    this.active.set(id, turn);
    const signal = turn.abort.signal;
    const { stt, tts, agent } = this.services;
    const caps = session.client.capabilities;
    const hasScreen = caps.includes("screen");
    const state = (s: "transcribing" | "thinking" | "idle", detail?: string) =>
      this.port.send(session, { t: "turn", turnId, state: s, ...(detail ? { detail } : {}) });

    try {
      let text = "";
      if ("say" in input) {
        // Nothing to transcribe and nobody to ask: the words are already here.
      } else if ("pcm" in input) {
        if (!stt) throw new TurnFailure("upstream_down", "speech recognition is not set up");
        state("transcribing");
        const sttStarted = Date.now();
        text = await stt.transcribe(input.pcm, input.format, signal);
        record.sttMs = Date.now() - sttStarted;
        if (signal.aborted) return "interrupted";
        if (!text) {
          record.outcome = "no_speech";
          state("idle", "no speech heard");
          return undefined;
        }
        if (hasScreen) this.port.send(session, { t: "transcript", turnId, text: text.slice(0, 4000) });
      } else {
        text = input.text;
      }

      let source: AsyncIterable<string>;
      if ("say" in input) {
        source = (async function* (words: string) {
          yield words;
        })(input.say);
      } else {
        if (!agent) throw new TurnFailure("upstream_down", "the agent is not set up");
        state("thinking");
        source = agent.reply(`${this.header(session)}\n${text}`, signal);
      }

      const speaker =
        caps.includes("speaker") && tts ? new Speaker(this.port, session, turnId, tts.format, signal) : undefined;
      const settings = this.port.settings(session);
      const voice = typeof settings.voice === "string" && settings.voice ? settings.voice : undefined;
      const splitter = new SentenceSplitter();
      let full = "";

      const emit = async (piece: string) => {
        if (hasScreen) this.port.send(session, { t: "reply.text", turnId, text: piece, final: false });
        if (!speaker || !tts) return;
        for await (const chunk of tts.synthesize(piece, { voice }, signal)) {
          if (signal.aborted) return;
          record.firstAudioMs ??= Date.now() - started;
          await speaker.write(chunk);
        }
        await speaker.flush();
      };

      // An agent reply that turns out to be "NO_REPLY" must not be spoken, so nothing goes out
      // while the text so far could still become one. Said words are never held back.
      const fromAgent = !("say" in input);
      const held: string[] = [];
      const asked = Date.now();
      for await (const delta of source) {
        if (signal.aborted) return "interrupted";
        if (fromAgent && delta) record.agentMs ??= Date.now() - asked;
        full += delta;
        for (const piece of splitter.push(delta)) held.push(piece);
        if (fromAgent && mayBeSilent(full)) continue;
        while (held.length) {
          await emit(held.shift()!);
          if (signal.aborted) return "interrupted";
        }
      }
      const rest = splitter.flush();
      if (rest) held.push(rest);
      const silent = fromAgent && isSilent(full);
      if (silent) record.outcome = "silent";
      if (!silent) {
        while (held.length) {
          await emit(held.shift()!);
          if (signal.aborted) return "interrupted";
        }
      }
      if (signal.aborted) return "interrupted";

      if (hasScreen) {
        // A silent reply leaves the screen empty rather than showing "NO_REPLY".
        this.port.send(session, { t: "reply.text", turnId, text: silent ? "" : full.trim().slice(0, 16000), final: true });
      }
      if (speaker?.started) {
        this.port.send(session, { t: "speak.end", turnId });
        // The client is still playing what it buffered. Wait for it to say it is done.
        await Promise.race([
          new Promise<void>((resolve) => (turn.playbackDone = resolve)),
          sleep(speaker.aheadMs() + this.playbackGraceMs, signal),
        ]);
        if (signal.aborted) return "interrupted";
      } else if (caps.includes("speaker") && !tts) {
        this.port.send(session, { t: "error", code: "upstream_down", message: "speech synthesis is not set up" });
      }
      state("idle");
      return undefined;
    } catch (error) {
      if (signal.aborted) return "interrupted";
      const failure =
        error instanceof TurnFailure
          ? error
          : new TurnFailure("upstream_down", error instanceof Error ? error.message : "turn failed");
      record.outcome = "failed";
      record.error = failure.message.slice(0, 200);
      this.port.send(session, { t: "stop", turnId });
      this.port.send(session, { t: "turn", turnId, state: "error", detail: failure.message.slice(0, 256) });
      this.port.send(session, { t: "error", code: failure.code, message: failure.message.slice(0, 256) });
      return failure.message;
    } finally {
      if (this.active.get(id) === turn) this.active.delete(id);
      if (outcome) outcome.heard = Boolean(turn.heard);
      finish();
      if (signal.aborted && record.outcome !== "failed") record.outcome = "interrupted";
      record.heard = Boolean(turn.heard);
      record.totalMs = Date.now() - started;
      try {
        this.options.record?.(record, session);
      } catch {
        // Losing one row of the activity log must never break a conversation.
      }
    }
  }
}
