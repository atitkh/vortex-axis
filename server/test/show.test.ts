import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { createInvokeHandler } from "../src/commands.js";
import { isPrivateAddress, readPicture, Shows, sniffImage, SHOW_HISTORY } from "../src/show.js";
import { MediaStore, type Pictures } from "../src/media.js";
import type { ClientRecord } from "../src/store.js";
import { admin, ctx, ready, useServer } from "./harness.js";

useServer();

function png(w: number, h: number): Buffer {
  const img = new PNG({ width: w, height: h });
  img.data.fill(200);
  return PNG.sync.write(img);
}
const PNG_BYTES = png(200, 100);
const GIF_BYTES = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** A fetch that answers with `bytes`, recording what was asked. */
function fakeFetch(bytes: Buffer, init: { status?: number; headers?: Record<string, string> } = {}) {
  const asked: string[] = [];
  const fn = (async (url: URL) => {
    asked.push(String(url));
    return new Response(new Uint8Array(bytes), { status: init.status ?? 200, headers: init.headers ?? {} });
  }) as unknown as typeof fetch;
  return { fn, asked };
}

describe("where a picture to show may come from", () => {
  it("takes an https address on the internet, once, and knows a picture by its bytes", async () => {
    const f = fakeFetch(PNG_BYTES, { headers: { "content-type": "text/plain" } });
    const got = await readPicture({ url: "https://pictures.example.org/a.png" }, { fetch: f.fn, lookup: async () => ["93.184.216.34"] });
    expect(got.mime).toBe("image/png");
    expect(f.asked).toEqual(["https://pictures.example.org/a.png"]);
  });

  it("refuses plain http, names with passwords and more than one source", async () => {
    const deps = { fetch: fakeFetch(PNG_BYTES).fn, lookup: async () => ["93.184.216.34"] };
    await expect(readPicture({ url: "http://pictures.example.org/a.png" }, deps)).rejects.toThrow(/https/);
    await expect(readPicture({ url: "https://me:pw@pictures.example.org/a.png" }, deps)).rejects.toThrow(/password/);
    await expect(readPicture({ url: "https://pictures.example.org/a.png", base64: "AA==" }, deps)).rejects.toThrow(/exactly one/);
    await expect(readPicture({}, deps)).rejects.toThrow(/exactly one/);
  });

  it("refuses an address on this machine or the local network, unless it is the gateway's host", async () => {
    const f = fakeFetch(PNG_BYTES);
    const deps = { fetch: f.fn, lookup: async (host: string) => (host === "gw.example.org" ? ["192.168.1.20"] : ["10.0.0.5"]) };
    await expect(readPicture({ url: "https://intranet.example.org/a.png" }, deps)).rejects.toThrow(/private network/);
    await expect(readPicture({ url: "https://127.0.0.1/a.png" }, deps)).rejects.toThrow(/private network/);
    await expect(readPicture({ url: "https://[::1]/a.png" }, deps)).rejects.toThrow(/private network/);
    await expect(readPicture({ url: "https://169.254.169.254/latest" }, deps)).rejects.toThrow(/private network/);
    expect(f.asked).toEqual([]);
    const got = await readPicture({ url: "https://gw.example.org/a.png" }, { ...deps, gatewayHost: () => "gw.example.org" });
    expect(got.mime).toBe("image/png");
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.20", "100.100.1.1", "0.0.0.0", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:2800:220:1::1")).toBe(false);
  });

  it("follows no redirect and caps the size", async () => {
    const lookup = async () => ["93.184.216.34"];
    await expect(readPicture({ url: "https://a.example.org/x" }, { fetch: fakeFetch(Buffer.alloc(0), { status: 302 }).fn, lookup })).rejects.toThrow(/redirects/);
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(2000)]);
    await expect(readPicture({ url: "https://a.example.org/x" }, { fetch: fakeFetch(big).fn, lookup, maxBytes: 1000 })).rejects.toThrow(/too large/);
    await expect(readPicture({ url: "https://a.example.org/x" }, { fetch: fakeFetch(Buffer.from("<html>")).fn, lookup })).rejects.toThrow(/not a picture/);
  });

  it("takes base64 with or without a data: prefix, checks the type it claims and the size", async () => {
    expect((await readPicture({ base64: PNG_BYTES.toString("base64"), mime: "image/png" })).bytes).toEqual(PNG_BYTES);
    expect((await readPicture({ base64: `data:image/gif;base64,${GIF_BYTES.toString("base64")}` })).mime).toBe("image/gif");
    await expect(readPicture({ base64: PNG_BYTES.toString("base64"), mime: "image/jpeg" })).rejects.toThrow(/not image\/jpeg/);
    await expect(readPicture({ base64: "not base64 at all!" })).rejects.toThrow(/not valid base64/);
    await expect(readPicture({ base64: PNG_BYTES.toString("base64") }, { maxBytes: 100 })).rejects.toThrow(/too large/);
  });

  it("reads a path only through the gateway's media route", async () => {
    await expect(readPicture({ path: "/tmp/a.png" })).rejects.toThrow(/paired with OpenClaw/);
    await expect(readPicture({ path: "file:///etc/passwd" }, { fromGateway: async () => ({ bytes: PNG_BYTES, mime: "" }) })).rejects.toThrow(/gateway's machine/);
    const asked: string[] = [];
    const got = await readPicture({ path: "/tmp/a.png" }, { fromGateway: async (p) => (asked.push(p), { bytes: PNG_BYTES, mime: "" }) });
    expect([got.mime, asked]).toEqual(["image/png", ["/tmp/a.png"]]);
  });

  it("knows the four picture types by their first bytes", () => {
    expect(sniffImage(PNG_BYTES)).toBe("image/png");
    expect(sniffImage(GIF_BYTES)).toBe("image/gif");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(Buffer.from("hello"))).toBeUndefined();
  });
});

