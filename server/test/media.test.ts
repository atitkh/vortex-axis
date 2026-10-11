import { describe, expect, it } from "vitest";
import type { Agent } from "../src/agent.js";
import { MediaLines, MediaStore, splitMedia } from "../src/media.js";
import { fitToJpeg } from "../src/fit.js";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { ready, restart, useServer } from "./harness.js";

/** Feeds text through the filter in the pieces given and returns what came out, and the sources found. */
function stream(pieces: string[]) {
  const lines = new MediaLines();
  let out = "";
  for (const piece of pieces) out += lines.push(piece);
  out += lines.flush();
  return { out, found: lines.found.map((m) => m.source) };
}

describe("lines that attach a file", () => {
  it("are taken out of the text, wherever the stream splits them", () => {
    const text = "Here is the picture.\nMEDIA:/workspace/tmp/a.png\n";
    for (const size of [1, 3, 7, 100]) {
      const pieces = text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))!;
      expect(stream(pieces)).toEqual({ out: "Here is the picture.\n", found: ["/workspace/tmp/a.png"] });
    }
  });

  it("are found at the very end, with no line break after", () => {
    expect(stream(["Done.\n", "MEDIA:https://example.org/b.jpg"])).toEqual({ out: "Done.\n", found: ["https://example.org/b.jpg"] });
  });

  it("leave ordinary text alone, also text that starts like one or mentions one", () => {
    expect(stream(["MEDIUM rare, please.\n"]).out).toBe("MEDIUM rare, please.\n");
    expect(stream(["Here is your image: MEDIA:/x.png\n"]))
      .toEqual({ out: "Here is your image: MEDIA:/x.png\n", found: [] });
  });

  it("are left alone inside a code block, even when its fence is split", () => {
    const { out, found } = stream(["``", "`\nMEDIA:/x.png\n``", "`\nok\n"]);
    expect(found).toEqual([]);
    expect(out).toBe("```\nMEDIA:/x.png\n```\nok\n");
  });

  it("do not hold back the rest of the text", () => {
    const lines = new MediaLines();
    expect(lines.push("Hello there,\n")).toBe("Hello there,\n");
    // At the start of a line, "M" could still become "MEDIA:", so it waits; "More" cannot, so it goes.
    expect(lines.push("M")).toBe("");
    expect(lines.push("ore")).toBe("More");
    // Further along a line nothing waits.
    expect(lines.push(" M")).toBe(" M");
  });

  it("can be split out of a whole reply", () => {
    expect(splitMedia("One.\n\nMEDIA:/a.png\nMEDIA:/b.png\n\nTwo.")).toEqual({ text: "One.\n\nTwo.", media: [{ source: "/a.png" }, { source: "/b.png" }] });
  });
});

describe("the picture store", () => {
  it("hands out long random addresses and forgets pictures after a day", () => {
    let now = 0;
    const store = new MediaStore({ now: () => now });
    const url = store.add(Buffer.from("png"), "image/png");
    expect(url).toMatch(/^\/v1\/media\/[\w-]{24}$/);
    expect(store.get(url.split("/").pop()!)?.mime).toBe("image/png");
    now = 25 * 3600_000;
    expect(store.get(url.split("/").pop()!)).toBeUndefined();
  });

  it("drops the oldest when it holds too much", () => {
    const store = new MediaStore({ maxBytes: 10 });
    const first = store.add(Buffer.alloc(6), "image/png");
    const second = store.add(Buffer.alloc(6), "image/png");
    expect(store.get(first.split("/").pop()!)).toBeUndefined();
    expect(store.get(second.split("/").pop()!)).toBeDefined();
  });
});

/** A real PNG, `w` by `h`, half red and half transparent. */
function png(w: number, h: number): Buffer {
  const img = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) img.data.set(i % w < w / 2 ? [255, 0, 0, 255] : [0, 0, 255, 0], i * 4);
  return PNG.sync.write(img);
}

