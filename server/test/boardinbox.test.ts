import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardInbox, inboxLine } from "../src/boardinbox.js";
import { Store } from "../src/store.js";

const board = (id: string, capabilities: string[] = ["screen", "touch"]) => ({ client: { id, name: id, capabilities } });

describe("the unread inbox on the boards", () => {
  let store: Store;
  let sent: Array<{ to: string; name: string; params: Record<string, unknown> }>;
  let sessions: ReturnType<typeof board>[];
  let connect: (s: unknown) => void;
  let inbox: BoardInbox;
  const notes: string[] = [];

  const add = (text: string, clientId?: string, title?: string) =>
    store.addNotification({ source: "agent", title, body: text, priority: "normal", everywhere: !clientId, retain: false, clientId, status: "delivered" });

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(":memory:", () => 1_000_000);
    sent = [];
    sessions = [board("a"), board("b"), board("speaker", ["speaker", "mic"]), board("screen-only", ["screen"])];
    const hub = {
      onConnect: (fn: (s: unknown) => void) => (connect = fn),
      sessions: () => sessions,
      command: async (s: { client: { id: string } }, name: string, params: Record<string, unknown>) => void sent.push({ to: s.client.id, name, params }),
    };
    inbox = new BoardInbox(hub as never, store, { now: () => 1_000_000, note: (_k, _s, t) => void notes.push(t) });
  });
  afterEach(() => {
    inbox.stop();
    vi.useRealTimers();
  });

  it("cuts a line to the title, else the body, on one line, at most 48 characters", () => {
    expect(inboxLine("Build done", "long body")).toBe("Build done");
    expect(inboxLine(undefined, "first\nsecond\tthird")).toBe("first second third");
    expect(inboxLine(undefined, "x".repeat(100)).length).toBeLessThanOrEqual(48);
    expect(inboxLine("  ", "body")).toBe("body");
  });

  it("tells only screens with touch, and only what the viewer may see", () => {
    add("for everyone");
    add("only for a", "a");
    add("only for b", "b");
    vi.advanceTimersByTime(600);
    expect(sent.map((s) => s.to).sort()).toEqual(["a", "b"]);
    const a = sent.find((s) => s.to === "a")!;
    expect(a.name).toBe("inbox.show");
    expect(a.params.count).toBe(2);
    expect(String(a.params.items)).toContain("only for a");
    expect(String(a.params.items)).not.toContain("only for b");
    expect(String(a.params.items)).toMatch(/^\d+\tonly for a\n\d+\tfor everyone\n$/);
  });

  it("lists at most five, newest first, and counts them all", () => {
    for (let i = 1; i <= 7; i++) add(`n${i}`);
    inbox.tell(sessions[0] as never);
    const p = sent[0]!.params;
    expect(p.count).toBe(7);
    expect(String(p.items).trimEnd().split("\n")).toHaveLength(5);
    expect(String(p.items).startsWith("7\tn7\n")).toBe(true);
  });

  it("sends nothing again when nothing changed, and one send for changes close together", () => {
    add("one");
    inbox.tell();
    const first = sent.length;
    inbox.tell();
    expect(sent.length).toBe(first);
    sent.length = 0;
    add("two");
    add("three");
    add("four");
    vi.advanceTimersByTime(499);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(10);
    expect(sent.filter((s) => s.to === "a")).toHaveLength(1);
    expect(sent.find((s) => s.to === "a")!.params.count).toBe(4);
  });

  it("tells a screen as it connects", () => {
    add("waiting");
    connect(sessions[1]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "b", name: "inbox.show" });
  });

  it("reads and dismisses what the board may see, and nothing else", () => {
    const mine = add("mine", "a");
    const others = add("others", "b");
    const shared = add("shared");
    inbox.act(sessions[0] as never, others.id, "read");
    inbox.act(sessions[0] as never, others.id, "dismiss");
    expect(store.unreadCount({ viewer: "b" })).toBe(2);
    inbox.act(sessions[0] as never, mine.id, "read");
    expect(store.listNotifications({ viewer: "a", unread: true }).map((n) => n.id)).toEqual([shared.id]);
    inbox.act(sessions[0] as never, shared.id, "dismiss");
    expect(store.listNotifications({ viewer: "a" }).map((n) => n.id)).toEqual([mine.id]);
    inbox.act(sessions[0] as never, 9999, "read");
    inbox.act(sessions[0] as never, 9999, "dismiss");
    expect(notes.some((t) => /failed/.test(t))).toBe(false);
  });

  it("tells the boards after an act, once", () => {
    const n = add("x", "a");
    inbox.tell();
    sent.length = 0;
    inbox.act(sessions[0] as never, n.id, "read");
    vi.advanceTimersByTime(600);
    expect(sent.filter((s) => s.to === "a")).toHaveLength(1);
    expect(sent.find((s) => s.to === "a")!.params).toEqual({ count: 0, items: "" });
  });
});
