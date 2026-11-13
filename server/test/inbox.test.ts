import { describe, expect, it } from "vitest";
import { createInvokeHandler } from "../src/commands.js";
import { Store } from "../src/store.js";
import { admin, ctx, newPairedClient, useServer } from "./harness.js";

useServer();

const T0 = 1_800_000_000_000;
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

describe("inbox store", () => {
  it("filters by source, source name and unread, and pages with before", () => {
    const store = new Store(":memory:", () => T0);
    const a = store.addNotification(note({ body: "a" }));
    store.addNotification(note({ source: "webhook", sourceName: "ci", body: "b", createdAt: T0 + 1 }));
    store.addNotification(note({ source: "webhook", sourceName: "kuma", body: "c", createdAt: T0 + 2 }));
    store.markRead([a.id], T0 + 5);
    expect(store.listNotifications({ source: "webhook" }).map((n) => n.body)).toEqual(["c", "b"]);
    expect(store.listNotifications({ sourceName: "ci" }).map((n) => n.body)).toEqual(["b"]);
    expect(store.listNotifications({ unread: true }).map((n) => n.body)).toEqual(["c", "b"]);
    const page1 = store.listNotifications({ limit: 2 });
    expect(page1.map((n) => n.body)).toEqual(["c", "b"]);
    expect(store.listNotifications({ limit: 2, before: page1[1]!.id }).map((n) => n.body)).toEqual(["a"]);
    expect(store.inboxSources()).toEqual([
      { source: "agent", count: 1 },
      { source: "webhook", name: "ci", count: 1 },
      { source: "webhook", name: "kuma", count: 1 },
    ]);
    store.close();
  });

  it("counts unread and marks read without overwriting an earlier read time", () => {
    const store = new Store(":memory:", () => T0);
    const a = store.addNotification(note({ body: "a" }));
    const b = store.addNotification(note({ body: "b" }));
    expect(store.unreadCount()).toBe(2);
    expect(store.markRead([a.id], T0 + 1)).toBe(1);
    expect(store.markRead([a.id], T0 + 2)).toBe(0);
    expect(store.listNotifications().find((n) => n.id === a.id)!.readAt).toBe(T0 + 1);
    expect(store.unreadCount()).toBe(1);
    expect(store.markRead("all", T0 + 3)).toBe(1);
    expect(store.listNotifications().find((n) => n.id === b.id)!.readAt).toBe(T0 + 3);
    expect(store.unreadCount()).toBe(0);
    store.close();
  });

  it("dismisses: hidden, expiring now, read; pending and held rows are skipped", () => {
    const store = new Store(":memory:", () => T0);
    const done = store.addNotification(note({ body: "done" }));
    const pending = store.addNotification(note({ body: "pending", status: "pending" }));
    const held = store.addNotification(note({ body: "held", status: "held" }));
    expect(store.dismissNotifications("all", T0 + 10)).toBe(1);
    expect(store.dismissNotifications([pending.id, held.id], T0 + 10)).toBe(0);
    expect(store.listNotifications().map((n) => n.body).sort()).toEqual(["held", "pending"]);
    const gone = store.listNotifications({ includeDismissed: true }).find((n) => n.id === done.id)!;
    expect(gone).toMatchObject({ dismissedAt: T0 + 10, expiresAt: T0 + 10, readAt: T0 + 10 });
    // mark read still reaches a pending row
    expect(store.markRead([pending.id], T0 + 11)).toBe(1);
    expect(store.sweepNotifications(T0 + 10)).toBe(1);
    expect(store.listNotifications({ includeDismissed: true })).toHaveLength(2);
    store.close();
  });

  it("dismiss-all honours the source filter and the viewer", () => {
    const store = new Store(":memory:", () => T0);
    store.addNotification(note({ source: "webhook", sourceName: "ci", body: "ci" }));
    store.addNotification(note({ source: "webhook", sourceName: "kuma", body: "kuma" }));
    store.addNotification(note({ clientId: "other", body: "private" }));
    expect(store.dismissNotifications("all", T0, { sourceName: "ci" })).toBe(1);
    expect(store.listNotifications({ viewer: "me" }).map((n) => n.body)).toEqual(["kuma"]);
    expect(store.dismissNotifications("all", T0, { viewer: "me" })).toBe(1);
    expect(store.listNotifications().map((n) => n.body)).toEqual(["private"]);
    store.close();
  });
});

