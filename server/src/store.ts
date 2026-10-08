import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Capability, Scalar, ScalarMap } from "@vortex-axis/protocol";
import type { ClientSchema } from "./schema.js";
import {
  hashSecret,
  newClientId,
  newPairingCode,
  newToken,
  normalizePairingCode,
  secretMatches,
} from "./secrets.js";

export interface ClientRecord {
  id: string;
  name: string;
  type: string;
  capabilities: Capability[];
  version: string;
  createdAt: number;
  lastSeenAt: number | null;
}

export type SettingsScope = "global" | "type" | "device";

interface ClientRow {
  id: string;
  name: string;
  type: string;
  capabilities: string;
  version: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    version TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    scope TEXT NOT NULL CHECK (scope IN ('global', 'type', 'device')),
    scope_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (scope, scope_id, key)
  );
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO meta (key, value) VALUES ('settings_version', '1');
  `,
  // What happened, for the admin page's activity and uptime. Timings and outcomes only:
  // never audio, never what anybody said. Rows older than the retention period are pruned.
  `
  CREATE TABLE turns (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    outcome TEXT NOT NULL,
    error TEXT,
    speech_ms INTEGER,
    stt_ms INTEGER,
    agent_ms INTEGER,
    first_audio_ms INTEGER,
    total_ms INTEGER NOT NULL,
    heard INTEGER NOT NULL
  );
  CREATE INDEX turns_at ON turns (at);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    state TEXT,
    level TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX events_at ON events (at);
  CREATE INDEX events_subject ON events (kind, subject, at);
  `,
  // Timers agents set. Kept on disk so a restart of Axis does not lose one.
  `
  CREATE TABLE timers (
    id INTEGER PRIMARY KEY,
    client_id TEXT NOT NULL,
    label TEXT NOT NULL,
    seconds INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

/** A timer an agent set. It is announced on `clientId` when that client can be reached. */
export interface TimerRecord {
  id: number;
  clientId: string;
  /** What it is for, in a word or two. May be empty. */
  label: string;
  /** How long it was set for. */
  seconds: number;
  dueAt: number;
  createdAt: number;
}

interface TurnRow {
  at: number;
  client_id: string;
  kind: string;
  outcome: string;
  error: string | null;
  speech_ms: number | null;
  stt_ms: number | null;
  agent_ms: number | null;
  first_audio_ms: number | null;
  total_ms: number;
  heard: number;
}

interface EventRow {
  at: number;
  kind: string;
  subject: string;
  state: string | null;
  level: string;
  text: string;
}

function toEvent(r: EventRow): EventRecord {
  return { at: r.at, kind: r.kind, subject: r.subject, state: r.state ?? undefined, level: r.level as EventRecord["level"], text: r.text };
}

function toRecord(row: ClientRow): ClientRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    capabilities: JSON.parse(row.capabilities) as Capability[],
    version: row.version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** One turn as the activity log keeps it. Durations are milliseconds; absent when that stage did not run. */
export interface TurnRecord {
  at: number;
  clientId: string;
  /** voice: spoken; text: typed; say: started by an agent. */
  kind: "voice" | "text" | "say";
  outcome: "answered" | "silent" | "no_speech" | "interrupted" | "failed";
  error?: string | undefined;
  /** How long the person spoke. */
  speechMs?: number | undefined;
  sttMs?: number | undefined;
  /** From asking the agent to its first words. */
  agentMs?: number | undefined;
  /** From Axis starting on the turn to the first audio sent to the client. */
  firstAudioMs?: number | undefined;
  totalMs: number;
  /** The client confirmed it played the reply to the end. */
  heard: boolean;
}

/** Something that happened. Events with a `state` draw the uptime timelines. */
export interface EventRecord {
  at: number;
  /** axis, service, client, settings or admin. */
  kind: string;
  /** What it is about: a client id, a service name, or "" for Axis itself. */
  subject: string;
  state?: string | undefined;
  level: "info" | "warn" | "bad";
  text: string;
}

/** Everything Axis keeps on disk. Live state (who is online) is not stored here. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    if (dataDir === ":memory:") {
      this.db = new DatabaseSync(":memory:");
    } else {
      mkdirSync(dataDir, { recursive: true });
      this.db = new DatabaseSync(join(dataDir, "axis.sqlite"));
      // A rollback journal, not write-ahead logging: WAL needs shared memory
      // between processes and is not safe when the data folder is on network
      // storage, which is a common place to keep it. Axis writes rarely, so
      // nothing is lost by this. An existing WAL database is converted on open.
      this.db.exec("PRAGMA journal_mode = DELETE");
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let version = row.user_version; version < MIGRATIONS.length; version++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[version]!);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  // --- pairing ------------------------------------------------------------

  /** Creates a one-time pairing code. Only its hash is stored. */
  createPairingCode(ttlMs: number): { code: string; expiresAt: number } {
    const now = this.now();
    this.db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(now);
    const code = newPairingCode();
    const expiresAt = now + ttlMs;
    this.db
      .prepare("INSERT OR REPLACE INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(hashSecret(normalizePairingCode(code)), now, expiresAt);
    return { code, expiresAt };
  }

  /**
   * Spends a pairing code and registers the client. Returns undefined when the
   * code is unknown, expired or already used.
   */
  pair(input: {
    code: string;
    type: string;
    version: string;
    capabilities: Capability[];
    name?: string | undefined;
  }): { client: ClientRecord; token: string } | undefined {
    const now = this.now();
    const spent = this.db
      .prepare("DELETE FROM pairing_codes WHERE code_hash = ? AND expires_at > ?")
      .run(hashSecret(normalizePairingCode(input.code)), now);
    if (spent.changes !== 1) return undefined;

    const id = newClientId();
    const token = newToken();
    const name = this.uniqueName(input.name?.trim() || input.type);
    this.db
      .prepare(
        "INSERT INTO clients (id, name, type, capabilities, version, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, name, input.type, JSON.stringify(input.capabilities), input.version, hashSecret(token), now);
    return { client: this.getClient(id)!, token };
  }

  private uniqueName(base: string): string {
    const taken = this.db.prepare("SELECT 1 FROM clients WHERE name = ?");
    if (!taken.get(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} ${n}`;
      if (!taken.get(candidate)) return candidate;
    }
  }

  // --- clients ------------------------------------------------------------

  getClient(id: string): ClientRecord | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as ClientRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  listClients(): ClientRecord[] {
    const rows = this.db.prepare("SELECT * FROM clients ORDER BY created_at, id").all() as unknown as ClientRow[];
    return rows.map(toRecord);
  }

  /** Returns the client when the token is right, otherwise undefined. */
  authenticate(id: string, token: string): ClientRecord | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as ClientRow | undefined;
    if (!row || !secretMatches(token, row.token_hash)) return undefined;
    return toRecord(row);
  }

  /** Records what a client reported about itself in `hello`. */
  recordHello(id: string, info: { version: string; capabilities: Capability[] }): void {
    this.db
      .prepare("UPDATE clients SET version = ?, capabilities = ?, last_seen_at = ? WHERE id = ?")
      .run(info.version, JSON.stringify(info.capabilities), this.now(), id);
  }

  touch(id: string): void {
    this.db.prepare("UPDATE clients SET last_seen_at = ? WHERE id = ?").run(this.now(), id);
  }

  /**
   * Gives a client a new name. Names are matched without regard to case when agents
   * address a client, so two clients may not differ only in case.
   */
  renameClient(id: string, name: string): ClientRecord | "taken" | undefined {
    const clash = this.db.prepare("SELECT 1 FROM clients WHERE lower(name) = lower(?) AND id != ?").get(name, id);
    if (clash) return "taken";
    const changed = this.db.prepare("UPDATE clients SET name = ? WHERE id = ?").run(name, id);
    return changed.changes === 1 ? this.getClient(id) : undefined;
  }

  /** Removes a client and its device settings. Its token stops working at once. */
  removeClient(id: string): boolean {
    const removed = this.db.prepare("DELETE FROM clients WHERE id = ?").run(id);
    if (removed.changes !== 1) return false;
    this.db.prepare("DELETE FROM settings WHERE scope = 'device' AND scope_id = ?").run(id);
    return true;
  }

  // --- timers -------------------------------------------------------------

  addTimer(timer: Omit<TimerRecord, "id">): TimerRecord {
    const result = this.db
      .prepare("INSERT INTO timers (client_id, label, seconds, due_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(timer.clientId, timer.label, timer.seconds, timer.dueAt, timer.createdAt);
    return { ...timer, id: Number(result.lastInsertRowid) };
  }

  /** Every timer still running, soonest first. */
  listTimers(): TimerRecord[] {
    const rows = this.db.prepare("SELECT * FROM timers ORDER BY due_at, id").all() as unknown as Array<{
      id: number;
      client_id: string;
      label: string;
      seconds: number;
      due_at: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      label: r.label,
      seconds: r.seconds,
      dueAt: r.due_at,
      createdAt: r.created_at,
    }));
  }

  removeTimer(id: number): boolean {
    return this.db.prepare("DELETE FROM timers WHERE id = ?").run(id).changes === 1;
  }

  // --- what each client type offers ----------------------------------------

  /** Keeps what a client type declared in `describe`, so it can be edited while the device is off. */
  saveSchema(type: string, schema: ClientSchema): void {
    this.setMeta(`schema:${type}`, JSON.stringify(schema));
  }

  getSchema(type: string): ClientSchema | undefined {
    const text = this.getMeta(`schema:${type}`);
    return text ? (JSON.parse(text) as ClientSchema) : undefined;
  }

  // --- activity -------------------------------------------------------------

  addTurn(t: TurnRecord): void {
    this.db
      .prepare(
        "INSERT INTO turns (at, client_id, kind, outcome, error, speech_ms, stt_ms, agent_ms, first_audio_ms, total_ms, heard) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.at, t.clientId, t.kind, t.outcome, t.error ?? null, t.speechMs ?? null, t.sttMs ?? null, t.agentMs ?? null,
        t.firstAudioMs ?? null, t.totalMs, t.heard ? 1 : 0);
  }

  /** Turns that started in [from, to), oldest first. */
  turnsBetween(from: number, to: number, clientId?: string): TurnRecord[] {
    const rows = (
      clientId
        ? this.db.prepare("SELECT * FROM turns WHERE at >= ? AND at < ? AND client_id = ? ORDER BY at").all(from, to, clientId)
        : this.db.prepare("SELECT * FROM turns WHERE at >= ? AND at < ? ORDER BY at").all(from, to)
    ) as unknown as TurnRow[];
    return rows.map((r) => ({
      at: r.at,
      clientId: r.client_id,
      kind: r.kind as TurnRecord["kind"],
      outcome: r.outcome as TurnRecord["outcome"],
      error: r.error ?? undefined,
      speechMs: r.speech_ms ?? undefined,
      sttMs: r.stt_ms ?? undefined,
      agentMs: r.agent_ms ?? undefined,
      firstAudioMs: r.first_audio_ms ?? undefined,
      totalMs: r.total_ms,
      heard: r.heard === 1,
    }));
  }

  addEvent(e: EventRecord): void {
    this.db
      .prepare("INSERT INTO events (at, kind, subject, state, level, text) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.at, e.kind, e.subject, e.state ?? null, e.level, e.text);
  }

  /** Events in [from, to), oldest first. */
  eventsBetween(from: number, to: number): EventRecord[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE at >= ? AND at < ? ORDER BY at, id").all(from, to) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /** The last event with a state for each subject of `kind` before `at`: where a timeline starts. */
  statesBefore(kind: string, at: number): Map<string, EventRecord> {
    const rows = this.db
      .prepare(
        "SELECT e.* FROM events e JOIN (SELECT subject, MAX(id) AS id FROM events WHERE kind = ? AND state IS NOT NULL AND at < ? GROUP BY subject) last ON e.id = last.id",
      )
      .all(kind, at) as unknown as EventRow[];
    return new Map(rows.map((r) => [r.subject, toEvent(r)]));
  }

  /** Removes turns and events older than `before`. */
  pruneActivity(before: number): void {
    this.db.prepare("DELETE FROM turns WHERE at < ?").run(before);
    this.db.prepare("DELETE FROM events WHERE at < ?").run(before);
  }

  // --- small named values --------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  /** Stores a named value. Passing undefined removes it. */
  setMeta(key: string, value: string | undefined): void {
    if (value === undefined) this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    else {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(key, value);
    }
  }

  /** Finds a client by id, or by name without regard to case. */
  findClient(idOrName: string): ClientRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM clients WHERE id = ? OR lower(name) = lower(?) ORDER BY id = ? DESC LIMIT 1")
      .get(idOrName, idOrName, idOrName) as ClientRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  // --- settings -----------------------------------------------------------

  settingsVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'settings_version'").get() as { value: string };
    return Number(row.value);
  }

  private bumpSettingsVersion(): number {
    const next = this.settingsVersion() + 1;
    this.db.prepare("UPDATE meta SET value = ? WHERE key = 'settings_version'").run(String(next));
    return next;
  }

  getLayer(scope: SettingsScope, scopeId: string): ScalarMap {
    const rows = this.db
      .prepare("SELECT key, value FROM settings WHERE scope = ? AND scope_id = ? ORDER BY key")
      .all(scope, scope === "global" ? "" : scopeId) as unknown as { key: string; value: string }[];
    const layer: ScalarMap = {};
    for (const row of rows) layer[row.key] = JSON.parse(row.value) as Scalar;
    return layer;
  }

  /**
   * Merges values into one settings layer. A null value removes the key from
   * that layer, so the layer below shows through again. Returns the new
   * settings version.
   */
  patchLayer(scope: SettingsScope, scopeId: string, values: ScalarMap): number {
    const id = scope === "global" ? "" : scopeId;
    const upsert = this.db.prepare(
      "INSERT INTO settings (scope, scope_id, key, value) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (scope, scope_id, key) DO UPDATE SET value = excluded.value",
    );
    const remove = this.db.prepare("DELETE FROM settings WHERE scope = ? AND scope_id = ? AND key = ?");
    this.db.exec("BEGIN");
    try {
      for (const [key, value] of Object.entries(values)) {
        if (value === null) remove.run(scope, id, key);
        else upsert.run(scope, id, key, JSON.stringify(value));
      }
      const version = this.bumpSettingsVersion();
      this.db.exec("COMMIT");
      return version;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Global, then client type, then device. The more specific layer wins. */
  resolveSettings(client: Pick<ClientRecord, "id" | "type">): ScalarMap {
    return {
      ...this.getLayer("global", ""),
      ...this.getLayer("type", client.type),
      ...this.getLayer("device", client.id),
    };
  }
}
