import { describe, expect, it } from "vitest";
import {
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  UPSTREAM_AUDIO_FORMAT,
  encodeClientMessage,
  encodeServerMessage,
  isPairRequest,
  isPairResponse,
  isSupportedProtocolVersion,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../src/index.js";

const clientSamples: ClientMessage[] = [
  {
    t: "hello",
    protocol: PROTOCOL_VERSION,
    clientId: "c_desk",
    token: "secret-token",
    type: "esp32s3-speaker",
    version: "0.1.0",
    capabilities: ["mic", "speaker", "screen"],
    settingsVersion: 0,
    maxFrameBytes: 4096,
    audioBufferMs: 6000,
  },
  { t: "wake", wakeId: "w1", score: 0.92, level: 0.4 },
  { t: "audio.start", turnId: "t1", format: UPSTREAM_AUDIO_FORMAT, wakeId: "w1" },
  { t: "audio.end", turnId: "t1", reason: "silence" },
  { t: "text", turnId: "t2", text: "what time is it" },
  { t: "interrupt" },
  { t: "answer", askId: "a1", choice: "Yes" },
  { t: "playback", turnId: "t1", state: "finished" },
  { t: "sense", readings: { battery: 0.81, charging: false, room: "office" } },
  { t: "settings.get", have: 3 },
  { t: "command.result", id: "k1", ok: true, payload: { volume: 60 } },
  {
    t: "describe",
    settings: [
      { key: "volume", label: "Volume", kind: "number", group: "Sound", min: 0, max: 100, default: 60, unit: "%" },
      { key: "rotation", label: "Rotation", kind: "choice", options: [0, 90, 180, 270], default: 90 },
      { key: "listenCue", label: "Listening cue", kind: "toggle", default: 1, help: "A short tone when it starts listening." },
    ],
    actions: [{ name: "reboot", label: "Reboot", confirm: true }],
    links: [{ label: "Device log", path: "/logs" }],
    address: "10.0.0.49",
  },
];

const serverSamples: ServerMessage[] = [
  { t: "welcome", protocol: PROTOCOL_VERSION, clientId: "c_desk", serverTime: 1791421200000, settingsVersion: 4 },
  { t: "settings", version: 4, values: { wakeWord: "hey vortex", volume: 60, room: "office" } },
  { t: "wake.result", wakeId: "w1", granted: true },
  { t: "turn", turnId: "t1", state: "thinking" },
  { t: "transcript", turnId: "t1", text: "what time is it" },
  { t: "reply.text", turnId: "t1", text: "It is eight o'clock.", final: true },
  { t: "speak.start", turnId: "t1", format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 } },
  { t: "speak.end", turnId: "t1" },
  { t: "ask", askId: "a1", question: "Turn off the lights?", choices: ["Yes", "No"], timeoutMs: 30000 },
  { t: "ask", askId: "a2", question: "What should I call it?", choices: [], timeoutMs: 30000 },
  { t: "ask.end", askId: "a1" },
  { t: "stop" },
  { t: "status", upstream: { openclaw: "up", stt: "down", tts: "up" } },
  { t: "command", id: "k1", name: "config.set", params: { key: "volume", value: 60 } },
  { t: "error", code: "upstream_down", message: "speech recognition is unavailable" },
];

describe("protocol version", () => {
  it("accepts the current version and rejects others", () => {
    expect(isSupportedProtocolVersion(PROTOCOL_VERSION)).toBe(true);
    expect(isSupportedProtocolVersion(0)).toBe(false);
    expect(isSupportedProtocolVersion(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isSupportedProtocolVersion(1.5)).toBe(false);
  });
});

describe("client messages", () => {
  it("has a sample for every message type", () => {
    expect(clientSamples.map((m) => m.t).sort()).toEqual([...CLIENT_MESSAGE_TYPES].sort());
  });

  it.each(clientSamples)("round-trips $t", (sample) => {
    const parsed = parseClientMessage(encodeClientMessage(sample));
    expect(parsed).toEqual({ ok: true, message: sample });
  });

  it("accepts an already parsed object", () => {
    expect(parseClientMessage({ t: "interrupt" })).toEqual({ ok: true, message: { t: "interrupt" } });
  });

  it("rejects a server message type", () => {
    const result = parseClientMessage({ t: "welcome" });
    expect(result.ok).toBe(false);
  });
});

describe("server messages", () => {
  it("has a sample for every message type", () => {
    expect([...new Set(serverSamples.map((m) => m.t))].sort()).toEqual([...SERVER_MESSAGE_TYPES].sort());
  });

  it.each(serverSamples)("round-trips $t", (sample) => {
    const parsed = parseServerMessage(encodeServerMessage(sample));
    expect(parsed).toEqual({ ok: true, message: sample });
  });
});

describe("rejections", () => {
  const bad = (input: unknown) => {
    const result = parseClientMessage(input);
    if (result.ok) throw new Error("expected a rejection");
    return result.error;
  };

  it("rejects text that is not JSON", () => {
    expect(bad("{nope")).toBe("not valid JSON");
  });

  it("rejects non-objects", () => {
    expect(bad("[]")).toBe("message must be a JSON object");
    expect(bad("42")).toBe("message must be a JSON object");
  });

  it("rejects a missing or unknown type", () => {
    expect(bad({})).toMatch(/no type field/);
    expect(bad({ t: "launch" })).toMatch(/unknown message type "launch"/);
  });

  it("rejects unknown fields", () => {
    expect(bad({ t: "interrupt", extra: true })).toMatch(/^interrupt:/);
  });

  it("rejects missing required fields", () => {
    expect(bad({ t: "wake", wakeId: "w1", score: 0.5 })).toMatch(/^wake:/);
  });

  it("rejects out-of-range values", () => {
    expect(bad({ t: "wake", wakeId: "w1", score: 1.5, level: 0.2 })).toMatch(/^wake: \/score/);
  });

  it("rejects an unknown capability", () => {
    const hello = { ...clientSamples[0], capabilities: ["mic", "laser"] };
    expect(bad(hello)).toMatch(/^hello: \/capabilities/);
  });

  it("accepts every playback state", () => {
    for (const state of ["started", "finished", "stopped", "blocked"]) {
      expect(parseClientMessage({ t: "playback", turnId: "t1", state }).ok).toBe(true);
    }
    expect(bad({ t: "playback", turnId: "t1", state: "muted" })).toMatch(/^playback:/);
  });

  it("rejects audio that is not 16-bit mono PCM", () => {
    const start = { t: "audio.start", turnId: "t1", format: { encoding: "opus", sampleRate: 16000, channels: 1 } };
    expect(bad(start)).toMatch(/^audio.start: \/format/);
  });

  it("refuses to encode an invalid message", () => {
    const invalid = { t: "wake", wakeId: "", score: 0.5, level: 0.5 } as ClientMessage;
    expect(() => encodeClientMessage(invalid)).toThrow(/^wake:/);
  });
});

describe("pairing", () => {
  it("accepts a valid request and response", () => {
    expect(
      isPairRequest({ code: "483-221", type: "web", version: "0.1.0", capabilities: ["mic", "speaker"] }),
    ).toBe(true);
    expect(isPairResponse({ clientId: "c_web1", token: "tok", name: "Web" })).toBe(true);
  });

  it("rejects a request without a code", () => {
    expect(isPairRequest({ type: "web", version: "0.1.0", capabilities: [] })).toBe(false);
  });
});
