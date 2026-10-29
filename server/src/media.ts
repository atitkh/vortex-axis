import { randomBytes } from "node:crypto";
import { FIT_TYPES } from "./fit.js";

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

/** A client as `Pictures` sees it. */
interface PictureSession {
  client: { id: string; capabilities: readonly string[] };
  readings?: Record<string, unknown>;
  maxFrameBytes?: number;
}

/** What `Pictures` needs of the hub: the clients online and a way to send them a message. */
export interface PicturePort {
  sessions(): Iterable<PictureSession>;
  session(clientId: string): PictureSession | undefined;
  send(session: never, message: Record<string, unknown> & { t: string }): void;
}

/** At most this many pictures from one reply. */
const MAX_PER_REPLY = 4;
/** A board's screen, when it has not said its size. */
const DEFAULT_SCREEN = { width: 368, height: 448 };

const showsUrl = (s: PictureSession | undefined) => Boolean(s?.client.capabilities.includes("images"));
const showsFrames = (s: PictureSession | undefined) => Boolean(s?.client.capabilities.includes("image-frames"));

/**
 * Gets the pictures of a reply to a screen that can show them: the client the reply was for when it can,
 * otherwise (a reply that arrived after the device stopped waiting) every online client that shows pictures.
 * A client with `images` is sent an address; one with `image-frames` (a board) is sent the picture itself,
 * shrunk to its screen, over its socket.
 */
export class Pictures {
  private count = 0;

  constructor(
    private readonly options: {
      store: MediaStore;
      port: PicturePort;
      fetch: () => ((media: { source: string; sessionKey?: string | undefined; agentId?: string | undefined }) => Promise<{ bytes: Buffer; mime: string }>) | undefined;
      /** Shrinks a picture for a small screen (fit.ts). Without it, boards are sent no pictures. */
      fit?: (bytes: Buffer, mime: string, box: { width: number; height: number; cover?: boolean }) => Promise<{ jpeg: Buffer; width: number; height: number }>;
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
    const shows = (s: PictureSession | undefined) => showsUrl(s) || (showsFrames(s) && Boolean(this.options.fit));
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
        const url = targets.some(showsUrl) ? this.options.store.add(bytes, mime) : undefined;
        // One shrunk copy per screen size.
        const fitted = new Map<string, Promise<{ jpeg: Buffer; width: number; height: number }>>();
        for (const session of targets) {
          if (showsUrl(session)) {
            this.options.port.send(session as never, { t: "reply.image", turnId: to.turnId, url: url!, mime });
            continue;
          }
          const box = screenOf(session);
          const key = `${box.width}x${box.height}`;
          if (!fitted.has(key)) fitted.set(key, this.options.fit!(bytes, mime, box));
          try {
            this.sendFrames(session, to.turnId, await fitted.get(key)!);
          } catch (error) {
            this.options.log?.(`a picture could not be made small enough for ${session.client.id}: ${(error as Error).message}`);
          }
        }
        sent++;
      } catch (error) {
        this.options.log?.(`a picture attached to a reply could not be fetched: ${(error as Error).message}`);
      }
    }
    return sent;
  }

  /**
   * Puts one picture on one client's screen, with nobody having asked (the `show` tool, the admin page). Says how
   * it went; never throws for a client that cannot show it. `store` keeps it for clients that fetch an address.
   */
  async put(
    session: PictureSession,
    picture: { bytes: Buffer; mime: string; url?: string | undefined },
    to: { turnId: string; seconds?: number | undefined; alt?: string | undefined; cover?: boolean | undefined },
  ): Promise<{ shown: boolean; how?: "address" | "frames"; note?: string }> {
    const extra = { ...(to.alt ? { alt: to.alt.slice(0, 500) } : {}), ...(to.seconds ? { seconds: to.seconds } : {}) };
    if (showsUrl(session)) {
      const url = picture.url ?? this.options.store.add(picture.bytes, picture.mime);
      this.options.port.send(session as never, { t: "reply.image", turnId: to.turnId, url, mime: picture.mime, ...extra });
      return { shown: true, how: "address" };
    }
    if (!showsFrames(session) || !this.options.fit) return { shown: false, note: "no screen: it cannot show pictures" };
    if (!FIT_TYPES.includes(picture.mime)) return { shown: false, note: `a ${picture.mime} picture cannot be shown on a board: PNG or JPEG only` };
    try {
      const fitted = await this.options.fit(picture.bytes, picture.mime, { ...screenOf(session), ...(to.cover ? { cover: true } : {}) });
      this.sendFrames(session, to.turnId, fitted, to.seconds);
      return { shown: true, how: "frames" };
    } catch (error) {
      return { shown: false, note: `the picture could not be made small enough: ${(error as Error).message}` };
    }
  }

  /** Sends a picture over a client's socket, in frames no larger than it takes. */
  private sendFrames(session: PictureSession, turnId: string, picture: { jpeg: Buffer; width: number; height: number }, seconds?: number): void {
    const imageId = `img-${(++this.count).toString(36)}`;
    // Room for the JSON around the data; base64 makes 4 characters of every 3 bytes.
    const chunk = Math.max(300, Math.floor(((session.maxFrameBytes ?? 4096) - 120) / 4) * 3);
    const send = (message: Record<string, unknown> & { t: string }) => this.options.port.send(session as never, message);
    send({ t: "image.start", imageId, turnId, mime: "image/jpeg", size: picture.jpeg.length, width: picture.width, height: picture.height, ...(seconds ? { seconds } : {}) });
    for (let at = 0; at < picture.jpeg.length; at += chunk) {
      send({ t: "image.data", imageId, data: picture.jpeg.subarray(at, at + chunk).toString("base64") });
    }
    send({ t: "image.end", imageId });
  }
}

/** The screen a client says it has, the way up it stands now. */
function screenOf(session: PictureSession): { width: number; height: number } {
  const w = Number(session.readings?.screenW), h = Number(session.readings?.screenH);
  return w > 0 && h > 0 && w <= 4096 && h <= 4096 ? { width: w, height: h } : DEFAULT_SCREEN;
}
