/**
 * The `show` tool: a picture put on a device's screen for a number of seconds, with nobody having asked and no
 * turn behind it, the picture counterpart of `say`. The picture comes from an https address (fetched once, with
 * checks against reaching the local network), a file on the OpenClaw gateway's machine (through the gateway's
 * own media route, as `MEDIA:` lines are) or bytes in base64. It goes out by `Pictures.put` (media.ts), the same
 * way pictures in replies do. The last few shown are kept in memory for the admin page's Recent pictures.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ClientRecord } from "./store.js";
import { drain } from "./drain.js";
import type { MediaStore, Pictures } from "./media.js";

/** The largest picture taken, by any route. */
export const SHOW_MAX_BYTES = 5 * 1024 * 1024;
export const SHOW_DEFAULT_SECONDS = 10;
export const SHOW_MAX_SECONDS = 300;
/** How many shown pictures the admin page lists. */
export const SHOW_HISTORY = 30;
const FETCH_TIMEOUT_MS = 10_000;

/** What the bytes are, by their first bytes; never by what a server or an agent says. */
export function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6))) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Whether an address is on this machine, the local network or otherwise not the public internet. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (ip === "::" || ip === "::1") return true;
    return /^(f[cd]|fe[89ab]|ff)/.test(ip);
  }
  return true;
}

export interface PictureInput {
  url?: unknown;
  path?: unknown;
  base64?: unknown;
  mime?: unknown;
}

export interface SourceDeps {
  fetch?: typeof fetch;
  /** Every address a host name has. */
  lookup?: (host: string) => Promise<string[]>;
  /** The OpenClaw gateway's host name, which may be on the local network. */
  gatewayHost?: () => string | undefined;
  /** A file on the gateway's machine, through its media route. Absent when Axis is not paired with OpenClaw. */
  fromGateway?: ((path: string, maxBytes: number) => Promise<{ bytes: Buffer; mime: string }>) | undefined;
  maxBytes?: number;
  timeoutMs?: number;
}

const given = (value: unknown) => value !== undefined && value !== null && value !== "";

/** Reads a picture from exactly one of `url`, `path` or `base64`. Throws a sentence fit to hand an agent. */
export async function readPicture(input: PictureInput, deps: SourceDeps = {}): Promise<{ bytes: Buffer; mime: string }> {
  const max = deps.maxBytes ?? SHOW_MAX_BYTES;
  const sources = [input.url, input.path, input.base64].filter(given).length;
  if (sources !== 1) throw new Error("give the picture as exactly one of url, path or base64");
  let bytes: Buffer;
  if (given(input.url)) bytes = await fetchPicture(input.url, deps, max);
  else if (given(input.path)) {
    if (typeof input.path !== "string" || /^[a-z][a-z0-9+.-]*:\/\//i.test(input.path)) throw new Error("path must be a file on the OpenClaw gateway's machine; give an address as url");
    if (!deps.fromGateway) throw new Error("a path needs Axis paired with OpenClaw, whose media route hands out the file");
    bytes = (await deps.fromGateway(input.path, max)).bytes;
  } else {
    if (typeof input.base64 !== "string") throw new Error("base64 must be text");
    const data = input.base64.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(data)) throw new Error("base64 is not valid base64");
    if (Math.floor((data.length * 3) / 4) > max + 3) throw new Error(`the picture is too large: ${Math.round(max / 1024 / 1024)} MB at most`);
    bytes = Buffer.from(data, "base64");
  }
  if (bytes.length > max) throw new Error(`the picture is too large: ${Math.round(max / 1024 / 1024)} MB at most`);
  const mime = sniffImage(bytes);
  if (!mime) throw new Error("that is not a picture Axis can show: PNG, JPEG, WebP or GIF");
  if (given(input.base64) && given(input.mime)) {
    const said = String(input.mime).toLowerCase().replace("image/jpg", "image/jpeg");
    if (said !== mime) throw new Error(`the bytes are a ${mime} picture, not ${said}`);
  }
  return { bytes, mime };
}

