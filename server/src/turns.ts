import type { AudioFormat, ClientMessage, ErrorCode, ScalarMap, ServerMessage } from "@vortex-axis/protocol";
import type { Agent } from "./agent.js";
import { matchChoice, type AskResult } from "./ask.js";
import type { Session } from "./hub.js";
import { SentenceSplitter, type Piece } from "./sentences.js";
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
  /** Told when several clients heard the wake word at once: who answered, and a line saying how each scored. */
  contested?: (winnerId: string, text: string) => void;
  /** Told when a wake word was put down to another device talking in the same location. */
  wakeIgnored?: (clientId: string, text: string) => void;
}

type TurnMessage = Extract<
  ClientMessage,
  { t: "wake" | "audio.start" | "audio.end" | "text" | "interrupt" | "playback" | "answer" }
>;

/** A question a client has been asked and not yet answered. */
interface PendingAsk {
  askId: string;
  question: string;
  since: number;
  choices: string[];
  resolve: (result: AskResult) => void;
  timer: NodeJS.Timeout;
  /** When to stop waiting, even for somebody who is still talking. */
  hardStop: number;
}

interface Capture {
  turnId: string;
  startedAt: number;
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
  /**
   * True while the turn waits for the agent's first words. The agent may be
   * busy calling a tool that speaks or asks on this very client, so the client
   * is free for that; the turn carries on when the agent answers.
   */
  thinking?: boolean;
  /** Set when the turn is over. */
  done?: boolean;
  startedAt?: number;
}

/** What a client is doing at this moment, for the admin page. */
export interface ClientNow {
  clientId: string;
  state: "listening" | "thinking" | "speaking" | "asked";
  since: number;
  /** The question and its choices, when `state` is "asked". */
  question?: string;
  choices?: string[];
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
  /** Samples of near-silence at the end of what was sent so far. */
  private quietTail = 0;
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

  /**
   * Silence until the end of what was sent is `ms` quiet. Speech engines differ in how much
   * silence they leave at the end of a clip, so only the difference is added: the pause comes
   * out the same whichever engine is used.
   */
  async pause(ms: number): Promise<void> {
    await this.flush();
    const tailMs = (this.quietTail * 2) / this.bytesPerMs;
    const missing = Math.round(ms - tailMs);
    if (missing <= 0 || this.signal.aborted) return;
    const bytes = Math.round(missing * this.bytesPerMs);
    await this.write(Buffer.alloc(bytes - (bytes % 2)));
    await this.flush();
  }

  private async sendFrame(frame: Buffer): Promise<void> {
    const over = this.aheadMs() - this.session.audioBufferMs;
    if (over > 0) await sleep(over, this.signal);
    if (this.signal.aborted) return;
    this.port.sendBinary(this.session, frame);
    this.sentMs += frame.length / this.bytesPerMs;
    this.measureTail(frame);
  }

  /** Below about -44 dBFS counts as quiet. */
  private measureTail(frame: Buffer): void {
    const samples = frame.length >> 1;
    let quiet = 0;
    while (quiet < samples && Math.abs(frame.readInt16LE((samples - 1 - quiet) * 2)) < QUIET_SAMPLE) quiet++;
    this.quietTail = quiet === samples ? this.quietTail + quiet : quiet;
  }
}

const QUIET_SAMPLE = 200;

/** The pause after a piece, as a share of the sentence pause. */
const PAUSE_SHARE: Record<Piece["end"], number> = { sentence: 1, clause: 0.5, paragraph: 1.5, none: 0.25 };

/** One sentence being synthesized: its audio arrives here as the speech service sends it. */
interface SynthJob {
  piece: Piece;
  started: boolean;
  chunks: Buffer[];
  done: boolean;
  failed: boolean;
  error?: unknown;
}

/**
 * Speaks a reply sentence by sentence. The next sentence is synthesized while the one before
 * is still playing, up to one sentence ahead, so it is ready when the last ends. Only one
 * synthesis runs at a time: a small speech server shares its processor between requests, and
 * a second one would delay the first sentence's first sound. Between sentences a deliberate
 * pause goes in, so the rhythm is the same whether the speech service is quick or slow.
 */
class SpeechQueue {
  private readonly jobs: SynthJob[] = [];
  private playing = 0;
  private closed = false;
  private loop: Promise<void> | undefined;
  private notify = () => {};
  private changed = new Promise<void>((resolve) => (this.notify = resolve));
  /** Set when synthesis failed; the turn stops with it. */
  failure: unknown;
  failed = false;

