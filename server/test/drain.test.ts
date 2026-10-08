import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { drain } from "../src/drain.js";
import { OpenAiTextToSpeech } from "../src/speech.js";

/** A server that sends `size` bytes and closes the connection, like a speech service finishing. */
async function closingServer(size: number) {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/octet-stream", connection: "close", "content-length": size });
    res.end(Buffer.alloc(size, 1));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reading a streamed body", () => {
  // Without drain(), this exact pattern ends the process: nodejs/undici#5360.
  it("survives the server closing while the reader is busy elsewhere", async () => {
    const { server, url } = await closingServer(300_000);
    const res = await fetch(url);
    const chunks = drain(res.body!);
    await pause(300);
    let got = 0;
    for await (const chunk of chunks) {
      got += chunk.length;
      await pause(20);
    }
    expect(got).toBe(300_000);
    server.close();
  });

  it("speech synthesis played at a slow pace gets every byte", async () => {
    const { server, url } = await closingServer(200_000);
    const tts = new OpenAiTextToSpeech({ url, model: "m", apiKey: undefined, voice: undefined, sampleRate: 24000 });
    let got = 0;
    for await (const chunk of tts.synthesize("hello", {})) {
      got += chunk.length;
      await pause(30);
    }
    expect(got).toBe(200_000);
    server.close();
  });

  it("stops reading when the caller stops early", async () => {
    const { server, url } = await closingServer(300_000);
    const res = await fetch(url);
    for await (const chunk of drain(res.body!)) {
      expect(chunk.length).toBeGreaterThan(0);
      break;
    }
    server.close();
  });
});
