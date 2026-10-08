export interface Config {
  /** Interface to listen on. */
  host: string;
  /** Port to listen on. 0 picks a free port. */
  port: number;
  /** Directory holding the SQLite file. */
  dataDir: string;
  /** Bearer token for the admin API. The admin API is disabled when unset. */
  adminToken: string | undefined;
  /** How long a pairing code stays valid. */
  pairingCodeTtlMs: number;
  /** How long a new connection may take to send `hello`. */
  helloTimeoutMs: number;
  /** How long wake arbitration waits for other clients to report. */
  wakeWindowMs: number;
  /** Longest utterance accepted from a client. */
  maxUtteranceMs: number;
  /** How often upstream services are checked. 0 turns the checks off. */
  healthIntervalMs: number;
  stt: { url: string; model: string; apiKey: string | undefined } | undefined;
  tts:
    | { url: string; model: string; voice: string | undefined; sampleRate: number; apiKey: string | undefined }
    | undefined;
  agent: { url: string; model: string; token: string | undefined; sessionKey: string | undefined } | undefined;
}

function integer(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/** Reads configuration from environment variables. Nothing is host-specific in code. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.AXIS_HOST || "0.0.0.0",
    port: integer("AXIS_PORT", env.AXIS_PORT, 8440),
    dataDir: env.AXIS_DATA_DIR || "./data",
    adminToken: env.AXIS_ADMIN_TOKEN || undefined,
    pairingCodeTtlMs: integer("AXIS_PAIRING_CODE_TTL_MS", env.AXIS_PAIRING_CODE_TTL_MS, 10 * 60 * 1000),
    helloTimeoutMs: integer("AXIS_HELLO_TIMEOUT_MS", env.AXIS_HELLO_TIMEOUT_MS, 10 * 1000),
    wakeWindowMs: integer("AXIS_WAKE_WINDOW_MS", env.AXIS_WAKE_WINDOW_MS, 200),
    maxUtteranceMs: integer("AXIS_MAX_UTTERANCE_MS", env.AXIS_MAX_UTTERANCE_MS, 30 * 1000),
    healthIntervalMs: integer("AXIS_HEALTH_INTERVAL_MS", env.AXIS_HEALTH_INTERVAL_MS, 30 * 1000),
    stt: env.AXIS_STT_URL
      ? { url: env.AXIS_STT_URL, model: env.AXIS_STT_MODEL || "whisper-1", apiKey: env.AXIS_STT_API_KEY || undefined }
      : undefined,
    tts: env.AXIS_TTS_URL
      ? {
          url: env.AXIS_TTS_URL,
          model: env.AXIS_TTS_MODEL || "tts-1",
          voice: env.AXIS_TTS_VOICE || undefined,
          sampleRate: integer("AXIS_TTS_SAMPLE_RATE", env.AXIS_TTS_SAMPLE_RATE, 24000),
          apiKey: env.AXIS_TTS_API_KEY || undefined,
        }
      : undefined,
    agent: env.AXIS_AGENT_URL
      ? {
          url: env.AXIS_AGENT_URL,
          model: env.AXIS_AGENT_MODEL || "openclaw",
          token: env.AXIS_AGENT_TOKEN || undefined,
          sessionKey: env.AXIS_AGENT_SESSION_KEY || "vortex-axis",
        }
      : undefined,
  };
}
