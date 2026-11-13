import { createHmac } from "node:crypto";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { admin, ctx, useServer } from "./harness.js";

useServer();

async function post(id: string, body: unknown, headers: Record<string, string> = {}, method = "POST") {
  const res = await fetch(`${ctx.base}/v1/hook/${id}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

/** Posts without a content-length, in chunks, so only the streamed size can give it away. */
function postChunked(id: string, token: string, size: number): Promise<number> {
  const url = new URL(`${ctx.base}/v1/hook/${id}`);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { authorization: `Bearer ${token}`, "transfer-encoding": "chunked" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    for (let sent = 0; sent < size; sent += 1024) req.write(Buffer.alloc(1024, 32));
    req.end();
  });
}

const bearerSource = (id = "ci", extra: Record<string, unknown> = {}) => {
  const made = ctx.app.hooks.create({ id, label: "CI", auth: "bearer", ...extra });
  return { authorization: `Bearer ${made.secret}` };
};
const webhookRows = () => ctx.app.store.listNotifications({ source: "webhook" });

describe("webhook door", () => {
  it("takes a notice with the right token: 202 and one webhook row, recorded", async () => {
    const auth = bearerSource();
    const sent = await post("ci", { title: "Deploy", body: "finished" }, auth);
    expect(sent).toMatchObject({ status: 202, body: { priority: "normal", clamped: false } });
    expect(webhookRows()).toHaveLength(1);
    expect(webhookRows()[0]).toMatchObject({ id: sent.body.id, source: "webhook", sourceName: "ci", title: "Deploy", body: "finished", status: "recorded" });
    const source = ctx.app.hooks.record("ci")!;
    expect(source.lastStatus).toBe("ok");
    expect(source.lastSeenAt).toBeGreaterThan(0);
  });

  it("refuses a wrong token, and ten shut the address out of this door but not out of /mcp", async () => {
    const auth = bearerSource();
    const wrong = await post("ci", { body: "x" }, { authorization: "Bearer wrong" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBe("Bearer");
    expect(ctx.app.hooks.record("ci")!.lastStatus).toBe("bad-auth");
    for (let i = 0; i < 9; i++) await post("ci", { body: "x" }, { authorization: "Bearer wrong" });
    expect((await post("ci", { body: "x" }, auth)).status).toBe(429);
    const made = await admin("POST", "/admin/mcp/tokens", { name: "Harness" });
    const mcp = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${made.body.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(mcp.status).toBe(200);
    expect(webhookRows()).toHaveLength(0);
  });

  it("checks an HMAC signature of the raw body", async () => {
    const { secret } = ctx.app.hooks.create({ id: "gitea", label: "Gitea", auth: "hmac" });
    const raw = JSON.stringify({ body: "Build failed" });
    const signature = createHmac("sha256", secret).update(raw).digest("hex");
    expect((await post("gitea", raw, { "x-hub-signature-256": `sha256=${signature}` })).status).toBe(202);
    expect((await post("gitea", raw, { "x-gitea-signature": signature })).status).toBe(202);
    const bad = await post("gitea", raw, { "x-gitea-signature": createHmac("sha256", "other").update(raw).digest("hex") });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toBeNull();
    expect(webhookRows()).toHaveLength(2);
  });

  it("answers 404 for an unknown or switched-off source, and under a public name until that is allowed", async () => {
    const auth = bearerSource();
    expect((await post("nope", { body: "x" }, auth)).status).toBe(404);
    ctx.app.hooks.update("ci", { enabled: false });
    expect((await post("ci", { body: "x" }, auth)).status).toBe(404);
    expect(ctx.app.hooks.record("ci")!.lastStatus).toBe("disabled");
    ctx.app.hooks.update("ci", { enabled: true });
    await admin("PATCH", "/admin/integrations", { publicHosts: "axis.example.org" });
    const outside = { ...auth, "x-forwarded-host": "axis.example.org" };
    expect((await post("ci", { body: "x" }, outside)).status).toBe(404);
    ctx.app.hooks.update("ci", { public: true });
    expect((await post("ci", { body: "x" }, outside)).status).toBe(202);
  });

  it("refuses a body over the source's limit, by its stated length and by what actually arrives", async () => {
    const auth = bearerSource("ci", { maxBody: 1024 });
    expect((await post("ci", { body: "x".repeat(2000) }, auth)).status).toBe(413);
    expect(ctx.app.hooks.record("ci")!.lastStatus).toBe("too-large");
    expect(await postChunked("ci", auth.authorization.slice(7), 4096)).toBe(413);
    expect(webhookRows()).toHaveLength(0);
  });

  it("answers 429 past the source's rate, writing no row", async () => {
    const auth = bearerSource("ci", { ratePerMin: 2 });
    expect((await post("ci", { body: "1" }, auth)).status).toBe(202);
    expect((await post("ci", { body: "2" }, auth)).status).toBe(202);
    expect((await post("ci", { body: "3" }, auth)).status).toBe(429);
    expect(ctx.app.hooks.record("ci")!.lastStatus).toBe("rate-limited");
    expect(webhookRows()).toHaveLength(2);
  });

  it("answers a repeat with the first one's id and writes nothing", async () => {
    const auth = bearerSource();
    const first = await post("ci", { body: "down", dedupe: "monitor-4" }, auth);
    const again = await post("ci", { body: "down", dedupe: "monitor-4" }, auth);
    expect(again).toMatchObject({ status: 200, body: { id: first.body.id, duplicate: true } });
    expect(ctx.app.hooks.record("ci")!.lastStatus).toBe("duplicate");
    expect(webhookRows()).toHaveLength(1);
  });

  it("answers anything but POST with 405", async () => {
    bearerSource();
    const got = await post("ci", undefined, {}, "GET");
    expect(got.status).toBe(405);
    expect(got.headers.get("allow")).toBe("POST");
  });
});
