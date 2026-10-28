import { afterEach, describe, expect, it, vi } from "vitest";
import type { Capability, ScalarMap } from "@vortex-axis/protocol";
import { createInvokeHandler } from "../src/commands.js";
import { deviceInfo, duration, lowest, signalLabel, spokenSummary, type DeviceInfo } from "../src/deviceinfo.js";
import type { ClientChange } from "../src/hub.js";
import type { LiveEvent } from "../src/live.js";
import { startMapFeed } from "../src/mapfeed.js";
import type { ClientRecord } from "../src/store.js";
import { ADMIN_TOKEN, admin, ctx, ready, useServer } from "./harness.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function record(extra: Partial<ClientRecord> = {}): ClientRecord {
  const capabilities: Capability[] = ["mic", "speaker", "screen"];
  return { id: "c1", name: "Desk board", type: "waveshare-amoled-1.8", capabilities, reported: capabilities, off: [], version: "0.20.1", createdAt: 0, lastSeenAt: null, ...extra };
}

const online = (readings: ScalarMap, extra: Partial<ClientRecord> = {}, settings: ScalarMap = {}) =>
  deviceInfo({ client: record(extra), settings, session: { connectedAt: NOW - 3 * 86_400_000, readings } }, NOW);

describe("deviceInfo", () => {
  it("labels the vitals it was given and leaves out the rest", () => {
    const info = online({ battery: 62, charging: 1, rssi: -55, uptimeS: 3 * 86_400 + 5, heap: 120_000, lastStart: "power on", touchesToday: 4 }, {}, { location: "Office" });
    expect(info).toMatchObject({ online: true, state: "idle", location: "Office", kind: "board", offlineAfterMs: 15 * 60_000, attention: [] });
    expect(info.vitals).toEqual({
      battery: { percent: 62, label: "ok", charging: true },
      signal: { rssi: -55, label: "strong" },
      uptime: { seconds: 259_205, text: "3 days" },
      memory: { freeBytes: 120_000 },
      usage: { touchesToday: 4 },
      lastRestart: "power on",
    });
    expect(online({}).vitals).toEqual({});
    expect(online({ battery: "n/a", rssi: "" }).vitals).toEqual({});
  });

  it("puts signal into words by dBm", () => {
    expect([-50, -60, -61, -70, -71, -80, -81].map(signalLabel)).toEqual(["strong", "strong", "ok", "ok", "weak", "weak", "poor"]);
  });

  it("lists a low battery not charging, weak Wi-Fi and a different build held", () => {
    expect(online({ battery: 14, rssi: -83 }).attention).toEqual(["battery low (14%)", "poor Wi-Fi (-83 dBm)"]);
    expect(online({ battery: 19, charging: 1 }).attention).toEqual([]);
    expect(online({ battery: 20, rssi: -70 }).attention).toEqual([]);
    const held = deviceInfo({ client: record(), settings: {}, session: { connectedAt: NOW, readings: {} }, held: "0.21.0" }, NOW);
    expect(held.updateAvailable).toBe("0.21.0");
    expect(held.attention).toEqual(["old firmware (0.20.1; 0.21.0 is available)"]);
    expect(deviceInfo({ client: record(), settings: {}, session: { connectedAt: NOW, readings: {} }, held: "0.20.1" }, NOW).attention).toEqual([]);
  });

  it("lists a device offline past its alert time, by kind and setting, as the admin page does", () => {
    const away = (ms: number, extra: Partial<ClientRecord> = {}, settings: ScalarMap = {}) =>
      deviceInfo({ client: record({ lastSeenAt: NOW - ms, ...extra }), settings }, NOW);
    expect(away(14 * 60_000).attention).toEqual([]);
    expect(away(3 * HOUR)).toMatchObject({ online: false, state: "offline", attention: ["offline for 3 hours"] });
    const desktop: Capability[] = ["desktop"];
    expect(away(3 * HOUR, { reported: desktop, capabilities: desktop })).toMatchObject({ kind: "computer", attention: [] });
    expect(away(13 * HOUR, { reported: desktop, capabilities: desktop }).attention).toEqual(["offline for 13 hours"]);
    expect(away(30 * 86_400_000, { type: "web" })).toMatchObject({ kind: "browser", offlineAfterMs: null, attention: [] });
    expect(away(11 * 60_000, { type: "web" }, { offlineAlert: "always" }).attention).toEqual(["offline for 11 minutes"]);
    expect(away(3 * HOUR, {}, { offlineAlert: "never" }).attention).toEqual([]);
    expect(deviceInfo({ client: record(), settings: {} }, NOW).attention).toEqual(["never connected"]);
  });

  it("takes the state from what the device is doing", () => {
    const info = deviceInfo({ client: record(), settings: {}, session: { connectedAt: NOW, readings: {} }, now: { clientId: "c1", state: "speaking", since: NOW - 500 } }, NOW);
    expect(info).toMatchObject({ state: "speaking", stateSince: NOW - 500 });
  });
});

