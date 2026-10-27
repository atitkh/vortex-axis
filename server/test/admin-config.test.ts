import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GATEWAY_NOTE, DEFAULT_SYSTEM_PROMPT } from "../src/agent.js";
import { AXIS_VERSION } from "../src/version.js";
import type { Agent } from "../src/agent.js";
import type { SpeechToText, TextToSpeech } from "../src/speech.js";
import { resample } from "../src/upstream.js";
import { admin, ctx, ready, restart, useServer } from "./harness.js";

useServer();

const page = async (path: string) => {
  const res = await fetch(`${ctx.base}${path}`);
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
};

describe("web pages", () => {
  it("serves the client and admin pages without a token", async () => {
    const client = await page("/");
    expect(client.status).toBe(200);
    expect(client.type).toMatch(/text\/html/);
    expect(client.body).toContain("/web/client.js");

    const adminPage = await page("/admin");
    expect(adminPage.status).toBe(200);
    expect(adminPage.body).toContain("/web/admin.js");
    expect((await page("/web/admin.js")).type).toMatch(/javascript/);
    expect((await page("/web/style.css")).type).toMatch(/css/);
  });

  it("serves the new admin page beside the classic one, on the local network only", async () => {
    const next = await page("/admin-next");
    expect(next.status).toBe(200);
    expect(next.type).toMatch(/text\/html/);
    expect(next.body).toMatch(/\/web\/admin-next\.js\?v=[0-9a-f]{12}/);
    // Its vendored libraries are plain files of the same flat folder.
    expect((await page("/web/preact.js")).body).toContain("export{");
    expect((await page("/web/qr.js")).type).toMatch(/javascript/);
    // Under a public name neither admin page exists.
    await admin("PATCH", "/admin/integrations", { publicHosts: "axis.example.org" });
    for (const path of ["/admin", "/admin-next"]) {
      const outside = await fetch(`${ctx.base}${path}`, { headers: { "x-forwarded-host": "axis.example.org" } });
      expect(outside.status).toBe(404);
    }
    expect((await page("/admin-next")).status).toBe(200);
    await admin("PATCH", "/admin/integrations", { publicHosts: "" });
  });

  it("lists Axis's own settings with the shared layer", async () => {
    const body = (await admin("GET", "/admin/settings/global")).body as { values: unknown; builtIns: { key: string }[] };
    expect(body.values).toEqual({});
    expect(body.builtIns.map((s) => s.key)).toEqual(expect.arrayContaining(["voice", "quietFrom", "offlineAlert", "wakeWord"]));
  });

  it("stamps the addresses of its own files, so a new build is never served from an old copy", async () => {
    const page = await fetch(`${ctx.base}/`);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const script = /src="(\/web\/client\.js\?v=[0-9a-f]{12})"/.exec(await page.text())?.[1];
    expect(script).toBeTruthy();
    const stamped = await fetch(`${ctx.base}${script}`);
    expect(stamped.headers.get("cache-control")).toContain("immutable");
    // The script's own imports carry the same stamp.
    expect(await stamped.text()).toContain(`/web/vortex.js?v=${script!.split("=")[1]}`);
    // An address with no stamp, or an old one, is checked every time.
    expect((await fetch(`${ctx.base}/web/client.js`)).headers.get("cache-control")).toBe("no-cache");
    expect((await fetch(`${ctx.base}/web/client.js?v=000000000000`)).headers.get("cache-control")).toBe("no-cache");
  });

  it("serves nothing outside its list of files", async () => {
    expect((await page("/web/nope.js")).status).toBe(404);
    expect((await page("/web/..%2Fpackage.json")).status).toBe(404);
    expect((await page("/web/%2e%2e%2f%2e%2e%2fREADME.md")).status).toBe(404);
  });

  it("still guards the API behind the page", async () => {
    expect((await fetch(`${ctx.base}/admin/status`)).status).toBe(401);
    expect((await admin("GET", "/admin/status")).body).toMatchObject({ version: AXIS_VERSION, clientsOnline: 0, clientsKnown: 0 });
  });
});

