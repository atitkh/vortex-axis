import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SOURCE_CAP, Store, type HookSourceRecord } from "../src/store.js";

const T0 = 1_800_000_000_000;
let clock = T0;
const fakeNow = () => clock;

type Hook = Parameters<Store["createHookSource"]>[0];
const hook = (over: Partial<Hook> = {}): Hook => ({
  id: "gitea",
  label: "Gitea",
  enabled: true,
  auth: "bearer",
  tokenHash: "hash-of-token",
  ceiling: "notify",
  askAgent: false,
  format: "generic",
  targetEverywhere: false,
  ratePerMin: 30,
  public: false,
  maxBody: 16_384,
  ...over,
});

type Input = Parameters<Store["addNotification"]>[0];
const note = (over: Partial<Input> = {}): Input => ({
  source: "webhook",
  sourceName: "a",
  body: "hello",
  priority: "normal",
  everywhere: false,
  retain: false,
  status: "recorded",
  ...over,
});

describe("hook sources store", () => {
  it("a fresh database ends at user_version 16", () => {
    const store = new Store(":memory:", fakeNow);
    const raw = (store as unknown as { db: DatabaseSync }).db;
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(16);
    store.close();
  });

  it("creates, reads, lists, updates, touches and removes a source", () => {
    clock = T0;
    const store = new Store(":memory:", fakeNow);
    const made = store.createHookSource(hook());
    expect(made.createdAt).toBe(T0);
    expect(store.getHookSource("gitea")).toEqual(made);
    store.createHookSource(hook({ id: "kuma", label: "Kuma", auth: "hmac", tokenHash: undefined, hmacSecret: "s3", targetLocation: "desk" }));
    expect(store.listHookSources().map((h) => h.id)).toEqual(["gitea", "kuma"]);
    expect(store.getHookSource("kuma")).toMatchObject({ auth: "hmac", hmacSecret: "s3", targetLocation: "desk", tokenHash: undefined });

    clock = T0 + 1000;
    expect(store.updateHookSource("gitea", { label: "Gitea 2", enabled: false, ceiling: "speak", public: true, targetEverywhere: true })).toBe(true);
    const updated = store.getHookSource("gitea") as HookSourceRecord;
    expect(updated).toMatchObject({ label: "Gitea 2", enabled: false, ceiling: "speak", public: true, targetEverywhere: true, createdAt: T0, updatedAt: T0 + 1000 });
    store.updateHookSource("kuma", { targetLocation: undefined });
    expect(store.getHookSource("kuma")?.targetLocation).toBeUndefined();
    expect(store.updateHookSource("nope", { label: "x" })).toBe(false);

    clock = T0 + 5000;
    store.touchHookSource("gitea", "ok");
    expect(store.getHookSource("gitea")).toMatchObject({ lastSeenAt: T0 + 5000, lastStatus: "ok" });

    expect(store.removeHookSource("gitea")).toBe(true);
    expect(store.removeHookSource("gitea")).toBe(false);
    expect(store.getHookSource("gitea")).toBeUndefined();
    expect(() => store.createHookSource(hook({ id: "kuma" }))).toThrow();
    store.close();
  });

  it("a bearer source keeps only the hash it was given", () => {
    const store = new Store(":memory:", fakeNow);
    store.createHookSource(hook({ tokenHash: "hash-only" }));
    const raw = (store as unknown as { db: DatabaseSync }).db;
    const row = raw.prepare("SELECT * FROM hook_sources WHERE id = 'gitea'").get() as Record<string, unknown>;
    expect(row.token_hash).toBe("hash-only");
    expect(row.hmac_secret).toBeNull();
    store.close();
  });

  it("the dedupe key is allowed in different namespaces; the same namespaced key throws", () => {
    const store = new Store(":memory:", fakeNow);
    const first = store.addNotification(note({ dedupeKey: "gitea:build-1" }));
    store.addNotification(note({ dedupeKey: "kuma:build-1", sourceName: "kuma" }));
    expect(() => store.addNotification(note({ dedupeKey: "gitea:build-1" }))).toThrow();
    expect(store.findNotificationByDedupe("webhook", "gitea:build-1")?.id).toBe(first.id);
    expect(store.findNotificationByDedupe("webhook", "gitea:nope")).toBeUndefined();
    expect(store.findNotificationByDedupe("agent", "gitea:build-1")).toBeUndefined();
    store.close();
  });

  it("the cap counts webhook rows per source name and leaves other hooks alone", () => {
    clock = T0;
    const store = new Store(":memory:", fakeNow);
    for (let i = 0; i < 6; i++) store.addNotification(note({ sourceName: "b", body: `b${i}`, createdAt: T0 + i }));
    for (let i = 0; i < SOURCE_CAP + 100; i++) store.addNotification(note({ sourceName: "a", body: `a${i}`, createdAt: T0 + 100 + i }));
    // An agent row older than everything: other sources keep counting by source only.
    store.addNotification(note({ source: "agent", sourceName: undefined, body: "agent", createdAt: T0 - 1 }));
    store.sweepNotifications(T0 + 10_000);
    const rows = store.listNotifications({ source: "webhook", limit: 5000 });
    expect(rows.filter((r) => r.sourceName === "a")).toHaveLength(SOURCE_CAP);
    expect(rows.filter((r) => r.sourceName === "b")).toHaveLength(6);
    expect(rows.filter((r) => r.sourceName === "a").some((r) => r.body === "a99")).toBe(false);
    expect(rows.filter((r) => r.sourceName === "a").some((r) => r.body === "a100")).toBe(true);
    expect(store.listNotifications({ source: "agent" })).toHaveLength(1);
    store.close();
  });
});
