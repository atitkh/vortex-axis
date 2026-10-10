import { titleFor } from "./cards.js";
import type { Store } from "./store.js";

/**
 * Points Axis at another of the person's OpenClaw conversations.
 *
 * All of Axis's devices are one way into one agent, and normally what is said
 * on any of them goes to one conversation of that agent's, the voice one. A
 * person who says "attach to internship hunt" wants the same devices, all of
 * them, to be heard in that conversation instead: whichever device picks up
 * the wake word next, it is the same place. So this is one pointer for the
 * hub, not one per device. It lets go by itself when nothing has been said
 * for a while, so that words meant for the assistant do not land in a thread
 * forgotten an hour ago.
 */

/** The part of the gateway this needs. */
export interface AttachSource {
  call(method: string, params: unknown): Promise<any>;
}

export interface Attached {
  /** The conversation's key, as the gateway knows it. */
  sessionKey: string;
  /** What the person calls it. */
  title: string;
  since: number;
  usedAt: number;
}

export interface Conversation {
  sessionKey: string;
  title: string;
}

export interface AttachmentOptions {
  source: AttachSource;
  store: Store;
  /** Whether a conversation is Axis's own voice one, which is where it is pointed when it is pointed nowhere else. */
  isHome: (sessionKey: string) => boolean;
  /** Told when the pointer moves, with where it now points (undefined: home). */
  onChange?: (attached: Attached | undefined) => void;
  /** How long it stays put with nothing said. */
  idleMs?: number;
  now?: () => number;
}

const META_KEY = "attached_session";
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export class Attachment {
  private readonly now: () => number;
  private readonly idleMs: number;

  constructor(private readonly options: AttachmentOptions) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 30 * 60_000;
  }

  /** Where Axis is pointed, if anywhere but home. One left unused too long is let go here. */
  current(): Attached | undefined {
    const saved = this.options.store.getMeta(META_KEY);
    if (!saved) return undefined;
    let attached: Attached;
    try {
      attached = JSON.parse(saved) as Attached;
    } catch {
      this.options.store.setMeta(META_KEY, undefined);
      return undefined;
    }
    if (this.now() - attached.usedAt > this.idleMs) {
      this.options.store.setMeta(META_KEY, undefined);
      this.options.onChange?.(undefined);
      return undefined;
    }
    return attached;
  }

  /** The key turns should go to, when that is not home. Calling it counts as use. */
  sessionKey(): string | undefined {
    const attached = this.current();
    if (!attached) return undefined;
    attached.usedAt = this.now();
    this.options.store.setMeta(META_KEY, JSON.stringify(attached));
    return attached.sessionKey;
  }

  /** The conversations a person could mean: the ones they talk in, not scheduled jobs and not Axis's own. */
  async list(): Promise<Conversation[]> {
    const reply = await this.options.source.call("sessions.list", { limit: 200 });
    const seen = new Set<string>();
    return (Array.isArray(reply?.sessions) ? (reply.sessions as any[]) : [])
      .filter((s) => typeof s?.key === "string" && !this.options.isHome(s.key) && s.classification !== "cron" && s.isBackground !== true && s.archived !== true)
      .map((s) => ({ sessionKey: s.key as string, title: titleFor(s) }))
      // Two conversations of one name cannot be told apart by saying it: the one used last stands for both.
      .filter((c) => !seen.has(plain(c.title)) && seen.add(plain(c.title)));
  }

  /**
   * Points Axis at the conversation a person named. A name said in full wins; then one that contains
   * what was said, or is contained in it. Several that fit are handed back to choose from.
   */
  async attach(wanted: string): Promise<{ attached?: Attached; candidates?: string[] }> {
    const said = plain(wanted);
    if (!said) throw new Error("say which conversation: its name, as the user calls it");
    const all = await this.list();
    const byKey = all.find((c) => c.sessionKey === wanted.trim());
    const exact = all.filter((c) => plain(c.title) === said);
    const near = all.filter((c) => plain(c.title).includes(said) || said.includes(plain(c.title)));
    const found = byKey ? [byKey] : exact.length ? exact : near;
    if (!found.length) {
      throw new Error(`there is no conversation called "${wanted}". There are: ${all.slice(0, 12).map((c) => c.title).join(", ") || "none"}`);
    }
    if (found.length > 1) return { candidates: found.map((c) => c.title) };
    const attached: Attached = { sessionKey: found[0]!.sessionKey, title: found[0]!.title, since: this.now(), usedAt: this.now() };
    this.options.store.setMeta(META_KEY, JSON.stringify(attached));
    this.options.onChange?.(attached);
    return { attached };
  }

  /** Points Axis home again. True when it was pointed somewhere else. */
  detach(): boolean {
    const was = this.current();
    if (!was) return false;
    this.options.store.setMeta(META_KEY, undefined);
    this.options.onChange?.(undefined);
    return true;
  }
}