describe("runtime settings", () => {
  it("starts from the environment and never returns secrets", async () => {
    await restart({
      stt: { url: "http://stt.test/v1/audio/transcriptions", model: "whisper-1", apiKey: "stt-secret" },
      tts: { url: "http://tts.test/v1/audio/speech", model: "tts-1", voice: undefined, sampleRate: 22050, apiKey: undefined },
    });
    const res = await admin("GET", "/admin/config");
    expect(res.body).toEqual({
      stt: { url: "http://stt.test/v1/audio/transcriptions", model: "whisper-1", apiKeySet: true },
      tts: { url: "http://tts.test/v1/audio/speech", model: "tts-1", voice: "", sampleRate: 22050, apiKeySet: false },
      voiceprint: { url: "" },
      agent: { backend: "gateway", url: "", model: "", systemPrompt: "", gatewayNote: "", tokenSet: false, defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT, defaultGatewayNote: DEFAULT_GATEWAY_NOTE },
    });
    expect(JSON.stringify(res.body)).not.toContain("stt-secret");
  });

  it("saves a change, keeps untouched secrets, and survives a restart", async () => {
    await admin("PATCH", "/admin/config", { stt: { url: "http://a.test/t", apiKey: "k1" } });
    const second = await admin("PATCH", "/admin/config", { stt: { model: "parakeet" }, tts: { url: "http://b.test/s", voice: "nova" } });
    expect(second.body.stt).toEqual({ url: "http://a.test/t", model: "parakeet", apiKeySet: true });
    expect(second.body.tts).toMatchObject({ url: "http://b.test/s", voice: "nova", sampleRate: 24000 });

    await restart();
    expect((await admin("GET", "/admin/config")).body.stt).toEqual({ url: "http://a.test/t", model: "parakeet", apiKeySet: true });

    const cleared = await admin("PATCH", "/admin/config", { stt: { apiKey: "", url: "" } });
    expect(cleared.body.stt).toEqual({ url: "", model: "parakeet", apiKeySet: false });
  });

  it("rejects values it cannot use", async () => {
    const bad = async (body: unknown) => (await admin("PATCH", "/admin/config", body)).status;
    expect(await bad({ stt: { url: "ftp://x" } })).toBe(400);
    expect(await bad({ stt: { url: "not a url" } })).toBe(400);
    expect(await bad({ tts: { sampleRate: 100 } })).toBe(400);
    expect(await bad({ agent: { backend: "magic" } })).toBe(400);
    expect(await bad({ other: {} })).toBe(400);
    expect(await bad({ stt: "x" })).toBe(400);
  });

  it("applies a change to the next turn without a restart", async () => {
    // A tiny OpenAI-style chat endpoint, to stand in for "another harness".
    const { createServer } = await import("node:http");
    const seen: any[] = [];
    const chat = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method !== "POST") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "From the other " } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "harness." } }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    await new Promise<void>((r) => chat.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(chat.address() as any).port}/v1/chat/completions`;

    try {
      const { client } = await ready(["screen"], { name: "Panel" });
      client.send({ t: "text", turnId: "t1", text: "hi" });
      expect((await client.turn("t1", "error")).detail).toBe("not connected to OpenClaw");

      await admin("PATCH", "/admin/config", { agent: { backend: "openai", url, model: "m1", token: "tok" } });
      client.send({ t: "text", turnId: "t2", text: "hi again" });
      expect((await client.next("reply.text", 0, (m) => m.final)).text).toBe("From the other harness.");
      expect(seen[0].auth).toBe("Bearer tok");
      expect(seen[0].body).toMatchObject({ model: "m1", stream: true, user: "vortex-axis" });
      // The built-in system prompt goes first, then the person's words under the line describing the device.
      expect(seen[0].body.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
      expect(seen[0].body.messages[0].content).toBe(DEFAULT_SYSTEM_PROMPT);
      expect(seen[0].body.messages[1].content).toMatch(/^\[from: Panel.*\]\nhi again$/);

      // A prompt of the admin's own replaces it; emptied, the built-in one is back.
      await admin("PATCH", "/admin/config", { agent: { systemPrompt: "Answer like a pirate." } });
      client.send({ t: "text", turnId: "t2b", text: "ahoy" });
      await vi.waitFor(() => expect(seen.length).toBe(2));
      expect(seen[1].body.messages[0]).toEqual({ role: "system", content: "Answer like a pirate." });
      await admin("PATCH", "/admin/config", { agent: { systemPrompt: "" } });
      await client.turn("t2b", "idle");
      client.send({ t: "text", turnId: "t2c", text: "hello" });
      await vi.waitFor(() => expect(seen.length).toBe(3));
      await client.turn("t2c", "idle");
      expect(seen[2].body.messages[0].content).toBe(DEFAULT_SYSTEM_PROMPT);
      expect((await admin("PATCH", "/admin/config", { agent: { systemPrompt: "x".repeat(8001) } })).status).toBe(400);

      await admin("PATCH", "/admin/config", { agent: { backend: "gateway" } });
      client.send({ t: "text", turnId: "t3", text: "back" });
      expect((await client.turn("t3", "error")).detail).toBe("not connected to OpenClaw");
    } finally {
      chat.close();
    }
  });

  it("tries a chat endpoint before it is saved, and stores nothing", async () => {
    const { createServer } = await import("node:http");
    const auths: (string | undefined)[] = [];
    const chat = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        auths.push(req.headers.authorization);
        if (req.url !== "/v1/chat/completions") return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ready" } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((r) => chat.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(chat.address() as any).port}`;
    try {
      const before = (await admin("GET", "/admin/config")).body;
      const good = await admin("POST", "/admin/config/test-agent", { url: `${base}/v1/chat/completions`, model: "m1", token: "typed" });
      expect(good.body).toMatchObject({ ok: true, reply: "ready", model: "m1" });
      expect(auths.at(-1)).toBe("Bearer typed");
      expect((await admin("GET", "/admin/config")).body).toEqual(before);

      const wrongPath = await admin("POST", "/admin/config/test-agent", { url: `${base}/nope`, model: "m1" });
      expect(wrongPath.body).toMatchObject({ ok: false, error: "agent answered HTTP 404" });
    } finally {
      chat.close();
    }
    const dead = await admin("POST", "/admin/config/test-agent", { url: `${base}/v1/chat/completions`, model: "m1" });
    expect(dead.body.ok).toBe(false);
    expect(dead.body.error).toMatch(/could not connect/);
    expect((await admin("POST", "/admin/config/test-agent", { url: "ftp://x", model: "m" })).status).toBe(400);
  });

  it("changes the gateway address at runtime", async () => {
    const changed = await admin("PATCH", "/admin/gateway", { url: "http://gw.test:18789" });
    expect(changed.body.url).toBe("ws://gw.test:18789/");
    expect(changed.body.commands).toContain("vortex.axis.say");
    expect((await admin("PATCH", "/admin/gateway", { url: "ftp://nope" })).status).toBe(400);
    expect((await admin("PATCH", "/admin/gateway", { url: null })).body.url ?? null).toBeNull();
  });
});

