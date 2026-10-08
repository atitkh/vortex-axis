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
  /** Roles a person has approved, per device id. */
  readonly approvedRoles = new Map<string, Set<string>>();
  /** Pairing requests waiting for a person: "deviceId:role". */
  readonly pendingRequests = new Set<string>();
  /** A setup code in use by a pending request is refused to any other role, as on a real gateway. */
  private readonly codeInUse = new Map<string, string>();
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

  /** Approves pending requests the way `openclaw devices approve` does. Returns how many. */
  approve(deviceId: string, roles?: string[]): number {
    const granted = this.approvedRoles.get(deviceId) ?? new Set<string>();
    this.approvedRoles.set(deviceId, granted);
    let count = 0;
    for (const request of [...this.pendingRequests]) {
      const [id, role] = request.split(":") as [string, string];
      if (id !== deviceId || (roles && !roles.includes(role))) continue;
      granted.add(role);
      this.pendingRequests.delete(request);
      for (const [code, owner] of this.codeInUse) if (owner === request) this.codeInUse.delete(code);
      count++;
    }
    for (const role of roles ?? []) granted.add(role);
    return count;
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
    // A real gateway hangs up after refusing a connect.
    if (!conn.role) setTimeout(() => conn.socket.close(), 5);
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

      // A Linux node host is taken for the gateway's own headless node: it pins
      // a device family that an operator connect without one then fails to match.
      if (client.platform === "linux") return this.fail(conn, id, "PAIRING_REQUIRED", "device identity changed and must be re-approved");

      const granted = this.approvedRoles.get(device.id) ?? new Set<string>();
      const request = `${device.id}:${role}`;
      let extra: any[] | undefined;
      if (auth.bootstrapToken) {
        const token = auth.bootstrapToken;
        if (!this.bootstrapTokens.has(token)) return this.fail(conn, id, "AUTH_BOOTSTRAP_TOKEN_INVALID");
        const owner = this.codeInUse.get(token);
        if (owner && owner !== request) return this.fail(conn, id, "AUTH_BOOTSTRAP_TOKEN_INVALID");
        if (!granted.has(role)) {
          this.codeInUse.set(token, request);
          this.pendingRequests.add(request);
          return this.fail(
            conn,
            id,
            "PAIRING_REQUIRED",
            granted.size ? "device is asking for a higher role than currently approved" : "device is not approved yet",
          );
        }
        // Redeeming issues a token for every other approved role, in deviceTokens[].
        extra = [...granted]
          .filter((other) => other !== role)
          .map((other) => ({ deviceToken: this.issue(device.id, other), role: other, scopes: [], issuedAtMs: Date.now() }));
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
      if (method === "node.pluginSurface.refresh") return this.fail(conn, id, "INVALID_REQUEST", "surface required");
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
