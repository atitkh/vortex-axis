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
  };
}
