import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@vortex-axis/protocol";
import { ADMIN_TOKEN, TestClient, admin, connect, ctx, newPairedClient, pair, restart, socketUrl, useServer } from "./harness.js";
import { steadyStatus } from "../src/app.js";
import { sentDefaults } from "../src/schema.js";

void ADMIN_TOKEN;
useServer();

describe("health", () => {
  it("answers /healthz without auth", async () => {
    const res = await fetch(`${ctx.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("admin API", () => {
  it("rejects a missing or wrong token", async () => {
    expect((await admin("GET", "/admin/clients", undefined, "nope")).status).toBe(401);
  });

  it("is disabled when no admin token is configured", async () => {
    await restart({ adminToken: undefined });
    expect((await admin("GET", "/admin/clients")).status).toBe(503);
  });
});

describe("pairing", () => {
  it("exchanges a code for an identity, once", async () => {
    const code = (await admin("POST", "/admin/pairing-codes")).body.code as string;
    expect(code).toMatch(/^\d{3}-\d{3}$/);

    const first = await pair(code, { name: "Desk" });
    expect(first.status).toBe(200);
    expect(first.body.clientId).toMatch(/^c_/);
    expect(first.body.name).toBe("Desk");
    expect(first.body.token.length).toBeGreaterThan(20);

    expect((await pair(code)).status).toBe(403);
  });

  it("accepts the code without its dash", async () => {
    const code = (await admin("POST", "/admin/pairing-codes")).body.code as string;
    expect((await pair(code.replace("-", ""))).status).toBe(200);
  });

  it("rejects a wrong code and an expired code", async () => {
    expect((await pair("000-000")).status).toBe(403);

    await restart({ pairingCodeTtlMs: 0 });
    const code = (await admin("POST", "/admin/pairing-codes")).body.code as string;
    expect((await pair(code)).status).toBe(403);
  });

  it("rejects a malformed request", async () => {
    const code = (await admin("POST", "/admin/pairing-codes")).body.code as string;
    expect((await pair(code, { capabilities: ["laser"] })).status).toBe(400);
  });

  it("keeps client names unique", async () => {
    const a = await newPairedClient({ name: "Desk" });
    const b = await newPairedClient({ name: "Desk" });
    expect([a.name, b.name]).toEqual(["Desk", "Desk 2"]);
  });

  it("limits repeated attempts", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await pair("000-000")).status);
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe("connecting", () => {
  it("welcomes a paired client and sends settings and status", async () => {
    await admin("PATCH", "/admin/settings/global", { values: { wakeWord: "hey vortex", volume: 50 } });
    const identity = await newPairedClient();
    const client = await connect(identity);

    const welcome = await client.next("welcome");
    expect(welcome.clientId).toBe(identity.clientId);
    expect(welcome.protocol).toBe(PROTOCOL_VERSION);

    const settings = await client.next("settings");
    expect(settings.version).toBe(welcome.settingsVersion);
    expect(settings.values).toEqual({ ...sentDefaults(), wakeWord: "hey vortex", volume: 50 });

    const status = await client.next("status");
    expect(status.upstream).toEqual({ openclaw: "unknown", stt: "unknown", tts: "unknown" });

    const listed = (await admin("GET", "/admin/clients")).body.clients;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: identity.clientId, online: true, type: "web" });
    expect(listed[0].token).toBeUndefined();
    expect(listed[0].token_hash).toBeUndefined();
  });

  it("skips settings when the client is already up to date", async () => {
    const identity = await newPairedClient();
    const client = await connect(identity, { settingsVersion: ctx.app.store.settingsVersion() });
    await client.next("status");
    expect(client.received.some((m) => m.t === "settings")).toBe(false);
  });

  it("rejects a wrong token", async () => {
    const identity = await newPairedClient();
    const client = await connect({ ...identity, token: "wrong" });
    const error = await client.next("error");
    expect(error).toMatchObject({ code: "unauthorized", fatal: true });
    expect(await client.closed()).toBe(4401);
  });

  it("rejects an unsupported protocol version", async () => {
    const identity = await newPairedClient();
    const client = await connect(identity, { protocol: PROTOCOL_VERSION + 1 });
    expect((await client.next("error")).code).toBe("unsupported_protocol");
    expect(await client.closed()).toBe(4400);
  });

  it("rejects anything before hello", async () => {
    const client = new TestClient(socketUrl());
    await client.opened();
    client.send({ t: "interrupt" });
    expect((await client.next("error")).code).toBe("bad_message");
    expect(await client.closed()).toBe(4400);
  });

  it("closes a connection that never says hello", async () => {
    await restart({ helloTimeoutMs: 100 });
    const client = new TestClient(socketUrl());
    await client.opened();
    expect((await client.next("error")).code).toBe("timeout");
    expect(await client.closed()).toBe(4400);
  });

  it("replaces an older connection from the same client", async () => {
    const identity = await newPairedClient();
    const first = await connect(identity);
    await first.next("status");
    const second = await connect(identity);
    await second.next("status");

    expect((await first.next("error")).code).toBe("busy");
    expect(await first.closed()).toBe(4409);
    expect(ctx.app.hub.isOnline(identity.clientId)).toBe(true);
  });

  it("keeps the connection open after a malformed message", async () => {
    const identity = await newPairedClient();
    const client = await connect(identity);
    await client.next("status");
    client.sendRaw('{"t":"launch"}');
    expect((await client.next("error")).code).toBe("bad_message");
    expect(ctx.app.hub.isOnline(identity.clientId)).toBe(true);
  });

  it("refuses sockets on other paths", async () => {
    const client = new TestClient(socketUrl("/elsewhere"));
    await expect(client.opened()).rejects.toThrow();
  });
});

describe("settings", () => {
  it("layers global, type and device, most specific first", async () => {
    const identity = await newPairedClient();
    await admin("PATCH", "/admin/settings/global", { values: { volume: 50, voice: "nova", wakeWord: "hey vortex" } });
    await admin("PATCH", "/admin/settings/type/web", { values: { volume: 70, voice: "echo" } });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 90, location: "office" } });

    const client = await connect(identity);
    const settings = await client.next("settings");
    expect(settings.values).toEqual({ ...sentDefaults(), volume: 90, voice: "echo", wakeWord: "hey vortex", location: "office" });
  });

  it("pushes a change to connected clients", async () => {
    const identity = await newPairedClient();
    const client = await connect(identity);
    await client.next("status");
    const seen = client.received.length;

    const patched = await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 30 } });
    expect(patched.status).toBe(200);

    const settings = await client.next("settings", seen);
    expect(settings.values).toEqual({ ...sentDefaults(), volume: 30 });
    expect(settings.version).toBe(patched.body.version);
  });

  it("removes a key when it is set to null", async () => {
    const identity = await newPairedClient();
    await admin("PATCH", "/admin/settings/global", { values: { volume: 50 } });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 90 } });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: null } });

    const described = (await admin("GET", `/admin/clients/${identity.clientId}`)).body;
    expect(described.settings).toEqual({ volume: 50 });
  });

  it("answers settings.get only when the client is behind", async () => {
    const identity = await newPairedClient();
    const client = await connect(identity, { settingsVersion: ctx.app.store.settingsVersion() });
    await client.next("status");

    client.send({ t: "settings.get", have: 0 });
    const settings = await client.next("settings");
    expect(settings.version).toBe(ctx.app.store.settingsVersion());
  });

  it("rejects invalid values and unknown devices", async () => {
    expect((await admin("PATCH", "/admin/settings/global", { values: { nested: { a: 1 } } })).status).toBe(400);
    expect((await admin("PATCH", "/admin/settings/device/c_missing", { values: { volume: 1 } })).status).toBe(404);
  });

  it("survives a restart", async () => {
    const identity = await newPairedClient();
    await admin("PATCH", "/admin/settings/global", { values: { voice: "nova" } });
    await restart();

    const client = await connect(identity);
    expect((await client.next("settings")).values).toEqual({ ...sentDefaults(), voice: "nova" });
  });
});

describe("clients", () => {
  it("records sensor readings in memory", async () => {
    const identity = await newPairedClient();
    const client = await connect(identity);
    await client.next("status");
    client.send({ t: "sense", readings: { battery: 0.8 } });
    client.send({ t: "sense", readings: { charging: true } });
    client.send({ t: "settings.get", have: 0 });
    await client.next("settings");

    const described = (await admin("GET", `/admin/clients/${identity.clientId}`)).body;
    expect(described.readings).toEqual({ battery: 0.8, charging: true });
  });

  it("removing a client disconnects it and kills its token", async () => {
    const identity = await newPairedClient();
    const client = await connect(identity);
    await client.next("status");

    expect((await admin("DELETE", `/admin/clients/${identity.clientId}`)).status).toBe(200);
    expect(await client.closed()).toBe(4410);

    const again = await connect(identity);
    expect((await again.next("error")).code).toBe("unauthorized");
    expect((await admin("GET", "/admin/clients")).body.clients).toEqual([]);
  });
});

describe("a client that goes silent", () => {
  it("is dropped when it stops answering pings, and one that answers stays", async () => {
    await restart({ pingIntervalMs: 50 });
    const silent = await newPairedClient();
    const alive = await newPairedClient();
    // A device that lost power: the socket stays open but nothing comes back.
    const ws = new WebSocket(socketUrl(), { autoPong: false });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, clientId: silent.clientId, token: silent.token, type: "web", version: "0.1.0", capabilities: ["screen"], settingsVersion: 0 }));
    const answering = await connect(alive);
    await answering.next("status");
    expect((await admin("GET", `/admin/clients/${silent.clientId}`)).body.online).toBe(true);

    await new Promise((r) => setTimeout(r, 250));
    expect((await admin("GET", `/admin/clients/${silent.clientId}`)).body.online).toBe(false);
    expect((await admin("GET", `/admin/clients/${alive.clientId}`)).body.online).toBe(true);
    ws.close();
  });
});

describe("service status", () => {
  it("calls a service down only after two missed checks in a row", () => {
    const status = steadyStatus();
    expect(status("up")).toBe("up");
    expect(status("down")).toBe("up");
    expect(status("up")).toBe("up");
    expect(status("down")).toBe("up");
    expect(status("down")).toBe("down");
    expect(status("up")).toBe("up");
  });

  it("believes a miss at once when the service has not been seen up", () => {
    expect(steadyStatus()("down")).toBe("down");
  });
});

describe("version", () => {
  it("is one number, written once, for the server, its packages and the web pages", async () => {
    const { readFileSync } = await import("node:fs");
    const { AXIS_VERSION } = await import("../src/version.js");
    const of = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).version;
    expect(AXIS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect([of("../../package.json"), of("../package.json"), of("../../protocol/package.json")]).toEqual([AXIS_VERSION, AXIS_VERSION, AXIS_VERSION]);
    expect((await admin("GET", "/admin/status")).body).toMatchObject({ version: AXIS_VERSION, protocol: 1 });
    // The web client is handed the same number to report as its own.
    const page = await (await fetch(`${ctx.base}/web/client.js`)).text();
    expect(page).toContain(`const VERSION = "${AXIS_VERSION}";`);
    expect(page).not.toContain("__AXIS_VERSION__");
  });
});