  constructor(
    private readonly speaker: Speaker,
    private readonly tts: TextToSpeech,
    private readonly options: {
      voice: string | undefined;
      signal: AbortSignal;
      /** Base pause after a sentence, in milliseconds. */
      pauseMs: number;
      /** Called as a piece starts to play, to show its text. */
      onPiece: (piece: Piece) => void;
      /** Called with the first audio of the reply. */
      onFirstAudio: () => void;
      /** Sentences synthesized ahead of the one playing. */
      lookahead?: number;
    },
  ) {}

  /** Queues a piece. Never waits: the text keeps flowing while earlier pieces play. */
  add(piece: Piece): void {
    this.jobs.push({ piece, started: false, chunks: [], done: false, failed: false });
    this.startDue();
    this.wake();
    this.loop ??= this.run().catch((error: unknown) => {
      this.failed = true;
      this.failure = error;
    });
  }

  /** No more pieces. Resolves once everything has been sent, or throws what failed. */
  async finish(): Promise<void> {
    this.closed = true;
    this.wake();
    await this.loop;
    if (this.failed) throw this.failure;
  }

  private wake(): void {
    this.notify();
  }

  private async next(): Promise<void> {
    await this.changed;
    // A new promise before anything is checked again, so a change that lands now is not missed.
    this.changed = new Promise<void>((resolve) => (this.notify = resolve));
  }

  /** Starts the next synthesis that is due, if none is running. */
  private startDue(): void {
    const last = Math.min(this.jobs.length - 1, this.playing + (this.options.lookahead ?? 1));
    for (let i = this.playing; i <= last; i++) {
      const job = this.jobs[i]!;
      if (job.started && !job.done) return; // one at a time
      if (!job.started) return this.synthesize(job);
    }
  }

  private synthesize(job: SynthJob): void {
    job.started = true;
    void (async () => {
      try {
        for await (const chunk of this.tts.synthesize(job.piece.text, { voice: this.options.voice }, this.options.signal)) {
          job.chunks.push(chunk);
          this.wake();
        }
      } catch (error) {
        job.failed = true;
        job.error = error;
      } finally {
        job.done = true;
        // The speech service is free again: the next sentence can start.
        if (!this.options.signal.aborted) this.startDue();
        this.wake();
      }
    })();
  }

