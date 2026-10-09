import type { EventRecord, Store, TurnRecord } from "./store.js";

/**
 * Records what happens around Axis (turns, connections, service health, admin changes) and
 * sums it up for the admin page: uptime timelines, response times, recent events.
 *
 * Only timings and outcomes are kept, never audio or what anybody said, and nothing is kept
 * longer than the retention period. Axis stays a bridge: this measures what passes through.
 */

export interface ActivityOptions {
  /** How long turns and events are kept. */
  retentionMs: number;
  /** How often Axis notes that it is still running, so a crash shows when it stopped. */
  aliveEveryMs?: number;
  now?: () => number;
}

/** Things with an up/down timeline, in the order the page shows them. */
export const SERVICES: { key: string; label: string }[] = [
  { key: "openclaw", label: "Agent" },
  { key: "stt", label: "Speech recognition" },
  { key: "tts", label: "Speech synthesis" },
  { key: "operator", label: "Gateway turn link" },
  { key: "node", label: "Gateway command link" },
];

/** States that count as working, for availability. */
const GOOD = new Set(["up", "online", "connected"]);

export interface Segment {
  from: number;
  to: number;
  state: string;
}

export interface Timeline {
  segments: Segment[];
  /** Share of the known time spent working, 0 to 1. Null when nothing is known yet. */
  availability: number | null;
}

const MAX_HOURS = 24 * 31;

export class Activity {
  private readonly now: () => number;
  /** The last state recorded per subject, so only changes are written. */
  private readonly last = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private ticks = 0;
  private stopped = false;

