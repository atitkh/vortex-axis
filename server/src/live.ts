import type { TurnRecord, WakeRecord } from "./store.js";

/**
 * What is happening right now, for the admin page's Live view: each turn as it
 * moves from listening to recognition to the agent to speech, and each wake
 * word a device reports.
 *
 * Everything here is held in memory and gone on a restart. The words of a turn
 * are shown while it is fresh and dropped after a few minutes; only the
 * timings stay, as in the activity log. Nothing said is written to disk.
 */

export type LiveStage = "listening" | "transcribing" | "thinking" | "speaking";

export interface LiveTurn {
  key: string;
  clientId: string;
  client: string;
  kind: TurnRecord["kind"];
  startedAt: number;
  /** Each stage the turn reached and when. */
  stages: { name: LiveStage; at: number }[];
  /** What the person said or typed. */
  heard?: string;
  /** What was said back, so far. */
  said?: string;
  endedAt?: number;
  /** Set when the turn is over. "cancelled" is a recording that never became a turn. */
  outcome?: TurnRecord["outcome"] | "cancelled";
  error?: string;
  /** The client confirmed it played the reply to the end. */
  played?: boolean;
  speechMs?: number;
  sttMs?: number;
  agentMs?: number;
  firstAudioMs?: number;
  totalMs?: number;
}

export type LiveEvent = { type: "turn"; turn: LiveTurn } | { type: "wake"; wake: WakeRecord & { client: string } };

/** How many finished turns are kept to look back at. */
const KEEP_TURNS = 30;
/** How long a finished turn's words stay readable. */
const WORDS_MS = 10 * 60_000;
/** A turn open this long was lost track of. */
const STALE_MS = 10 * 60_000;
const MAX_WORDS = 4000;

export class Live {
  private readonly turns: LiveTurn[] = [];
  private readonly open = new Map<string, LiveTurn>();
  private readonly listeners = new Set<(event: LiveEvent) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Calls `listener` with everything that happens from now on. Returns how to stop. */
  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Recent turns, newest first. Words of turns that ended a while ago are left out. */
  snapshot(): LiveTurn[] {
    const cutoff = this.now() - WORDS_MS;
    return this.turns
      .map((turn) => {
        if (turn.endedAt === undefined || turn.endedAt > cutoff) return turn;
        const { heard: _heard, said: _said, ...rest } = turn;
        return rest;
      })
      .reverse();
  }

  /** A turn reached a stage. The first stage of a turn is what makes it appear. */
  stage(client: { id: string; name: string }, turnId: string, kind: TurnRecord["kind"], name: LiveStage): void {
    const key = `${client.id}/${turnId}`;
    let turn = this.open.get(key);
    if (!turn) {
      this.sweep(client.id);
      turn = { key: `${key}/${this.now()}`, clientId: client.id, client: client.name, kind, startedAt: this.now(), stages: [] };
      this.open.set(key, turn);
      this.turns.push(turn);
      // Finished turns beyond the last few are forgotten; one still running is never dropped.
      while (this.turns.length > KEEP_TURNS) {
        const oldest = this.turns.findIndex((t) => t.endedAt !== undefined);
        if (oldest < 0) break;
        this.turns.splice(oldest, 1);
      }
    }
    turn.kind = kind;
    if (turn.stages.at(-1)?.name === name) return;
    turn.stages.push({ name, at: this.now() });
    this.publish({ type: "turn", turn });
  }

  /** The words of a turn as they become known. `said` is added to what was said so far. */
  words(clientId: string, turnId: string, words: { heard?: string; said?: string }): void {
    const turn = this.open.get(`${clientId}/${turnId}`);
    if (!turn) return;
    if (words.heard !== undefined) turn.heard = words.heard.slice(0, MAX_WORDS);
    // Pieces come a sentence at a time, without the space that was between them.
    if (words.said) turn.said = `${turn.said && !/\s$/.test(turn.said) ? `${turn.said} ` : turn.said ?? ""}${words.said}`.slice(0, MAX_WORDS);
    this.publish({ type: "turn", turn });
  }

  /** A turn is over. Given its record when it ran, or nothing when the recording was dropped before it became one. */
  end(clientId: string, turnId: string, record?: TurnRecord): void {
    const key = `${clientId}/${turnId}`;
    const turn = this.open.get(key);
    if (!turn) return;
    this.open.delete(key);
    turn.endedAt = this.now();
    turn.outcome = record?.outcome ?? "cancelled";
    if (record) {
      turn.played = record.heard;
      turn.totalMs = record.totalMs;
      if (record.error) turn.error = record.error;
      if (record.speechMs !== undefined) turn.speechMs = record.speechMs;
      if (record.sttMs !== undefined) turn.sttMs = record.sttMs;
      if (record.agentMs !== undefined) turn.agentMs = record.agentMs;
      if (record.firstAudioMs !== undefined) turn.firstAudioMs = record.firstAudioMs;
    }
    this.publish({ type: "turn", turn });
  }

  /** A device reported its wake word, and what came of it. */
  wake(wake: WakeRecord, client: string): void {
    this.publish({ type: "wake", wake: { ...wake, client } });
  }

  /**
   * Closes what a client left open: a recording that was replaced by a new one
   * without ever becoming a turn, and anything open for far too long.
   */
  private sweep(clientId: string): void {
    for (const [key, turn] of this.open) {
      const onlyListening = turn.clientId === clientId && turn.stages.every((s) => s.name === "listening");
      if (!onlyListening && this.now() - turn.startedAt < STALE_MS) continue;
      this.open.delete(key);
      turn.endedAt = this.now();
      turn.outcome = "cancelled";
      this.publish({ type: "turn", turn });
    }
  }

  private publish(event: LiveEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Somebody watching must never be able to break a turn.
      }
    }
  }
}
