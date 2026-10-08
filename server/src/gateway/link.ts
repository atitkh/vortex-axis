import WebSocket from "ws";
import {
  CLIENT_KIND,
  GATEWAY_PROTOCOL,
  GatewayError,
  PLATFORM,
  authPayload,
  errorCode,
  isAuthCode,
  type DeviceIdentity,
  type EventFrame,
  type ResponseFrame,
  type Role,
} from "./wire.js";

export type LinkState =
  /** Nothing to connect with: no address, or no credential. */
  | "unconfigured"
  | "connecting"
  | "connected"
  /** The gateway knows this device and is waiting for a person to approve it. */
  | "pairing_required"
  /** The credential was refused. A new setup code is needed. */
  | "auth_failed"
  /** The gateway did not answer. */
  | "unreachable";

/** Credentials shared by both links. One device identity, one token per role. */
export interface Credentials {
  url(): string | undefined;
  identity(): DeviceIdentity;
  deviceToken(role: Role): string | undefined;
  bootstrapToken(): string | undefined;
  /** Stores the tokens a successful connect in role `from` returned. */
  storeTokens(from: Role, tokens: Partial<Record<Role, string>>): void;
  dropDeviceToken(role: Role): void;
  dropBootstrapToken(): void;
}

export interface LinkOptions {
  role: Role;
  scopes: string[];
  caps: string[];
  /** Node role only: the commands this node accepts. */
  commands?: string[];
  displayName: string;
  version: string;
  credentials: Credentials;
  log: (line: string) => void;
  onState?: (state: LinkState) => void;
  onEvent?: (event: string, payload: any) => void;
  /** Called after each successful handshake. */
  onConnected?: () => void;
  /** Delays, overridable so tests do not wait. */
  timing?: Partial<LinkTiming>;
}

interface LinkTiming {
  reconnectMs: number;
  pairingRetryMs: number;
  authBackoffStartMs: number;
  authBackoffMaxMs: number;
  requestTimeoutMs: number;
}

const DEFAULT_TIMING: LinkTiming = {
  reconnectMs: 4_000,
  // Pairing is cleared by a person, usually within seconds, so it never backs off.
  pairingRetryMs: 10_000,
  // A refused credential retried on a fixed interval trips the gateway's rate
  // limit, which then blocks connections that would have worked.
  authBackoffStartMs: 15_000,
  authBackoffMaxMs: 8 * 60_000,
  requestTimeoutMs: 15_000,
};

