import { Type, type Static } from "@sinclair/typebox";

/** What a client can do. Axis routes on these, never on device names. */
export const CAPABILITIES = [
  "mic",
  "speaker",
  "screen",
  "buttons",
  "vibration",
  "sensors",
  "images",
  "image-frames",
] as const;

export const Capability = Type.Union(
  CAPABILITIES.map((c) => Type.Literal(c)),
  { $id: "Capability" },
);
export type Capability = Static<typeof Capability>;

/** Short opaque identifier chosen by whichever side opens the exchange. */
export const Id = Type.String({ minLength: 1, maxLength: 64 });

/** Raw PCM is the only encoding in protocol version 1. */
export const AudioFormat = Type.Object(
  {
    encoding: Type.Literal("pcm_s16le"),
    sampleRate: Type.Integer({ minimum: 8000, maximum: 48000 }),
    channels: Type.Literal(1),
  },
  { $id: "AudioFormat", additionalProperties: false },
);
export type AudioFormat = Static<typeof AudioFormat>;

/** Format a client sends microphone audio in. */
export const UPSTREAM_AUDIO_FORMAT: AudioFormat = {
  encoding: "pcm_s16le",
  sampleRate: 16000,
  channels: 1,
};

/** A setting or sensor value. Kept flat so small clients can parse it. */
export const Scalar = Type.Union([
  Type.String({ maxLength: 512 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
export type Scalar = Static<typeof Scalar>;

export const ScalarMap = Type.Record(
  Type.String({ minLength: 1, maxLength: 64 }),
  Scalar,
);
export type ScalarMap = Static<typeof ScalarMap>;

/** Where a turn is in its life. Clients render this as their visible state. */
export const TURN_STATES = [
  "idle",
  "listening",
  "transcribing",
  "thinking",
  "speaking",
  "error",
] as const;

export const TurnState = Type.Union(
  TURN_STATES.map((s) => Type.Literal(s)),
  { $id: "TurnState" },
);
export type TurnState = Static<typeof TurnState>;

/** Upstream services a client may need to report as down. */
export const UPSTREAMS = ["openclaw", "stt", "tts"] as const;

export const UpstreamHealth = Type.Union([
  Type.Literal("up"),
  Type.Literal("down"),
  Type.Literal("unknown"),
]);
export type UpstreamHealth = Static<typeof UpstreamHealth>;

export const ERROR_CODES = [
  "bad_message",
  "unsupported_protocol",
  "unauthorized",
  "busy",
  "upstream_down",
  "timeout",
  "not_supported",
  "internal",
] as const;

export const ErrorCode = Type.Union(
  ERROR_CODES.map((c) => Type.Literal(c)),
  { $id: "ErrorCode" },
);
export type ErrorCode = Static<typeof ErrorCode>;
