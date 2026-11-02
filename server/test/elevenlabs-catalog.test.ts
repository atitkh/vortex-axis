import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCatalogCache, loadCatalog } from "../src/elevenlabs-catalog.js";
import { admin, ctx, useServer } from "./harness.js";

const KEY = "sk-secret-value-123";

let server: Server;
let base: string;
let seen: { url: string; key: string | undefined }[] = [];
let statuses: Record<string, number> = {};
let models: unknown = [];

const voice = (n: number) => ({ voice_id: `v${n}`, name: `Voice ${n}`, category: "premade", preview_url: `https://x/p${n}.mp3`, labels: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    seen.push({ url, key: req.headers["xi-api-key"] as string | undefined });
    const path = url.split("?")[0]!;
    res.statusCode = statuses[path] ?? 200;
    if (path === "/v1/models") return void res.end(JSON.stringify(models));
    if (path === "/v2/voices") {
      const token = new URL(url, "http://x").searchParams.get("next_page_token");
      // Three pages of 100: a cap of 200 must stop after two.
      const page = token ? Number(token) : 0;
      return void res.end(JSON.stringify({
        voices: Array.from({ length: 100 }, (_, i) => voice(page * 100 + i)),
        has_more: true,
        next_page_token: String(page + 1),
      }));
    }
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
  statuses = {};
  models = [
    { model_id: "eleven_flash_v2_5", name: "Flash", can_do_text_to_speech: true },
    { model_id: "eleven_vc", name: "VC", can_do_text_to_speech: false, can_do_voice_conversion: true },
  ];
  clearCatalogCache();
  delete process.env.ELEVENLABS_API_KEY;
});

describe("loadCatalog", () => {
  it("normalizes voices (v2, capped at 200) and keeps only TTS-capable models for tts", async () => {
    const c = await loadCatalog("tts", { url: base, apiKey: KEY });
    expect(c.voices).toHaveLength(200);
    expect(c.voices[0]).toEqual({ id: "v0", name: "Voice 0", category: "premade", previewUrl: "https://x/p0.mp3" });
    expect(c.models).toEqual([{ id: "eleven_flash_v2_5", name: "Flash" }]);
    expect(seen.filter((r) => r.url.startsWith("/v2/voices"))).toHaveLength(2);
    expect(seen.every((r) => r.key === KEY)).toBe(true);
  });

  it("for stt returns scribe models if listed, else the static scribe_v2, and no voices", async () => {
    let c = await loadCatalog("stt", { url: base, apiKey: KEY });
    expect(c).toEqual({ voices: [], models: [{ id: "scribe_v2", name: "Scribe v2" }], modelSource: "static" });
    expect(seen.some((r) => r.url.startsWith("/v2/voices"))).toBe(false);
    models = [{ model_id: "scribe_v1", name: "Scribe v1" }, { model_id: "eleven_x", name: "X" }];
    c = await loadCatalog("stt", { url: base, apiKey: KEY }, true);
    expect(c.models).toEqual([{ id: "scribe_v1", name: "Scribe v1" }]);
    expect(c.modelSource).toBe("api");
  });

  it("caches per service, base and key, and refresh bypasses it", async () => {
    await loadCatalog("stt", { url: base, apiKey: KEY });
    await loadCatalog("stt", { url: base, apiKey: KEY });
    expect(seen).toHaveLength(1);
    await loadCatalog("stt", { url: base, apiKey: "other-key" });
    expect(seen).toHaveLength(2);
    await loadCatalog("stt", { url: base, apiKey: KEY }, true);
    expect(seen).toHaveLength(3);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    await loadCatalog("stt", { url: base, apiKey: "other-key" });
    vi.useRealTimers();
    expect(seen).toHaveLength(4);
  });

  it("maps errors without the key", async () => {
    await expect(loadCatalog("tts", { url: base })).rejects.toMatchObject({ status: 400, code: "no-key" });
    expect(seen).toHaveLength(0);
    for (const [up, status, code] of [[401, 424, "bad-key"], [429, 429, "rate-limited"], [503, 502, "upstream"]] as const) {
      statuses = { "/v1/models": up };
      const err = await loadCatalog("stt", { url: base, apiKey: KEY }, true).catch((e: Error) => e);
      expect(err).toMatchObject({ status, code, upstream: up });
      expect((err as Error).message).not.toContain(KEY);
    }
    await expect(loadCatalog("stt", { url: "http://127.0.0.1:1", apiKey: KEY })).rejects.toMatchObject({ code: "unreachable" });
  });

  it("reads the ELEVENLABS_API_KEY fallback", async () => {
    process.env.ELEVENLABS_API_KEY = KEY;
    await loadCatalog("stt", { url: base });
    expect(seen[0]!.key).toBe(KEY);
  });
});

describe("GET /admin/config/elevenlabs", () => {
  useServer();
  const get = (q: string, token?: string) =>
    admin("GET", `/admin/config/elevenlabs${q}`, undefined, token);

  it("needs the admin token", async () => {
    expect((await get("?service=tts", "wrong-token")).status).toBe(401);
    const bare = await fetch(`${ctx.base}/admin/config/elevenlabs?service=tts`);
    expect(bare.status).toBe(401);
  });

  it("validates service and kind, reports a missing key, and never returns the key", async () => {
    expect((await get("?service=x")).status).toBe(400);
    expect((await get("?service=tts")).status).toBe(400);
    await admin("PATCH", "/admin/config", { tts: { kind: "elevenlabs", url: base }, stt: { kind: "elevenlabs", url: base } });
    const none = await get("?service=tts");
    expect(none.status).toBe(400);
    expect(none.body.code).toBe("no-key");
    await admin("PATCH", "/admin/config", { tts: { apiKey: KEY } });
    const ok = await get("?service=tts");
    expect(ok.status).toBe(200);
    expect(ok.body.models).toEqual([{ id: "eleven_flash_v2_5", name: "Flash" }]);
    expect(ok.body.voices).toHaveLength(200);
    expect(JSON.stringify(ok.body)).not.toContain(KEY);
    statuses = { "/v1/models": 401 };
    const bad = await get("?service=tts&refresh=1");
    expect(bad.status).toBe(424);
    expect(bad.body).toMatchObject({ code: "bad-key", upstreamStatus: 401 });
    expect(JSON.stringify(bad.body)).not.toContain(KEY);
  });
});