async function fetchPicture(raw: unknown, deps: SourceDeps, max: number): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error("url is not a web address");
  }
  if (url.protocol !== "https:") throw new Error("url must be an https address");
  if (url.username || url.password) throw new Error("url must not carry a name or password");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // The gateway's own host may be on the local network: it is where MEDIA: files come from anyway.
  const gateway = deps.gatewayHost?.()?.toLowerCase();
  if (host !== gateway) {
    let addresses: string[];
    try {
      addresses = isIP(host) ? [host] : await (deps.lookup ?? lookupAll)(host);
    } catch {
      throw new Error(`${host} could not be found`);
    }
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error("url points into a private network or this machine, which Axis does not fetch from");
  }
  const signal = AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    // A redirect could lead anywhere, the local network included: not followed.
    const res = await (deps.fetch ?? fetch)(url, { redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) throw new Error("the address redirects elsewhere; give the final address");
    if (!res.ok || !res.body) throw new Error(`the picture could not be fetched (HTTP ${res.status})`);
    if (Number(res.headers.get("content-length") ?? 0) > max) throw new Error(`the picture is too large: ${Math.round(max / 1024 / 1024)} MB at most`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of drain(res.body)) {
      size += chunk.length;
      if (size > max) throw new Error(`the picture is too large: ${Math.round(max / 1024 / 1024)} MB at most`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (signal.aborted) throw new Error("fetching the picture took longer than 10 seconds");
    throw error;
  }
}

async function lookupAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address);
}

/** One picture shown, as the admin page lists it. Never the picture itself, only where it is kept. */
export interface ShownPicture {
  id: string;
  at: number;
  by: "agent" | "admin";
  clientId: string;
  device: string;
  seconds: number;
  alt: string | null;
  fit: "contain" | "cover";
  shown: boolean;
  note: string | null;
  /** Addresses in the media store (`/v1/media/<id>`), gone after a day. */
  url: string;
  thumb: string;
}

export type ShowResult = {
  client: string;
  shown: boolean;
  seconds: number;
  note: string;
};

/** A session as `Shows` needs it. */
interface ShowSession {
  client: ClientRecord;
  readings?: Record<string, unknown>;
  maxFrameBytes?: number;
}

export interface ShowOptions {
  pictures: Pictures;
  media: MediaStore;
  session: (clientId: string) => ShowSession | undefined;
  send: (session: ShowSession, message: { t: "image.clear"; turnId?: string }) => void;
  /** Shrinks a picture for the Recent pictures list (fit.ts). */
  thumb?: (bytes: Buffer, mime: string) => Promise<Buffer>;
  note?: (clientId: string, text: string) => void;
  now?: () => number;
}

export class Shows {
  private readonly shown: ShownPicture[] = [];
  /** The picture each device was last sent, so Clear can name it. */
  private readonly onScreen = new Map<string, string>();
  private count = 0;

  constructor(private readonly options: ShowOptions) {}

  /** Puts a picture on one client's screen. `client` need not be online: the result says so. */
  async show(
    client: ClientRecord,
    picture: { bytes: Buffer; mime: string; url?: string | undefined; thumb?: string | undefined },
    how: { seconds?: unknown; alt?: unknown; fit?: unknown; by: "agent" | "admin" },
  ): Promise<ShowResult> {
    const seconds = pictureSeconds(how.seconds);
    const alt = typeof how.alt === "string" && how.alt.trim() ? how.alt.trim().slice(0, 200) : undefined;
    if (how.fit !== undefined && how.fit !== "contain" && how.fit !== "cover") throw new Error("fit must be contain or cover");
    const fit = how.fit === "cover" ? "cover" : "contain";
    const result = (shown: boolean, note: string): ShowResult => ({ client: client.name, shown, seconds, note });
    // Kept once in the media store (a day at most): the address clients fetch, and Show again.
    picture = { ...picture, url: picture.url ?? this.options.media.add(picture.bytes, picture.mime) };
    const session = this.options.session(client.id);
    let outcome: ShowResult;
    if (!client.reported.some((c) => c === "images" || c === "image-frames")) outcome = result(false, "No screen: it cannot show pictures.");
    else if (client.off.some((c) => c === "screen" || c === "images" || c === "image-frames")) {
      outcome = result(false, "Its screen is switched off on the admin page, so nothing was shown.");
    } else if (!session) outcome = result(false, "It is offline. Pictures are not kept for later.");
    else {
      const turnId = `say-${(this.now()).toString(36)}${(++this.count).toString(36)}`;
      const put = await this.options.pictures.put(session as never, picture, { turnId, seconds, alt, cover: fit === "cover" });
      if (put.shown) this.onScreen.set(client.id, turnId);
      outcome = put.shown
        ? result(true, `On its screen for ${seconds} s. Screens do not confirm pictures, so it is not known that anyone looked.`)
        : result(false, sentence(put.note ?? "it could not be shown"));
    }
    await this.remember(client, picture, { seconds, alt, fit, by: how.by }, outcome);
    return outcome;
  }