describe("spoken summary", () => {
  it("says one sentence", () => {
    expect(spokenSummary(online({ battery: 62, charging: 1, rssi: -55, uptimeS: 3 * 86_400 }), NOW)).toBe("Desk board: online, battery 62% and charging, strong Wi-Fi, up 3 days.");
    expect(spokenSummary(online({ battery: 9, rssi: -75 }), NOW)).toBe("Desk board: online, battery 9%, low, weak Wi-Fi.");
    expect(spokenSummary(online({ onPower: 1, uptimeS: 3700 }, { name: "Laptop" }), NOW)).toBe("Laptop: online, on power, up 1 hour.");
    expect(spokenSummary(deviceInfo({ client: record({ lastSeenAt: NOW - 2 * HOUR }), settings: {}, held: "0.21.0" }, NOW), NOW)).toBe(
      "Desk board: offline for 2 hours, an update is waiting.",
    );
  });

  it("finds the lowest battery, else the weakest signal", () => {
    const infos: DeviceInfo[] = [online({ battery: 40 }, { name: "A" }), online({ battery: 12 }, { name: "B" }), online({ battery: 5, charging: 1 }, { name: "C" })];
    expect(lowest(infos)).toEqual({ client: "B", reason: "battery 12%" });
    expect(lowest([online({ rssi: -60 }, { name: "A" }), online({ rssi: -78 }, { name: "B" })])).toEqual({ client: "B", reason: "weak Wi-Fi (-78 dBm)" });
    expect(lowest([online({})])).toBeUndefined();
  });

  it("words spans", () => {
    expect([30_000, 60_000, 2 * HOUR + 59 * 60_000, 86_400_000].map(duration)).toEqual(["less than a minute", "1 minute", "2 hours", "1 day"]);
  });
});

describe("the map's stream", () => {
  afterEach(() => vi.useRealTimers());

  function feed() {
    vi.useFakeTimers();
    let change: (id: string, c: ClientChange) => void = () => {};
    let live: (e: LiveEvent) => void = () => {};
    const sent: { event: string; data: any }[] = [];
    let n = 0;
    const stop = startMapFeed({
      info: (id) => ({ id, n: ++n }) as unknown as DeviceInfo,
      onClientChange: (l) => ((change = l), () => {}),
      subscribeLive: (l) => ((live = l), () => {}),
      send: (event, data) => sent.push({ event, data }),
      now: () => Date.now(),
    });
    return { sent, stop, change: (id: string, c: ClientChange) => change(id, c), live: (e: LiveEvent) => live(e) };
  }

  it("sends readings at most once per 5 s per device, the latest last; online and offline at once", () => {
    const f = feed();
    f.change("a", "readings");
    f.change("a", "readings");
    f.change("a", "readings");
    f.change("b", "readings");
    expect(f.sent.map((s) => s.data.id)).toEqual(["a", "b"]);
    vi.advanceTimersByTime(4_999);
    expect(f.sent).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(f.sent.map((s) => s.data.id)).toEqual(["a", "b", "a"]);
    f.change("b", "offline");
    expect(f.sent.at(-1)).toEqual({ event: "client", data: { id: "b", n: 4 } });
    vi.advanceTimersByTime(10_000);
    expect(f.sent).toHaveLength(4);
    f.stop();
  });

  it("sends each turn stage once, without words", () => {
    const f = feed();
    const turn = { key: "t1", clientId: "a", client: "A", kind: "voice" as const, startedAt: 1, stages: [{ name: "listening" as const, at: 1 }], heard: "secret" };
    f.live({ type: "turn", turn });
    f.live({ type: "turn", turn: { ...turn, said: "more" } });
    f.live({ type: "turn", turn: { ...turn, stages: [...turn.stages, { name: "thinking", at: 2 }] } });
    f.live({ type: "turn", turn: { ...turn, endedAt: 3, outcome: "answered" } });
    const turns = f.sent.filter((s) => s.event === "turn").map((s) => s.data);
    expect(turns).toEqual([
      { key: "t1", clientId: "a", stage: "listening", startedAt: 1 },
      { key: "t1", clientId: "a", stage: "thinking", startedAt: 1 },
      { key: "t1", clientId: "a", stage: "done", startedAt: 1, endedAt: 3, outcome: "answered" },
    ]);
    expect(f.sent.filter((s) => s.event === "client")).toHaveLength(3);
    f.stop();
  });
});

