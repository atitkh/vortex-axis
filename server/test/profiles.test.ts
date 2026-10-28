import { describe, expect, it } from "vitest";
import { UPSTREAM_AUDIO_FORMAT } from "@vortex-axis/protocol";
import type { Agent } from "../src/agent.js";
import { createInvokeHandler } from "../src/commands.js";
import { deviceInfo } from "../src/deviceinfo.js";
import { activeProfile, batterySaver, withProfile } from "../src/profiles.js";
import { withQuiet } from "../src/quiet.js";
import type { SpeechToText, TextToSpeech } from "../src/speech.js";
import { admin, ctx, ready, useServer } from "./harness.js";

const spoken: string[] = [];
const asked: string[] = [];
const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: (text) =>
    (async function* () {
      spoken.push(text);
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
const stt: SpeechToText = { transcribe: async () => "what time is it", healthy: async () => true };
const agent: Agent = {
  reply: (message) =>
    (async function* () {
      asked.push(message);
      yield "It is eight.";
    })(),
  healthy: async () => true,
};
useServer(() => {
  spoken.length = 0;
  asked.length = 0;
  return { tts, stt, agent };
});

function invoke(command: string, params: Record<string, unknown> = {}) {
  const { hub, store, timers, delivery, activity } = ctx.app;
  return createInvokeHandler({ hub, store, timers, delivery, activity, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(
    command,
    params,
  ) as Promise<any>;
}

/** Settings a board declares, so profiles have something to act on. */
const BOARD_SETTINGS = [
  { key: "brightness", label: "Brightness", kind: "number", group: "Screen", min: 10, max: 255, default: 200 },
  { key: "maxFps", label: "Frame rate", kind: "choice", group: "Screen", options: ["20", "30", "45", "60"], default: "30" },
  { key: "volume", label: "Volume", kind: "number", group: "Sound", min: 0, max: 100, default: 60 },
  { key: "listenCue", label: "Listening cue", kind: "toggle", group: "Sound", default: 1 },
  { key: "taskChime", label: "Task chime", kind: "toggle", group: "Sound", default: 1 },
] as const;

describe("profile overrides", () => {
  it("caps power saver and sets silent, only on keys the device has", () => {
    expect(withProfile({ brightness: 220, maxFps: "60", volume: 70 }, "power-saver")).toEqual({ brightness: 100, maxFps: "15", volume: 70 });
    // A lower value the device already has stays.
    expect(withProfile({ brightness: 50 }, "power-saver")).toEqual({ brightness: 50 });
    // Declared defaults count as the device's own when nothing is saved.
    expect(withProfile({}, "power-saver", { brightness: 200, maxFps: "30" })).toEqual({ brightness: 100, maxFps: "15" });
    expect(withProfile({ volume: 60, listenCue: 1 }, "silent", { taskChime: 1 })).toEqual({ volume: 0, listenCue: 0, taskChime: 0 });
    expect(withProfile({ location: "den" }, "silent")).toEqual({ location: "den" });
    expect(withProfile({ brightness: 220 }, "normal")).toEqual({ brightness: 220 });
  });

  it("comes between the device's settings and quiet hours, which stay the cap", () => {
    const quiet = { quietFrom: "00:00", quietTo: "23:59", quietVolume: 25, quietBrightness: 40 };
    const device = { volume: 80, brightness: 220, ...quiet };
    const atNoon = Date.UTC(2026, 0, 15, 12, 0);
    // Power saver lowers brightness to 100, quiet hours lower it further and cap volume.
    const out = withQuiet(withProfile(device, "power-saver"), atNoon, "UTC");
    expect(out.brightness).toBeLessThanOrEqual(40);
    expect(out.volume).toBe(25);
    // Silent's 0 is not raised by quiet hours.
    expect(withQuiet(withProfile(device, "silent"), atNoon, "UTC").volume).toBe(0);
  });
});

describe("the battery rule", () => {
  it("turns power saver on at the level, off ten above it or when charging", () => {
    expect(batterySaver(false, 20, false, 20)).toBe(true);
    expect(batterySaver(false, 21, false, 20)).toBe(false);
    // Between the level and level + 10 it keeps what it was.
    expect(batterySaver(true, 25, false, 20)).toBe(true);
    expect(batterySaver(false, 25, false, 20)).toBe(false);
    expect(batterySaver(true, 30, false, 20)).toBe(false);
    expect(batterySaver(true, 10, true, 20)).toBe(false);
    expect(batterySaver(true, undefined, false, 20)).toBe(false);
    expect(batterySaver(false, 5, false, 0)).toBe(false);
  });

  it("lets a manual choice beat the rule", () => {
    expect(activeProfile("auto", true)).toEqual({ profile: "power-saver", reason: "battery" });
    expect(activeProfile(undefined, false)).toEqual({ profile: "normal", reason: "auto" });
    expect(activeProfile("silent", true)).toEqual({ profile: "silent", reason: "manual" });
    expect(activeProfile("normal", true)).toEqual({ profile: "normal", reason: "manual" });
  });

  it("puts a board on power saver from its readings and back when it charges", async () => {
    const { identity, client } = await ready(["mic", "speaker", "screen"], { name: "Desk board" });
    client.send({ t: "describe", settings: BOARD_SETTINGS as any, actions: [], links: [] });
    client.send({ t: "sense", readings: { battery: 15, charging: 0 } });
    const saving = await client.next("settings", 0, (m) => m.values.maxFps === "15");
    expect(saving.values).toMatchObject({ brightness: 100, maxFps: "15" });
    // Volume is not the profile's business.
    expect(saving.values.volume).toBeUndefined();
    expect(saving.values.profile).toBeUndefined();
    expect((await invoke("vortex.axis.sense", { client: "Desk board" })).readings[0].info).toMatchObject({ profile: "power-saver", profileReason: "battery" });

    client.send({ t: "sense", readings: { battery: 16, charging: 1 } });
    await expect.poll(() => ctx.app.hub.profile({ id: identity.clientId, type: "web" })).toEqual({ profile: "normal", reason: "auto" });
    // Back to the board's own values: nothing saved, so its declared defaults apply again.
    const last = () => (client.received.filter((m) => m.t === "settings").at(-1) as any).values;
    await expect.poll(() => last().maxFps).toBeUndefined();
    expect(last().brightness).toBeUndefined();
  });

  it("does not change a manual silent", async () => {
    const { identity, client } = await ready(["mic", "speaker", "screen"], { name: "Desk board" });
    client.send({ t: "describe", settings: BOARD_SETTINGS as any, actions: [], links: [] });
    await expect.poll(() => ctx.app.store.getSchema("web")?.settings.length).toBe(BOARD_SETTINGS.length);
    await invoke("vortex.axis.config", { client: "Desk board", key: "profile", value: "silent" });
    await client.next("settings", 0, (m) => m.values.volume === 0);
    client.send({ t: "sense", readings: { battery: 5, charging: 0 } });
    await expect.poll(() => ctx.app.hub.profile({ id: identity.clientId, type: "web" })).toEqual({ profile: "silent", reason: "manual" });
  });
});

describe("the silent profile", () => {
  it("is switched by the config tool, checked, and reported back", async () => {
    await ready(["speaker", "screen"], { name: "Desk board" });
    const set = await invoke("vortex.axis.config", { client: "Desk board", key: "profile", value: "silent" });
    expect(set.profile).toEqual({ profile: "silent", reason: "manual" });
    await expect(invoke("vortex.axis.config", { client: "Desk board", key: "profile", value: "loud" })).rejects.toThrow(/profile must be one of/);
    const back = await invoke("vortex.axis.config", { client: "Desk board", key: "profile", value: "auto" });
    expect(back.profile).toEqual({ profile: "normal", reason: "auto" });
  });

  it("shows `say` as text on a screen, even when urgent", async () => {
    const { client } = await ready(["speaker", "screen"], { name: "Desk board" });
    await invoke("vortex.axis.config", { client: "Desk board", key: "profile", value: "silent" });
    const said = await invoke("vortex.axis.say", { text: "The dryer is done.", client: "Desk board", urgent: true });
    expect(said).toMatchObject({ heard: false, shown: true });
    expect(said.note).toMatch(/silent/);
    expect((await client.next("reply.text", 0, (m) => m.final)).text).toBe("The dryer is done.");
    expect(client.received.some((m) => m.t === "speak.start")).toBe(false);
    expect(spoken).toEqual([]);
  });

  it("keeps `say` for a device with no screen until it leaves silent", async () => {
    const { client } = await ready(["speaker"], { name: "Puck" });
    await invoke("vortex.axis.config", { client: "Puck", key: "profile", value: "silent" });
    const said = await invoke("vortex.axis.say", { text: "Hello.", client: "Puck" });
    expect(said).toMatchObject({ heard: false, shown: false, held: true });
    expect(spoken).toEqual([]);

    await invoke("vortex.axis.config", { client: "Puck", key: "profile", value: "auto" });
    const end = await client.next("speak.end");
    client.send({ t: "playback", turnId: end.turnId, state: "finished" });
    expect(spoken).toEqual(["Hello."]);
  });

  it("answers a voice turn in text and tells the agent the device is silent", async () => {
    const { client } = await ready(["mic", "speaker", "screen"], { name: "Desk board" });
    await invoke("vortex.axis.config", { client: "Desk board", key: "profile", value: "silent" });
    client.send({ t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT });
    client.sendAudio(Buffer.alloc(16000, 2));
    client.send({ t: "audio.end", turnId: "t1", reason: "silence" });
    expect((await client.next("reply.text", 0, (m) => m.final)).text).toBe("It is eight.");
    await client.turn("t1", "idle");
    expect(client.received.some((m) => m.t === "speak.start")).toBe(false);
    expect(spoken).toEqual([]);
    expect(asked[0]).toMatch(/^\[from: Desk board, .*, profile: silent \(nothing is spoken here/);
  });

  it("is shown in the device's info and spoken summary", () => {
    const client = { id: "c1", name: "Desk board", type: "web", capabilities: [], createdAt: 0, lastSeenAt: 0 } as any;
    const info = deviceInfo({ client, settings: {}, profile: { profile: "power-saver", reason: "battery" } }, 0);
    expect(info).toMatchObject({ profile: "power-saver", profileReason: "battery" });
    expect(deviceInfo({ client, settings: {} }, 0)).toMatchObject({ profile: "normal", profileReason: "auto" });
  });
});

describe("the power saver level", () => {
  it("is a hub setting from 0 to 90", async () => {
    expect((await admin("PATCH", "/admin/integrations", { powerSaverBelow: 30 })).body.settings.powerSaverBelow).toBe(30);
    expect((await admin("PATCH", "/admin/integrations", { powerSaverBelow: 95 })).status).toBe(400);
  });
});