  /** Takes the picture off a client's screen early. */
  clear(client: ClientRecord): { client: string; cleared: boolean; note?: string } {
    const session = this.options.session(client.id);
    if (!session) return { client: client.name, cleared: false, note: "It is offline." };
    const turnId = this.onScreen.get(client.id);
    this.onScreen.delete(client.id);
    this.options.send(session, { t: "image.clear", ...(turnId ? { turnId } : {}) });
    return { client: client.name, cleared: true };
  }

  /** The pictures shown lately, newest first, with whether each can still be shown again. */
  recent(): (ShownPicture & { available: boolean })[] {
    return this.shown.map((p) => ({ ...p, available: Boolean(this.options.media.get(mediaId(p.url))) }));
  }

  /** A picture shown lately, its bytes still kept, for Show again. */
  again(id: string): { entry: ShownPicture; picture: { bytes: Buffer; mime: string; url: string; thumb: string } } | undefined {
    const entry = this.shown.find((p) => p.id === id);
    const kept = entry ? this.options.media.get(mediaId(entry.url)) : undefined;
    if (!entry || !kept) return undefined;
    return { entry, picture: { bytes: kept.bytes, mime: kept.mime, url: entry.url, thumb: entry.thumb } };
  }

  private async remember(
    client: ClientRecord,
    picture: { bytes: Buffer; mime: string; url?: string | undefined; thumb?: string | undefined },
    how: { seconds: number; alt: string | undefined; fit: "contain" | "cover"; by: "agent" | "admin" },
    outcome: ShowResult,
  ): Promise<void> {
    // The picture itself is in the media store, never in the activity log.
    const url = picture.url!;
    let thumb = picture.thumb;
    if (!thumb) {
      thumb = url;
      if (this.options.thumb) {
        try {
          thumb = this.options.media.add(await this.options.thumb(picture.bytes, picture.mime), "image/jpeg");
        } catch {
          // A picture a board cannot decode (WebP, GIF) is listed by itself.
        }
      }
    }
    this.shown.unshift({
      id: (++this.count).toString(36) + this.now().toString(36),
      at: this.now(),
      by: how.by,
      clientId: client.id,
      device: client.name,
      seconds: how.seconds,
      alt: how.alt ?? null,
      fit: how.fit,
      shown: outcome.shown,
      note: outcome.shown ? null : outcome.note,
      url,
      thumb,
    });
    this.shown.length = Math.min(this.shown.length, SHOW_HISTORY);
    if (outcome.shown) this.options.note?.(client.id, `picture shown on ${client.name}, ${how.alt ?? "none"}`);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** How long to keep a picture up: whole seconds from 1 to 300, 10 when not given. */
export function pictureSeconds(value: unknown): number {
  if (value === undefined || value === null) return SHOW_DEFAULT_SECONDS;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("seconds must be a number from 1 to 300");
  return Math.min(SHOW_MAX_SECONDS, Math.max(1, Math.round(value)));
}

const mediaId = (url: string) => url.slice(url.lastIndexOf("/") + 1);
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replace(/\.?$/, ".");
