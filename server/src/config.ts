import { fileURLToPath } from "node:url";

export interface Config {
  /** Interface to listen on. */
  host: string;
  /** Port to listen on. 0 picks a free port. */
  port: number;
  /** Directory holding the SQLite file. */
  dataDir: string;
  /** Bearer token for the admin API. The admin API is disabled when unset. */
  adminToken: string | undefined;
  /**
   * Host names Axis is reached by from outside, for example a public domain
   * behind a reverse proxy. Requests for these get the client side only: the
   * admin page and API answer "not found" there.
   */
  publicHosts: string[];
  /** Addresses of reverse proxies whose `X-Forwarded-For` is believed. */
  trustedProxies: string[];
  /** How long a pairing code stays valid. */
  pairingCodeTtlMs: number;
  /** How long a new connection may take to send `hello`. */
  helloTimeoutMs: number;
  /**
   * How often each client socket is pinged. A client that has not answered by the next
   * ping is dropped, so a device that lost power shows offline within two intervals.
   * 0 turns pinging off.
   */
  pingIntervalMs: number;
  /** How many days of turns and events the admin page's activity keeps. */
  activityDays: number;
  /** How long wake arbitration waits for other clients to report. */
  wakeWindowMs: number;
  /** Longest utterance accepted from a client. */
  maxUtteranceMs: number;
  /** How often upstream services are checked. 0 turns the checks off. */
  healthIntervalMs: number;
  stt: { url: string; model: string; apiKey: string | undefined } | undefined;
  /** The voiceprint service, for telling voices apart. */
  voiceprintUrl: string | undefined;
  tts:
    | { url: string; model: string; voice: string | undefined; sampleRate: number; apiKey: string | undefined }
    | undefined;
  /**
   * An OpenAI-style chat endpoint to use as the agent instead of an OpenClaw
   * gateway. Leave unset to use the gateway link.
   */
  agent: { url: string; model: string; token: string | undefined; sessionKey: string | undefined } | undefined;
  gateway: {
    /** Gateway address. When unset, the address inside the setup code is used. */
    url: string | undefined;
    /** Agent to send turns to. When unset, the gateway's default agent. */
    agentId: string | undefined;
    /** Keeps every client in one conversation. */
    sessionKey: string;
    /** Name the hub shows up under on the gateway. */
    displayName: string;
  };
  /** How long the last client spoken to stays the default place to answer. */
  outputHoldMs: number;
  /** How long something said to a client that is offline is kept for it. */
  messageHoldMs: number;
  /** How long an agent may go quiet before a device stops waiting and the run carries on in the background. 0: never. */
  handoverMs: number;
  /** Whether agents may reach the MCP door under a public name. Off: it answers on the local network only, like the admin page. */
  mcpPublic: boolean;
  /** Whether progress cards of the OpenClaw gateway's sessions are shown as tasks with no tool call. */
  mirrorCards: boolean;
  /** Whether questions OpenClaw agents ask are put to the person on a device. */
  mirrorQuestions: boolean;
  /** Whether approvals OpenClaw agents wait on are offered on a device. */
  mirrorApprovals: boolean;
  /** Where copies of the data folder go, as Axis sees it. Unset: no backup. */
  backupDir: string | undefined;
  /** Hours between copies. 0 makes one only when asked. */
  backupEveryHours: number;
  /** How many days a daily copy of the database is kept. */
  backupKeepDays: number;
  /** Home Assistant, through its MQTT broker. Absent when no broker address is given. */
  homeAssistant: { url: string; discoveryPrefix: string } | undefined;
  /** The time zone quiet hours are told in, such as "America/Chicago". */
  timeZone: string;
  /** Folder holding the web pages. Undefined serves none. */
  webDir: string | undefined;
}

