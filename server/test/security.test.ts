import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, admin, ctx, pair, restart, useServer } from "./harness.js";

useServer();

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${ctx.base}${path}`, { headers });

describe("a public address", () => {
  it("serves the client side only: the admin page and API are not there", async () => {
    await restart({ publicHosts: ["axis.example.org"] });
    // fetch does not let a test set Host, so the name arrives the way a reverse proxy passes it on.
    const outside = { "x-forwarded-host": "axis.example.org", authorization: `Bearer ${ADMIN_TOKEN}` };
    expect((await get("/admin", outside)).status).toBe(404);
    expect((await get("/admin/clients", outside)).status).toBe(404);
    expect((await get("/admin/clients", { ...outside, "x-forwarded-host": "AXIS.example.org:443" })).status).toBe(404);
    expect((await get("/", outside)).status).toBe(200);
    expect((await get("/healthz", outside)).status).toBe(200);
    // Under its local name everything is as before.
    expect((await get("/admin")).status).toBe(200);
    expect((await admin("GET", "/admin/clients")).status).toBe(200);
  });

  it("sends pages with a policy that keeps them to their own files", async () => {
    const page = await get("/");
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'self'/);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect((await get("/healthz")).headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("guessing", () => {
  it("shuts an address out after ten wrong admin tokens, and not for merely having none", async () => {
    for (let i = 0; i < 12; i++) expect((await get("/admin/clients")).status).toBe(401);
    for (let i = 0; i < 10; i++) expect((await admin("GET", "/admin/clients", undefined, `wrong-${i}`)).status).toBe(401);
    expect((await admin("GET", "/admin/clients", undefined, "wrong-again")).status).toBe(429);
    // Even the right token waits out the lock, so a guesser learns nothing from it.
    expect((await admin("GET", "/admin/clients")).status).toBe(429);
  });

  it("believes X-Forwarded-For only from a trusted proxy", async () => {
    await restart({ trustedProxies: ["127.0.0.1"] });
    const from = (address: string, token: string) =>
      fetch(`${ctx.base}/admin/clients`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": address } });
    for (let i = 0; i < 10; i++) await from("203.0.113.9", "wrong");
    expect((await from("203.0.113.9", ADMIN_TOKEN)).status).toBe(429);
    expect((await from("198.51.100.4", ADMIN_TOKEN)).status).toBe(200);

    await restart({ trustedProxies: [] });
    for (let i = 0; i < 10; i++) await from(`203.0.113.${i}`, "wrong");
    // Without a trusted proxy the header is ignored: all ten came from one address.
    expect((await from("198.51.100.4", ADMIN_TOKEN)).status).toBe(429);
  });

  it("throws away unused pairing codes after thirty wrong ones", async () => {
    await restart({ trustedProxies: ["127.0.0.1"] });
    const code = (await admin("POST", "/admin/pairing-codes")).body.code as string;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${ctx.base}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${i}` },
        body: JSON.stringify({ code: "000-000", type: "web", version: "0.1.0", capabilities: ["screen"] }),
      });
      expect(res.status).toBe(403);
    }
    // The real code no longer works: it was dropped with the rest.
    expect((await pair(code)).status).toBe(403);
    const fresh = (await admin("POST", "/admin/pairing-codes")).body.code as string;
    expect((await pair(fresh)).status).toBe(200);
  });
});