describe("through a running Axis", () => {
  useServer();

  const invoke = (command: string, params: Record<string, unknown> = {}) => {
    const { hub, store, timers, delivery, activity } = ctx.app;
    return createInvokeHandler({ hub, store, timers, delivery, activity, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(command, params) as Promise<any>;
  };

  it("sense keeps the raw readings and adds info and a summary for every device", async () => {
    const { client } = await ready(["mic", "speaker", "screen"], { name: "Desk", hello: { type: "board-x" } });
    await ready(["screen"], { name: "Hall", hello: { type: "board-x" } });
    client.send({ t: "sense", readings: { battery: 14, rssi: -50 } });
    await vi.waitFor(async () => expect((await invoke("vortex.axis.sense", { client: "Desk" })).readings[0].readings.battery).toBe(14));
    const one = await invoke("vortex.axis.sense", { client: "Desk" });
    expect(one.readings[0]).toMatchObject({ client: "Desk", readings: { battery: 14, rssi: -50 }, summary: "Desk: online, battery 14%, low, strong Wi-Fi.", info: { attention: ["battery low (14%)"] } });
    expect(one.lowest).toBeUndefined();
    const all = await invoke("vortex.axis.sense");
    expect(all.readings.map((r: any) => r.client).sort()).toEqual(["Desk", "Hall"]);
    expect(all.lowest).toEqual({ client: "Desk", reason: "battery 14%" });
  });

  it("serves the map to an admin only", async () => {
    expect((await fetch(`${ctx.base}/admin/map`)).status).toBe(401);
    expect((await fetch(`${ctx.base}/admin/map/stream`)).status).toBe(401);
    const { identity } = await ready(["mic", "speaker"], { name: "Desk" });
    const map = (await admin("GET", "/admin/map")).body;
    expect(map.nodes).toHaveLength(1);
    expect(map.nodes[0]).toMatchObject({ id: identity.clientId, name: "Desk", online: true, state: "idle", kind: "browser" });
    expect(map.services.map((s: any) => s.id)).toEqual(expect.arrayContaining(["agent", "stt", "tts"]));
    expect(map.edges).toContainEqual({ from: identity.clientId, to: "axis", kind: "link" });
    expect(map.edges).toContainEqual({ from: "axis", to: "stt", kind: "speech" });
    expect(typeof map.at).toBe("number");
    const listed = (await admin("GET", "/admin/clients")).body.clients[0];
    expect(listed).toMatchObject({ kind: "browser", offlineAfterMs: null, offlineAfterAutoMs: null });
  });

  it("streams the snapshot, then a device as it reports", async () => {
    const stop = new AbortController();
    const res = await fetch(`${ctx.base}/admin/map/stream`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, signal: stop.signal });
    const reader = res.body!.getReader();
    let text = "";
    const read = async (pattern: RegExp) => {
      while (!pattern.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await read(/event: snapshot\ndata: .+\n\n/);
    const { client } = await ready(["mic", "speaker"], { name: "Desk" });
    await read(/event: client\ndata: .*"online":true/);
    client.send({ t: "sense", readings: { rssi: -77 } });
    await read(/"label":"weak"/);
    stop.abort();
  });
});
