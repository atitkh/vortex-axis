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
];

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

  // --- what each client type offers ----------------------------------------

  /** Keeps what a client type declared in `describe`, so it can be edited while the device is off. */
  saveSchema(type: string, schema: ClientSchema): void {
    this.setMeta(`schema:${type}`, JSON.stringify(schema));
  }

  getSchema(type: string): ClientSchema | undefined {
    const text = this.getMeta(`schema:${type}`);
    return text ? (JSON.parse(text) as ClientSchema) : undefined;
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
