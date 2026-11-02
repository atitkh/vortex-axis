// The Speech page's ranked-list logic (web/speech-entries.js): reorder, drag-drop slots, add cap, delete, payload shape.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module
import * as se from "../../web/speech-entries.js";

const E = (id: string, extra = {}) => ({ id, key: id, enabled: true, label: id, kind: "openai", url: "http://x/" + id, model: "m", voice: "", sampleRate: 24000, apiKey: "", ...extra });
const ids = (l: Array<{ id?: string }>) => l.map((e) => e.id).join(",");

describe("speech entries", () => {
  it("moves up and down, clamped", () => {
    const l = [E("a"), E("b"), E("c")];
    expect(ids(se.moveEntry(l, 2, 1))).toBe("a,c,b");
    expect(ids(se.moveEntry(l, 0, 1))).toBe("b,a,c");
    expect(se.moveEntry(l, 0, -1)).toBe(l);
    expect(ids(se.moveEntry(l, 0, 99))).toBe("b,c,a");
  });
  it("finds the drop slot from card midpoints and drops there", () => {
    const mids = [10, 30, 50];
    expect(se.dropIndex(mids, 0)).toBe(0);
    expect(se.dropIndex(mids, 35)).toBe(2);
    expect(se.dropIndex(mids, 99)).toBe(3);
    const l = [E("a"), E("b"), E("c")];
    expect(ids(se.dropEntry(l, 0, 3))).toBe("b,c,a");
    expect(ids(se.dropEntry(l, 2, 0))).toBe("c,a,b");
    expect(se.dropEntry(l, 1, 1)).toBe(l);
    expect(se.dropEntry(l, 1, 2)).toBe(l);
  });
  it("adds up to 8 and deletes", () => {
    let l: any[] = [];
    for (let i = 0; i < 12; i++) l = se.addEntry(l);
    expect(l).toHaveLength(8);
    expect(se.canAdd(l)).toBe(false);
    expect(new Set(l.map((e: any) => e.key)).size).toBe(8);
    expect(l[0]).toMatchObject({ kind: "openai", enabled: true, url: "" });
    expect(se.removeEntry(l, 0)).toHaveLength(7);
  });
  it("builds the working copy from entries or the flat single-entry shape", () => {
    expect(se.entriesFromConfig({ entries: [{ id: "x", enabled: true, kind: "openai", url: "u", model: "m" }] })[0]).toMatchObject({ id: "x", key: "x", apiKey: "" });
    expect(se.entriesFromConfig({ url: "u", model: "m", kind: "openai" })).toHaveLength(1);
    expect(se.entriesFromConfig({})).toHaveLength(0);
  });
  it("patch: order kept, key omitted unless typed, new entry has no id", () => {
    const l = [E("b"), E("a", { apiKey: "sk-new" }), se.newEntry("elevenlabs")];
    const p = se.buildServicePatch("tts", l, "90");
    expect(p.cooldownSeconds).toBe(90);
    expect(p.entries.map((e: any) => e.id)).toEqual(["b", "a", undefined]);
    expect("apiKey" in p.entries[0]).toBe(false);
    expect(p.entries[1].apiKey).toBe("sk-new");
    expect("sampleRate" in p.entries[2]).toBe(false);
    expect(p.entries[0].sampleRate).toBe(24000);
    expect("voice" in se.buildServicePatch("stt", [E("a")], 60).entries[0]).toBe(false);
  });
  it("patch: rejects bad cooldown, bad rate, too many", () => {
    expect(() => se.buildServicePatch("stt", [E("a")], 4)).toThrow(/cooldown/);
    expect(() => se.buildServicePatch("stt", [E("a")], 3601)).toThrow(/cooldown/);
    expect(() => se.buildServicePatch("tts", [E("a", { sampleRate: 100 })], 60)).toThrow(/sample rate/);
    expect(() => se.buildServicePatch("stt", Array.from({ length: 9 }, (_, i) => E("e" + i)), 60)).toThrow(/At most 8/);
    expect(se.buildServicePatch("stt", [], 60).entries).toEqual([]);
  });
  it("detects changes and labels status", () => {
    const a = [E("a"), E("b")];
    expect(se.listChanged(a, a.map((e) => ({ ...e })))).toBe(false);
    expect(se.listChanged(se.moveEntry(a, 0, 1), a)).toBe(true);
    expect(se.entryBadge(E("a", { enabled: false }), { up: true })[0]).toBe("disabled");
    expect(se.entryBadge(E("a"), { up: true })[0]).toBe("up");
    expect(se.entryBadge(E("a"), { up: "unknown" })[0]).toBe("unknown");
    const down = se.entryBadge(E("a"), { up: false, downUntil: 61_000, lastError: "boom" }, 1000);
    expect(down).toEqual(["down, retry in 60s", "bad", "boom"]);
  });
});
