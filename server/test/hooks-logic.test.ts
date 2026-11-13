import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clamp, HookInputError, HookSources, parsePayload, RateLimiter, sanitize, spokenLine, verify } from "../src/hooks.js";
import { Store } from "../src/store.js";

let clock = 1_800_000_000_000;
const now = () => clock;

function setup() {
  const store = new Store(":memory:", now);
  const hooks = new HookSources(store, undefined, { now });
  return { store, hooks };
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const sign = (secret: string, raw: Buffer) => createHmac("sha256", secret).update(raw).digest("hex");

describe("hook sources", () => {
  it("hands the secret back once on create and rotate, never in the list, and an old token stops working", () => {
    const { hooks } = setup();
    const made = hooks.create({ id: "kuma", label: "Uptime", auth: "bearer" });
    expect(made.secret.length).toBeGreaterThan(20);
    expect(JSON.stringify(hooks.list())).not.toContain(made.secret);
    expect(hooks.list()[0]).not.toHaveProperty("tokenHash");
    const ok = { authorization: `Bearer ${made.secret}` };
    expect(verify(hooks.record("kuma")!, ok, Buffer.alloc(0))).toBe(true);
    const next = hooks.rotate("kuma")!;
    expect(verify(hooks.record("kuma")!, ok, Buffer.alloc(0))).toBe(false);
    expect(verify(hooks.record("kuma")!, { authorization: `Bearer ${next}` }, Buffer.alloc(0))).toBe(true);

    const hmac = hooks.create({ id: "gitea", label: "Gitea", auth: "hmac" });
    expect(JSON.stringify(hooks.list())).not.toContain(hmac.secret);
    expect(hooks.list().find((s) => s.id === "gitea")).not.toHaveProperty("hmacSecret");
  });

  it("refuses a bad id, a taken one, an agent hand-off, other formats and out-of-range numbers", () => {
    const { hooks } = setup();
    expect(() => hooks.create({ id: "Bad Id", label: "x", auth: "bearer" })).toThrow(HookInputError);
    hooks.create({ id: "a", label: "A", auth: "bearer" });
    expect(() => hooks.create({ id: "a", label: "A", auth: "bearer" })).toThrow(HookInputError);
    expect(() => hooks.update("a", { askAgent: true })).toThrow(HookInputError);
    expect(() => hooks.update("a", { format: "bogus" })).toThrow(HookInputError);
    expect(() => hooks.update("a", { ratePerMin: 601 })).toThrow(HookInputError);
    expect(() => hooks.update("a", { maxBody: 100 })).toThrow(HookInputError);
    expect(hooks.update("a", { ceiling: "speak" })).toBe(true);
    expect(hooks.update("nope", { ceiling: "speak" })).toBe(false);
  });
});

describe("signature check", () => {
  const { hooks } = setup();
  const bearer = hooks.create({ id: "b", label: "B", auth: "bearer" });
  const hmac = hooks.create({ id: "h", label: "H", auth: "hmac" });
  const raw = json({ body: "Build failed" });

  it("takes the right bearer token and refuses a wrong or empty one", () => {
    const source = hooks.record("b")!;
    expect(verify(source, { authorization: `Bearer ${bearer.secret}` }, raw)).toBe(true);
    expect(verify(source, { authorization: "Bearer wrong" }, raw)).toBe(false);
    expect(verify(source, { authorization: "Bearer " }, raw)).toBe(false);
    expect(verify(source, {}, raw)).toBe(false);
  });

  it("checks an HMAC of the raw bytes, from GitHub's header or Gitea's", () => {
    const source = hooks.record("h")!;
    const good = sign(hmac.secret, raw);
    expect(verify(source, { "x-hub-signature-256": `sha256=${good}` }, raw)).toBe(true);
    expect(verify(source, { "x-hub-signature-256": `sha256=${sign("other", raw)}` }, raw)).toBe(false);
    const changed = Buffer.from(raw);
    changed[changed.length - 2] ^= 1;
    expect(verify(source, { "x-hub-signature-256": `sha256=${good}` }, changed)).toBe(false);
    expect(verify(source, { "x-hub-signature-256": good }, raw)).toBe(false);
    expect(verify(source, { "x-gitea-signature": good }, raw)).toBe(true);
    // Signatures carry no time: the same signed body is taken both times (dedupe is the payload's job).
    expect(verify(source, { "x-gitea-signature": good }, raw)).toBe(true);
    // A bearer token is no use against an HMAC source.
    expect(verify(source, { authorization: `Bearer ${hmac.secret}` }, raw)).toBe(false);
  });
});

describe("payload rules", () => {
  it("clamps every priority under every ceiling", () => {
    const table = (["low", "normal", "urgent"] as const).flatMap((p) => (["notify", "speak", "urgent"] as const).map((c) => [p, c, clamp(p, c)]));
    expect(table).toEqual([
      ["low", "notify", { priority: "low", quietly: false, clamped: false }],
      ["low", "speak", { priority: "low", quietly: false, clamped: false }],
      ["low", "urgent", { priority: "low", quietly: false, clamped: false }],
      ["normal", "notify", { priority: "normal", quietly: true, clamped: false }],
      ["normal", "speak", { priority: "normal", quietly: false, clamped: false }],
      ["normal", "urgent", { priority: "normal", quietly: false, clamped: false }],
      ["urgent", "notify", { priority: "normal", quietly: true, clamped: true }],
      ["urgent", "speak", { priority: "normal", quietly: false, clamped: true }],
      ["urgent", "urgent", { priority: "urgent", quietly: false, clamped: false }],
    ]);
  });

  it("lets 30 a minute through, refuses the 31st, and lets it in again a minute later", () => {
    const limiter = new RateLimiter(now);
    for (let i = 0; i < 30; i++) expect(limiter.allow("s", 30)).toBe(true);
    expect(limiter.allow("s", 30)).toBe(false);
    expect(limiter.allow("other", 30)).toBe(true);
    clock += 60_001;
    expect(limiter.allow("s", 30)).toBe(true);
  });

  it("takes out controls, bidi and zero-width characters and turns every square bracket round", () => {
    expect(sanitize("a\u0007b‮c​d﻿e\u0085f", 100)).toBe("abcdef");
    expect(sanitize("  one \t two\n\n\nthree  ", 100)).toBe("one two\nthree");
    expect(sanitize("[whispers] hello [shouting, angry] now", 100)).toBe("(whispers) hello (shouting, angry) now");
    expect(spokenLine("CI", "[whispers]", "]][[x")).toBe("From CI: (whispers). ))((x");
    expect(sanitize("​", 10)).toBeUndefined();
    expect(sanitize("a\u061Cb\u00ADc\u180Ed\u2060e\u2061f\u2064g", 100)).toBe("abcdefg");
  });

  it("reads markdown and links out plainly and cuts the spoken line at a word, the stored body at 1000", () => {
    expect(spokenLine("Gitea", "**Build** failed", "See [the log](https://ci.example.org/1) or https://ci.example.org/2 `now`")).toBe(
      "From Gitea: Build failed. See the log or a link now",
    );
    const long = Array.from({ length: 900 }, () => "words").join(" "); // 5399 characters
    const parsed = parsePayload(json({ body: long }), {});
    if (parsed.kind !== "generic") throw new Error(parsed.kind);
    expect(parsed.notice.body.length).toBe(1000);
    const line = spokenLine("Kuma", undefined, parsed.notice.body);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line.endsWith("words...")).toBe(true);
  });

  it("refuses what is not our shape, and keeps only the event name of a GitHub or Gitea payload", () => {
    expect(parsePayload(Buffer.from("not json"), {}).kind).toBe("error");
    expect(parsePayload(json({ body: 5 }), {}).kind).toBe("error");
    expect(parsePayload(json({ body: "x", priority: "loud" }), {}).kind).toBe("error");
    expect(parsePayload(json({ body: "x", url: "javascript:alert(1)" }), {}).kind).toBe("error");
    expect(parsePayload(json({ body: "x", tag: "has space" }), {}).kind).toBe("error");
    expect(parsePayload(json({}), {}).kind).toBe("error");
    expect(parsePayload(json({ body: "[shouting] go" }), { "x-github-event": "push" })).toEqual({ kind: "foreign", event: "push" });
    expect(parsePayload(json({}), { "x-gitea-event": "<b>" })).toEqual({ kind: "foreign", event: "unknown" });
  });
});

