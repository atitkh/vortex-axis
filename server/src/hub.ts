import type { AskResult } from "./ask.js";
import type { Background } from "./background.js";
import type { WebSocket } from "ws";
import type { Activity } from "./activity.js";
import {
  PROTOCOL_VERSION,
  DEFAULT_AUDIO_BUFFER_MS,
  DEFAULT_MAX_FRAME_BYTES,
  encodeServerMessage,
  isSupportedProtocolVersion,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type LinkDef,
  type ScalarMap,
  type ServerMessage,
  type Status,
} from "@vortex-axis/protocol";
import type { Live } from "./live.js";
import type { Voiceprints } from "./voiceprint.js";
import { isQuiet, withQuiet } from "./quiet.js";
import type { ClientRecord, Store } from "./store.js";
import { TurnManager, type ClientNow, type Services, type TurnPort } from "./turns.js";
import type { SpeechShare } from "./speech.js";

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
  /** Where the client's own pages are reachable, from its last `describe`. */
  address?: string | undefined;
  /** Links the client offers, relative to `address`. */
  links: LinkDef[];
}

/** What a client answered to a `command`. */
export interface CommandOutcome {
  ok: boolean;
  payload?: ScalarMap | undefined;
  error?: string | undefined;
}

interface PendingCommand {
  resolve: (outcome: CommandOutcome) => void;
  timer: NodeJS.Timeout;
}

export interface HubOptions {
  store: Store;
  helloTimeoutMs: number;
  /** How often each socket is pinged; one missed answer drops it. 0 or unset: never. */
  pingIntervalMs?: number;
  /** Where connections, service health and turns are recorded for the admin page. */
  activity?: Activity;
  /** Where turns and wake words are shown as they happen, for the admin page's Live view. */
  live?: Live;
  /** Tells voices apart, when switched on. */
  voices?: Voiceprints;
  services?: Services;
  wakeWindowMs?: number;
  maxUtteranceMs?: number;
  playbackGraceMs?: number;
  /** How long the last client spoken to stays the default place to answer. */
  outputHoldMs?: number;
  /** The time zone quiet hours are told in. */
  timeZone?: string;
  now?: () => number;
  log?: (line: string) => void;
}

/** Tracks which clients are connected and speaks the client protocol to them. */
export class Hub implements TurnPort {
  private readonly online = new Map<string, Session>();
  private readonly turns: TurnManager;
  private readonly outputHoldMs: number;
  private timeZone: string;
  private readonly wasQuiet = new Map<string, boolean>();
  private readonly screens = new Map<string, { heard: string; said: string; at: number }>();
  private readonly store: Store;
  private readonly helloTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly activity: Activity | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly pending = new Map<string, PendingCommand>();
  private commandCount = 0;
  private readonly connectListeners: Array<(session: Session) => void> = [];
  private readonly settingsListeners: Array<() => void> = [];
  private upstream: Status["upstream"] = { openclaw: "unknown", stt: "unknown", tts: "unknown" };

  constructor(options: HubOptions) {
    this.store = options.store;
    this.helloTimeoutMs = options.helloTimeoutMs;
    this.pingIntervalMs = options.pingIntervalMs ?? 0;
    this.activity = options.activity;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.outputHoldMs = options.outputHoldMs ?? 10 * 60_000;
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.turns = new TurnManager(this, {
      services: options.services ?? {},
      wakeWindowMs: options.wakeWindowMs ?? 200,
      maxUtteranceMs: options.maxUtteranceMs ?? 30_000,
      ...(options.playbackGraceMs === undefined ? {} : { playbackGraceMs: options.playbackGraceMs }),
      record: (turn, session) => this.activity?.turn(turn, session.client.name),
      live: options.live,
      voices: options.voices,
      wakeSeen: (seen) => {
        const session = this.online.get(seen.clientId);
        const wake = { ...seen, at: this.now(), word: String((session && this.settings(session).wakeWord) || "built-in") };
        try {
          this.store.addWake(wake);
        } catch {
          // A lost row of history must never get in the way of a wake word.
        }
        options.live?.wake(wake, session?.client.name ?? seen.clientId);
      },
      wakeIgnored: (clientId, text) => {
        this.log(text);
        this.activity?.note("wake", clientId, text);
      },
      contested: (winnerId, text) => {
        this.log(text);
        this.activity?.note("wake", winnerId, text);
      },
    });
  }

  /** Hands agent runs that go on too long to `background` (see turns.ts). */
  useBackground(background: Background, busySessionKey: string, handoverMs?: number): void {
    this.turns.useBackground(background, busySessionKey, handoverMs);
  }

  sessions(): Iterable<Session> {
    return this.online.values();
  }

  settings(session: Session): ScalarMap {
    return this.store.resolveSettings(session.client);
  }

  upstreamStatus(): Status["upstream"] {
    return this.upstream;
  }

  /** Says something an agent started on one client. Resolves when it has been played or shown. */
  say(session: Session, text: string, options: { silent?: boolean; share?: SpeechShare } = {}): Promise<{ heard: boolean }> {
    return this.turns.say(session, text, options);
  }

