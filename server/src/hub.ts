import type { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  DEFAULT_AUDIO_BUFFER_MS,
  DEFAULT_MAX_FRAME_BYTES,
  encodeServerMessage,
  isSupportedProtocolVersion,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ScalarMap,
  type ServerMessage,
  type Status,
} from "@vortex-axis/protocol";
import type { ClientRecord, Store } from "./store.js";
import { TurnManager, type Services, type TurnPort } from "./turns.js";

/** WebSocket close codes in the application range. */
const CLOSE_PROTOCOL = 4400;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REPLACED = 4409;
const CLOSE_REMOVED = 4410;

export interface Session {
  client: ClientRecord;
  socket: WebSocket;
  maxFrameBytes: number;
  /** How much speech the client can buffer, in milliseconds. */
  audioBufferMs: number;
  connectedAt: number;
  /** Latest sensor readings the client reported. Not persisted. */
  readings: ScalarMap;
}

export interface HubOptions {
  store: Store;
  helloTimeoutMs: number;
  services?: Services;
  wakeWindowMs?: number;
  maxUtteranceMs?: number;
  playbackGraceMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** Tracks which clients are connected and speaks the client protocol to them. */
export class Hub implements TurnPort {
  private readonly online = new Map<string, Session>();
  private readonly turns: TurnManager;
  private readonly store: Store;
  private readonly helloTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private upstream: Status["upstream"] = { openclaw: "unknown", stt: "unknown", tts: "unknown" };

  constructor(options: HubOptions) {
    this.store = options.store;
    this.helloTimeoutMs = options.helloTimeoutMs;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.turns = new TurnManager(this, {
      services: options.services ?? {},
      wakeWindowMs: options.wakeWindowMs ?? 200,
      maxUtteranceMs: options.maxUtteranceMs ?? 30_000,
      ...(options.playbackGraceMs === undefined ? {} : { playbackGraceMs: options.playbackGraceMs }),
    });
  }

  sessions(): Iterable<Session> {
    return this.online.values();
  }

  settings(session: Session): ScalarMap {
    return this.store.resolveSettings(session.client);
  }

  isOnline(clientId: string): boolean {
    return this.online.has(clientId);
  }

  session(clientId: string): Session | undefined {
    return this.online.get(clientId);
  }

