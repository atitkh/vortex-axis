import { describe, expect, it } from "vitest";
import { UPSTREAM_AUDIO_FORMAT } from "@vortex-axis/protocol";
import type { Agent } from "../src/agent.js";
import { Live, type LiveTurn } from "../src/live.js";
import type { SpeechToText, TextToSpeech } from "../src/speech.js";
import { ADMIN_TOKEN, admin, ctx, ready, restart, useServer } from "./harness.js";

const stt: SpeechToText = { transcribe: async () => "what time is it", healthy: async () => true };
const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: () =>
    (async function* () {
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
const agent: Agent = {
  reply: () =>
    (async function* () {
      yield "It is eight o'clock.";
    })(),
  healthy: async () => true,
};
useServer(() => ({ stt, tts, agent }));

/** Reads the live stream the way the admin page does, collecting what arrives. */
async function watch() {
  const stop = new AbortController();
  const res = await fetch(`${ctx.base}/admin/live`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, signal: stop.signal });
  const events: { event: string; data: any }[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of res.body!) {
        pending += decoder.decode(chunk as Uint8Array, { stream: true });
        for (let cut = pending.indexOf("\n\n"); cut >= 0; cut = pending.indexOf("\n\n")) {
          const block = pending.slice(0, cut);
          pending = pending.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // The test closed the stream.
    }
  })();
  const until = async (found: () => unknown) => {
    const deadline = Date.now() + 3000;
    while (!found()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the live stream");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await until(() => events.length);
  return { res, events, until, stop: () => stop.abort() };
}

describe("live view", () => {
  it("shows a spoken turn stage by stage, with its words and timings", async () => {
    const { client } = await ready(["mic", "speaker", "screen"], { name: "Desk" });
    const stream = await watch();
    expect(stream.res.headers.get("content-type")).toBe("text/event-stream");
    expect(stream.events[0]).toMatchObject({ event: "snapshot", data: { turns: [] } });

    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(Buffer.alloc(3200, 1));
    client.send({ t: "audio.end", turnId: "t1", reason: "silence" });
    await client.next("speak.end");
    client.send({ t: "playback", turnId: "t1", state: "finished" });
    const ended = () => stream.events.find((e) => e.event === "turn" && e.data.outcome)?.data as LiveTurn | undefined;
    await stream.until(ended);

    expect(ended()).toMatchObject({
      client: "Desk",
      kind: "voice",
      heard: "what time is it",
      said: "It is eight o'clock.",
      outcome: "answered",
      played: true,
    });
    expect(ended()!.stages.map((s) => s.name)).toEqual(["listening", "transcribing", "thinking", "speaking"]);
    expect(ended()!.totalMs).toBeGreaterThanOrEqual(0);
    // Each stage was sent as it happened, not only at the end.
    expect(stream.events.filter((e) => e.event === "turn").length).toBeGreaterThan(4);

    // Somebody who opens the page afterwards sees the turn too.
    const later = await watch();
    expect(later.events[0]!.data.turns[0]).toMatchObject({ client: "Desk", outcome: "answered", heard: "what time is it" });
    stream.stop();
    later.stop();
  });

  it("closes a recording that was cancelled before it became a turn", async () => {
    const { client } = await ready(["mic", "speaker"]);
    const stream = await watch();
    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    client.send({ t: "audio.end", turnId: "t1", reason: "cancel" });
    await stream.until(() => stream.events.some((e) => e.event === "turn" && e.data.outcome === "cancelled"));
    stream.stop();
  });

  it("needs the admin token", async () => {
    expect((await fetch(`${ctx.base}/admin/live`)).status).toBe(401);
  });
});

describe("wake word log", () => {
  it("keeps every wake word a device reports, with its score and what came of it", async () => {
    const near = await ready(["mic", "speaker"], { name: "Near" });
    const far = await ready(["mic", "speaker"], { name: "Far" });
    const stream = await watch();
    far.client.send({ t: "wake", wakeId: "wf", score: 0.7, level: 0.9 });
    near.client.send({ t: "wake", wakeId: "wn", score: 0.95, level: 0.3 });
    await near.client.next("wake.result");
    await far.client.next("wake.result");

    const { body } = await admin("GET", "/admin/wakes");
    expect(body.wakes).toHaveLength(2);
    expect(body.wakes.find((w: any) => w.client === "Near")).toMatchObject({ score: 0.95, level: 0.3, outcome: "answered", word: "built-in" });
    expect(body.wakes.find((w: any) => w.client === "Far")).toMatchObject({ score: 0.7, outcome: "stood_down" });
    await stream.until(() => stream.events.filter((e) => e.event === "wake").length === 2);
    stream.stop();
  });
});

describe("announce from the admin page", () => {
  it("speaks on every client that can speak", async () => {
    const a = await ready(["speaker", "screen"], { name: "One" });
    const b = await ready(["speaker"], { name: "Two" });
    await ready(["screen"], { name: "Silent" });
    const sent = admin("POST", "/admin/announce", { text: "Dinner is ready." });
    for (const { client } of [a, b]) {
      const start = await client.next("speak.start");
      await client.next("speak.end");
      client.send({ t: "playback", turnId: start.turnId, state: "finished" });
    }
    const { status, body } = await sent;
    expect(status).toBe(200);
    expect(body.heard).toBe(true);
    expect(body.clients.map((c: any) => c.client).sort()).toEqual(["One", "Two"]);
  });

  it("speaks on one client when one is named, and keeps it for a client that is away", async () => {
    const { identity, client } = await ready(["speaker"], { name: "One" });
    const sent = admin("POST", "/admin/announce", { text: "Hello.", client: identity.clientId });
    const start = await client.next("speak.start");
    await client.next("speak.end");
    client.send({ t: "playback", turnId: start.turnId, state: "finished" });
    expect((await sent).body).toMatchObject({ heard: true, clients: [{ client: "One", heard: true }] });

    client.close();
    await client.closed();
    await new Promise((r) => setTimeout(r, 50));
    const away = await admin("POST", "/admin/announce", { text: "Hello again.", client: identity.clientId });
    expect(away.body.clients[0]).toMatchObject({ client: "One", held: true });
  });

  it("refuses an empty message, and says so when nobody can speak", async () => {
    expect((await admin("POST", "/admin/announce", { text: "  " })).status).toBe(400);
    expect((await admin("POST", "/admin/announce", { text: "Anyone?" })).status).toBe(409);
  });
});

describe("integrations", () => {
  it("says what Axis is connected to, without any secret", async () => {
    const { body } = await admin("GET", "/admin/integrations");
    expect(body).toMatchObject({ homeAssistant: null, backup: { configured: false }, notifications: { ready: true, clients: [] }, publicAddress: { hosts: [] } });
    expect(JSON.stringify(body)).not.toContain(ADMIN_TOKEN);
  });
});

describe("words held in memory", () => {
  const record = { at: 0, clientId: "c1", kind: "text" as const, outcome: "answered" as const, totalMs: 5, heard: false };

  it("are deleted ten minutes after a turn ends, and the timings stay", () => {
    let now = 1_000_000;
    const live = new Live(() => now);
    const events: string[] = [];
    live.subscribe((event) => events.push(event.type));
    live.stage({ id: "c1", name: "Desk" }, "t1", "text", "thinking");
    live.words("c1", "t1", { heard: "a secret", said: "an answer" });
    live.end("c1", "t1", record);
    now += 9 * 60_000;
    live.forgetOldWords();
    expect(live.snapshot()[0]).toMatchObject({ heard: "a secret", said: "an answer" });
    now += 2 * 60_000;
    live.forgetOldWords();
    // Gone from the object itself, not left out of a copy.
    expect(JSON.stringify(live.snapshot())).not.toMatch(/secret|answer"/);
    expect(live.snapshot()[0]).toMatchObject({ client: "Desk", outcome: "answered", totalMs: 5 });
    expect(events.at(-1)).toBe("snapshot");
  });

  it("are deleted at once when the view is cleared, and a turn still running carries on", () => {
    const live = new Live();
    live.stage({ id: "c1", name: "Desk" }, "t1", "text", "thinking");
    live.words("c1", "t1", { heard: "first" });
    live.end("c1", "t1", record);
    live.stage({ id: "c1", name: "Desk" }, "t2", "text", "thinking");
    live.words("c1", "t2", { heard: "second" });
    live.clear();
    expect(live.snapshot()).toHaveLength(1);
    expect(JSON.stringify(live.snapshot())).not.toMatch(/first|second/);
    live.end("c1", "t2", record);
    expect(live.snapshot()[0]).toMatchObject({ outcome: "answered" });
  });

  it("can be cleared from the admin page", async () => {
    const { client } = await ready(["screen"], { name: "Desk" });
    client.send({ t: "text", turnId: "t1", text: "what time is it" });
    await client.turn("t1", "idle");
    expect(Object.keys((await admin("GET", "/admin/now")).body.screens)).toHaveLength(1);
    const stream = await watch();
    expect(stream.events[0]!.data.turns[0].heard).toBe("what time is it");
    expect((await admin("POST", "/admin/live/clear")).status).toBe(200);
    await stream.until(() => stream.events.filter((e) => e.event === "snapshot").length === 2);
    expect(stream.events.at(-1)!.data.turns).toEqual([]);
    expect((await admin("GET", "/admin/now")).body.screens).toEqual({});
    stream.stop();
  });
});

describe("hub settings on the integrations page", () => {
  it("saves the clock and how long things are kept, and keeps them across a restart", async () => {
    const saved = await admin("PATCH", "/admin/integrations", { timeZone: "Asia/Kathmandu", activityDays: 3, messageHoldMinutes: 25 });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ timeZone: "Asia/Kathmandu", activityDays: 3, messageHoldMinutes: 25 });
    await restart();
    expect((await admin("GET", "/admin/integrations")).body.settings).toMatchObject({ timeZone: "Asia/Kathmandu", activityDays: 3, messageHoldMinutes: 25 });
  });

  it("refuses values that cannot work", async () => {
    for (const body of [{ timeZone: "Mars/Olympus" }, { activityDays: 0 }, { trustedProxies: "not-an-address" }, { publicHosts: "https://example.org" }, { mqtt: { port: 70000 } }]) {
      expect((await admin("PATCH", "/admin/integrations", body)).status).toBe(400);
    }
  });

  it("will not make the name the page is being used at a public one", async () => {
    const here = new URL(ctx.base).hostname;
    const refused = await admin("PATCH", "/admin/integrations", { publicHosts: [here] });
    expect(refused.status).toBe(400);
    expect((await admin("PATCH", "/admin/integrations", { publicHosts: "axis.example.org", trustedProxies: "10.0.0.1" })).body.settings).toMatchObject({
      publicHosts: ["axis.example.org"],
      trustedProxies: ["10.0.0.1"],
    });
    // The admin page is still here, and gone under the new public name.
    expect((await admin("GET", "/admin/status")).status).toBe(200);
    const elsewhere = await fetch(`${ctx.base}/admin/status`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "x-forwarded-host": "axis.example.org" } });
    expect(elsewhere.status).toBe(404);
  });

  it("sets up the Home Assistant link and never gives its password back", async () => {
    const { body } = await admin("PATCH", "/admin/integrations", { mqtt: { host: "127.0.0.1", port: 1, user: "axis", password: "hunter2-secret" } });
    expect(body.settings.mqtt).toEqual({ host: "127.0.0.1", port: 1, user: "axis", discoveryPrefix: "homeassistant", passwordSet: true });
    const shown = await admin("GET", "/admin/integrations");
    expect(shown.body.homeAssistant).toMatchObject({ broker: "127.0.0.1:1", user: "axis", connected: false });
    expect(JSON.stringify(shown.body)).not.toContain("hunter2");
    expect(JSON.stringify((await admin("GET", "/admin/activity")).body)).not.toContain("hunter2");
    // An empty password keeps the one there is; an empty host switches the link off.
    expect((await admin("PATCH", "/admin/integrations", { mqtt: { user: "other", password: "" } })).body.settings.mqtt).toMatchObject({ user: "other", passwordSet: true });
    await admin("PATCH", "/admin/integrations", { mqtt: { host: "" } });
    expect((await admin("GET", "/admin/integrations")).body.homeAssistant).toBeNull();
  });
});