/** The node's command handler, as an agent calls it, with the app's own pictures. */
function invoke(command: string, params: Record<string, unknown>) {
  const { hub, store, timers, delivery, activity, shows } = ctx.app;
  return createInvokeHandler({ hub, store, timers, delivery, activity, shows, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(command, params) as Promise<any>;
}

describe("showing a picture", () => {
  it("sends a board the picture shrunk to its screen with the seconds, and Clear takes it down", async () => {
    const { client, identity } = await ready(["screen", "image-frames"], { name: "Desk" });
    client.send({ t: "sense", readings: { screenW: 368, screenH: 448 } });
    await new Promise((r) => setTimeout(r, 50));
    const result = await invoke("vortex.axis.show", { client: "Desk", base64: PNG_BYTES.toString("base64"), seconds: 45, alt: "a grey box" });
    expect(result).toMatchObject({ client: "Desk", shown: true, seconds: 45 });
    const start = await client.next("image.start");
    expect(start).toMatchObject({ mime: "image/jpeg", seconds: 45, width: 368, height: 184 });
    expect(start.turnId).toMatch(/^say-/);
    await client.next("image.end");
    // Cover fills the screen.
    await invoke("vortex.axis.show", { client: "Desk", base64: PNG_BYTES.toString("base64"), fit: "cover" });
    const covered = await client.next("image.start", 0, (m: any) => m.turnId !== start.turnId);
    expect([covered.width, covered.height, covered.seconds]).toEqual([368, 448, 10]);
    await client.next("image.end", 0, (m: any) => m.imageId === covered.imageId);
    const pieces = client.received.filter((m: any) => m.t === "image.data" && m.imageId === covered.imageId) as { data: string }[];
    expect(jpeg.decode(Buffer.concat(pieces.map((p) => Buffer.from(p.data, "base64")))).height).toBe(448);
    // A board cannot decode a GIF: said so.
    expect(await invoke("vortex.axis.show", { client: "Desk", base64: GIF_BYTES.toString("base64") })).toMatchObject({ shown: false, note: expect.stringMatching(/PNG or JPEG/) });
    expect((await admin("POST", `/admin/clients/${identity.clientId}/show/clear`)).body).toEqual({ client: "Desk", cleared: true });
    expect(await client.next("image.clear")).toEqual({ t: "image.clear", turnId: covered.turnId });
  });

  it("sends a browser the picture's address with the seconds, from the admin page", async () => {
    const { client, identity } = await ready(["screen", "images"], { name: "Phone" });
    const res = await admin("POST", `/admin/clients/${identity.clientId}/show`, { base64: GIF_BYTES.toString("base64"), mime: "image/gif", seconds: 300, alt: "a dot" });
    expect(res.body).toMatchObject({ client: "Phone", shown: true, seconds: 300 });
    const image = await client.next("reply.image");
    expect(image).toMatchObject({ mime: "image/gif", seconds: 300, alt: "a dot" });
    const fetched = await fetch(`${ctx.base}${image.url}`);
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(GIF_BYTES);
    expect((await admin("POST", `/admin/clients/${identity.clientId}/show`, { url: "http://a.example.org/x.png" })).status).toBe(400);
  });

  it("says no screen, a screen switched off, or offline, and never puts the picture in the activity log", async () => {
    const speaker = await ready(["mic", "speaker"], { name: "Kitchen" });
    expect(await invoke("vortex.axis.show", { client: "Kitchen", base64: PNG_BYTES.toString("base64") })).toMatchObject({ shown: false, note: expect.stringMatching(/^No screen/) });
    const board = await ready(["screen", "image-frames"], { name: "Desk" });
    await admin("PATCH", `/admin/clients/${board.identity.clientId}`, { capabilitiesOff: ["screen"] });
    expect(await invoke("vortex.axis.show", { client: "Desk", base64: PNG_BYTES.toString("base64") })).toMatchObject({ shown: false, note: expect.stringMatching(/switched off/) });
    await admin("PATCH", `/admin/clients/${board.identity.clientId}`, { capabilitiesOff: [] });
    board.client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await invoke("vortex.axis.show", { client: "Desk", base64: PNG_BYTES.toString("base64") })).toMatchObject({ shown: false, note: expect.stringMatching(/offline/) });
    speaker.client.close();
  });

  it("keeps the last pictures shown, with thumbnails, and shows one again", async () => {
    const { client, identity } = await ready(["screen", "images"], { name: "Phone" });
    for (let i = 0; i < 3; i++) {
      await invoke("vortex.axis.show", { client: "Phone", base64: PNG_BYTES.toString("base64"), alt: `picture ${i}` });
    }
    const { body } = await admin("GET", "/admin/pictures");
    expect(body.pictures).toHaveLength(3);
    expect(body.pictures[0]).toMatchObject({ device: "Phone", by: "agent", alt: "picture 2", seconds: 10, shown: true, available: true });
    expect(body.pictures[0].thumb).not.toBe(body.pictures[0].url);
    const thumb = await fetch(`${ctx.base}${body.pictures[0].thumb}`);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    const again = await admin("POST", `/admin/pictures/${body.pictures[1].id}/show`, {});
    expect(again.body).toMatchObject({ client: "Phone", shown: true });
    const after = (await admin("GET", "/admin/pictures")).body.pictures;
    expect(after[0]).toMatchObject({ by: "admin", alt: body.pictures[1].alt, url: body.pictures[1].url });
    expect((await admin("POST", "/admin/pictures/nope/show", {})).status).toBe(410);
    // Only a line, never the picture.
    await new Promise((r) => setTimeout(r, 50));
    const events = JSON.stringify(ctx.app.store.eventsBetween(0, Date.now() + 1000));
    expect(events).toContain("picture shown on Phone, picture 0");
    expect(events).not.toContain(PNG_BYTES.toString("base64").slice(0, 40));
    expect(identity.clientId).toBeTruthy();
    client.close();
  });
});

describe("the list of pictures shown", () => {
  it("keeps the last 30, newest first", async () => {
    const media = new MediaStore();
    const client = { id: "c1", name: "Phone", type: "web", capabilities: ["screen", "images"], reported: ["screen", "images"], off: [] } as unknown as ClientRecord;
    const shows = new Shows({
      media,
      pictures: { put: async () => ({ shown: true }) } as unknown as Pictures,
      session: () => ({ client }),
      send: () => {},
      thumb: async () => Buffer.from("thumb"),
    });
    for (let i = 0; i < SHOW_HISTORY + 3; i++) await shows.show(client, { bytes: PNG_BYTES, mime: "image/png" }, { alt: `picture ${i}`, by: "agent" });
    const list = shows.recent();
    expect(list).toHaveLength(SHOW_HISTORY);
    expect([list[0]!.alt, list.at(-1)!.alt]).toEqual([`picture ${SHOW_HISTORY + 2}`, "picture 3"]);
    expect(list.every((p) => p.available && p.thumb !== p.url)).toBe(true);
    await expect(shows.show(client, { bytes: PNG_BYTES, mime: "image/png" }, { fit: "stretch", by: "agent" })).rejects.toThrow(/contain or cover/);
  });
});
