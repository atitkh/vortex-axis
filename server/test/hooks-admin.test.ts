import { describe, expect, it } from "vitest";
import { admin, ctx, useServer } from "./harness.js";

useServer();

const make = (extra: Record<string, unknown> = {}) => admin("POST", "/admin/hooks", { id: "ci", label: "CI", auth: "bearer", ...extra });
const rows = () => ctx.app.store.listNotifications({ source: "webhook" });

describe("webhook admin", () => {
  it("needs the admin token and does not exist under a public name", async () => {
    expect((await admin("GET", "/admin/hooks", undefined, "wrong")).status).toBe(401);
    await admin("PATCH", "/admin/integrations", { publicHosts: "axis.example.org" });
    const res = await fetch(`${ctx.base}/admin/hooks`, { headers: { authorization: "Bearer test-admin-token", "x-forwarded-host": "axis.example.org" } });
    expect(res.status).toBe(404);
  });

  it("shows the secret only when made or rotated, never in a list", async () => {
    const made = await make();
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/\S{16,}/);
    expect(made.body.source.path).toBe("/v1/hook/ci");
    const listed = await admin("GET", "/admin/hooks");
    expect(JSON.stringify(listed.body)).not.toContain(made.body.secret);
    expect(listed.body.hooks[0]).not.toHaveProperty("tokenHash");
    expect(listed.body.hooks[0]).not.toHaveProperty("hmacSecret");
    const rotated = await admin("POST", "/admin/hooks/ci/rotate");
    expect(rotated.body.secret).not.toBe(made.body.secret);
    expect(JSON.stringify((await admin("GET", "/admin/hooks")).body)).not.toContain(rotated.body.secret);
    const patched = await admin("PATCH", "/admin/hooks/ci", { enabled: false, ceiling: "speak" });
    expect(patched.body.hooks[0]).toMatchObject({ enabled: false, ceiling: "speak" });
  });

  it("refuses what is not valid", async () => {
    expect((await make({ id: "Bad Name" })).status).toBe(400);
    expect((await make({ ceiling: "shout" })).status).toBe(400);
    expect((await make({ askAgent: true })).status).toBe(400);
    expect((await make({ ratePerMin: 0 })).status).toBe(400);
    expect((await make({ ratePerMin: 601 })).status).toBe(400);
    expect((await make({ maxBody: 10 })).status).toBe(400);
    expect((await make({ maxBody: 999_999 })).status).toBe(400);
    expect((await make({ auth: "basic" })).status).toBe(400);
    expect((await make()).status).toBe(201);
    expect((await make()).status).toBe(400);
    expect((await admin("PATCH", "/admin/hooks/ci", { askAgent: true })).status).toBe(400);
    expect((await admin("PATCH", "/admin/hooks/nope", { enabled: true })).status).toBe(404);
    expect((await admin("POST", "/admin/hooks/nope/rotate")).status).toBe(404);
    expect((await admin("DELETE", "/admin/hooks/nope")).status).toBe(404);
  });

  it("deleting a source makes its address 404", async () => {
    const made = await make();
    const url = `${ctx.base}/v1/hook/ci`;
    const post = () => fetch(url, { method: "POST", headers: { authorization: `Bearer ${made.body.secret}`, "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
    expect((await post()).status).toBe(202);
    expect((await admin("DELETE", "/admin/hooks/ci")).status).toBe(200);
    expect((await post()).status).toBe(404);
  });

  it("a test send goes through clamp and writes a row tagged test", async () => {
    await make();
    const before = rows().length;
    const sent = await admin("POST", "/admin/hooks/ci/test");
    expect(sent.status).toBe(202);
    const after = rows();
    expect(after.length).toBe(before + 1);
    expect(JSON.stringify(after[0])).toContain("test");
    expect((await admin("POST", "/admin/hooks/nope/test")).status).toBe(404);
  });
});