describe("shrinking a picture for a small screen", () => {
  it("fits it in the box, keeps its shape, and lays transparency on black", async () => {
    const fitted = await fitToJpeg(png(800, 400), "image/png", { width: 368, height: 448 });
    expect([fitted.width, fitted.height]).toEqual([368, 184]);
    const back = jpeg.decode(fitted.jpeg, { useTArray: true });
    expect([back.width, back.height]).toEqual([368, 184]);
    const at = (x: number) => Array.from(back.data.subarray((90 * 368 + x) * 4, (90 * 368 + x) * 4 + 3));
    expect(at(40)[0]).toBeGreaterThan(200);
    expect(Math.max(...at(320))).toBeLessThan(40);
  });

  it("enlarges a small one at most twice, and refuses what is not a picture or far too large", async () => {
    expect((await fitToJpeg(png(50, 50), "image/png", { width: 368, height: 448 })).width).toBe(100);
    await expect(fitToJpeg(Buffer.from("nope"), "image/png", { width: 10, height: 10 })).rejects.toThrow(/not a PNG/);
    await expect(fitToJpeg(png(300, 300), "image/png", { width: 10, height: 10, maxPixels: 1000 })).rejects.toThrow(/too large/);
    await expect(fitToJpeg(Buffer.from("x"), "image/gif", { width: 10, height: 10 })).rejects.toThrow(/cannot be shrunk/);
  });
});

// A turn whose reply attaches a picture, end to end through Axis.
const PNG_BYTES = png(200, 100);
let fetched: string[] = [];
const agent: Agent = {
  reply: (_message, _signal, _onTool, _onState, _route, _onRun, onMedia) =>
    (async function* () {
      yield "Here it is.";
      onMedia?.([{ source: "/workspace/tmp/vortex.png", sessionKey: "agent:main:vortex-axis", agentId: "main" }]);
    })(),
  fetchMedia: async (media) => {
    fetched.push(media.source);
    return { bytes: PNG_BYTES, mime: "image/png" };
  },
  healthy: async () => true,
};
useServer(() => {
  fetched = [];
  return { agent };
});

describe("a reply with a picture", () => {
  it("shows the picture under the reply on a client that shows pictures, and serves it", async () => {
    await restart({}, { agent });
    const { client } = await ready(["screen", "images"]);
    client.send({ t: "text", turnId: "t1", text: "draw me a vortex" });
    const image = await client.next("reply.image");
    expect(image).toMatchObject({ turnId: "t1", mime: "image/png" });
    expect(fetched).toEqual(["/workspace/tmp/vortex.png"]);
    const { ctx } = await import("./harness.js");
    const res = await fetch(`http://127.0.0.1:${ctx.app.port}${image.url}`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
    expect((await fetch(`http://127.0.0.1:${ctx.app.port}/v1/media/nope`)).status).toBe(404);
  });

  it("sends a board the picture itself, shrunk to its screen, in frames that fit", async () => {
    await restart({}, { agent });
    const { client } = await ready(["screen", "image-frames"], { hello: { maxFrameBytes: 1024 } });
    client.send({ t: "sense", readings: { screenW: 448, screenH: 368 } });
    await new Promise((r) => setTimeout(r, 50));
    client.send({ t: "text", turnId: "t1", text: "draw me a vortex" });
    const start = await client.next("image.start");
    await client.next("image.end");
    expect(start).toMatchObject({ turnId: "t1", mime: "image/jpeg", width: 400, height: 200 });
    const pieces = client.received.filter((m) => m.t === "image.data") as { data: string }[];
    expect(pieces.every((p) => JSON.stringify(p).length <= 1024)).toBe(true);
    const bytes = Buffer.concat(pieces.map((p) => Buffer.from(p.data, "base64")));
    expect(bytes.length).toBe(start.size);
    expect(jpeg.decode(bytes).width).toBe(400);
    expect(client.types()).not.toContain("reply.image");
  });

  it("sends no picture to a client that cannot show one", async () => {
    await restart({}, { agent });
    const { client } = await ready(["screen"]);
    client.send({ t: "text", turnId: "t1", text: "draw me a vortex" });
    await client.turn("t1", "idle");
    await new Promise((r) => setTimeout(r, 100));
    expect(client.types()).not.toContain("reply.image");
  });
});