interface Pending {
  resolve: (payload: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One WebSocket connection to the gateway in one role, kept alive across failures. */
export class GatewayLink {
  state: LinkState = "unconfigured";
  /** Last failure, for the status page. */
  lastError: string | undefined;

  private socket: WebSocket | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private authBackoffMs = 0;
  private nextId = 0;
  private stopped = true;
  /** The bootstrap token already presented in this attempt cycle. */
  private bootstrapTried: string | undefined;
  private connectId: string | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly timing: LinkTiming;

  constructor(private readonly options: LinkOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
  }

  get role(): Role {
    return this.options.role;
  }

  get connected(): boolean {
    return this.state === "connected";
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
    this.dropSocket(new GatewayError("CLOSED", "link stopped"));
    this.setState("unconfigured");
  }

  /** Forgets backoff and tries again now. Used after a new setup code or a manual retry. */
  retryNow(): void {
    if (this.stopped) return;
    this.authBackoffMs = 0;
    this.bootstrapTried = undefined;
    this.clearRetry();
    this.dropSocket(new GatewayError("CLOSED", "reconnecting"));
    this.connect();
  }

  /** Sends a request and resolves with its payload. Rejects with a GatewayError. */
  request(method: string, params: unknown, timeoutMs = this.timing.requestTimeoutMs): Promise<any> {
    const socket = this.socket;
    if (!this.connected || !socket) {
      return Promise.reject(new GatewayError("NOT_CONNECTED", `${this.role} link is not connected`));
    }
    return new Promise((resolve, reject) => {
      const id = String(++this.nextId);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError("TIMEOUT", `${method} got no answer`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  private setState(state: LinkState, error?: string): void {
    if (error !== undefined) this.lastError = error;
    if (state === "connected") this.lastError = undefined;
    if (this.state === state) return;
    this.state = state;
    this.options.onState?.(state);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private retryIn(ms: number): void {
    this.clearRetry();
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => this.connect(), ms);
  }

  private dropSocket(reason: GatewayError): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connectId = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.terminate();
    }
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const { credentials, role } = this.options;
    const url = credentials.url();
    const hasCredential = Boolean(credentials.bootstrapToken() || credentials.deviceToken(role));
    // With no credential the gateway would only answer that one is missing, on
    // a loop. Stand down until a setup code arrives.
    if (!url || !hasCredential) {
      this.setState("unconfigured");
      return;
    }
    if (this.state !== "pairing_required" && this.state !== "auth_failed") this.setState("connecting");

    // The `ws` library sends no Origin header. That matters: with one, the
    // gateway treats the connection as a browser session and refuses it.
    const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.socket = socket;

    socket.on("message", (data) => {
      if (this.socket !== socket) return;
      let frame: EventFrame | ResponseFrame;
      try {
        frame = JSON.parse(data.toString()) as EventFrame | ResponseFrame;
      } catch {
        return;
      }
      if (frame.type === "event") this.onEventFrame(frame);
      else if (frame.type === "res") this.onResponse(frame);
    });

    socket.on("close", () => {
      if (this.socket !== socket) return;
      const wasConnected = this.connected;
      this.dropSocket(new GatewayError("CLOSED", "connection closed"));
      if (wasConnected) {
        this.options.log(`gateway ${role} link closed, reconnecting`);
        this.setState("connecting");
        this.retryIn(this.timing.reconnectMs);
      } else if (!this.retryTimer) {
        // Closed before any answer to connect.
        if (this.state === "connecting") this.setState("unreachable", "gateway closed the connection");
        this.retryIn(this.timing.reconnectMs);
      }
    });

    socket.on("error", (error) => {
      if (this.socket !== socket) return;
      this.dropSocket(new GatewayError("CLOSED", error.message));
      if (this.state === "connecting") this.setState("unreachable", error.message);
      this.retryIn(this.timing.reconnectMs);
    });
  }

  private onEventFrame(frame: EventFrame): void {
    if (frame.event === "connect.challenge") {
      this.sendConnect(String(frame.payload?.nonce ?? ""), Number(frame.payload?.ts ?? Date.now()));
      return;
    }
    if (this.connected) this.options.onEvent?.(frame.event, frame.payload);
  }

  private sendConnect(nonce: string, signedAtMs: number): void {
    const { credentials, role, scopes } = this.options;
    const identity = credentials.identity();
    const bootstrap = credentials.bootstrapToken();
    const device = credentials.deviceToken(role);

    // A waiting setup code means "pair again", and redeeming it retires the old
    // tokens of every role. So each link presents it once before falling back
    // to the token it already holds.
    const useBootstrap = Boolean(bootstrap) && this.bootstrapTried !== bootstrap;
    if (useBootstrap) this.bootstrapTried = bootstrap;
    const token = useBootstrap ? bootstrap! : (device ?? "");

    const kind = CLIENT_KIND[role];
    const signature = identity.sign(
      authPayload({ deviceId: identity.deviceId, role, scopes, signedAtMs, token, nonce }),
    );
    const id = String(++this.nextId);
    this.connectId = id;
    this.socket?.send(
      JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
          minProtocol: GATEWAY_PROTOCOL,
          maxProtocol: GATEWAY_PROTOCOL,
          client: {
            id: kind.id,
            mode: kind.mode,
            displayName: this.options.displayName,
            version: this.options.version,
            platform: PLATFORM,
          },
          role,
          scopes,
          caps: this.options.caps,
          ...(role === "node" ? { commands: this.options.commands ?? [], permissions: {} } : {}),
          auth: useBootstrap ? { bootstrapToken: token } : device ? { deviceToken: device } : {},
          device: {
            id: identity.deviceId,
            publicKey: identity.publicKey,
            signature,
            signedAt: signedAtMs,
            nonce,
          },
        },
      }),
    );
  }

  private onResponse(frame: ResponseFrame): void {
    if (frame.id === this.connectId) {
      this.connectId = undefined;
      if (frame.ok) this.onHello(frame.payload);
      else this.onConnectRefused(errorCode(frame.error), frame.error?.message ?? "connect refused");
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) pending.resolve(frame.payload);
    else {
      const code = errorCode(frame.error);
      pending.reject(new GatewayError(code, frame.error?.message ?? code));
      // Only credential failures justify dropping the connection. Anything else
      // is the result of one method call.
      if (isAuthCode(code)) this.onConnectRefused(code, frame.error?.message ?? code);
    }
  }

  private onHello(payload: any): void {
    const { credentials, role } = this.options;
    const tokens: Partial<Record<Role, string>> = {};
    const own = payload?.auth?.deviceToken;
    if (typeof own === "string" && own) tokens[role] = own;
    // Tokens for the other roles arrive only when a setup code is redeemed, and
    // each entry keys its token as `deviceToken`.
    for (const entry of Array.isArray(payload?.auth?.deviceTokens) ? payload.auth.deviceTokens : []) {
      const token = entry?.deviceToken ?? entry?.token;
      if ((entry?.role === "operator" || entry?.role === "node") && typeof token === "string" && token) {
        tokens[entry.role as Role] ??= token;
      }
    }
    this.authBackoffMs = 0;
    this.setState("connected");
    credentials.storeTokens(role, tokens);
    this.options.log(`gateway ${role} link connected`);
    this.options.onConnected?.();
  }

  private onConnectRefused(code: string, message: string): void {
    const { credentials, role, log } = this.options;
    log(`gateway ${role} link refused: ${code} (${message})`);
    this.dropSocket(new GatewayError(code, message));

    if (code === "PAIRING_REQUIRED") {
      // Present the same code again on the next try: approval is what we wait for.
      this.bootstrapTried = undefined;
      this.setState("pairing_required", "waiting for approval on the gateway");
      this.retryIn(this.timing.pairingRetryMs);
      return;
    }
    if (code === "AUTH_BOOTSTRAP_TOKEN_INVALID") {
      credentials.dropBootstrapToken();
      if (credentials.deviceToken(role)) {
        this.retryIn(100);
        return;
      }
      this.setState("auth_failed", "the setup code is spent or expired; a new one is needed");
      return;
    }
    if (code === "AUTH_DEVICE_TOKEN_MISMATCH") {
      // The token was retired, usually by a re-pair. Redeem a waiting code if there is one.
      credentials.dropDeviceToken(role);
      if (credentials.bootstrapToken()) {
        this.bootstrapTried = undefined;
        this.retryIn(100);
        return;
      }
      this.setState("auth_failed", "the gateway no longer accepts this device's token; a new setup code is needed");
      return;
    }
    if (isAuthCode(code)) {
      this.authBackoffMs = Math.min(
        this.authBackoffMs ? this.authBackoffMs * 2 : this.timing.authBackoffStartMs,
        this.timing.authBackoffMaxMs,
      );
      this.setState("auth_failed", `${code}: ${message}`);
      this.retryIn(this.authBackoffMs);
      return;
    }
    this.setState("unreachable", `${code}: ${message}`);
    this.retryIn(this.timing.reconnectMs);
  }
}
