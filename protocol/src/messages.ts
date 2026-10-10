import { Type, type Static, type TObject } from "@sinclair/typebox";
import {
  AudioFormat,
  Capability,
  ErrorCode,
  Id,
  Scalar,
  ScalarMap,
  TurnState,
  UpstreamHealth,
} from "./common.js";

/**
 * Every control frame is a JSON object with a `t` field naming its type.
 * Unknown fields are rejected so that typos fail loudly on both sides.
 */
function message<T extends string, P extends Record<string, any>>(t: T, props: P) {
  return Type.Object({ t: Type.Literal(t), ...props }, { $id: t, additionalProperties: false });
}

// ---------------------------------------------------------------------------
// Client -> Axis
// ---------------------------------------------------------------------------

/** First frame on every connection. */
export const Hello = message("hello", {
  protocol: Type.Integer({ minimum: 1 }),
  clientId: Id,
  token: Type.String({ minLength: 1, maxLength: 256 }),
  /** Client type, for example "web" or "esp32s3-speaker". */
  type: Type.String({ minLength: 1, maxLength: 64 }),
  /** Firmware or app version, without a leading "v". */
  version: Type.String({ minLength: 1, maxLength: 32 }),
  capabilities: Type.Array(Capability, { uniqueItems: true, maxItems: 16 }),
  /** Settings version the client already holds; 0 when it has none. */
  settingsVersion: Type.Integer({ minimum: 0 }),
  /** Largest binary frame the client can receive. */
  maxFrameBytes: Type.Optional(Type.Integer({ minimum: 512, maximum: 1048576 })),
  /**
   * How much audio the client can hold before playing it, in milliseconds.
   * Axis never sends speech further ahead of real time than this.
   */
  audioBufferMs: Type.Optional(Type.Integer({ minimum: 200, maximum: 60000 })),
});

/** The client heard the wake word and is buffering audio locally. */
export const Wake = message("wake", {
  wakeId: Id,
  /** Detection confidence, 0 to 1. */
  score: Type.Number({ minimum: 0, maximum: 1 }),
  /** Loudness of the wake word, 0 to 1. Breaks ties between clients. */
  level: Type.Number({ minimum: 0, maximum: 1 }),
});

/** Opens the upstream audio stream. Binary frames that follow belong to it. */
export const AudioStart = message("audio.start", {
  turnId: Id,
  format: AudioFormat,
  /** Present when the turn began with a granted wake. */
  wakeId: Type.Optional(Id),
  /**
   * What made the client start listening: the wake word, a tap, a press held down, listening on
   * after an answer, or a question Axis asked. Optional: an older client says nothing, and Axis
   * then knows only whether there was a wake word.
   */
  trigger: Type.Optional(
    Type.Union([Type.Literal("wake"), Type.Literal("tap"), Type.Literal("hold"), Type.Literal("follow_up"), Type.Literal("question")]),
  ),
});

/** Closes the upstream audio stream. */
export const AudioEnd = message("audio.end", {
  turnId: Id,
  reason: Type.Union([Type.Literal("silence"), Type.Literal("max"), Type.Literal("cancel")]),
});

/** Typed input, for clients without a microphone. Starts a turn. */
export const Text = message("text", {
  turnId: Id,
  text: Type.String({ minLength: 1, maxLength: 4000 }),
});

/** The user wants playback to stop: a tap, a button, or a repeated wake word. */
export const Interrupt = message("interrupt", {
  turnId: Type.Optional(Id),
});

/** The user picked one of the choices in an `ask`. */
export const Answer = message("answer", {
  askId: Id,
  choice: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * Playback progress, so Axis knows when the client has actually finished.
 * `blocked` means the client could not make sound at all, for example a
 * browser page nobody has clicked on yet.
 */
export const Playback = message("playback", {
  turnId: Id,
  state: Type.Union([
    Type.Literal("started"),
    Type.Literal("finished"),
    Type.Literal("stopped"),
    Type.Literal("blocked"),
  ]),
});

/** Sensor readings the client chooses to report. */
export const Sense = message("sense", {
  readings: ScalarMap,
});

/** Asks for settings newer than the version the client holds. */
export const SettingsGet = message("settings.get", {
  have: Type.Integer({ minimum: 0 }),
});

/**
 * One setting a client reads, so Axis can draw an editor for it without
 * knowing the device. The value itself lives in the settings layers; this
 * only says what it is. Toggles are stored as 1 and 0.
 */
export const SettingDef = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 64 }),
    label: Type.String({ maxLength: 80 }),
    kind: Type.Union([Type.Literal("number"), Type.Literal("text"), Type.Literal("toggle"), Type.Literal("choice")]),
    /** Headings the editor groups settings under, for example "Sound". */
    group: Type.Optional(Type.String({ maxLength: 40 })),
    help: Type.Optional(Type.String({ maxLength: 240 })),
    /** What the client uses when nothing is set. */
    default: Type.Optional(Type.Union([Type.String({ maxLength: 128 }), Type.Number()])),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    unit: Type.Optional(Type.String({ maxLength: 16 })),
    /** The allowed values of a `choice`. */
    options: Type.Optional(Type.Array(Type.Union([Type.String({ maxLength: 64 }), Type.Number()]), { maxItems: 16 })),
  },
  { $id: "SettingDef", additionalProperties: false },
);
export type SettingDef = Static<typeof SettingDef>;