  /** Takes over a freshly accepted socket. The first frame must be `hello`. */
  accept(socket: WebSocket): void {
    let session: Session | undefined;

    const helloTimer = setTimeout(() => {
      this.fail(socket, "timeout", "no hello received", CLOSE_PROTOCOL);
    }, this.helloTimeoutMs);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!session) this.fail(socket, "bad_message", "hello must come first", CLOSE_PROTOCOL);
        else this.turns.handleAudio(session, data as Buffer);
        return;
      }
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        if (session) this.send(session, { t: "error", code: "bad_message", message: clip(parsed.error) });
        else this.fail(socket, "bad_message", parsed.error, CLOSE_PROTOCOL);
        return;
      }
      const message = parsed.message;

      if (!session) {
        clearTimeout(helloTimer);
        if (message.t !== "hello") {
          this.fail(socket, "bad_message", "hello must come first", CLOSE_PROTOCOL);
          return;
        }
        session = this.handleHello(socket, message);
        return;
      }
      this.handleMessage(session, message);
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (session && this.online.get(session.client.id) === session) {
        this.online.delete(session.client.id);
        this.turns.drop(session);
        this.store.touch(session.client.id);
        this.log(`client ${session.client.id} disconnected`);
      }
    });

    socket.on("error", () => socket.terminate());
  }

  private handleHello(socket: WebSocket, hello: Extract<ClientMessage, { t: "hello" }>): Session | undefined {
    if (!isSupportedProtocolVersion(hello.protocol)) {
      this.fail(socket, "unsupported_protocol", `protocol ${hello.protocol} is not supported`, CLOSE_PROTOCOL);
      return undefined;
    }
    const known = this.store.authenticate(hello.clientId, hello.token);
    if (!known) {
      this.fail(socket, "unauthorized", "unknown client or wrong token", CLOSE_UNAUTHORIZED);
      return undefined;
    }

    this.store.recordHello(known.id, { version: hello.version, capabilities: hello.capabilities });
    const client = this.store.getClient(known.id)!;

    const previous = this.online.get(client.id);
    if (previous) {
      this.turns.drop(previous);
      this.fail(previous.socket, "busy", "replaced by a newer connection", CLOSE_REPLACED);
    }

    const session: Session = {
      client,
      socket,
      maxFrameBytes: hello.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      audioBufferMs: hello.audioBufferMs ?? DEFAULT_AUDIO_BUFFER_MS,
      connectedAt: this.now(),
      readings: {},
    };
    this.online.set(client.id, session);
    this.log(`client ${client.id} (${client.name}) connected`);

    const settingsVersion = this.store.settingsVersion();
    this.send(session, {
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      clientId: client.id,
      serverTime: this.now(),
      settingsVersion,
    });
    if (hello.settingsVersion !== settingsVersion) this.sendSettings(session);
    this.send(session, { t: "status", upstream: this.upstream });
    return session;
  }

  private handleMessage(session: Session, message: ClientMessage): void {
    switch (message.t) {
      case "hello":
        this.send(session, { t: "error", code: "bad_message", message: "hello was already sent" });
        return;
      case "settings.get":
        if (message.have !== this.store.settingsVersion()) this.sendSettings(session);
        return;
      case "sense":
        session.readings = { ...session.readings, ...message.readings };
        return;
      case "command.result":
      case "answer":
        // Nothing sends commands or questions yet, so there is nothing to match these to.
        return;
      case "wake":
      case "audio.start":
      case "audio.end":
      case "text":
      case "interrupt":
      case "playback":
        this.turns.handle(session, message);
        return;
    }
  }

  private sendSettings(session: Session): void {
    this.send(session, {
      t: "settings",
      version: this.store.settingsVersion(),
      values: this.store.resolveSettings(session.client),
    });
  }

  /** Pushes current settings to every connected client a change could affect. */
  pushSettings(filter?: (client: ClientRecord) => boolean): void {
    for (const session of this.online.values()) {
      if (!filter || filter(session.client)) this.sendSettings(session);
    }
  }

  /** Records upstream health and tells connected clients when it changes. */
  setUpstream(upstream: Status["upstream"]): void {
    const changed = JSON.stringify(upstream) !== JSON.stringify(this.upstream);
    this.upstream = upstream;
    if (!changed) return;
    for (const session of this.online.values()) this.send(session, { t: "status", upstream });
  }

  /** Drops a client's connection, for example after it was removed. */
  disconnect(clientId: string): void {
    const session = this.online.get(clientId);
    if (!session) return;
    this.online.delete(clientId);
    this.turns.drop(session);
    this.fail(session.socket, "unauthorized", "client was removed", CLOSE_REMOVED);
  }

  closeAll(): void {
    this.turns.stop();
    for (const session of this.online.values()) session.socket.close(1001, "server shutting down");
    this.online.clear();
  }

  send(session: Session, message: ServerMessage): void {
    this.sendTo(session.socket, message);
  }

  sendBinary(session: Session, data: Buffer): void {
    if (session.socket.readyState !== session.socket.OPEN) return;
    session.socket.send(data, { binary: true });
  }

  private sendTo(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(encodeServerMessage(message));
  }

  private fail(socket: WebSocket, code: ErrorCode, message: string, closeCode: number): void {
    this.sendTo(socket, { t: "error", code, message: clip(message), fatal: true });
    socket.close(closeCode, code);
  }
}

function clip(text: string): string {
  return text.length > 256 ? `${text.slice(0, 253)}...` : text;
}