describe("inbox routes", () => {
  const headers = (id: string, token: string) => ({ authorization: `Bearer ${token}`, "x-axis-client": id, "content-type": "application/json" });
  const call = (method: string, path: string, who: { clientId: string; token: string }, body?: unknown, token = who.token) =>
    fetch(`${ctx.base}${path}`, { method, headers: headers(who.clientId, token), ...(body ? { body: JSON.stringify(body) } : {}) });

  it("admin list, read and dismiss need the token and do not exist under a public name", async () => {
    expect((await admin("GET", "/admin/notifications", undefined, "wrong")).status).toBe(401);
    ctx.app.store.addNotification(note({ source: "webhook", sourceName: "ci", body: "build failed", url: "https://secret.example/x" }));
    ctx.app.store.addNotification(note({ body: "other" }));
    const listed = await admin("GET", "/admin/notifications?source=webhook&unread=1");
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body).toMatchObject({ unread: 2 });
    expect(listed.body.sources).toEqual(expect.arrayContaining([{ source: "webhook", name: "ci", count: 1 }]));
    expect(JSON.stringify(listed.body)).not.toContain("secret.example");
    expect((await admin("GET", "/admin/notifications?source=bogus")).status).toBe(400);
    const id = listed.body.items[0].id;
    expect((await admin("POST", "/admin/notifications/read", { ids: [id] })).body).toMatchObject({ read: 1, unread: 1 });
    expect((await admin("POST", "/admin/notifications/dismiss", { all: true, source: "webhook" })).body).toMatchObject({ dismissed: 1 });
    expect((await admin("POST", "/admin/notifications/dismiss", {})).status).toBe(400);
    await admin("PATCH", "/admin/integrations", { publicHosts: "axis.example.org" });
    const res = await fetch(`${ctx.base}/admin/notifications`, { headers: { authorization: "Bearer test-admin-token", "x-forwarded-host": "axis.example.org" } });
    expect(res.status).toBe(404);
  });

  it("/v1/inbox rejects a bad token and a non-browser client, and shows a browser only its own view", async () => {
    const web = await newPairedClient({ name: "Phone" });
    const other = await newPairedClient({ name: "Other" });
    const board = await newPairedClient({ type: "board", name: "Desk" });
    expect((await call("GET", "/v1/inbox", web, undefined, "wrong")).status).toBe(401);
    expect((await call("GET", "/v1/inbox", board)).status).toBe(403);
    ctx.app.store.addNotification(note({ body: "for all" }));
    ctx.app.store.addNotification(note({ body: "for me", clientId: web.clientId }));
    ctx.app.store.addNotification(note({ body: "for them", clientId: other.clientId }));
    const mine = (await (await call("GET", "/v1/inbox", web)).json()) as any;
    expect(mine.items.map((n: any) => n.body).sort()).toEqual(["for all", "for me"]);
    expect(mine.unread).toBe(2);
    const theirs = mine.items.length;
    const them = ctx.app.store.listNotifications().find((n) => n.body === "for them")!;
    const read = (await (await call("POST", "/v1/inbox/read", web, { ids: [them.id] })).json()) as any;
    expect(read.read).toBe(0);
    expect(ctx.app.store.unreadCount({ viewer: other.clientId })).toBe(2);
    const dismissed = (await (await call("POST", "/v1/inbox/dismiss", web, { all: true })).json()) as any;
    expect(dismissed).toMatchObject({ dismissed: theirs, unread: 0 });
    expect(ctx.app.store.listNotifications().map((n) => n.body)).toEqual(["for them"]);
  });
});

describe("vortex_axis_inbox", () => {
  function invoke(params: Record<string, unknown>) {
    const { hub, store, timers, reminders, delivery, activity } = ctx.app;
    return createInvokeHandler({ hub, store, timers, reminders, timeZone: () => "UTC", delivery, activity, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(
      "vortex.axis.inbox",
      params,
    ) as Promise<any>;
  }

  it("lists unread without links, cuts long text, marks read and dismisses", async () => {
    const { store } = ctx.app;
    store.addNotification(note({ source: "webhook", sourceName: "ci", title: "Build", body: "x".repeat(500), url: "https://secret.example/x" }));
    const second = store.addNotification(note({ body: "second" }));
    const listed = await invoke({});
    expect(listed.items).toHaveLength(2);
    expect(listed.unread).toBe(2);
    expect(listed.items.find((i: any) => i.from === "ci").body.length).toBeLessThan(310);
    expect(JSON.stringify(listed)).not.toContain("secret.example");
    expect(Object.keys(listed.items[0])).not.toContain("url");
    expect(await invoke({ action: "read", ids: [second.id] })).toMatchObject({ read: 1, unread: 1 });
    expect((await invoke({ action: "list" })).items).toHaveLength(1);
    expect((await invoke({ action: "list", unread: false })).items).toHaveLength(2);
    expect(await invoke({ action: "dismiss", all: true })).toMatchObject({ dismissed: 2, unread: 0 });
    await expect(invoke({ action: "dismiss" })).rejects.toThrow(/which notifications/);
  });
});
