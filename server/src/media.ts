import { randomBytes } from "node:crypto";

/**
 * Pictures that come with an agent's reply.
 *
 * An OpenClaw agent attaches a file to its final reply with a line of its own,
 * `MEDIA:<path or https URL>` (outside code blocks). Axis takes those lines out
 * of the text before anything is spoken or shown (`MediaLines`), fetches each
 * image once (from the gateway, see `GatewayClient.fetchMedia`) and keeps it
 * here for a day under an unguessable address, `/v1/media/<id>`, that clients
 * with the `images` capability are sent (`reply.image`). The address is the
 * only key, so it is long and random and never logged.
 */

/** A source an agent attached, as it wrote it. */
export interface MediaRef {
  source: string;
}

const MEDIA_LINE = /^\s*MEDIA:\s*(\S.*?)\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Takes `MEDIA:` lines out of streamed reply text. Text is passed on as it
 * comes, except a line that could still turn out to be a `MEDIA:` line, which
 * is held until it ends. Lines inside a fenced code block are left alone.
 */
export class MediaLines {
  readonly found: MediaRef[] = [];
  /** The line so far, all of it, and how much of it has not been passed on yet. */
  private line = "";
  private held = "";
  private fenced = false;

  /** Returns the part of `delta` that may be shown and spoken now. */
  push(delta: string): string {
    let out = "";
    for (const ch of delta) {
      this.line += ch;
      this.held += ch;
      if (ch === "\n") out += this.endLine();
    }
    // An unfinished line goes out at once unless it may still become a MEDIA line.
    if (this.held && !this.mayBeMedia()) {
      out += this.held;
      this.held = "";
    }
    return out;
  }

  /** At the end of the reply: whatever was held back, unless it was a MEDIA line. */
  flush(): string {
    const rest = this.held;
    const whole = this.line;
    this.line = this.held = "";
    if (!rest) return "";
    return rest === whole && this.take(whole) ? "" : rest;
  }

  private endLine(): string {
    const whole = this.line;
    const rest = this.held;
    this.line = this.held = "";
    if (FENCE.test(whole)) {
      this.fenced = !this.fenced;
      return rest;
    }
    // Only a line held back whole can be a MEDIA line; one already partly passed on was ordinary text.
    if (rest === whole && this.take(whole)) return "";
    return rest;
  }

  private mayBeMedia(): boolean {
    if (this.fenced || this.held !== this.line) return false;
    const start = this.line.replace(/^\s+/, "");
    return start.length < 6 ? "MEDIA:".startsWith(start) : start.startsWith("MEDIA:");
  }

  private take(line: string): boolean {
    const match = MEDIA_LINE.exec(line);
    if (!match || this.fenced) return false;
    this.found.push({ source: match[1]! });
    return true;
  }
}

/** Takes MEDIA lines out of a whole text, for replies that arrive in one piece. */
export function splitMedia(text: string): { text: string; media: MediaRef[] } {
  const lines = new MediaLines();
  const kept = lines.push(text) + lines.flush();
  return { text: kept.replace(/\n{3,}/g, "\n\n").trim(), media: lines.found };
}

export interface StoredMedia {
  id: string;
  mime: string;
  bytes: Buffer;
  at: number;
}

/** The image types clients are sent. Anything else an agent attaches is left out. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export class MediaStore {
  private readonly items = new Map<string, StoredMedia>();
  private total = 0;

  constructor(
    private readonly options: { keepMs?: number; maxBytes?: number; now?: () => number } = {},
  ) {}

  /** Keeps a picture and returns the address clients fetch it at. */
  add(bytes: Buffer, mime: string): string {
    this.prune();
    const id = randomBytes(18).toString("base64url");
    this.items.set(id, { id, mime, bytes, at: this.now() });
    this.total += bytes.length;
    // Over the limit, the oldest go first.
    const max = this.options.maxBytes ?? 64 * 1024 * 1024;
    for (const [old, item] of this.items) {
      if (this.total <= max || old === id) break;
      this.items.delete(old);
      this.total -= item.bytes.length;
    }
    return `/v1/media/${id}`;
  }

  get(id: string): StoredMedia | undefined {
    this.prune();
    return this.items.get(id);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private prune(): void {
    const keep = this.options.keepMs ?? 24 * 3600_000;
    for (const [id, item] of this.items) {
      if (this.now() - item.at <= keep) break;
      this.items.delete(id);
      this.total -= item.bytes.length;
    }
  }
}

/** What `Pictures` needs of the hub: the clients online and a way to send them a message. */
export interface PicturePort {
  sessions(): Iterable<{ client: { id: string; capabilities: readonly string[] } }>;
  session(clientId: string): { client: { id: string; capabilities: readonly string[] } } | undefined;
  send(session: never, message: { t: "reply.image"; turnId: string; url: string; mime?: string }): void;
}

/** At most this many pictures from one reply. */
const MAX_PER_REPLY = 4;

/**
 * Gets the pictures of a reply to a screen that can show them: the client the reply was for when it can,
 * otherwise (a reply that arrived after the device stopped waiting) every online client that shows images.
 */
export class Pictures {
  constructor(
    private readonly options: {
      store: MediaStore;
      port: PicturePort;
      fetch: () => ((media: { source: string; sessionKey?: string | undefined; agentId?: string | undefined }) => Promise<{ bytes: Buffer; mime: string }>) | undefined;
      log?: (line: string) => void;
    },
  ) {}

  /** Fetches and keeps each picture, and sends it on. Never throws: a picture that fails is left out, with a line in the log. */
  async show(
    media: { source: string; sessionKey?: string | undefined; agentId?: string | undefined }[],
    to: { clientId: string; turnId: string; orAnywhere?: boolean },
  ): Promise<number> {
    const fetchMedia = this.options.fetch();
    if (!fetchMedia || !media.length) return 0;
    const shows = (s: { client: { capabilities: readonly string[] } } | undefined) => Boolean(s?.client.capabilities.includes("images"));
    const own = this.options.port.session(to.clientId);
    const targets = shows(own) ? [own!] : to.orAnywhere ? [...this.options.port.sessions()].filter(shows) : [];
    if (!targets.length) {
      this.options.log?.(`a reply came with ${media.length} picture(s), but no client that shows pictures is online`);
      return 0;
    }
    let sent = 0;
    for (const item of media.slice(0, MAX_PER_REPLY)) {
      try {
        const { bytes, mime } = await fetchMedia(item);
        if (!IMAGE_TYPES.includes(mime)) {
          this.options.log?.(`left out a ${mime || "file of unknown type"} attached to a reply: only pictures are shown`);
          continue;
        }
        const url = this.options.store.add(bytes, mime);
        for (const session of targets) this.options.port.send(session as never, { t: "reply.image", turnId: to.turnId, url, mime });
        sent++;
      } catch (error) {
        this.options.log?.(`a picture attached to a reply could not be fetched: ${(error as Error).message}`);
      }
    }
    return sent;
  }
}
