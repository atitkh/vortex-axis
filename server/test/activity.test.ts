import { describe, expect, it } from "vitest";
import { Activity, percentile } from "../src/activity.js";
import { Store } from "../src/store.js";

const HOUR = 3_600_000;

/** A store and an activity log on a clock the test moves by hand. */
function setup() {
  let clock = 1_000 * HOUR;
  const now = () => clock;
  const store = new Store(":memory:", now);
  const activity = new Activity(store, { retentionMs: 7 * 24 * HOUR, now });
  return { store, activity, advance: (ms: number) => (clock += ms), now };
}

describe("the activity log", () => {
  it("draws a timeline from state changes and works out availability", () => {
    const { activity, advance } = setup();
    activity.start();
    activity.state("service", "stt", "up", "Speech recognition up");
    advance(HOUR);
    activity.state("service", "stt", "down", "Speech recognition down", "bad");
    advance(HOUR);
    activity.state("service", "stt", "up", "Speech recognition up");
    advance(2 * HOUR);

    const stt = activity.summary(4).services.find((s) => s.key === "stt")!;
    expect(stt.segments.map((s) => [s.state, (s.to - s.from) / HOUR])).toEqual([["up", 1], ["down", 1], ["up", 2]]);
    expect(stt.availability).toBeCloseTo(0.75);
  });

  it("writes only changes, so repeated health checks add nothing", () => {
    const { activity, store, now } = setup();
    activity.start();
    for (let i = 0; i < 5; i++) activity.state("service", "tts", "up", "Speech synthesis up");
    expect(store.eventsBetween(0, now() + 1).filter((e) => e.subject === "tts")).toHaveLength(1);
  });

  it("marks the time Axis was down after a crash, and clients start offline after a restart", () => {
    const { store, activity, advance, now } = setup();
    const { code } = store.createPairingCode(60_000);
    const desk = store.pair({ code, type: "board", version: "1", capabilities: ["speaker"], name: "Desk" })!.client;
    activity.start();
    activity.state("client", desk.id, "online", "Desk connected");
    advance(HOUR);
    // A crash: nothing is written at the end, only the last "still running" note is left.
    store.setMeta("alive_at", String(now()));
    advance(HOUR);
    const restarted = new Activity(store, { retentionMs: 7 * 24 * HOUR, now });
    restarted.start();
    advance(HOUR);

    const summary = restarted.summary(3);
    expect(summary.axis.segments.map((s) => s.state)).toEqual(["up", "down", "up"]);
    expect(summary.events.some((e) => /without shutting down/.test(e.text))).toBe(true);
    // Online, then nothing known while Axis was down, then offline: it has not come back.
    const line = summary.clients.find((c) => c.id === desk.id)!;
    expect(line.segments.map((s) => s.state)).toEqual(["online", "axis_down", "offline"]);
    expect(line.availability).toBeCloseTo(1 / 3);
  });

  it("keeps a turn's timings and sums them up by hour", () => {
    const { activity, advance, now } = setup();
    activity.start();
    const base = { clientId: "c_1", kind: "voice" as const, heard: true, totalMs: 4000 };
    activity.turn({ ...base, at: now(), outcome: "answered", sttMs: 200, agentMs: 1500, firstAudioMs: 2500 }, "Desk");
    advance(HOUR);
    activity.turn({ ...base, at: now(), outcome: "failed", error: "agent answered HTTP 502" }, "Desk");
    advance(1);

    const summary = activity.summary(24);
    expect(summary.turns).toMatchObject({ count: 2, answered: 1, failed: 1, firstAudioP50: 2500, sttP50: 200, agentP50: 1500, synthesisP50: 800 });
    expect(summary.turns.buckets).toHaveLength(24);
    expect(summary.events.some((e) => e.level === "bad" && /Turn on Desk failed: agent answered HTTP 502/.test(e.text))).toBe(true);
  });

  it("forgets what is older than the retention period", () => {
    const { store, activity, advance, now } = setup();
    activity.start();
    activity.note("admin", "", "an old change");
    advance(8 * 24 * HOUR);
    new Activity(store, { retentionMs: 7 * 24 * HOUR, now }).start();
    expect(store.eventsBetween(0, now() + 1).some((e) => e.text === "an old change")).toBe(false);
  });

  it("records nothing after it stopped", () => {
    const { store, activity, now } = setup();
    activity.start();
    activity.stop();
    activity.note("admin", "", "too late");
    expect(store.eventsBetween(0, now() + 1).some((e) => e.text === "too late")).toBe(false);
  });
});

describe("percentile", () => {
  it("ignores missing values and picks the nearest rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([undefined, 300, 100, 200], 50)).toBe(200);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
});
