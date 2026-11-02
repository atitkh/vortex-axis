import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { admin, useServer } from "./harness.js";

/** An OpenAI-style synthesis service that either answers with PCM or fails with `status`. */
async function speechServer(status: number): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "POST") hits++;
      if (status !== 200) return void res.writeHead(status).end("no");
      if (req.method !== "POST") return void res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
      res.writeHead(200, { "content-type": "audio/pcm" }).end(Buffer.alloc(4800, 1));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/audio/speech`, hits: () => hits };
}

let broken: Awaited<ReturnType<typeof speechServer>>;
let working: Awaited<ReturnType<typeof speechServer>>;

beforeAll(async () => {
  broken = await speechServer(500);
  working = await speechServer(200);
});
afterAll(() => {
  broken.server.close();
  working.server.close();
});

useServer();

describe("ranked speech entries in a running Axis", () => {
  it("fails over to the next entry, says so per entry, and shows the service degraded on the map", async () => {
    const saved = await admin("PATCH", "/admin/config", {
      stt: { entries: [] },
      tts: { entries: [{ label: "Local", url: broken.url, apiKey: "top-secret" }, { label: "Backup", url: working.url, sampleRate: 16000 }], cooldownSeconds: 120 },
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain("top-secret");
    const [first, second] = saved.body.tts.entries;

    const test = await admin("POST", "/admin/config/test");
    expect(test.body.tts.ok).toBe(true);
    expect(broken.hits()).toBe(1);
    expect(working.hits()).toBe(1);

    const status = await admin("GET", "/admin/config/speech-status");
    expect(status.status).toBe(200);
    expect(status.body.stt).toEqual({ state: "off", cooldownSeconds: 60, entries: [] });
    expect(status.body.tts.state).toBe("degraded");
    expect(status.body.tts.cooldownSeconds).toBe(120);
    expect(status.body.tts.entries).toEqual([
      expect.objectContaining({ id: first.id, rank: 1, label: "Local", usable: true, up: false, lastError: "speech synthesis answered HTTP 500", active: false }),
      expect.objectContaining({ id: second.id, rank: 2, label: "Backup", usable: true, up: true, active: true }),
    ]);
    expect(status.body.tts.entries[0].downUntil).toBeGreaterThan(Date.now() + 100_000);
    expect(status.body.realtimeFallback).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain("top-secret");

    // Devices hear "up"; the map tells an admin a lower-ranked entry is speaking.
    await vi.waitFor(async () => {
      const map = await admin("GET", "/admin/map");
      expect(map.body.services.find((s: { id: string }) => s.id === "tts").state).toBe("degraded");
    });
  });

  it("lists a switched-off entry as not usable, and keeps the status route behind the admin token", async () => {
    await admin("PATCH", "/admin/config", { tts: { entries: [{ url: working.url, enabled: false }, { url: working.url, label: "On" }] } });
    const status = await admin("GET", "/admin/config/speech-status");
    expect(status.body.tts.entries.map((e: { usable: boolean; enabled: boolean }) => [e.enabled, e.usable])).toEqual([[false, false], [true, true]]);
    expect((await admin("GET", "/admin/config/speech-status", undefined, "wrong-token")).status).toBe(401);
  });

  it("keeps a one-entry page working: its save edits entry #1 and keeps the rest", async () => {
    await admin("PATCH", "/admin/config", { tts: { entries: [{ url: broken.url, apiKey: "k1" }, { url: working.url, label: "Backup" }] } });
    const page = await admin("PATCH", "/admin/config", { tts: { kind: "openai", url: working.url, model: "tts-1", voice: "nova", sampleRate: 24000 } });
    expect(page.body.tts).toMatchObject({ url: working.url, voice: "nova", apiKeySet: true });
    expect(page.body.tts.entries).toHaveLength(2);
    expect(page.body.tts.entries[1].label).toBe("Backup");
  });
});
