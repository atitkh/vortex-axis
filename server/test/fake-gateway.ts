import { createHash, createPublicKey, verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

interface Conn {
  socket: WebSocket;
  role: string;
  deviceId: string;
  nonce: string;
  ts: number;
}

/**
 * A stand-in for an OpenClaw gateway, covering what Axis uses: the signed
 * handshake, setup codes and approval, per-role tokens, agent turns and node
 * commands.
 */
export class FakeGateway {
  readonly server: WebSocketServer;
  /** Devices a person has approved. */
  readonly approved = new Set<string>();
  /** Setup tokens that are still redeemable. */
  readonly bootstrapTokens = new Set<string>();
  /** Issued device tokens: token -> "deviceId:role". */
  readonly deviceTokens = new Map<string, string>();
  readonly connects: any[] = [];
  readonly agentRequests: any[] = [];
  readonly nodeRequests: { method: string; params: any }[] = [];
  readonly conns: Conn[] = [];
  agents = [
    { id: "main", default: true },
    { id: "vertex", default: false },
  ];
  /** Pieces of the reply an agent turn streams back. */
  reply: string[] = ["Hello ", "from the agent."];
  private issued = 0;
  private runs = 0;
  private readonly invokes = new Map<string, (result: any) => void>();

  constructor() {
    this.server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    this.server.on("connection", (socket, req) => {
      if (req.headers.origin) {
        socket.close(1008, "CONTROL_UI_ORIGIN_NOT_ALLOWED");
        return;
      }
      const conn: Conn = { socket, role: "", deviceId: "", nonce: `nonce-${Math.random()}`, ts: Date.now() };
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: conn.nonce, ts: conn.ts } }));
      socket.on("message", (data) => this.onFrame(conn, JSON.parse(data.toString())));
      socket.on("close", () => {
        const at = this.conns.indexOf(conn);
        if (at >= 0) this.conns.splice(at, 1);
      });
    });
  }

  /** Resolves once the server has a port. */
  listening(): Promise<void> {
    if (this.server.address()) return Promise.resolve();
    return new Promise((resolve) => this.server.once("listening", () => resolve()));
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Mints a setup code the way `openclaw qr --setup-code-only` does. */
  setupCode(urls: string[] = [this.url]): string {
    const bootstrapToken = `boot-${++this.issued}`;
    this.bootstrapTokens.add(bootstrapToken);
    return Buffer.from(JSON.stringify({ url: urls[0], urls, bootstrapToken })).toString("base64url");
  }

  connected(role: string): Conn | undefined {
    return this.conns.find((c) => c.role === role);
  }

  /** Sends a node command the way an agent's tool call would, and waits for the result. */
  invoke(command: string, params: unknown, timeoutMs = 3000): Promise<any> {
    const node = this.connected("node");
    if (!node) return Promise.reject(new Error("no node connected"));
    const id = `inv-${++this.issued}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`invoke ${command} timed out`)), timeoutMs);
      this.invokes.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      node.socket.send(
        JSON.stringify({
          type: "event",
          event: "node.invoke.request",
          payload: { id, nodeId: node.deviceId, command, paramsJSON: JSON.stringify(params), timeoutMs },
        }),
      );
    });
  }

  dropAll(): void {
    for (const conn of [...this.conns]) conn.socket.terminate();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private ok(conn: Conn, id: string, payload: unknown): void {
    conn.socket.send(JSON.stringify({ type: "res", id, ok: true, payload }));
  }

  private fail(conn: Conn, id: string, code: string, message = code): void {
    conn.socket.send(JSON.stringify({ type: "res", id, ok: false, error: { code: "INVALID_REQUEST", message, details: { code } } }));
  }

  private issue(deviceId: string, role: string): string {
    for (const [token, owner] of this.deviceTokens) if (owner === `${deviceId}:${role}`) this.deviceTokens.delete(token);
    const token = `dev-${role}-${++this.issued}`;
    this.deviceTokens.set(token, `${deviceId}:${role}`);
    return token;
  }

  private onFrame(conn: Conn, frame: any): void {
    if (frame.type !== "req") return;
    const { id, method, params } = frame;

    if (method === "connect") {
      this.connects.push(params);
      const { client, role, scopes, auth, device } = params;
      if (!["cli", "node-host"].includes(client.id) || !["cli", "node"].includes(client.mode)) {
        return this.fail(conn, id, "INVALID_REQUEST", "client.id is not allowed");
      }
      const raw = Buffer.from(device.publicKey, "base64");
      if (createHash("sha256").update(raw).digest("hex") !== device.id) {
        return this.fail(conn, id, "DEVICE_AUTH_DEVICE_ID_MISMATCH");
      }
      const token = auth.bootstrapToken ?? auth.deviceToken ?? "";
      const payload = ["v3", device.id, client.id, client.mode, role, scopes.join(","), String(device.signedAt), token, device.nonce, client.platform, ""].join("|");
      const key = createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
        format: "der",
        type: "spki",
      });
      if (device.nonce !== conn.nonce || !verify(null, Buffer.from(payload), key, Buffer.from(device.signature, "base64"))) {
        return this.fail(conn, id, "DEVICE_AUTH_SIGNATURE_INVALID");
      }

      let extra: any[] | undefined;
      if (auth.bootstrapToken) {
        if (!this.bootstrapTokens.has(auth.bootstrapToken)) return this.fail(conn, id, "AUTH_BOOTSTRAP_TOKEN_INVALID");
        if (!this.approved.has(device.id)) return this.fail(conn, id, "PAIRING_REQUIRED");
        // Redeeming issues a token for every approved role, the other one in deviceTokens[].
        const other = role === "operator" ? "node" : "operator";
        extra = [{ deviceToken: this.issue(device.id, other), role: other, scopes: [], issuedAtMs: Date.now() }];
      } else if (auth.deviceToken) {
        if (this.deviceTokens.get(auth.deviceToken) !== `${device.id}:${role}`) {
          return this.fail(conn, id, "AUTH_DEVICE_TOKEN_MISMATCH");
        }
      } else {
        return this.fail(conn, id, "AUTH_PASSWORD_MISSING");
      }

      conn.role = role;
      conn.deviceId = device.id;
      this.conns.push(conn);
      const own = auth.bootstrapToken ? this.issue(device.id, role) : auth.deviceToken;
      return this.ok(conn, id, {
        type: "hello-ok",
        protocol: 4,
        auth: { role, deviceToken: own, ...(extra ? { deviceTokens: extra } : {}) },
      });
    }

    if (!conn.role) return this.fail(conn, id, "AUTH_REQUIRED");

    if (conn.role === "node") {
      this.nodeRequests.push({ method, params });
      if (method === "node.invoke.result") this.invokes.get(params.id)?.(params);
      return this.ok(conn, id, {});
    }

    if (method === "agents.list") {
      return this.ok(conn, id, { defaultId: "main", agents: this.agents.map((a) => ({ id: a.id })) });
    }
    if (method === "agent") {
      this.agentRequests.push(params);
      if (params.agentId && !this.agents.some((a) => a.id === params.agentId)) {
        return this.fail(conn, id, "INVALID_REQUEST", `unknown agent ${params.agentId}`);
      }
      const runId = `run-${++this.runs}`;
      this.ok(conn, id, { runId, status: "accepted" });
      const send = (seq: number, stream: string, data: unknown) =>
        conn.socket.send(JSON.stringify({ type: "event", event: "agent", payload: { runId, seq, stream, ts: Date.now(), data } }));
      // Another run's events share the socket, as they do on a real gateway.
      conn.socket.send(JSON.stringify({ type: "event", event: "agent", payload: { runId: "someone-else", seq: 0, stream: "assistant", ts: 0, data: { text: "NOT FOR YOU" } } }));
      let text = "";
      this.reply.forEach((piece, i) => {
        text += piece;
        send(i, "assistant", { text });
      });
      send(this.reply.length, "lifecycle", { phase: "end", terminalReply: { text } });
      return;
    }
    return this.fail(conn, id, "INVALID_REQUEST", `unknown method ${method}`);
  }
}
