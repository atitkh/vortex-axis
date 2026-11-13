import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HookSources, parsePayload, verify } from "../src/hooks.js";
import { mapPreset } from "../src/presets.js";
import { Store } from "../src/store.js";

const json = (v: unknown) => Buffer.from(JSON.stringify(v));
const repo = { full_name: "atit/axis" };

describe("presets: gitea and github", () => {
  it("maps a merged pull request, with the delivery id as dedupe", () => {
    const r = mapPreset("gitea", { "x-gitea-event": "pull_request", "x-gitea-delivery": "d-1" }, { action: "closed", repository: repo, pull_request: { merged: true, title: "Fix it", html_url: "https://g.example/pr/1" } });
    expect(r).toMatchObject({ data: { title: "atit/axis: pull request merged", body: "Fix it", priority: "normal", dedupe: "d-1", url: "https://g.example/pr/1" } });
  });
  it("maps a failed workflow run and ignores a successful one", () => {
    const h = { "x-github-event": "workflow_run" };
    const bad = mapPreset("github", h, { action: "completed", repository: repo, workflow_run: { name: "CI", conclusion: "failure", head_branch: "main" } });
    expect(bad).toMatchObject({ data: { title: "atit/axis: CI failed", priority: "normal" } });
    expect(mapPreset("github", h, { action: "completed", repository: repo, workflow_run: { name: "CI", conclusion: "success" } })).toEqual({ ignore: "workflow_run" });
  });
  it("keeps push, star, ping and an edited pull request to a quiet line", () => {
    for (const event of ["push", "star", "watch", "fork", "ping"]) expect(mapPreset("github", { "x-github-event": event }, { repository: repo })).toEqual({ ignore: event });
    expect(mapPreset("gitea", { "x-gitea-event": "pull_request" }, { action: "edited" })).toEqual({ ignore: "pull_request" });
  });
  it("needs the event header", () => {
    expect(mapPreset("github", {}, {})).toMatchObject({ error: expect.any(String) });
  });
});

describe("presets: kuma and ha", () => {
  it("makes down urgent and up normal; a test ping is quiet", () => {
    expect(mapPreset("kuma", {}, { monitor: { id: 3, name: "Blog" }, heartbeat: { status: 0, msg: "timeout", time: "t1" } })).toMatchObject({ data: { title: "Blog is down", body: "timeout", priority: "urgent", dedupe: "3-t1" } });
    expect(mapPreset("kuma", {}, { monitor: { id: 3, name: "Blog" }, heartbeat: { status: 1, time: "t2" } })).toMatchObject({ data: { title: "Blog is back up", priority: "normal" } });
    expect(mapPreset("kuma", {}, { msg: "Testing" })).toEqual({ ignore: "ping" });
  });
  it("passes a Home Assistant message through and refuses an empty one", () => {
    expect(mapPreset("ha", {}, { title: "Door", message: "Front door open" })).toEqual({ data: { body: "Front door open", title: "Door" } });
    expect(mapPreset("ha", {}, { title: "x" })).toMatchObject({ error: expect.any(String) });
  });
});

describe("presets through the door", () => {
  it("sanitizes mapped text like a generic body, and a foreign event stays low", () => {
    const p = parsePayload(json({ monitor: { name: "Bl[og]‮" }, heartbeat: { status: 0, msg: "down\u0000 now" } }), {}, "kuma");
    expect(p).toMatchObject({ kind: "generic", notice: { title: "Bl(og) is down", body: "down now", priority: "urgent" } });
    expect(parsePayload(json({}), { "x-github-event": "push" }, "github")).toEqual({ kind: "foreign", event: "push" });
  });
  it("clamps Kuma down by the ceiling, and a gitea source still verifies its HMAC", () => {
    const store = new Store(":memory:", () => 1_800_000_000_000);
    const hooks = new HookSources(store, undefined, { now: () => 1_800_000_000_000 });
    hooks.create({ id: "up", label: "Kuma", auth: "bearer", ceiling: "speak", format: "kuma" });
    const a = hooks.handle(hooks.record("up")!, json({ monitor: { id: 1, name: "Blog" }, heartbeat: { status: 0, msg: "x", time: "t" } }), {});
    expect(a).toMatchObject({ status: 202, body: { priority: "normal", clamped: true } });
    const g = hooks.create({ id: "gt", label: "Gitea", auth: "hmac", ceiling: "urgent", format: "gitea" });
    const raw = json({ action: "opened", repository: repo, issue: { title: "Bug" }, sender: { login: "bo" } });
    const headers = { "x-gitea-event": "issues", "x-gitea-delivery": "dl-9", "x-gitea-signature": createHmac("sha256", g.secret).update(raw).digest("hex") };
    expect(verify(hooks.record("gt")!, headers, raw)).toBe(true);
    const r = hooks.handle(hooks.record("gt")!, raw, headers);
    expect(r.row).toMatchObject({ title: "atit/axis: issue opened", body: "bo: Bug", dedupeKey: "gt:dl-9", priority: "normal" });
    expect(hooks.handle(hooks.record("gt")!, raw, headers)).toMatchObject({ status: 200, body: { duplicate: true } });
  });
});
