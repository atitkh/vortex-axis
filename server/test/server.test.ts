import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CLIENT_SOCKET_PATH,
  PAIR_PATH,
  PROTOCOL_VERSION,
  encodeClientMessage,
  parseServerMessage,
  type ClientMessage,
  type PairResponse,
  type ServerMessage,
} from "@vortex-axis/protocol";
import { startApp, type App } from "../src/app.js";
import type { Config } from "../src/config.js";

const ADMIN_TOKEN = "test-admin-token";

let app: App;
let dataDir: string;
let base: string;
const open: TestClient[] = [];

function config(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    adminToken: ADMIN_TOKEN,
    pairingCodeTtlMs: 60_000,
    helloTimeoutMs: 2_000,
    ...overrides,
  };
}

async function admin(method: string, path: string, body?: unknown, token = ADMIN_TOKEN) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function pair(code: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}${PAIR_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, type: "web", version: "0.1.0", capabilities: ["mic", "speaker"], ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function newPairedClient(extra: Record<string, unknown> = {}): Promise<PairResponse> {
  const code = (await admin("POST", "/admin/pairing-codes")).body.code as string;
  const paired = await pair(code, extra);
  expect(paired.status).toBe(200);
  return paired.body as PairResponse;
}

/** A minimal client: collects server messages and lets a test wait for one. */
class TestClient {
  readonly received: ServerMessage[] = [];
  closeCode: number | undefined;
  private waiters: (() => void)[] = [];
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data) => {
      const parsed = parseServerMessage(data.toString());
      if (!parsed.ok) throw new Error(`server sent an invalid message: ${parsed.error}`);
      this.received.push(parsed.message);
      this.wake();
    });
    this.socket.on("close", (code) => {
      this.closeCode = code;
      this.wake();
    });
    this.socket.on("error", () => {});
    open.push(this);
  }

  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
  }

  send(message: ClientMessage) {
    this.socket.send(encodeClientMessage(message));
  }

  sendRaw(text: string) {
    this.socket.send(text);
  }

  /** Resolves with the next message of that type at or after `from`. */
  async next<T extends ServerMessage["t"]>(t: T, from = 0): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const found = this.received.slice(from).find((m) => m.t === t);
      if (found) return found as Extract<ServerMessage, { t: T }>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for "${t}"`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  async closed(): Promise<number> {
    const deadline = Date.now() + 2_000;
    while (this.closeCode === undefined) {
      if (Date.now() > deadline) throw new Error("timed out waiting for close");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return this.closeCode;
  }

  close() {
    this.socket.close();
  }
}

async function connect(identity: PairResponse, overrides: Partial<Extract<ClientMessage, { t: "hello" }>> = {}) {
  const client = new TestClient(`${base.replace("http", "ws")}${CLIENT_SOCKET_PATH}`);
  await client.opened();
  client.send({
    t: "hello",
    protocol: PROTOCOL_VERSION,
    clientId: identity.clientId,
    token: identity.token,
    type: "web",
    version: "0.1.0",
    capabilities: ["mic", "speaker"],
    settingsVersion: 0,
    ...overrides,
  });
  return client;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "axis-test-"));
  app = await startApp(config());
  base = `http://127.0.0.1:${app.port}`;
});

afterEach(async () => {
  for (const client of open.splice(0)) client.close();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("health", () => {
  it("answers /healthz without auth", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("admin API", () => {
  it("rejects a missing or wrong token", async () => {
    expect((await admin("GET", "/admin/clients", undefined, "nope")).status).toBe(401);
  });

  it("is disabled when no admin token is configured", async () => {
    await app.close();
    app = await startApp(config({ adminToken: undefined }));
    base = `http://127.0.0.1:${app.port}`;
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

    await app.close();
    app = await startApp(config({ pairingCodeTtlMs: 0 }));
    base = `http://127.0.0.1:${app.port}`;
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
    expect(settings.values).toEqual({ wakeWord: "hey vortex", volume: 50 });

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
    const client = await connect(identity, { settingsVersion: app.store.settingsVersion() });
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
    const client = new TestClient(`${base.replace("http", "ws")}${CLIENT_SOCKET_PATH}`);
    await client.opened();
    client.send({ t: "interrupt" });
    expect((await client.next("error")).code).toBe("bad_message");
    expect(await client.closed()).toBe(4400);
  });

  it("closes a connection that never says hello", async () => {
    await app.close();
    app = await startApp(config({ helloTimeoutMs: 100 }));
    base = `http://127.0.0.1:${app.port}`;
    const client = new TestClient(`${base.replace("http", "ws")}${CLIENT_SOCKET_PATH}`);
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
    expect(app.hub.isOnline(identity.clientId)).toBe(true);
  });

  it("keeps the connection open after a malformed message", async () => {
    const identity = await newPairedClient();
    const client = await connect(identity);
    await client.next("status");
    client.sendRaw('{"t":"launch"}');
    expect((await client.next("error")).code).toBe("bad_message");
    expect(app.hub.isOnline(identity.clientId)).toBe(true);
  });

  it("says turns are not supported yet", async () => {
    const identity = await newPairedClient();
    const client = await connect(identity);
    await client.next("status");
    client.send({ t: "text", turnId: "t1", text: "hello" });
    expect((await client.next("error")).code).toBe("not_supported");
  });

  it("refuses sockets on other paths", async () => {
    const client = new TestClient(`${base.replace("http", "ws")}/elsewhere`);
    await expect(client.opened()).rejects.toThrow();
  });
});

describe("settings", () => {
  it("layers global, type and device, most specific first", async () => {
    const identity = await newPairedClient();
    await admin("PATCH", "/admin/settings/global", { values: { volume: 50, voice: "nova", wakeWord: "hey vortex" } });
    await admin("PATCH", "/admin/settings/type/web", { values: { volume: 70, voice: "echo" } });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 90, room: "office" } });

    const client = await connect(identity);
    const settings = await client.next("settings");
    expect(settings.values).toEqual({ volume: 90, voice: "echo", wakeWord: "hey vortex", room: "office" });
  });

  it("pushes a change to connected clients", async () => {
    const identity = await newPairedClient();
    const client = await connect(identity);
    await client.next("status");
    const seen = client.received.length;

    const patched = await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 30 } });
    expect(patched.status).toBe(200);

    const settings = await client.next("settings", seen);
    expect(settings.values).toEqual({ volume: 30 });
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
    const client = await connect(identity, { settingsVersion: app.store.settingsVersion() });
    await client.next("status");

    client.send({ t: "settings.get", have: 0 });
    const settings = await client.next("settings");
    expect(settings.version).toBe(app.store.settingsVersion());
  });

  it("rejects invalid values and unknown devices", async () => {
    expect((await admin("PATCH", "/admin/settings/global", { values: { nested: { a: 1 } } })).status).toBe(400);
    expect((await admin("PATCH", "/admin/settings/device/c_missing", { values: { volume: 1 } })).status).toBe(404);
  });

  it("survives a restart", async () => {
    const identity = await newPairedClient();
    await admin("PATCH", "/admin/settings/global", { values: { voice: "nova" } });
    await app.close();
    app = await startApp(config());
    base = `http://127.0.0.1:${app.port}`;

    const client = await connect(identity);
    expect((await client.next("settings")).values).toEqual({ voice: "nova" });
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
