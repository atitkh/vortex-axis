import type { AudioFormat } from "@vortex-axis/protocol";

/**
 * PROTOTYPE (0.22): a second way to answer a spoken turn. Instead of Axis's own
 * chain (recognise the speech, ask the agent, synthesise the reply), the
 * person's audio goes to a realtime voice model through the OpenClaw gateway's
 * Talk relay, and the model's own voice comes back. The model answers small
 * things itself and hands real work to the agent ("agent-consult"), in the
 * same conversation.
 *
 * It is half-duplex: the device still decides when the person has stopped
 * talking and sends one utterance, as it does for the local chain. Axis
 * forwards it, adds a moment of silence so the model's own end-of-speech
 * detection fires, and plays what comes back. Talking over the answer is not
 * part of this; an interrupt stops the playback and cancels the output.
 *
 * The audio leaves the house and the model is paid for by the minute, so it is
 * off unless a device is set to it (`voiceMode: realtime`).
 */

/** The part of the gateway link this needs. */
export interface TalkSource {
  onEvent(listener: (event: string, payload: any) => void): void;
  call(method: string, params: unknown): Promise<any>;
}

export interface TalkHandlers {
  signal: AbortSignal;
  /** What the model heard the person say, once it is sure. */
  onHeard?: (text: string) => void;
  /** The words of the answer so far, whole, each time there are more. */
  onText?: (text: string) => void;
  /** The answer's voice, as it arrives. */
  onAudio?: (pcm: Buffer) => Promise<void> | void;
  /**
   * The model wants the agent to do real work: it has told the person it is checking, and waits for
   * what this resolves with to say the actual answer. Without it the model is told the agent cannot be asked.
   */
  consult?: (question: string, signal: AbortSignal) => Promise<string>;
  /** The realtime provider to ask for when a session has to be opened (the `voiceProvider` setting). */
  provider?: string | undefined;
}

export interface TalkOutcome {
  heard: string;
  said: string;
  /** False when the model made nothing of the audio: no speech in it. */
  answered: boolean;
}

export interface RealtimeTalkOptions {
  source: TalkSource;
  /** The conversation the turns belong to, as the gateway names it. */
  sessionKey?: (() => string | undefined) | undefined;
  /** The realtime provider to ask for; the gateway's own choice when unset. */
  provider?: string | undefined;
  log?: (line: string) => void;
  /** A session nobody has used for this long is closed: it costs while it is open. */
  idleMs?: number;
  /** Longest wait for the model to start answering, and for the agent to finish work handed to it. */
  firstAnswerMs?: number;
  consultMs?: number;
  /** How long after an answer ends another may still follow it and count as the same turn. */
  settleMs?: number;
}

interface Open {
  id: string;
  ready: Promise<void>;
  closeTimer?: NodeJS.Timeout | undefined;
  /** Told each of this session's events while a turn is in hand. */
  listener?: ((event: any) => void) | undefined;
}

/** What the relay speaks and hears. */
export const TALK_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 };

/** Changes the sample rate of 16-bit mono sound by drawing straight lines between samples. Plenty for speech. */
export function resample(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to) return pcm;
  const input = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const length = Math.floor((input.length * to) / from);
  const output = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const at = (i * from) / to;
    const left = Math.floor(at), right = Math.min(input.length - 1, left + 1);
    output[i] = Math.round(input[left]! + (input[right]! - input[left]!) * (at - left));
  }
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
}

export class RealtimeTalk {
  readonly format = TALK_FORMAT;
  private readonly open = new Map<string, Open>();

  constructor(private readonly options: RealtimeTalkOptions) {
    options.source.onEvent((event, payload) => {
      if (event !== "talk.event") return;
      // PROTOTYPE: every event but the sound itself is logged, to learn what the relay says.
      if (payload?.type !== "audio" && payload?.type !== "mark") options.log?.(`realtime voice event: ${JSON.stringify({ ...payload, talkEvent: payload?.talkEvent?.type }).slice(0, 400)}`);
      if (typeof payload?.relaySessionId !== "string") return;
      for (const session of this.open.values()) if (session.id === payload.relaySessionId) session.listener?.(payload);
    });
  }

  stop(): void {
    for (const [clientId] of this.open) this.close(clientId);
  }

