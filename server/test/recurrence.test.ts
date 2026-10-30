import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { describeWhen, localToUtc, nextOccurrence, parseRepeat, parseWhen, weekdayOf } from "../src/recurrence.js";
import { Store } from "../src/store.js";

const CHI = "America/Chicago";
const iso = (ms: number) => new Date(ms).toISOString();

describe("recurrence", () => {
  it("weekdays skip a weekend in Chicago", () => {
    const rule = { timeOfDay: "09:00", days: parseRepeat("weekdays") };
    const fri = localToUtc(2026, 10, 30, 9, 0, CHI);
    const mon = nextOccurrence(rule, fri, CHI);
    expect(describeWhen(mon, CHI)).toBe("Mon 2 Nov 09:00");
    expect(describeWhen(nextOccurrence(rule, fri - 1, CHI), CHI)).toBe("Fri 30 Oct 09:00");
  });

  it("DST overlap on 2026-11-01 01:30 fires once", () => {
    const rule = { timeOfDay: "01:30", days: parseRepeat("daily") };
    const first = localToUtc(2026, 11, 1, 1, 30, CHI);
    expect(iso(first)).toBe("2026-11-01T06:30:00.000Z");
    expect(describeWhen(nextOccurrence(rule, first, CHI), CHI)).toBe("Mon 2 Nov 01:30");
  });

  it("DST gap on 2027-03-14 02:30 moves to 03:00", () => {
    expect(iso(localToUtc(2027, 3, 14, 2, 30, CHI))).toBe("2027-03-14T08:00:00.000Z");
    expect(describeWhen(localToUtc(2027, 3, 14, 2, 30, CHI), CHI)).toBe("Sun 14 Mar 03:00");
  });

  it("09:00 stays 09:00 local across both changes", () => {
    const rule = { timeOfDay: "09:00", days: parseRepeat("daily") };
    let t = localToUtc(2026, 10, 30, 9, 0, CHI);
    const seen = new Set<string>();
    for (let i = 0; i < 160; i++) {
      t = nextOccurrence(rule, t, CHI);
      seen.add(describeWhen(t, CHI).slice(-5));
    }
    expect([...seen]).toEqual(["09:00"]);
    expect(iso(localToUtc(2026, 10, 31, 9, 0, CHI))).toBe("2026-10-31T14:00:00.000Z");
    expect(iso(localToUtc(2026, 11, 2, 9, 0, CHI))).toBe("2026-11-02T15:00:00.000Z");
  });

  it("reads repeat rules", () => {
    expect(parseRepeat("weekends")).toBe("0,6");
    expect(parseRepeat("Mon, wed,fri")).toBe("1,3,5");
    expect(parseRepeat("weekly", 4)).toBe("4");
    expect(weekdayOf(localToUtc(2026, 10, 31, 9, 0, CHI), CHI)).toBe(6);
    expect(() => parseRepeat("weekly")).toThrow();
    expect(() => parseRepeat("monthly")).toThrow();
    expect(() => parseRepeat("")).toThrow();
  });

  it("reads and checks `at`", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    expect(iso(parseWhen("2026-10-31 09:00", CHI, now))).toBe("2026-10-31T14:00:00.000Z");
    expect(iso(parseWhen("2026-10-31T09:00:00+02:00", CHI, now))).toBe("2026-10-31T07:00:00.000Z");
    expect(() => parseWhen("tomorrow", CHI, now)).toThrow(/not a date/);
    expect(() => parseWhen("2026-02-30 09:00", CHI, now)).toThrow(/real/);
    expect(() => parseWhen("2026-10-29 09:00", CHI, now)).toThrow(/past/);
    expect(() => parseWhen("2027-11-02 09:00", CHI, now)).toThrow(/366/);
    expect(() => parseWhen("2027-10-30 09:00", CHI, now)).not.toThrow();
  });
});

describe("reminder store", () => {
  it("round trips, orders and updates", () => {
    const store = new Store(":memory:", () => 1000);
    const base = { everywhere: false, urgent: false, attempts: 0, missedCount: 0, createdAt: 1000 };
    const late = store.addReminder({ ...base, text: "later", dueAt: 9000 });
    const gone = store.addReminder({ ...base, text: "missed one-off" });
    const soon = store.addReminder({ ...base, text: "soon", dueAt: 5000, timeOfDay: "09:00", days: "1,2", clientId: "c1", urgent: true });
    expect(store.listReminders().map((r) => r.id)).toEqual([soon.id, late.id, gone.id]);
    expect(store.listReminders()[0]).toMatchObject({ text: "soon", timeOfDay: "09:00", days: "1,2", clientId: "c1", urgent: true, everywhere: false });
    expect(store.updateReminder(soon.id, { dueAt: 12000, retryAt: 13000, attempts: 1, missedAt: 14000, missedCount: 2 })).toBe(true);
    expect(store.listReminders().find((r) => r.id === soon.id)).toMatchObject({ dueAt: 12000, retryAt: 13000, attempts: 1, missedAt: 14000, missedCount: 2 });
    store.updateReminder(soon.id, { retryAt: undefined, urgent: false });
    expect(store.listReminders().find((r) => r.id === soon.id)).toMatchObject({ retryAt: undefined, urgent: false });
    expect(store.updateReminder(999, { attempts: 1 })).toBe(false);
    expect(store.removeReminder(late.id)).toBe(true);
    expect(store.removeReminder(late.id)).toBe(false);
    store.close();
  });

  it("migrates a database from the previous schema and keeps its data", () => {
    const dir = mkdtempSync(join(tmpdir(), "axis-rem-"));
    try {
      const first = new Store(dir);
      first.addTimer({ clientId: "c1", label: "tea", seconds: 60, dueAt: 5000, createdAt: 1000 });
      first.close();
      const raw = new DatabaseSync(join(dir, "axis.sqlite"));
      const version = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      raw.exec("DROP TABLE reminders");
      raw.exec(`PRAGMA user_version = ${version - 1}`);
      raw.close();
      const store = new Store(dir);
      expect(store.listReminders()).toEqual([]);
      expect(store.listTimers().map((t) => t.label)).toEqual(["tea"]);
      store.addReminder({ text: "x", everywhere: false, urgent: false, attempts: 0, missedCount: 0, createdAt: 1 });
      expect(store.listReminders()).toHaveLength(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