/** Something a person can ask a client to do from the admin page, carried as a `command`. */
export const ActionDef = Type.Object(
  {
    /** The `command` name Axis sends. */
    name: Type.String({ minLength: 1, maxLength: 64 }),
    label: Type.String({ maxLength: 80 }),
    help: Type.Optional(Type.String({ maxLength: 240 })),
    /** Ask for confirmation first, for example before a reboot. */
    confirm: Type.Optional(Type.Boolean()),
  },
  { $id: "ActionDef", additionalProperties: false },
);
export type ActionDef = Static<typeof ActionDef>;

/** A page the client serves itself, for example its log. `path` is relative to its own address. */
export const LinkDef = Type.Object(
  {
    label: Type.String({ maxLength: 80 }),
    path: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { $id: "LinkDef", additionalProperties: false },
);
export type LinkDef = Static<typeof LinkDef>;

/**
 * What a client offers to the admin page: its settings, actions and own web
 * pages. Sent after `welcome`, and kept by Axis per client type.
 */
export const Describe = message("describe", {
  settings: Type.Array(SettingDef, { maxItems: 48 }),
  actions: Type.Array(ActionDef, { maxItems: 24 }),
  links: Type.Array(LinkDef, { maxItems: 8 }),
  /** Where the client's own pages are reachable, as host or host:port. */
  address: Type.Optional(Type.String({ maxLength: 64 })),
});

/** Result of a `command` sent by Axis. */
export const CommandResult = message("command.result", {
  id: Id,
  ok: Type.Boolean(),
  payload: Type.Optional(ScalarMap),
  error: Type.Optional(Type.String({ maxLength: 256 })),
});

// ---------------------------------------------------------------------------
// Axis -> client
// ---------------------------------------------------------------------------

/** Reply to a valid `hello`. */
export const Welcome = message("welcome", {
  protocol: Type.Integer({ minimum: 1 }),
  clientId: Id,
  /** Server clock in Unix milliseconds, for clients without their own. */
  serverTime: Type.Integer({ minimum: 0 }),
  settingsVersion: Type.Integer({ minimum: 0 }),
});

/** The full resolved settings for this client (global, type and device merged). */
export const Settings = message("settings", {
  version: Type.Integer({ minimum: 0 }),
  values: ScalarMap,
});

/** Outcome of wake arbitration. A client that is not granted discards its buffer. */
export const WakeResult = message("wake.result", {
  wakeId: Id,
  granted: Type.Boolean(),
});

/** State of a turn, for the client to show. */
export const Turn = message("turn", {
  turnId: Id,
  state: TurnState,
  /** Short human-readable note, mainly for `error`. */
  detail: Type.Optional(Type.String({ maxLength: 256 })),
  /**
   * With `thinking`: the kind of work the agent has just picked up (`search`, `home`, `files`, ...), for a
   * client that shows it as an icon. Sent again whenever it changes; a client that knows none of it ignores it.
   */
  doing: Type.Optional(Type.String({ maxLength: 24 })),
});

/** What speech recognition heard. */
export const Transcript = message("transcript", {
  turnId: Id,
  text: Type.String({ maxLength: 4000 }),
});

/**
 * Reply text for clients with a screen. Frames with `final: false` each carry
 * the next piece of the reply. The frame with `final: true` carries the whole reply.
 */
export const ReplyText = message("reply.text", {
  turnId: Id,
  text: Type.String({ maxLength: 16000 }),
  final: Type.Boolean(),
});

/** Opens the downstream audio stream. Binary frames that follow belong to it. */
export const SpeakStart = message("speak.start", {
  turnId: Id,
  format: AudioFormat,
});

/** Closes the downstream audio stream. */
export const SpeakEnd = message("speak.end", {
  turnId: Id,
});

/**
 * A question, sent after Axis has spoken it. With choices, the client offers
 * them and answers with `answer`. A client with a microphone also listens: a
 * spoken answer goes up as an ordinary recording and Axis matches it. With no
 * choices the question is open and only a spoken or typed answer ends it.
 */
export const Ask = message("ask", {
  askId: Id,
  question: Type.String({ minLength: 1, maxLength: 500 }),
  choices: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
    maxItems: 6,
    uniqueItems: true,
  }),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 600000 }),
});