  private async run(): Promise<void> {
    const { signal } = this.options;
    for (let i = 0; ; i++) {
      while (i >= this.jobs.length) {
        if (this.closed || signal.aborted) return;
        await this.next();
      }
      this.playing = i;
      this.startDue();
      const job = this.jobs[i]!;
      // The pause belongs between sentences: none before the first, none after the last.
      if (i > 0) await this.speaker.pause(this.options.pauseMs * PAUSE_SHARE[this.jobs[i - 1]!.piece.end]);
      if (signal.aborted) return;
      this.options.onPiece(job.piece);
      let read = 0;
      for (;;) {
        if (signal.aborted) return;
        if (read < job.chunks.length) {
          this.options.onFirstAudio();
          await this.speaker.write(job.chunks[read++]!);
          continue;
        }
        if (job.failed) throw job.error;
        if (job.done) break;
        await this.next();
      }
      await this.speaker.flush();
      job.chunks = [];
    }
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
  private readonly asks = new Map<string, PendingAsk>();
  private askCount = 0;

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
      contested: (reports, winner) => {
        const percent = (n: number) => `${Math.round(n * 100)}%`;
        const say = (r: (typeof reports)[number]) =>
          `${port.session(r.clientId)?.client.name ?? r.clientId} (score ${percent(r.score)}, loudness ${percent(r.level)})`;
        const rest = reports.filter((r) => r !== winner).map(say).join(", ");
        options.contested?.(winner.clientId, `Wake word heard by ${reports.length} devices: ${say(winner)} answered; stood down: ${rest}`);
      },
    });
  }

  handle(session: Session, message: TurnMessage): void {
    const id = session.client.id;
    switch (message.t) {
      case "wake": {
        if (!this.requireMic(session)) return;
        // A device talking nearby is the likeliest thing to have said the wake word: its own microphone
        // is told to ignore it, but the next device along hears it as clearly as it would a person.
        const talking = this.speakingNear(session);
        if (talking) {
          this.port.send(session, { t: "wake.result", wakeId: message.wakeId, granted: false });
          this.options.wakeIgnored?.(id, `Wake word on ${session.client.name} ignored: ${talking.client.name} is speaking in the same location`);
          return;
        }
        this.wake.report({ clientId: id, wakeId: message.wakeId, score: message.score, level: message.level });
        return;
      }

      case "audio.start": {
        if (!this.requireMic(session)) return;
        this.lastInput = { clientId: id, at: Date.now() };
        if (message.wakeId !== undefined && !this.wake.consume(id, message.wakeId)) {
          this.port.send(session, { t: "error", code: "busy", message: "that wake was not granted" });
          return;
        }
        // An answer to a question asked mid-turn must not cancel the turn that is waiting for it.
        if (!this.asks.has(id)) this.cancelActive(session, true);
        const bytesPerMs = (message.format.sampleRate * 2) / 1000;
        this.captures.set(id, {
          turnId: message.turnId,
          format: message.format,
          chunks: [],
          startedAt: Date.now(),
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

      case "answer": {
        const pending = this.asks.get(id);
        if (!pending || pending.askId !== message.askId || !pending.choices.includes(message.choice)) return;
        this.lastInput = { clientId: id, at: Date.now() };
        // A recording opened for the same question is no longer wanted.
        const capture = this.captures.get(id);
        if (capture) {
          this.captures.delete(id);
          this.port.send(session, { t: "turn", turnId: capture.turnId, state: "idle" });
        }
        this.endAsk(session, { answer: message.choice, how: "tap" });
        return;
      }

      case "text":
        this.lastInput = { clientId: id, at: Date.now() };
        this.captures.delete(id);
        if (this.asks.has(id)) {
          // Typed while a question is open: that is the answer, not something for the agent.
          this.endAsk(session, this.answerFrom(id, message.text, "typed"));
          this.port.send(session, { t: "turn", turnId: message.turnId, state: "idle" });
          return;
        }
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

  /** What each client is in the middle of. A client doing nothing is not listed. */
  /**
   * Another client that is speaking aloud in the same location as this one, if any.
   * Clients with no location set are never matched: nothing says they share a room.
   */
  private speakingNear(session: Session): Session | undefined {
    const place = (s: Session) => String(this.port.settings(s).location ?? "").trim().toLowerCase();
    const here = place(session);
    if (!here) return undefined;
    for (const [clientId, turn] of this.active) {
      if (clientId === session.client.id || turn.thinking || turn.done || this.captures.has(clientId)) continue;
      const other = this.port.session(clientId);
      if (other && other.client.capabilities.includes("speaker") && place(other) === here) return other;
    }
    return undefined;
  }

  now(): ClientNow[] {
    const list: ClientNow[] = [];
    for (const [clientId, ask] of this.asks) {
      list.push({ clientId, state: "asked", since: ask.since, question: ask.question, choices: ask.choices });
    }
    for (const [clientId, capture] of this.captures) {
      if (!this.asks.has(clientId)) list.push({ clientId, state: "listening", since: capture.startedAt });
    }
    for (const [clientId, turn] of this.active) {
      if (this.asks.has(clientId) || this.captures.has(clientId)) continue;
      list.push({ clientId, state: turn.thinking ? "thinking" : "speaking", since: turn.startedAt ?? Date.now() });
    }
    return list;
  }

  /**
   * True while the client is recording, speaking a reply or has been asked
   * something. A turn that is only waiting for the agent does not count: an
   * agent that asks a question in the middle of its own turn must not be told
   * the client is busy with that turn.
   */
  busy(session: Session): boolean {
    const id = session.client.id;
    const turn = this.active.get(id);
    return this.captures.has(id) || this.asks.has(id) || Boolean(turn && !turn.thinking);
  }

  /**
   * Puts a question to the person at a client and waits for the answer. The
   * question is spoken first (and shown). Then the client offers the choices
   * and listens: a choice picked on the screen, something said or something
   * typed all answer it. Resolves with `answer: null` when what was said
   * matched no choice, or nobody answered within `timeoutMs`.
   */
  async ask(session: Session, question: string, choices: string[], timeoutMs: number): Promise<AskResult> {
    const id = session.client.id;
    const caps = session.client.capabilities;
    // Somebody who cannot see the choices has to hear them.
    const spoken =
      choices.length && !caps.includes("screen") ? `${question} ${choices.join(", ")}?` : question;
    await this.say(session, spoken);
    if (this.port.session(id) !== session) throw new Error(`${session.client.name} disconnected`);
    if (this.busy(session)) throw new Error(`${session.client.name} is busy with a conversation`);

    const askId = `ask-${++this.askCount}`;
    return new Promise<AskResult>((resolve) => {
      const expire = () => {
        const pending = this.asks.get(id);
        if (!pending || pending.askId !== askId) return;
        // Somebody in the middle of answering is given the time to finish.
        if ((this.captures.has(id) || this.active.has(id)) && Date.now() < pending.hardStop) {
          pending.timer = setTimeout(expire, 1000);
          return;
        }
        this.endAsk(session, { answer: null, timedOut: true });
      };
      this.asks.set(id, {
        askId,
        question,
        since: Date.now(),
        choices,
        resolve,
        timer: setTimeout(expire, timeoutMs),
        hardStop: Date.now() + timeoutMs + 30_000,
      });
      this.port.send(session, { t: "ask", askId, question: question.slice(0, 500), choices, timeoutMs });
    });
  }

  /** Reads an answer out of what a person said or typed. */
  private answerFrom(clientId: string, said: string, how: "voice" | "typed"): AskResult {
    const choices = this.asks.get(clientId)?.choices ?? [];
    return { answer: matchChoice(said, choices) ?? null, said: said.slice(0, 2000), how };
  }

  private endAsk(session: Session, result: AskResult, tellClient = true): void {
    const id = session.client.id;
    const pending = this.asks.get(id);
    if (!pending) return;
    this.asks.delete(id);
    clearTimeout(pending.timer);
    if (tellClient) this.port.send(session, { t: "ask.end", askId: pending.askId });
    pending.resolve(result);
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
    this.endAsk(session, { answer: null }, false);
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
    const location = typeof settings.location === "string" && settings.location ? settings.location : "unknown";
    const { name, type, capabilities } = session.client;
    return `[from: ${name}, type: ${type}, location: ${location}, can: ${capabilities.join("+") || "nothing"}]`;
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
      startedAt: started,
      abort: new AbortController(),
      finished: new Promise<void>((resolve) => (finish = resolve)),
    };
    // A turn still waiting for its agent stays alive underneath this one and gets the client back afterwards.
    const outer = this.active.get(id);
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
        if (this.asks.has(id)) {
          // Said while a question is open: that is the answer, not something for the agent.
          this.endAsk(session, this.answerFrom(id, text, "voice"));
          state("idle");
          return undefined;
        }
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
        turn.thinking = true;
        source = agent.reply(`${this.header(session)}\n${text}`, signal);
      }

      const speaker =
        caps.includes("speaker") && tts ? new Speaker(this.port, session, turnId, tts.format, signal) : undefined;
      const settings = this.port.settings(session);
      const voice = typeof settings.voice === "string" && settings.voice ? settings.voice : undefined;
      const pauseMs = typeof settings.sentencePauseMs === "number" ? Math.min(1500, Math.max(0, settings.sentencePauseMs)) : 300;
      const splitter = new SentenceSplitter();
      let full = "";

      const showPiece = (piece: Piece) => {
        if (hasScreen) this.port.send(session, { t: "reply.text", turnId, text: piece.text, final: false });
      };
      // With a speaker, each sentence's text goes out as its audio starts; without, at once.
      const queue =
        speaker && tts
          ? new SpeechQueue(speaker, tts, {
              voice,
              signal,
              pauseMs,
              onPiece: showPiece,
              onFirstAudio: () => (record.firstAudioMs ??= Date.now() - started),
            })
          : undefined;
      const emit = (piece: Piece) => {
        if (queue) queue.add(piece);
        else showPiece(piece);
        if (queue?.failed) throw queue.failure;
      };

      // An agent reply that turns out to be "NO_REPLY" must not be spoken, so nothing goes out
      // while the text so far could still become one. Said words are never held back.
      const fromAgent = !("say" in input);
      const held: Piece[] = [];
      const asked = Date.now();
      for await (const delta of source) {
        if (signal.aborted) return "interrupted";
        if (fromAgent && delta) record.agentMs ??= Date.now() - asked;
        if (delta.trim() && turn.thinking) {
          turn.thinking = false;
          // The client may have been borrowed for a question meanwhile; say again whose turn it is.
          if (this.active.get(id) !== turn) {
            this.active.set(id, turn);
            state("thinking");
          }
        }
        full += delta;
        for (const piece of splitter.pushPieces(delta)) held.push(piece);
        if (fromAgent && mayBeSilent(full)) continue;
        while (held.length) emit(held.shift()!);
      }
      const rest = splitter.flushPiece();
      if (rest) held.push(rest);
      const silent = fromAgent && isSilent(full);
      if (silent) record.outcome = "silent";
      if (!silent) while (held.length) emit(held.shift()!);
      // Everything queued has been spoken (or the turn was stopped) once this returns.
      await queue?.finish();
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
      turn.done = true;
      turn.thinking = false;
      if (this.active.get(id) === turn) {
        if (outer && !outer.done && !outer.abort.signal.aborted) this.active.set(id, outer);
        else this.active.delete(id);
      }
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