  /** Puts a question to the person at a client. See `TurnManager.ask`. */
  ask(session: Session, question: string, choices: string[], timeoutMs: number, options: { silent?: boolean; signal?: AbortSignal } = {}): Promise<AskResult> {
    return this.turns.ask(session, question, choices, timeoutMs, options);
  }

  /** What each client is in the middle of, for the admin page. */
  doing(): ClientNow[] {
    return this.turns.now();
  }

  /** Called with every client as it connects, after its `welcome`. */
  onConnect(listener: (session: Session) => void): void {
    this.connectListeners.push(listener);
  }

  /**
   * Chooses where agent-started output goes. A named client or location wins.
   * Otherwise it is the client last spoken to, then the configured default
   * client, then any client that can speak or show text.
   */
  pickOutput(target: { client?: string | undefined; location?: string | undefined }): Session {
    const canOutput = (s: Session) =>
      s.client.capabilities.includes("speaker") || s.client.capabilities.includes("screen");
    // A client that can speak is preferred over one that can only show text.
    const best = (sessions: Session[]) =>
      sessions.find((s) => s.client.capabilities.includes("speaker")) ?? sessions[0];

    if (target.client) {
      const client = this.store.findClient(target.client);
      if (!client) throw new Error(`there is no client called "${target.client}"`);
      const session = this.online.get(client.id);
      if (!session) throw new Error(`${client.name} is offline`);
      if (!canOutput(session)) throw new Error(`${client.name} can neither speak nor show text`);
      return session;
    }

    const able = [...this.online.values()].filter(canOutput);
    if (target.location) {
      const location = target.location.toLowerCase();
      const there = able.filter((s) => String(this.settings(s).location ?? "").toLowerCase() === location);
      const session = best(there);
      if (!session) throw new Error(`no client that can speak or show text is online in "${target.location}"`);
      return session;
    }

    const recent = this.turns.recentInput(this.outputHoldMs);
    const fromRecent = recent ? able.find((s) => s.client.id === recent) : undefined;
    if (fromRecent) return fromRecent;

    const configured = this.store.getLayer("global", "").defaultClient;
    const preferred = typeof configured === "string" ? this.store.findClient(configured) : undefined;
    const fromDefault = preferred ? able.find((s) => s.client.id === preferred.id) : undefined;
    if (fromDefault) return fromDefault;

    const session = best(able);
    if (!session) throw new Error("no client that can speak or show text is online");
    return session;
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

    // A device that loses power or Wi-Fi never closes its socket, and the operating system
    // can take hours to notice. A ping it has not answered by the next one ends the socket.
    let answered = true;
    let silent = false;
    const pingTimer =
      this.pingIntervalMs > 0
        ? setInterval(() => {
            if (!answered) {
              if (session) this.log(`client ${session.client.id} stopped answering pings`);
              silent = true;
              socket.terminate();
              return;
            }
            answered = false;
            socket.ping();
          }, this.pingIntervalMs)
        : undefined;
    socket.on("pong", () => (answered = true));

    socket.on("message", (data, isBinary) => {
      answered = true;
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
      clearInterval(pingTimer);
      if (session && this.online.get(session.client.id) === session) {
        this.online.delete(session.client.id);
        this.turns.drop(session);
        this.abandonCommands(session);
        this.store.touch(session.client.id);
        this.log(`client ${session.client.id} disconnected`);
        const name = session.client.name;
        this.activity?.state(
          "client",
          session.client.id,
          "offline",
          silent ? `${name} stopped answering (lost power or network?)` : `${name} disconnected`,
          silent ? "warn" : "info",
        );
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
      this.abandonCommands(previous);
      this.fail(previous.socket, "busy", "replaced by a newer connection", CLOSE_REPLACED);
    }

    const session: Session = {
      client,
      socket,
      maxFrameBytes: hello.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      audioBufferMs: hello.audioBufferMs ?? DEFAULT_AUDIO_BUFFER_MS,
      connectedAt: this.now(),
      readings: {},
      links: [],
    };
    this.online.set(client.id, session);
    this.log(`client ${client.id} (${client.name}) connected`);
    this.activity?.state("client", client.id, "online", `${client.name} connected (${client.type} ${hello.version})`);

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
    for (const listener of this.connectListeners) listener(session);
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
      case "describe":
        this.store.saveSchema(session.client.type, {
          settings: message.settings,
          actions: message.actions,
          links: message.links,
        });
        session.address = message.address;
        session.links = message.links;
        return;
      case "command.result": {
        const wait = this.pending.get(`${session.client.id}:${message.id}`);
        if (!wait) return;
        this.pending.delete(`${session.client.id}:${message.id}`);
        clearTimeout(wait.timer);
        wait.resolve({ ok: message.ok, payload: message.payload, error: message.error });
        return;
      }
      case "answer":
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

  /** Asks a client to carry out a command and waits for its answer. Rejects when it does not answer in time. */
  command(session: Session, name: string, params?: ScalarMap, timeoutMs = 8000): Promise<CommandOutcome> {
    const id = `k${++this.commandCount}`;
    const key = `${session.client.id}:${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`${session.client.name} did not answer "${name}" in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(key, { resolve, timer });
      this.send(session, { t: "command", id, name, ...(params ? { params } : {}) });
    });
  }

  /** Forgets commands a client will no longer answer. */
  private abandonCommands(session: Session): void {
    const prefix = `${session.client.id}:`;
    for (const [key, wait] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(wait.timer);
      this.pending.delete(key);
      wait.resolve({ ok: false, error: `${session.client.name} disconnected` });
    }
  }

  private sendSettings(session: Session): void {
    this.send(session, {
      t: "settings",
      version: this.store.settingsVersion(),
      values: withQuiet(this.store.resolveSettings(session.client), Date.now(), this.timeZone),
    });
  }

  /** True when this client is in its quiet hours right now. */
  quiet(client: Pick<ClientRecord, "id" | "type">): boolean {
    return isQuiet(this.store.resolveSettings(client), Date.now(), this.timeZone);
  }

  /**
   * Notices quiet hours starting or ending for any connected client and sends the settings again,
   * since the volume and brightness a device is sent depend on it. Called once a minute.
   */
  checkQuiet(): void {
    let changed = false;
    for (const session of this.online.values()) {
      const now = this.quiet(session.client);
      if (this.wasQuiet.get(session.client.id) !== now) {
        // The first look at a client is not a change: it was sent the right settings when it connected.
        if (this.wasQuiet.has(session.client.id)) {
          changed = true;
          this.log(`${session.client.name}: quiet hours ${now ? "began" : "ended"}`);
          this.activity?.note("settings", session.client.id, `${session.client.name}: quiet hours ${now ? "began" : "ended"}`);
        }
        this.wasQuiet.set(session.client.id, now);
      }
    }
    if (changed) {
      this.store.touchSettings();
      this.pushSettings();
    }
  }

  /** Pushes current settings to every connected client a change could affect. */
  pushSettings(filter?: (client: ClientRecord) => boolean): void {
    for (const session of this.online.values()) {
      if (!filter || filter(session.client)) this.sendSettings(session);
    }
    for (const listener of this.settingsListeners) listener();
  }

  /** Called after settings have gone out to clients, so anything derived from them can follow. */
  onSettingsPushed(listener: () => void): void {
    this.settingsListeners.push(listener);
  }

  /** Records upstream health and tells connected clients when it changes. */
  setUpstream(upstream: Status["upstream"]): void {
    const names = { openclaw: "Agent", stt: "Speech recognition", tts: "Speech synthesis" } as const;
    for (const key of ["openclaw", "stt", "tts"] as const) {
      const state = upstream[key];
      this.activity?.state("service", key, state, `${names[key]} ${state}`, state === "down" ? "bad" : "info");
    }
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
    this.abandonCommands(session);
    this.fail(session.socket, "unauthorized", "client was removed", CLOSE_REMOVED);
  }

  closeAll(): void {
    this.turns.stop();
    for (const session of this.online.values()) session.socket.close(1001, "server shutting down");
    this.online.clear();
  }

  send(session: Session, message: ServerMessage): void {
    this.remember(session.client.id, message);
    this.sendTo(session.socket, message);
  }

  /**
   * Keeps the words a client was last sent, so the admin page can show what is on its screen. Held in
   * memory only and dropped when the client goes: nothing said is ever written to disk.
   */
  private remember(clientId: string, message: ServerMessage): void {
    if (message.t === "transcript") this.screens.set(clientId, { heard: message.text, said: "", at: Date.now() });
    else if (message.t === "reply.text") {
      const now = this.screens.get(clientId) ?? { heard: "", said: "", at: 0 };
      // Pieces arrive a sentence at a time; the final message carries the whole reply.
      const said = message.final ? message.text || now.said : `${now.said}${message.text}`;
      this.screens.set(clientId, { heard: now.heard, said: said.slice(0, 2000), at: Date.now() });
    } else if (message.t === "turn" && message.state === "listening") this.screens.delete(clientId);
  }

  /** Changes the clock quiet hours are told by, and looks at once whether that starts or ends any. */
  setTimeZone(timeZone: string): void {
    this.timeZone = timeZone;
    this.checkQuiet();
  }

  /** Deletes the words kept for the admin page's device sketch: those past their minute, or all of them. */
  forgetScreens(all = false): void {
    for (const [clientId, screen] of this.screens) {
      if (all || Date.now() - screen.at >= 60_000) this.screens.delete(clientId);
    }
  }

  /** The words each connected client was sent in the last minute: what it heard and what it was told. */
  showing(): Record<string, { heard: string; said: string; at: number }> {
    const out: Record<string, { heard: string; said: string; at: number }> = {};
    for (const [clientId, screen] of this.screens) {
      if (this.online.has(clientId) && Date.now() - screen.at < 60_000) out[clientId] = screen;
    }
    return out;
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