/** The question is over, answered or not. The client takes the choices away and stops listening for it. */
export const AskEnd = message("ask.end", {
  askId: Id,
});

/** Stop playback and drop any buffered audio. */
export const Stop = message("stop", {
  turnId: Type.Optional(Id),
});

/** Health of the services behind Axis, so a client can say what is down. */
export const Status = message("status", {
  upstream: Type.Object(
    { openclaw: UpstreamHealth, stt: UpstreamHealth, tts: UpstreamHealth },
    { additionalProperties: false },
  ),
});

/** An action for the client to carry out, answered with `command.result`. */
export const Command = message("command", {
  id: Id,
  /** For example "config.set", "reboot", "timer.set", "diag". */
  name: Type.String({ minLength: 1, maxLength: 64 }),
  params: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Scalar)),
});

/** Something went wrong. `fatal` means Axis closes the connection next. */
export const ErrorMessage = message("error", {
  code: ErrorCode,
  message: Type.String({ maxLength: 256 }),
  fatal: Type.Optional(Type.Boolean()),
});

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

export const CLIENT_MESSAGE_SCHEMAS = [
  Hello,
  Wake,
  AudioStart,
  AudioEnd,
  Text,
  Interrupt,
  Answer,
  Playback,
  Sense,
  SettingsGet,
  CommandResult,
  Describe,
] as const;

export const SERVER_MESSAGE_SCHEMAS = [
  Welcome,
  Settings,
  WakeResult,
  Turn,
  Transcript,
  ReplyText,
  SpeakStart,
  SpeakEnd,
  Ask,
  AskEnd,
  Stop,
  Status,
  Command,
  ErrorMessage,
] as const;

export const ClientMessage = Type.Union([...CLIENT_MESSAGE_SCHEMAS], { $id: "ClientMessage" });
export const ServerMessage = Type.Union([...SERVER_MESSAGE_SCHEMAS], { $id: "ServerMessage" });

export type Hello = Static<typeof Hello>;
export type Wake = Static<typeof Wake>;
export type AudioStart = Static<typeof AudioStart>;
export type AudioEnd = Static<typeof AudioEnd>;
export type Text = Static<typeof Text>;
export type Interrupt = Static<typeof Interrupt>;
export type Answer = Static<typeof Answer>;
export type Playback = Static<typeof Playback>;
export type Sense = Static<typeof Sense>;
export type SettingsGet = Static<typeof SettingsGet>;
export type CommandResult = Static<typeof CommandResult>;
export type Describe = Static<typeof Describe>;

export type Welcome = Static<typeof Welcome>;
export type Settings = Static<typeof Settings>;
export type WakeResult = Static<typeof WakeResult>;
export type Turn = Static<typeof Turn>;
export type Transcript = Static<typeof Transcript>;
export type ReplyText = Static<typeof ReplyText>;
export type SpeakStart = Static<typeof SpeakStart>;
export type SpeakEnd = Static<typeof SpeakEnd>;
export type Ask = Static<typeof Ask>;
export type AskEnd = Static<typeof AskEnd>;
export type Stop = Static<typeof Stop>;
export type Status = Static<typeof Status>;
export type Command = Static<typeof Command>;
export type ErrorMessage = Static<typeof ErrorMessage>;

export type ClientMessage = Static<typeof ClientMessage>;
export type ServerMessage = Static<typeof ServerMessage>;

export type ClientMessageType = ClientMessage["t"];
export type ServerMessageType = ServerMessage["t"];

function literalOf(schema: TObject): string {
  return (schema.properties["t"] as unknown as { const: string }).const;
}

export const CLIENT_MESSAGE_TYPES = CLIENT_MESSAGE_SCHEMAS.map(literalOf) as ClientMessageType[];
export const SERVER_MESSAGE_TYPES = SERVER_MESSAGE_SCHEMAS.map(literalOf) as ServerMessageType[];

// ---------------------------------------------------------------------------
// Pairing (plain HTTP, before a socket exists)
// ---------------------------------------------------------------------------

/** Body of `POST /v1/pair`. */
export const PairRequest = Type.Object(
  {
    code: Type.String({ minLength: 4, maxLength: 64 }),
    type: Type.String({ minLength: 1, maxLength: 64 }),
    version: Type.String({ minLength: 1, maxLength: 32 }),
    capabilities: Type.Array(Capability, { uniqueItems: true, maxItems: 16 }),
    /** Suggested display name. Axis may change it to keep names unique. */
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { $id: "PairRequest", additionalProperties: false },
);
export type PairRequest = Static<typeof PairRequest>;

/** Successful reply to `POST /v1/pair`. The token is shown once and stored by the client. */
export const PairResponse = Type.Object(
  {
    clientId: Id,
    token: Type.String({ minLength: 1, maxLength: 256 }),
    name: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { $id: "PairResponse", additionalProperties: false },
);
export type PairResponse = Static<typeof PairResponse>;