describe("handle", () => {
  it("makes one low row for a foreign payload, with nothing of it kept", () => {
    const { store, hooks } = setup();
    hooks.create({ id: "gitea", label: "Gitea", auth: "hmac", ceiling: "urgent" });
    const answer = hooks.handle(hooks.record("gitea")!, json({ title: "secret [whispers]" }), { "x-gitea-event": "push" });
    expect(answer.status).toBe(202);
    const rows = store.listNotifications({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "webhook", sourceName: "gitea", title: "Gitea", body: "push event received", priority: "low", status: "recorded" });
    expect(hooks.record("gitea")!.lastStatus).toBe("foreign");
  });

  it("records a notice, clamped, ignores a repeat, and refuses an unknown client", () => {
    const { store, hooks } = setup();
    hooks.create({ id: "ci", label: "CI", auth: "bearer", ceiling: "speak" });
    const source = hooks.record("ci")!;
    const first = hooks.handle(source, json({ title: "Deploy", body: "done", priority: "urgent", dedupe: "run-7" }), {});
    expect(first).toMatchObject({ status: 202, body: { priority: "normal", clamped: true } });
    expect(first.row).toMatchObject({ source: "webhook", dedupeKey: "ci:run-7", status: "recorded" });
    expect(hooks.handle(source, json({ body: "again", dedupe: "run-7" }), {})).toMatchObject({ status: 200, body: { id: first.row!.id, duplicate: true } });
    expect(hooks.handle(source, json({ body: "x", client: "nowhere" }), {}).status).toBe(400);
    expect(hooks.handle(source, json({ body: "x", location: "attic" }), {}).status).toBe(400);
    expect(store.listNotifications({})).toHaveLength(1);
  });
});