/** A time zone the runtime knows, or the machine's own when none (or a wrong one) is given. */
function zone(name: string | undefined): string {
  if (name) {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: name });
      return name;
    } catch {
      // Fall through to the machine's own.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function integer(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Reads configuration from environment variables. Nothing is host-specific in code. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.AXIS_HOST || "0.0.0.0",
    port: integer("AXIS_PORT", env.AXIS_PORT, 8440),
    dataDir: env.AXIS_DATA_DIR || "./data",
    adminToken: env.AXIS_ADMIN_TOKEN || undefined,
    publicHosts: list(env.AXIS_PUBLIC_HOSTS).map((host) => host.toLowerCase()),
    trustedProxies: list(env.AXIS_TRUSTED_PROXIES),
    pairingCodeTtlMs: integer("AXIS_PAIRING_CODE_TTL_MS", env.AXIS_PAIRING_CODE_TTL_MS, 10 * 60 * 1000),
    helloTimeoutMs: integer("AXIS_HELLO_TIMEOUT_MS", env.AXIS_HELLO_TIMEOUT_MS, 10 * 1000),
    pingIntervalMs: integer("AXIS_PING_INTERVAL_MS", env.AXIS_PING_INTERVAL_MS, 15 * 1000),
    activityDays: Math.max(1, integer("AXIS_ACTIVITY_DAYS", env.AXIS_ACTIVITY_DAYS, 7)),
    wakeWindowMs: integer("AXIS_WAKE_WINDOW_MS", env.AXIS_WAKE_WINDOW_MS, 200),
    maxUtteranceMs: integer("AXIS_MAX_UTTERANCE_MS", env.AXIS_MAX_UTTERANCE_MS, 30 * 1000),
    healthIntervalMs: integer("AXIS_HEALTH_INTERVAL_MS", env.AXIS_HEALTH_INTERVAL_MS, 30 * 1000),
    voiceprintUrl: env.AXIS_VOICEPRINT_URL || undefined,
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
    gateway: {
      url: env.AXIS_GATEWAY_URL || undefined,
      agentId: env.AXIS_AGENT_ID || undefined,
      sessionKey: env.AXIS_AGENT_SESSION_KEY || "vortex-axis",
      displayName: env.AXIS_NODE_NAME || "VorteX Axis",
    },
    outputHoldMs: integer("AXIS_OUTPUT_HOLD_MS", env.AXIS_OUTPUT_HOLD_MS, 10 * 60 * 1000),
    messageHoldMs: integer("AXIS_MESSAGE_HOLD_MS", env.AXIS_MESSAGE_HOLD_MS, 10 * 60 * 1000),
    handoverMs: integer("AXIS_HANDOVER_MS", env.AXIS_HANDOVER_MS, 30 * 1000),
    mcpPublic: env.AXIS_MCP_PUBLIC === "1" || env.AXIS_MCP_PUBLIC === "true",
    mirrorCards: env.AXIS_MIRROR_CARDS !== "0" && env.AXIS_MIRROR_CARDS !== "false",
    mirrorQuestions: env.AXIS_MIRROR_QUESTIONS !== "0" && env.AXIS_MIRROR_QUESTIONS !== "false",
    mirrorApprovals: env.AXIS_MIRROR_APPROVALS === "1" || env.AXIS_MIRROR_APPROVALS === "true",
    backupDir: env.AXIS_BACKUP_DIR || undefined,
    backupEveryHours: integer("AXIS_BACKUP_EVERY_HOURS", env.AXIS_BACKUP_EVERY_HOURS, 1),
    backupKeepDays: Math.max(1, integer("AXIS_BACKUP_KEEP_DAYS", env.AXIS_BACKUP_KEEP_DAYS, 7)),
    timeZone: zone(env.AXIS_TIMEZONE || env.TZ),
    homeAssistant: env.AXIS_MQTT_URL ? { url: env.AXIS_MQTT_URL, discoveryPrefix: env.AXIS_HA_DISCOVERY_PREFIX || "homeassistant" } : undefined,
    // The compiled server sits in server/dist, two levels below the repository root.
    webDir: env.AXIS_WEB_DIR || fileURLToPath(new URL("../../web", import.meta.url)),
  };
}