  /** Ends a client's session, if it has one. The next turn starts a new one. */
  close(clientId: string): void {
    const session = this.open.get(clientId);
    if (!session) return;
    this.open.delete(clientId);
    clearTimeout(session.closeTimer);
    this.options.source.call("talk.session.close", { sessionId: session.id }).catch(() => undefined);
  }

  private async session(clientId: string, wanted?: string): Promise<Open> {
    const existing = this.open.get(clientId);
    if (existing) return existing;
    // "openai" names a provider; "openai/gpt-realtime-2.1-mini" a model of it as well.
    const [provider, model] = (wanted || this.options.provider || "").split("/", 2);
    const sessionKey = this.options.sessionKey?.();
    const created = await this.options.source.call("talk.session.create", {
      ...(sessionKey ? { sessionKey } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      silenceDurationMs: 500,
    });
    const id = String(created?.relaySessionId ?? created?.sessionId ?? "");
    if (!id) throw new Error("the gateway did not start a realtime voice session");
    const rate = Number(created?.audio?.inputSampleRateHz);
    if (created?.audio && (created.audio.inputEncoding !== "pcm16" || rate !== TALK_FORMAT.sampleRate)) {
      throw new Error(`the realtime voice session wants sound Axis does not send (${created.audio.inputEncoding} at ${rate} Hz)`);
    }
    let isReady!: () => void, isNot!: (error: Error) => void;
    const session: Open = { id, ready: new Promise<void>((resolve, reject) => ((isReady = resolve), (isNot = reject))) };
    // The provider says when it is listening, or that it cannot be reached; a relay that says neither is tried anyway after a moment.
    session.listener = (event) => {
      if (event.type === "ready") isReady();
      else if (event.type === "error" || event.type === "close") {
        if (this.open.get(clientId) === session) this.open.delete(clientId);
        isNot(new Error(`the realtime voice of ${created?.provider ?? "the gateway"} could not be reached${event.code ? ` (${event.code})` : ""}`));
      }
    };
    session.ready.catch(() => undefined);
    setTimeout(isReady, 4000).unref();
    this.open.set(clientId, session);
    this.options.log?.(`realtime voice: session ${id.slice(0, 8)} opened for ${clientId} (${created?.provider ?? "provider unknown"}${created?.model ? `, ${created.model}` : ""})`);
    return session;
  }

  /**
   * Sends one utterance and plays back the answer through the handlers. Resolves when the model
   * has finished answering, including an answer that had to wait for the agent.
   */
  async converse(clientId: string, pcm: Buffer, format: AudioFormat, handlers: TalkHandlers): Promise<TalkOutcome> {
    const { source } = this.options;
    const session = await this.session(clientId, handlers.provider);
    clearTimeout(session.closeTimer);
    await session.ready;
    const outcome: TalkOutcome = { heard: "", said: "", answered: false };
    const settleMs = this.options.settleMs ?? 1500;

    let resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => ((resolve = yes), (reject = no)));
    let timer: NodeJS.Timeout | undefined;
    const wait = (ms: number, then: () => void) => {
      clearTimeout(timer);
      timer = setTimeout(then, ms);
    };
    // Answers under way; work the agent is doing for the model; and whether an answer is still owed for work handed back.
    let answering = 0, consulting = 0, owed = false, finished = false;
    let audio: Promise<void> = Promise.resolve();
    const said: string[] = [];
    let partial = "";
    const settle = () => {
      if (answering > 0) return;
      if (consulting > 0) return wait(this.options.consultMs ?? 120_000, () => reject(new Error("the agent did not come back with an answer in time")));
      // The agent's answer has gone back to the model, which has yet to say it.
      if (owed) return wait(20_000, resolve);
      // Another answer may follow at once, as when the model says it will look and then does.
      if (finished) wait(settleMs, resolve);
    };

    session.listener = (event) => {
      switch (event.type) {
        case "responseStarted":
          answering++;
          if (!consulting) owed = false;
          clearTimeout(timer);
          break;
        case "audio":
          if (typeof event.audioBase64 === "string") {
            // Sound with no word of an answer starting is an answer all the same.
            if (!answering) answering = 1;
            owed = false;
            clearTimeout(timer);
            outcome.answered = true;
            const chunk = Buffer.from(event.audioBase64, "base64");
            audio = audio.then(() => (handlers.signal.aborted ? undefined : handlers.onAudio?.(chunk))).catch(() => undefined);
          }
          break;
        case "mark":
          // The provider wants to know its sound has been played. Nothing here listens while it plays, so say so at once.
          if (typeof event.markName === "string") source.call("talk.session.acknowledgeMark", { sessionId: session.id, markName: event.markName }).catch(() => undefined);
          break;
        case "transcript":
          if (event.role === "user") {
            if (event.final && typeof event.text === "string" && event.text.trim()) {
              outcome.heard = `${outcome.heard} ${event.text.trim()}`.trim();
              handlers.onHeard?.(outcome.heard);
            }
          } else if (typeof event.text === "string") {
            if (event.final) {
              said.push(event.text.trim());
              partial = "";
            } else partial = event.text;
            outcome.said = [...said, partial].filter(Boolean).join(" ").trim();
            if (outcome.said) outcome.answered = true;
            handlers.onText?.(outcome.said);
          }
          break;
        case "toolCall": {
          // The gateway has already told the model to say it is checking. The work itself is Axis's to get done.
          const callId = String(event.callId ?? "");
          const submit = (result: unknown) => source.call("talk.session.submitToolResult", { sessionId: session.id, callId, result }).catch(() => undefined);
          if (event.name !== "openclaw_agent_consult" || !handlers.consult) {
            void submit({ error: event.name === "openclaw_agent_consult" ? "The agent cannot be asked from here." : `Tool "${event.name}" is not available on this device.` });
            break;
          }
          const args = typeof event.args === "object" && event.args !== null ? (event.args as Record<string, unknown>) : {};
          const question = [args.question, typeof args.context === "string" && args.context ? `Context:\n${args.context}` : undefined]
            .filter((part): part is string => typeof part === "string" && part.trim() !== "")
            .join("\n\n");
          consulting++;
          clearTimeout(timer);
          void handlers
            .consult(question, handlers.signal)
            .then((answer) => submit(handlers.signal.aborted ? { status: "cancelled" } : { result: answer.trim() || "Done, with nothing to report." }))
            .catch((error: Error) => submit({ error: error.message }))
            .finally(() => {
              consulting--;
              owed = true;
              settle();
            });
          break;
        }
        case "audioDone":
          answering = Math.max(0, answering - 1);
          finished = true;
          settle();
          break;
        case "error":
          reject(new Error(String(event.message ?? event.error?.message ?? "the realtime voice session failed")));
          break;
        case "close":
          reject(new Error("the realtime voice session ended"));
          break;
      }
    };

    const onAbort = () => {
      source.call("talk.session.cancelOutput", { sessionId: session.id, reason: "interrupted" }).catch(() => undefined);
      resolve();
    };
    handlers.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // The utterance, then quiet enough for the model's own ear to decide the person has finished. Seen on
      // the real gateway with Google's provider: 0.9 s is answered every time, 0.7 s never.
      const sound = Buffer.concat([resample(pcm, format.sampleRate, TALK_FORMAT.sampleRate), Buffer.alloc((TALK_FORMAT.sampleRate * 2 * 900) / 1000)]);
      const step = (TALK_FORMAT.sampleRate * 2 * 200) / 1000;
      for (let at = 0; at < sound.length && !handlers.signal.aborted; at += step) {
        await source.call("talk.session.appendAudio", { sessionId: session.id, audioBase64: sound.subarray(at, at + step).toString("base64") });
      }
      // No answer at all means there was no speech in it for the model.
      if (!answering && !finished) wait(this.options.firstAnswerMs ?? 12_000, resolve);
      await done;
      await audio;
      return outcome;
    } catch (error) {
      // A session that failed is not worth keeping: the next turn starts afresh.
      this.close(clientId);
      throw error;
    } finally {
      clearTimeout(timer);
      handlers.signal.removeEventListener("abort", onAbort);
      session.listener = undefined;
      if (this.open.get(clientId) === session) {
        session.closeTimer = setTimeout(() => this.close(clientId), this.options.idleMs ?? 180_000);
        session.closeTimer.unref();
      }
    }
  }
}