describe("speech test", () => {
  const agent: Agent = { reply: async function* () {}, healthy: async () => true };

  it("synthesizes a sentence and transcribes it back", async () => {
    let heardBytes = 0;
    const tts: TextToSpeech = {
      format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
      synthesize: () =>
        (async function* () {
          yield Buffer.alloc(24000, 1); // half a second
          yield Buffer.alloc(24001, 1); // plus a stray byte
        })(),
      healthy: async () => true,
    };
    const stt: SpeechToText = {
      transcribe: async (pcm, format) => {
        heardBytes = pcm.length;
        expect(format.sampleRate).toBe(16000);
        return "Testing one two three";
      },
      healthy: async () => true,
    };
    await restart({}, { stt, tts, agent });

    const report = (await admin("POST", "/admin/config/test")).body;
    expect(report.tts).toMatchObject({ ok: true, audioSeconds: 1 });
    expect(report.stt).toMatchObject({ ok: true, heard: "Testing one two three" });
    expect(report.agent.ok).toBe(true);
    expect(heardBytes).toBe(32000); // one second at 16 kHz
  });

  it("says what is missing or broken", async () => {
    const report = (await admin("POST", "/admin/config/test")).body;
    expect(report.tts).toEqual({ ok: false, error: "not set" });
    expect(report.stt).toEqual({ ok: false, error: "not set" });
    expect(report.agent.ok).toBe(false);

    const broken: TextToSpeech = {
      format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
      synthesize: () =>
        (async function* (): AsyncGenerator<Buffer> {
          throw new Error("speech synthesis answered HTTP 500");
        })(),
      healthy: async () => false,
    };
    await restart({}, { tts: broken, stt: { transcribe: async () => "", healthy: async () => true } });
    const second = (await admin("POST", "/admin/config/test")).body;
    expect(second.tts).toEqual({ ok: false, error: "speech synthesis answered HTTP 500" });
    expect(second.stt.ok).toBe(true);
  });
});

describe("resample", () => {
  it("keeps the duration and the level", () => {
    const input = Buffer.alloc(48000);
    for (let i = 0; i < 24000; i++) input.writeInt16LE(1000, i * 2);
    const output = resample(input, 24000, 16000);
    expect(output.length).toBe(32000);
    expect(output.readInt16LE(0)).toBe(1000);
    expect(output.readInt16LE(output.length - 2)).toBe(1000);
    expect(resample(input, 16000, 16000)).toBe(input);
  });
});
