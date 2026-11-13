import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RETENTION_DAYS, SOURCE_CAP, Store, type NotificationRecord } from "../src/store.js";

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
/** Number of entries in MIGRATIONS; raise it when a migration is added. */
const SCHEMA_VERSION = 16;

type Input = Parameters<Store["addNotification"]>[0];
const note = (over: Partial<Input> = {}): Input => ({
  source: "agent",
  body: "hello",
  priority: "normal",
  everywhere: false,
  retain: false,
  status: "delivered",
  ...over,
});

describe("notifications store", () => {
  it("a fresh database ends at the newest schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "axis-notif-"));
    try {
      new Store(dir).close();
      const raw = new DatabaseSync(join(dir, "axis.sqlite"));
      expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["notifications", "notification_deliveries"]));
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a repeated (source, dedupe_key) but lets missing keys repeat and other sources reuse a key", () => {
    const store = new Store(":memory:", () => T0);
    store.addNotification(note({ dedupeKey: "k" }));
    expect(() => store.addNotification(note({ dedupeKey: "k" }))).toThrow();
    expect(() => store.addNotification(note({ source: "system", dedupeKey: "k" }))).not.toThrow();
    store.addNotification(note());
    store.addNotification(note());
    expect(store.listNotifications()).toHaveLength(4);
    store.close();
  });

  it("sets expires_at by priority and retain", () => {
    const store = new Store(":memory:", () => T0);
    const week = T0 + RETENTION_DAYS * DAY;
    expect(store.addNotification(note({ priority: "low" })).expiresAt).toBe(week);
    expect(store.addNotification(note({ priority: "normal" })).expiresAt).toBe(week);
    expect(store.addNotification(note({ priority: "urgent" })).expiresAt).toBeUndefined();
    expect(store.addNotification(note({ retain: true })).expiresAt).toBeUndefined();
    expect(store.addNotification(note({ createdAt: T0 - DAY })).expiresAt).toBe(week - DAY);
    const stored = store.listNotifications().map((n) => [n.priority, n.retain, n.expiresAt]);
    expect(stored).toContainEqual(["urgent", false, undefined]);
    expect(stored).toContainEqual(["normal", true, undefined]);
    store.close();
  });

  it("sweep deletes expired rows and keeps those without an expiry", () => {
    const store = new Store(":memory:", () => T0);
    const old = store.addNotification(note({ body: "old" }));
    const keep = store.addNotification(note({ body: "urgent", priority: "urgent" }));
    const fresh = store.addNotification(note({ body: "fresh", createdAt: T0 + 6 * DAY }));
    expect(store.sweepNotifications(T0 + RETENTION_DAYS * DAY - 1)).toBe(0);
    expect(store.sweepNotifications(T0 + RETENTION_DAYS * DAY)).toBe(1);
    const ids = store.listNotifications().map((n) => n.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toEqual(expect.arrayContaining([keep.id, fresh.id]));
    store.close();
  });

  it("the per-source cap removes the oldest and skips pending and held", () => {
    const store = new Store(":memory:", () => T0);
    const pending = store.addNotification(note({ body: "first", status: "pending", createdAt: T0 }));
    const held = store.addNotification(note({ body: "second", status: "held", createdAt: T0 + 1 }));
    const other = store.addNotification(note({ source: "system", body: "other", createdAt: T0 + 2 }));
    for (let i = 0; i < SOURCE_CAP; i++) store.addNotification(note({ body: `n${i}`, createdAt: T0 + 10 + i }));
    // SOURCE_CAP + 2 agent rows: pending and held are the two oldest and must be skipped, so nothing goes.
    expect(store.sweepNotifications(T0)).toBe(0);
    const agent = store.listNotifications({ source: "agent", limit: 1000 });
    expect(agent).toHaveLength(SOURCE_CAP + 2);
    expect(store.listNotifications({ source: "system" }).map((n) => n.id)).toEqual([other.id]);
    store.addNotification(note({ body: "extra", createdAt: T0 + 10 + SOURCE_CAP }));
    // One over the cap now: the oldest deletable row (n0) goes.
    expect(store.sweepNotifications(T0)).toBe(1);
    const after = store.listNotifications({ source: "agent", limit: 1000 }).map((n: NotificationRecord) => n.body);
    expect(after).not.toContain("n0");
    expect(after).toEqual(expect.arrayContaining(["n1", "extra", "first", "second"]));
    store.close();
  });

  it("deleting a notification removes its deliveries", () => {
    const store = new Store(":memory:", () => T0);
    const a = store.addNotification(note({ priority: "low" }));
    store.setDelivery({ notificationId: a.id, clientId: "c1", route: "live", state: "heard", at: T0 });
    store.setDelivery({ notificationId: a.id, clientId: "c2", route: "push", state: "pushed", at: T0 });
    expect(store.deliveriesOf(a.id)).toHaveLength(2);
    store.sweepNotifications(T0 + RETENTION_DAYS * DAY);
    expect(store.listNotifications()).toEqual([]);
    expect(store.deliveriesOf(a.id)).toEqual([]);
    expect(store.countDeliveries("c1", "heard")).toBe(0);
    store.close();
  });

  it("deleting a reminder leaves its notifications", () => {
    const store = new Store(":memory:", () => T0);
    const reminder = store.addReminder({ text: "call", everywhere: false, urgent: false, attempts: 0, missedCount: 0, createdAt: T0 });
    store.addNotification(note({ source: "reminder", reminderId: reminder.id }));
    expect(store.removeReminder(reminder.id)).toBe(true);
    expect(store.notificationsForReminder(reminder.id)).toHaveLength(1);
    store.close();
  });

  it("holds at most five per client, newest kept, and takes deliveries once", () => {
    const store = new Store(":memory:", () => T0);
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const n = store.addNotification(note({ body: `m${i}`, status: "held" }));
      ids.push(n.id);
      store.setDelivery({ notificationId: n.id, clientId: "c1", route: "held", state: "held", at: T0 + i, until: T0 + 1000 });
    }
    expect(store.held("c1", T0 + 10).map((n) => n.body)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(store.countDeliveries("c1", "dropped")).toBe(1);
    expect(store.held("c1", T0 + 1000)).toEqual([]);
    expect(store.held("c2", T0 + 10)).toEqual([]);
    expect(store.takeDeliveries("c1", ["held"], T0 + 20)).toHaveLength(6);
    expect(store.takeDeliveries("c1", ["held"], T0 + 21)).toEqual([]);
    expect(store.listNotifications().every((n) => n.readAt === T0 + 20)).toBe(true);
    store.close();
  });

  it("lists pushed and missed-ask deliveries not yet taken, and updates fields", () => {
    const store = new Store(":memory:", () => T0);
    const p = store.addNotification(note({ body: "pushed" }));
    store.setDelivery({ notificationId: p.id, clientId: "c1", route: "push", state: "pushed", at: T0, until: T0 + 500 });
    const ask = store.addNotification(note({ source: "ask", body: "ok?", choices: ["yes", "no"], status: "pending" }));
    expect(store.updateNotification(ask.id, { status: "timed_out", expiresAt: undefined })).toBe(true);
    store.setDelivery({ notificationId: ask.id, clientId: "c1", route: "live", state: "missed", at: T0 + 1 });
    expect(store.updateNotification(9999, { status: "heard" })).toBe(false);
    expect(store.pushedUntaken("c1", T0 + 1).map((n) => n.body)).toEqual(["pushed"]);
    expect(store.pushedUntaken("c1", T0 + 500)).toEqual([]);
    const missed = store.missedAsksUntaken("c1", T0 + 2);
    expect(missed.map((n) => [n.body, n.choices, n.status, n.expiresAt])).toEqual([["ok?", ["yes", "no"], "timed_out", undefined]]);
    store.takeDeliveries("c1", ["push", "live"], T0 + 3);
    expect(store.pushedUntaken("c1", T0 + 4)).toEqual([]);
    expect(store.missedAsksUntaken("c1", T0 + 4)).toEqual([]);
    store.close();
  });
});
