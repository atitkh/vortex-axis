import { describe, expect, it } from "vitest";
import { createInvokeHandler } from "../src/commands.js";
import { isQuiet, minuteOfDay, minutesOf, withQuiet } from "../src/quiet.js";
import { declaredDefaults } from "../src/schema.js";
import type { TextToSpeech } from "../src/speech.js";
import { admin, ctx, ready, useServer } from "./harness.js";

const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: () =>
    (async function* () {
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
useServer(() => ({ tts }));

function invoke(command: string, params: Record<string, unknown> = {}) {
  const { hub, store, timers, delivery, activity } = ctx.app;
  return createInvokeHandler({ hub, store, timers, delivery, activity, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(
    command,
    params,
  ) as Promise<any>;
}

const at = (hhmm: string) => Date.UTC(2026, 0, 15, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)));

describe("quiet hours, by the clock", () => {
  it("reads times of day and nothing else", () => {
    expect(minutesOf("22:30")).toBe(1350);
    expect(minutesOf(" 7:05 ")).toBe(425);
    for (const bad of ["", "25:00", "12:60", "noon", 7, null]) expect(minutesOf(bad)).toBeUndefined();
  });

  it("knows the time of day in another zone", () => {
    expect(minuteOfDay(at("06:30"), "UTC")).toBe(390);
    // Chicago is six hours behind UTC in January.
    expect(minuteOfDay(at("06:30"), "America/Chicago")).toBe(30);
  });

  it("covers a stretch within a day and one over midnight", () => {
    const night = { quietFrom: "22:30", quietTo: "07:00" };
    expect(isQuiet(night, at("23:00"), "UTC")).toBe(true);
    expect(isQuiet(night, at("06:59"), "UTC")).toBe(true);
    expect(isQuiet(night, at("07:00"), "UTC")).toBe(false);
    expect(isQuiet(night, at("12:00"), "UTC")).toBe(false);
    const nap = { quietFrom: "13:00", quietTo: "14:00" };
    expect(isQuiet(nap, at("13:30"), "UTC")).toBe(true);
    expect(isQuiet(nap, at("14:00"), "UTC")).toBe(false);
    for (const none of [{}, { quietFrom: "22:00" }, { quietFrom: "08:00", quietTo: "08:00" }]) expect(isQuiet(none, at("23:00"), "UTC")).toBe(false);
  });

  it("caps volume and brightness in quiet hours, and only where the device has them", () => {
    const night = { quietFrom: "22:00", quietTo: "07:00", volume: 87, brightness: 255 };
    expect(withQuiet(night, at("23:00"), "UTC")).toMatchObject({ volume: 25, brightness: 40 });
    expect(withQuiet({ ...night, quietVolume: 10, quietBrightness: 5 }, at("23:00"), "UTC")).toMatchObject({ volume: 10, brightness: 5 });
    // Already quieter than the cap: left alone.
    expect(withQuiet({ ...night, volume: 12 }, at("23:00"), "UTC").volume).toBe(12);
    expect(withQuiet(night, at("12:00"), "UTC")).toMatchObject({ volume: 87, brightness: 255 });
    expect("brightness" in withQuiet({ quietFrom: "22:00", quietTo: "07:00", volume: 50 }, at("23:00"), "UTC")).toBe(false);
  });

  it("caps what a device declares when nothing is saved for it, and leaves saved values first", () => {
    const night = { quietFrom: "22:00", quietTo: "07:00" };
    // A computer: no volume saved, its own default 100.
    expect(withQuiet(night, at("23:00"), "UTC", { volume: 100 })).toMatchObject({ volume: 25 });
    expect(withQuiet(night, at("12:00"), "UTC", { volume: 100 }).volume).toBeUndefined();
    // A board with a volume saved for its type: that one is capped, whatever its default.
    expect(withQuiet({ ...night, volume: 87 }, at("23:00"), "UTC", { volume: 60, brightness: 200 })).toMatchObject({ volume: 25, brightness: 40 });
    expect(withQuiet({ ...night, volume: 10 }, at("23:00"), "UTC", { volume: 60 }).volume).toBe(10);
    // Nothing saved and nothing declared (the web client): still nothing.
    expect("volume" in withQuiet(night, at("23:00"), "UTC", {})).toBe(false);
    expect(declaredDefaults({ settings: [{ key: "volume", label: "V", kind: "number", default: "100" }, { key: "brightness", label: "B", kind: "number" }], actions: [], links: [] }, ["volume", "brightness"])).toEqual({ volume: 100 });
  });
});

describe("quiet hours on a device", () => {
  /** A stretch that includes this very minute, wherever and whenever the test runs. */
  function aroundNow() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = minuteOfDay(Date.now(), zone);
    const hhmm = (m: number) => `${String(Math.floor(((m + 1440) % 1440) / 60)).padStart(2, "0")}:${String((m + 1440) % 60).padStart(2, "0")}`;
    return { quietFrom: hhmm(now - 5), quietTo: hhmm(now + 120) };
  }

  it("sends a quieter volume, shows what an agent says without sound, and speaks what is urgent", async () => {
    const { identity, client } = await ready(["speaker", "screen"], { name: "Bedside" });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 80, ...aroundNow() } });
    const settings = await client.next("settings", 0, (m) => m.values.quietFrom !== undefined);
    expect(settings.values.volume).toBe(25);

    const shown = await invoke("vortex.axis.say", { text: "The dryer is done.", client: "Bedside" });
    expect(shown).toMatchObject({ client: "Bedside", heard: false, shown: true });
    expect(shown.note).toMatch(/quiet hours/);
    expect(client.received.some((m) => m.t === "speak.start")).toBe(false);
    expect((await client.next("reply.text", 0, (m) => m.final)).text).toBe("The dryer is done.");

    const spoken = invoke("vortex.axis.say", { text: "Smoke alarm.", client: "Bedside", urgent: true });
    const end = await client.next("speak.end");
    client.send({ t: "playback", turnId: end.turnId, state: "finished" });
    expect(await spoken).toMatchObject({ heard: true });
  });

  it("quietens a computer that keeps its own volume, from what it declares", async () => {
    const { identity, client } = await ready(["speaker", "screen"], { name: "Desk" });
    client.send({ t: "describe", settings: [{ key: "volume", label: "Volume", kind: "number", group: "Sound", min: 0, max: 100, unit: "%", default: 100 }], actions: [], links: [] });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: aroundNow() });
    expect((await client.next("settings", 0, (m) => m.values.quietFrom !== undefined)).values.volume).toBe(25);
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { quietVolume: 40 } });
    expect((await client.next("settings", 0, (m) => m.values.quietVolume === 40)).values.volume).toBe(40);
  });

  it("leaves a device with no screen alone", async () => {
    const { identity } = await ready(["speaker"], { name: "Puck" });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: aroundNow() });
    const said = await invoke("vortex.axis.say", { text: "Hello.", client: "Puck" });
    expect(said).toMatchObject({ heard: false, shown: false });
    expect(said.note).toMatch(/quiet hours/);
  });
});
