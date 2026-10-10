import type { AudioFormat } from "@vortex-axis/protocol";
import type { AgentRoute } from "./agent.js";
import { pcmToWav } from "./speech.js";
import type { Store, VoiceRecord } from "./store.js";

/**
 * Telling voices apart, roughly.
 *
 * A voiceprint service turns a recording into a list of numbers that comes out
 * close for two recordings of one voice and far for two different voices. Axis
 * keeps the voiceprints of the voices it was taught (never the recordings) and
 * compares what a device heard against them: a known voice, a guest, or unsure
 * when the score falls between the two cut-offs. Short commands from across a
 * room are the hard case, which is why "unsure" exists and has a rule of its own.
 *
 * It is not a lock: a recording of the owner passes. It decides what context a
 * voice gets, never who may approve something.
 */

export interface VoiceprintSettings {
  /** Voices are told apart only when this is on. */
  enabled: boolean;
  /** From this score up, the voice is the known one it matched. */
  knownAt: number;
  /** Below this score, a guest. Between the two: unsure. */
  guestBelow: number;
  /** What an unsure voice is taken for. */
  unsure: "known" | "guest";
  /**
   * What a guest's turn does. `label`: nothing changes but the label the agent sees;
   * `guest`: the same agent, in a conversation of its own, with the guest note;
   * `agent`: another agent (`guestAgent`), in a conversation of its own, with the note;
   * `decline`: no agent is asked and the device says `declineText`.
   */
  guests: "label" | "guest" | "agent" | "decline";
  guestAgent: string;
  /** Added to what the agent is told on a guest's turn. Empty: the built-in note. */
  guestNote: string;
  declineText: string;
}

export const DEFAULT_GUEST_NOTE = [
  "The voice on this turn was not recognised as the owner's, so treat the speaker as a guest in the home.",
  "Help with general questions and with shared household things such as lights, music and timers.",
  "Do not read out or act on the owner's personal information: their calendar, messages, email, contacts, notes, memory, files, location or accounts. If asked, say kindly that you can only do that for the owner.",
].join(" ");

export const DEFAULT_SETTINGS: VoiceprintSettings = {
  enabled: false,
  knownAt: 0.6,
  guestBelow: 0.4,
  unsure: "known",
  guests: "label",
  guestAgent: "",
  guestNote: "",
  declineText: "Sorry, I don't recognise your voice.",
};

const META_KEY = "voiceprint_settings";

/** Whose voice a turn was in. */
export interface Identity {
  /** known: one of the voices taught; guest: none of them; unsure: in between, or it could not be told. */
  verdict: "known" | "guest" | "unsure";
  /** The closest voice, when there is one. */
  name?: string | undefined;
  /** Its score, -1 to 1. */
  score?: number | undefined;
  /** Why it could not be told, when it could not. */
  error?: string | undefined;
  /** No voice has been taught yet, so there was nothing to compare with. */
  untaught?: boolean | undefined;
  ms: number;
  /** What the person is taken for, after the rule for unsure voices. */
  as: "known" | "guest";
}

/** The voiceprint service's client. */
export interface VoiceprintService {
  embed(pcm: Buffer, format: AudioFormat, signal?: AbortSignal): Promise<{ embedding: Float32Array; seconds: number }>;
  healthy(): Promise<boolean>;
}

export class HttpVoiceprintService implements VoiceprintService {
  constructor(private readonly url: string) {}

  async embed(pcm: Buffer, format: AudioFormat, signal?: AbortSignal): Promise<{ embedding: Float32Array; seconds: number }> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(pcmToWav(pcm, format)),
      signal: signal ?? AbortSignal.timeout(5000),
    });
    const body = (await res.json().catch(() => ({}))) as { embedding?: unknown; seconds?: unknown; error?: unknown };
    if (!res.ok || !Array.isArray(body.embedding)) {
      throw new Error(typeof body.error === "string" ? body.error : `the voiceprint service answered HTTP ${res.status}`);
    }
    return { embedding: Float32Array.from(body.embedding as number[]), seconds: typeof body.seconds === "number" ? body.seconds : 0 };
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(new URL("/health", this.url), { signal: AbortSignal.timeout(3000) });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  }
}