  constructor(private readonly store: Store, private readonly options: ActivityOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Notes that Axis started, and when it stopped last time if it did not stop cleanly. */
  start(): void {
    const aliveAt = Number(this.store.getMeta("alive_at") ?? 0);
    if (aliveAt) {
      this.write(() => this.store.addEvent({ at: aliveAt, kind: "axis", subject: "", state: "down", level: "bad", text: "Axis stopped without shutting down" }));
    }
    this.state("axis", "", "up", "Axis started", "info");
    this.prune();
    this.alive();
    const every = this.options.aliveEveryMs ?? 60_000;
    this.timer = setInterval(() => {
      this.alive();
      // Pruning once an hour is plenty.
      if (++this.ticks % Math.max(1, Math.round(3_600_000 / every)) === 0) this.prune();
    }, every);
    this.timer.unref();
  }

  /** Changes how long history is kept. What is now too old goes at once. */
  setRetention(retentionMs: number): void {
    this.options.retentionMs = retentionMs;
    this.prune();
  }

  /** Notes a clean shutdown. Nothing is recorded after this. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.write(() => {
      this.store.addEvent({ at: this.now(), kind: "axis", subject: "", state: "down", level: "warn", text: "Axis stopped" });
      this.store.setMeta("alive_at", undefined);
    });
    this.stopped = true;
  }

  /** Every write goes through here: a lost row of history must never break a turn or a connection. */
  private write(fn: () => void): void {
    if (this.stopped) return;
    try {
      fn();
    } catch {
      // The log is a convenience; the hub carries on without it.
    }
  }

  /** Records a finished turn. A failure also goes in the event list, where problems are read. */
  turn(record: TurnRecord, clientName: string): void {
    this.write(() => this.store.addTurn(record));
    if (record.outcome === "failed") {
      this.note("turn", record.clientId, `Turn on ${clientName} failed: ${record.error ?? "unknown error"}`, "bad");
    }
  }

  /** Records a state change of something with a timeline. Repeats of the same state are ignored. */
  state(kind: string, subject: string, state: string, text: string, level: EventRecord["level"] = "info"): void {
    const key = `${kind}:${subject}`;
    if (this.last.get(key) === state) return;
    this.last.set(key, state);
    this.write(() => this.store.addEvent({ at: this.now(), kind, subject, state, level, text: text.slice(0, 300) }));
  }

  /** Records something that happened, without a state. */
  note(kind: string, subject: string, text: string, level: EventRecord["level"] = "info"): void {
    this.write(() => this.store.addEvent({ at: this.now(), kind, subject, level, text: text.slice(0, 300) }));
  }

  private alive(): void {
    this.write(() => this.store.setMeta("alive_at", String(this.now())));
  }

  private prune(): void {
    this.write(() => this.store.pruneActivity(this.now() - this.options.retentionMs));
  }

  /** Everything the admin page draws for the last `hours`, optionally for one client only. */
  summary(hours: number, clientId?: string) {
    const to = this.now();
    const span = Math.min(Math.max(1, hours), MAX_HOURS, this.options.retentionMs / 3_600_000) * 3_600_000;
    const from = to - span;
    const events = this.store.eventsBetween(from, to);
    const turns = this.store.turnsBetween(from, to, clientId);
    const clients = this.store.listClients().filter((c) => !clientId || c.id === clientId);
    const names = new Map(this.store.listClients().map((c) => [c.id, c.name]));

    const axisBefore = this.store.statesBefore("axis", from).get("");
    const timeline = (kind: string, subject: string, reset: string): Timeline => {
      const ownBefore = this.store.statesBefore(kind, from).get(subject);
      // Where the timeline starts: the subject's own last state, unless Axis restarted since.
      let state =
        kind === "axis" ? axisBefore?.state ?? "unknown"
        : axisBefore && (!ownBefore || axisBefore.at >= ownBefore.at) ? (axisBefore.state === "down" ? "axis_down" : reset)
        : ownBefore?.state ?? "unknown";
      const segments: Segment[] = [];
      let at = from;
      const move = (when: number, next: string) => {
        if (next === state) return;
        if (when > at) segments.push({ from: at, to: when, state });
        at = Math.max(at, when);
        state = next;
      };
      for (const e of events) {
        if (!e.state) continue;
        if (e.kind === kind && e.subject === subject) move(e.at, e.state);
        else if (kind !== "axis" && e.kind === "axis") move(e.at, e.state === "down" ? "axis_down" : reset);
      }
      if (to > at) segments.push({ from: at, to, state });
      return { segments: merge(segments), availability: availability(segments) };
    };

    const byClient = new Map<string, TurnRecord[]>();
    for (const t of turns) byClient.set(t.clientId, [...(byClient.get(t.clientId) ?? []), t]);
    const bucketMs = span <= 24 * 3_600_000 ? 3_600_000 : span <= 72 * 3_600_000 ? 3 * 3_600_000 : 6 * 3_600_000;
    const recentEvents = (clientId ? events.filter((e) => e.subject === clientId) : events).slice(-150).reverse();

    return {
      from,
      to,
      bucketMs,
      axis: timeline("axis", "", "up"),
      services: clientId ? [] : SERVICES.map((s) => ({ ...s, ...timeline("service", s.key, "unknown") })),
      clients: clients.map((c) => {
        const own = byClient.get(c.id) ?? [];
        return {
          id: c.id,
          name: c.name,
          ...timeline("client", c.id, "offline"),
          connects: events.filter((e) => e.kind === "client" && e.subject === c.id && e.state === "online").length,
          turns: own.length,
          firstAudioP50: percentile(own.map((t) => t.firstAudioMs), 50),
        };
      }),
      turns: turnStats(turns, from, to, bucketMs),
      recentTurns: turns.slice(-60).reverse().map((t) => ({ ...t, clientName: names.get(t.clientId) ?? "removed client" })),
      events: recentEvents,
    };
  }
}

function turnStats(turns: TurnRecord[], from: number, to: number, bucketMs: number) {
  const count = (outcome: TurnRecord["outcome"]) => turns.filter((t) => t.outcome === outcome).length;
  // Synthesis is what is left of the wait for first sound once recognition and the agent are taken out.
  const synth = turns.map((t) => (t.firstAudioMs !== undefined && t.agentMs !== undefined ? t.firstAudioMs - (t.sttMs ?? 0) - t.agentMs : undefined));
  const buckets = [];
  for (let start = to - Math.ceil((to - from) / bucketMs) * bucketMs; start < to; start += bucketMs) {
    const inside = turns.filter((t) => t.at >= start && t.at < start + bucketMs);
    buckets.push({
      at: start,
      count: inside.length,
      failed: inside.filter((t) => t.outcome === "failed").length,
      firstAudioP50: percentile(inside.map((t) => t.firstAudioMs), 50),
      firstAudioP95: percentile(inside.map((t) => t.firstAudioMs), 95),
    });
  }
  return {
    count: turns.length,
    answered: count("answered"),
    silent: count("silent"),
    noSpeech: count("no_speech"),
    interrupted: count("interrupted"),
    failed: count("failed"),
    heard: turns.filter((t) => t.heard).length,
    firstAudioP50: percentile(turns.map((t) => t.firstAudioMs), 50),
    firstAudioP95: percentile(turns.map((t) => t.firstAudioMs), 95),
    sttP50: percentile(turns.map((t) => t.sttMs), 50),
    agentP50: percentile(turns.map((t) => t.agentMs), 50),
    synthesisP50: percentile(synth, 50),
    buckets,
  };
}

/** The p-th percentile of the values that exist, or null when none do. */
export function percentile(values: (number | undefined)[], p: number): number | null {
  const known = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (!known.length) return null;
  const index = Math.min(known.length - 1, Math.max(0, Math.ceil((p / 100) * known.length) - 1));
  return known[index]!;
}

function merge(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.state === s.state && prev.to === s.from) prev.to = s.to;
    else out.push({ ...s });
  }
  return out;
}

/** Working time over known time. Time while Axis itself was down counts as not working. */
function availability(segments: Segment[]): number | null {
  let good = 0;
  let known = 0;
  for (const s of segments) {
    if (s.state === "unknown") continue;
    const length = s.to - s.from;
    known += length;
    if (GOOD.has(s.state)) good += length;
  }
  return known > 0 ? good / known : null;
}
