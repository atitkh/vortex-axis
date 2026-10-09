import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPSTREAM_AUDIO_FORMAT } from "@vortex-axis/protocol";
import type { Agent } from "../src/agent.js";
import type { LiveTurn } from "../src/live.js";
import type { SpeechToText, TextToSpeech } from "../src/speech.js";
import { ADMIN_TOKEN, admin, ctx, ready, useServer } from "./harness.js";

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
    expect(body).toMatchObject({ homeAssistant: null, backup: null, notifications: { ready: true, clients: [] }, publicAddress: { hosts: [] } });
    expect(JSON.stringify(body)).not.toContain(ADMIN_TOKEN);
  });

  it("reports the last backup the script left word of", async () => {
    writeFileSync(join(ctx.dataDir, "backup-status.json"), JSON.stringify({ at: "2026-10-09T18:17:03Z", ok: true, to: "/mnt/copy", note: "" }));
    const { body } = await admin("GET", "/admin/integrations");
    expect(body.backup).toEqual({ at: Date.parse("2026-10-09T18:17:03Z"), ok: true, to: "/mnt/copy", note: "" });
  });
});