function unit(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const length = Math.sqrt(sum) || 1;
  return v.map((x) => x / length);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** A turn's voiceprint, kept a little while so an admin can say whose voice it was. */
interface Heard {
  turnId: string;
  clientId: string;
  at: number;
  embedding: Float32Array;
  seconds: number;
  identity: Identity;
}

export interface VoiceprintsOptions {
  store: Store;
  /** The service, or undefined when none is set up. Read on every use, so a change applies at once. */
  service: () => VoiceprintService | undefined;
  /** The usual conversation's key, which a guest's own is named after. */
  sessionKey: string;
  now?: () => number;
  /** How long a turn's voiceprint is kept for teaching. */
  keepMs?: number;
}

export class Voiceprints {
  private profiles: { name: string; embedding: Float32Array }[] | undefined;
  private readonly heard: Heard[] = [];
  private readonly now: () => number;
  private readonly keepMs: number;

  constructor(private readonly options: VoiceprintsOptions) {
    this.now = options.now ?? Date.now;
    this.keepMs = options.keepMs ?? 10 * 60_000;
  }

  settings(): VoiceprintSettings {
    const saved = this.options.store.getMeta(META_KEY);
    return { ...DEFAULT_SETTINGS, ...(saved ? (JSON.parse(saved) as Partial<VoiceprintSettings>) : {}) };
  }

  saveSettings(patch: unknown): VoiceprintSettings {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("body must be an object");
    const p = patch as Partial<Record<keyof VoiceprintSettings, unknown>>;
    const next = { ...this.settings() };
    for (const [key, value] of Object.entries(p)) {
      switch (key) {
        case "enabled":
          if (typeof value !== "boolean") throw new Error("enabled must be true or false");
          next.enabled = value;
          break;
        case "knownAt":
        case "guestBelow":
          if (typeof value !== "number" || !(value >= 0 && value <= 1)) throw new Error(`${key} must be a number from 0 to 1`);
          next[key] = Math.round(value * 100) / 100;
          break;
        case "unsure":
          if (value !== "known" && value !== "guest") throw new Error('unsure must be "known" or "guest"');
          next.unsure = value;
          break;
        case "guests":
          if (value !== "label" && value !== "guest" && value !== "agent" && value !== "decline") throw new Error('guests must be "label", "guest", "agent" or "decline"');
          next.guests = value;
          break;
        case "guestAgent":
          if (typeof value !== "string" || value.length > 64) throw new Error("guestAgent must be an agent's name");
          next.guestAgent = value.trim();
          break;
        case "guestNote":
          if (typeof value !== "string" || value.length > 4000) throw new Error("guestNote must be text of at most 4000 characters");
          next.guestNote = value;
          break;
        case "declineText":
          if (typeof value !== "string" || value.length > 300) throw new Error("declineText must be text of at most 300 characters");
          next.declineText = value.trim() || DEFAULT_SETTINGS.declineText;
          break;
        default:
          throw new Error(`unknown setting "${key}"`);
      }
    }
    if (next.guestBelow > next.knownAt) throw new Error("the guest cut-off cannot be above the known one");
    if (next.guests === "agent" && !next.guestAgent) throw new Error("choose the agent that answers guests");
    this.options.store.setMeta(META_KEY, JSON.stringify(next));
    return next;
  }

  /**
   * Whether turns should be checked: switched on and a service set up. Turns are checked
   * before any voice is taught too, so that one of them can be what teaches it.
   */
  active(): boolean {
    return this.settings().enabled && Boolean(this.options.service());
  }

  voices(): VoiceRecord[] {
    return this.options.store.listVoices();
  }

  addVoice(name: string): VoiceRecord {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error("a voice needs a name");
    const voice = this.options.store.addVoice(clean);
    if (!voice) throw new Error(`there is already a voice called ${clean}`);
    return voice;
  }

  removeVoice(id: number): boolean {
    this.profiles = undefined;
    return this.options.store.removeVoice(id);
  }

  removeSample(id: number): boolean {
    this.profiles = undefined;
    return this.options.store.removeVoiceSample(id);
  }

  samples(voiceId: number) {
    return this.options.store.voiceSamples(voiceId).map(({ embedding: _, ...rest }) => rest);
  }

  /** Teaches a voice from a recording made on the admin page. */
  async teach(voiceId: number, pcm: Buffer, format: AudioFormat): Promise<{ sampleId: number; seconds: number }> {
    const service = this.options.service();
    if (!service) throw new Error("no voiceprint service is set up");
    const { embedding, seconds } = await service.embed(pcm, format, AbortSignal.timeout(20_000));
    const sampleId = this.options.store.addVoiceSample(voiceId, embedding, seconds, "recorded");
    if (sampleId === undefined) throw new Error("no such voice");
    this.profiles = undefined;
    return { sampleId, seconds };
  }

  /** Teaches a voice from a turn a device heard in the last few minutes. */
  teachFromTurn(voiceId: number, turnId: string): { sampleId: number; seconds: number } {
    this.prune();
    const heard = this.heard.find((h) => h.turnId === turnId);
    if (!heard) throw new Error("that turn is no longer held; voiceprints of turns are kept for ten minutes");
    const sampleId = this.options.store.addVoiceSample(voiceId, heard.embedding, heard.seconds, "turn");
    if (sampleId === undefined) throw new Error("no such voice");
    this.profiles = undefined;
    return { sampleId, seconds: heard.seconds };
  }

  /** Turns heard lately, newest first, with whose voice each was taken for. */
  recent(): { turnId: string; clientId: string; at: number; seconds: number; identity: Identity }[] {
    this.prune();
    return this.heard.map(({ embedding: _, ...rest }) => rest).reverse();
  }

  /** Compares a recording with every voice taught, without keeping anything. */
  async check(pcm: Buffer, format: AudioFormat): Promise<{ identity: Identity; scores: { name: string; score: number }[] }> {
    const service = this.options.service();
    if (!service) throw new Error("no voiceprint service is set up");
    const { embedding } = await service.embed(pcm, format, AbortSignal.timeout(20_000));
    const scores = this.profileList().map((p) => ({ name: p.name, score: Math.round(cosine(p.embedding, embedding) * 100) / 100 }));
    scores.sort((a, b) => b.score - a.score);
    return { identity: this.judge(scores[0], 0), scores };
  }

  /**
   * Whose voice is in what a device heard. Never throws: a service that is down or a
   * recording too short to tell gives "unsure", which the unsure rule then decides.
   */
  async identify(pcm: Buffer, format: AudioFormat, turn: { turnId: string; clientId: string }, signal?: AbortSignal): Promise<Identity> {
    const started = this.now();
    const service = this.options.service();
    if (!service) return this.unsure("no voiceprint service is set up", started);
    try {
      const { embedding, seconds } = await service.embed(pcm, format, signal ?? AbortSignal.timeout(3000));
      let best: { name: string; score: number } | undefined;
      for (const p of this.profileList()) {
        const score = cosine(p.embedding, embedding);
        if (!best || score > best.score) best = { name: p.name, score: Math.round(score * 100) / 100 };
      }
      const identity = this.judge(best, this.now() - started);
      this.heard.push({ ...turn, at: this.now(), embedding, seconds, identity });
      this.prune();
      return identity;
    } catch (error) {
      return this.unsure((error as Error).message, started);
    }
  }

  /** Where a guest's turn goes, by the settings. No route: the usual place. `decline`: nowhere, say this instead. */
  routeFor(identity: Identity | undefined): { route?: AgentRoute; decline?: string } {
    if (!identity || identity.as !== "guest") return {};
    const s = this.settings();
    const note = s.guestNote.trim() || DEFAULT_GUEST_NOTE;
    switch (s.guests) {
      case "decline":
        return { decline: s.declineText };
      case "guest":
        return { route: { sessionKey: `${this.options.sessionKey}-guest`, note } };
      case "agent":
        return { route: { agentId: s.guestAgent || undefined, sessionKey: `${this.options.sessionKey}-guest`, note } };
      default:
        return {};
    }
  }

  /** The words added to the device line the agent sees: whose voice, roughly. */
  static label(identity: Identity | undefined): string | undefined {
    if (!identity || identity.untaught) return undefined;
    if (identity.verdict === "known") return `voice: ${identity.name}`;
    if (identity.verdict === "guest") return "voice: guest";
    return `voice: unsure${identity.as === "guest" ? ", taken for a guest" : identity.name ? `, maybe ${identity.name}` : ""}`;
  }

  private judge(best: { name: string; score: number } | undefined, ms: number): Identity {
    const s = this.settings();
    // With nothing taught there is nobody to be a guest of: the turn goes on as it always did.
    if (!best) return { verdict: "unsure", error: "no voice has been taught yet", untaught: true, ms, as: "known" };
    const verdict = best.score >= s.knownAt ? "known" : best.score < s.guestBelow ? "guest" : "unsure";
    return { verdict, name: best.name, score: best.score, ms, as: verdict === "unsure" ? s.unsure : verdict };
  }

  private unsure(error: string, started: number): Identity {
    const untaught = this.profileList().length === 0;
    return { verdict: "unsure", error, ms: this.now() - started, as: untaught ? "known" : this.settings().unsure, ...(untaught ? { untaught } : {}) };
  }

  /** Each voice's voiceprint: the average direction of its recordings'. */
  private profileList(): { name: string; embedding: Float32Array }[] {
    if (this.profiles) return this.profiles;
    const byVoice = new Map<number, Float32Array[]>();
    for (const s of this.options.store.voiceSamples()) {
      const list = byVoice.get(s.voiceId) ?? [];
      list.push(unit(s.embedding));
      byVoice.set(s.voiceId, list);
    }
    this.profiles = this.options.store
      .listVoices()
      .filter((v) => byVoice.has(v.id))
      .map((v) => {
        const list = byVoice.get(v.id)!;
        const sum = new Float32Array(list[0]!.length);
        for (const e of list) for (let i = 0; i < sum.length; i++) sum[i]! += e[i]!;
        return { name: v.name, embedding: unit(sum) };
      });
    return this.profiles;
  }

  private prune(): void {
    const cutoff = this.now() - this.keepMs;
    while (this.heard.length && (this.heard[0]!.at < cutoff || this.heard.length > 50)) this.heard.shift();
  }
}
