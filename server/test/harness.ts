import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import WebSocket from "ws";
import {
  CLIENT_SOCKET_PATH,
  PAIR_PATH,
  PROTOCOL_VERSION,
  encodeClientMessage,
  parseServerMessage,
  type Capability,
  type ClientMessage,
  type PairResponse,
  type ServerMessage,
} from "@vortex-axis/protocol";
import { startApp, type App } from "../src/app.js";
import type { Config } from "../src/config.js";
import type { Services } from "../src/turns.js";

export const ADMIN_TOKEN = "test-admin-token";

/** Mutable handles for the server a test is running against. */
/** How long a test waits for a message from the server. Tests that expect none wait this long too, so it stays short; a busy machine is covered by retries (vitest.config.ts). */
const WAIT_MS = 3_000;

export const ctx = {
  app: undefined as unknown as App,
  dataDir: "",
  base: "",
  services: {} as Services,
};
const open: TestClient[] = [];

export function config(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: ctx.dataDir,
    adminToken: ADMIN_TOKEN,
    publicHosts: [],
    trustedProxies: [],
    pairingCodeTtlMs: 60_000,
    helloTimeoutMs: 2_000,
    pingIntervalMs: 0,
    activityDays: 7,
    wakeWindowMs: 60,
    maxUtteranceMs: 30_000,
    healthIntervalMs: 0,
    stt: undefined,
    tts: undefined,
    agent: undefined,
    gateway: { url: undefined, agentId: undefined, sessionKey: "vortex-axis", displayName: "VorteX Axis" },
    outputHoldMs: 600_000,
    messageHoldMs: 600_000,
    mcpPublic: false,
    mirrorCards: true,
    mirrorQuestions: false,
    mirrorApprovals: false,
    backupDir: undefined,
    backupEveryHours: 1,
    backupKeepDays: 7,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    homeAssistant: undefined,
    webDir: fileURLToPath(new URL("../../web", import.meta.url)),
    bundledDir: undefined,
    flasherDir: fileURLToPath(new URL("../../flasher", import.meta.url)),
    ...overrides,
  };
}

/** Stops the running server and starts another on the same data directory. */
export async function restart(overrides: Partial<Config> = {}, services: Services = ctx.services): Promise<void> {
  if (ctx.app) await ctx.app.close();
  ctx.services = services;
  ctx.app = await startApp(config(overrides), {
    services,
    // Short delays so tests of the gateway link do not wait.
    gatewayTiming: { reconnectMs: 60, pairingRetryMs: 60, authBackoffStartMs: 80, authBackoffMaxMs: 200 },
  });
  ctx.base = `http://127.0.0.1:${ctx.app.port}`;
}

export async function admin(method: string, path: string, body?: unknown, token = ADMIN_TOKEN) {
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function pair(code: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${ctx.base}${PAIR_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, type: "web", version: "0.1.0", capabilities: ["mic", "speaker"], ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function newPairedClient(extra: Record<string, unknown> = {}): Promise<PairResponse> {
  const code = (await admin("POST", "/admin/pairing-codes")).body.code as string;
  const paired = await pair(code, extra);
  expect(paired.status).toBe(200);
  return paired.body as PairResponse;
}

export function socketUrl(path: string = CLIENT_SOCKET_PATH): string {
  return `${ctx.base.replace("http", "ws")}${path}`;
}

/** A minimal client: collects what the server sends and lets a test wait for it. */
export class TestClient {
  readonly received: ServerMessage[] = [];
  /** Binary frames, in order. */
  readonly audio: Buffer[] = [];
  /** Text and binary frames interleaved, to check ordering. */
  readonly timeline: (ServerMessage | { t: "<audio>"; bytes: number; at: number })[] = [];
  closeCode: number | undefined;
  private waiters: (() => void)[] = [];
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = data as Buffer;
        this.audio.push(frame);
        this.timeline.push({ t: "<audio>", bytes: frame.length, at: Date.now() });
      } else {
        const parsed = parseServerMessage(data.toString());
        if (!parsed.ok) throw new Error(`server sent an invalid message: ${parsed.error}`);
        this.received.push(parsed.message);
        this.timeline.push(parsed.message);
      }
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

  private pause(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      setTimeout(resolve, 25);
    });
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

  sendAudio(data: Buffer) {
    this.socket.send(data, { binary: true });
  }

  /** Resolves with the next message of that type at or after index `from`. */
  async next<T extends ServerMessage["t"]>(
    t: T,
    from = 0,
    match: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const found = this.received.slice(from).find((m) => m.t === t && match(m as Extract<ServerMessage, { t: T }>));
      if (found) return found as Extract<ServerMessage, { t: T }>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for "${t}"`);
      await this.pause();
    }
  }

  /** Waits for a turn to reach a state. */
  turn(turnId: string, state: Extract<ServerMessage, { t: "turn" }>["state"]) {
    return this.next("turn", 0, (m) => m.turnId === turnId && m.state === state);
  }

  types(): string[] {
    return this.received.map((m) => m.t);
  }

  async closed(): Promise<number> {
    const deadline = Date.now() + WAIT_MS;
    while (this.closeCode === undefined) {
      if (Date.now() > deadline) throw new Error("timed out waiting for close");
      await this.pause();
    }
    return this.closeCode;
  }

  close() {
    this.socket.close();
  }
}

export async function connect(
  identity: PairResponse,
  overrides: Partial<Extract<ClientMessage, { t: "hello" }>> = {},
): Promise<TestClient> {
  const client = new TestClient(socketUrl());
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

/** Pairs a client with the given capabilities, connects it and waits until it is ready. */
export async function ready(
  capabilities: Capability[] = ["mic", "speaker", "screen"],
  extra: { name?: string; hello?: Partial<Extract<ClientMessage, { t: "hello" }>> } = {},
): Promise<{ identity: PairResponse; client: TestClient }> {
  const identity = await newPairedClient({ capabilities, ...(extra.name ? { name: extra.name } : {}) });
  const client = await connect(identity, { capabilities, ...extra.hello });
  await client.next("status");
  return { identity, client };
}

/** Registers the per-test server lifecycle. Call once at the top of a test file. */
export function useServer(services: () => Services = () => ({})): void {
  beforeEach(async () => {
    ctx.dataDir = mkdtempSync(join(tmpdir(), "axis-test-"));
    ctx.app = undefined as unknown as App;
    await restart({}, services());
  });

  afterEach(async () => {
    for (const client of open.splice(0)) client.close();
    await ctx.app.close();
    rmSync(ctx.dataDir, { recursive: true, force: true });
  });
}
