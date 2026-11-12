import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import type { Capability, Scalar, ScalarMap } from "@vortex-axis/protocol";
import { RENAMED_TYPES, currentType } from "./clienttypes.js";
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
  /** What it can do: what it reported in its last `hello`, less what an admin switched off. Every decision reads this. */
  capabilities: Capability[];
  /** What it reported in its last `hello`, all of it. */
  reported: Capability[];
  /** What an admin switched off for it (`capabilities_off`). Usually empty. */
  off: Capability[];
  /** What the active profile switched off, of what was left on (hub.ts `withProfileCaps`); the store itself leaves it empty. */
  profileOff?: Capability[];
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
  capabilities_off: string;
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
  // "room" became "location": a device may be somewhere that is not a room, such as a car.
  `
  UPDATE OR REPLACE settings SET key = 'location' WHERE key = 'room';
  `,  // Where to reach a browser client whose page is closed (Web Push). One per client.
  `
  CREATE TABLE push_subscriptions (
    client_id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // Every wake word a device reported: how sure it was, how loud, and what came of it. No audio, no words.
  `
  CREATE TABLE wakes (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    word TEXT NOT NULL,
    score REAL NOT NULL,
    level REAL NOT NULL,
    outcome TEXT NOT NULL
  );
  CREATE INDEX wakes_at ON wakes (at);
  `,
  // Tokens agents use to reach Axis's tools over MCP. Hashes only, like client tokens.
  `
  CREATE TABLE agent_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  `,
  // What made a device start listening for a spoken turn: the wake word, a tap, and so on.
  `
  ALTER TABLE turns ADD COLUMN started_by TEXT;
  `,
  // Long work agents reported on, once it is over: what it was, how far it got and how long it took.
  `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    note TEXT NOT NULL,
    done INTEGER,
    total INTEGER,
    ending TEXT NOT NULL,
    started_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_at ON tasks (at);
  `,
  // Voices Axis knows by their voiceprints (voiceprint.ts), and whose voice a turn was in.
  `
  CREATE TABLE voices (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE voice_samples (
    id INTEGER PRIMARY KEY,
    voice_id INTEGER NOT NULL REFERENCES voices (id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    seconds REAL NOT NULL,
    source TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  ALTER TABLE turns ADD COLUMN speaker TEXT;
  `,
  `
  ALTER TABLE turns ADD COLUMN handed_over INTEGER;
  `,
  // A timer may carry something for the agent to do when it is due, and whether the person allowed it to act.
  `
  ALTER TABLE timers ADD COLUMN task TEXT;
  ALTER TABLE timers ADD COLUMN may_act INTEGER;
  `,
  // What an admin switched off of what a client reports it can do. The reported list stays in `capabilities`.
  `
  ALTER TABLE clients ADD COLUMN capabilities_off TEXT NOT NULL DEFAULT '[]';
  `,
  // Wall-clock reminders, one-off (`due_at`) or repeating (`time_of_day` local HH:MM on `days`, 0 = Sunday). Apart from timers on purpose.
  `
  CREATE TABLE reminders (id INTEGER PRIMARY KEY, text TEXT NOT NULL, due_at INTEGER, time_of_day TEXT, days TEXT, client_id TEXT, location TEXT, everywhere INTEGER NOT NULL DEFAULT 0, urgent INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, missed_at INTEGER, missed_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  `,
  // Everything that reaches the user through Axis, kept (see docs/design.md). `reminder_id` has no foreign key on purpose: a one-off reminder is deleted once done.
  `
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    source_name TEXT,
    title TEXT, body TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    tag TEXT, dedupe_key TEXT, url TEXT,
    client_id TEXT, location TEXT, everywhere INTEGER NOT NULL DEFAULT 0,
    retain INTEGER NOT NULL DEFAULT 0,
    reminder_id INTEGER,
    choices TEXT, answer TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL, delivered_at INTEGER, heard_at INTEGER,
    read_at INTEGER, dismissed_at INTEGER,
    expires_at INTEGER
  );
  CREATE UNIQUE INDEX notifications_dedupe ON notifications(source, dedupe_key);
  CREATE INDEX notifications_source_created ON notifications(source, created_at);
  CREATE INDEX notifications_reminder ON notifications(reminder_id);
  CREATE TABLE notification_deliveries (
    notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    route TEXT NOT NULL,
    state TEXT NOT NULL,
    at INTEGER NOT NULL, until INTEGER, taken_at INTEGER,
    PRIMARY KEY (notification_id, client_id)
  );
  CREATE INDEX deliveries_client ON notification_deliveries(client_id, state);
  `,
];

/** A voice Axis knows, with how many recordings of it it holds. */
export interface VoiceRecord {
  id: number;
  name: string;
  createdAt: number;
  samples: number;
  seconds: number;
}

/** One recording's voiceprint. The recording itself is never kept. */
export interface VoiceSample {
  id: number;
  voiceId: number;
  embedding: Float32Array;
  seconds: number;
  /** recorded: on the admin page; turn: a turn a device heard. */
  source: string;
  at: number;
}

/** A reminder: words to pass on at a wall-clock time, once or on repeat. A repeating one keeps `timeOfDay` and `days` and moves `dueAt`; `dueAt` is absent once a one-off is missed. */
export interface ReminderRecord {
  id: number;
  text: string;
  dueAt?: number | undefined;
  /** Local "HH:MM", repeating reminders only. */
  timeOfDay?: string | undefined;
  /** Weekdays as "1,2,3,4,5", 0 = Sunday, repeating reminders only. */
  days?: string | undefined;
  clientId?: string | undefined;
  location?: string | undefined;
  everywhere: boolean;
  urgent: boolean;
  /** Tries made for the current due time. */
  attempts: number;
  retryAt?: number | undefined;
  missedAt?: number | undefined;
  missedCount: number;
  createdAt: number;
}

/** Days a low or normal notification is kept; urgent and retained ones stay until dismissed. */
export const RETENTION_DAYS = 7;
/** Most notifications kept per source; the oldest go first. */
export const SOURCE_CAP = 500;
/** Most messages held for one device; older ones are dropped. */
const HELD_CAP = 5;

export type NotificationSource = "agent" | "reminder" | "ask" | "system";
export type NotificationPriority = "low" | "normal" | "urgent";
export type NotificationStatus = "pending" | "delivered" | "heard" | "held" | "missed" | "answered" | "timed_out" | "dropped";

/** One thing that reached (or tried to reach) the user. `expiresAt` absent: kept until dismissed. */
export interface NotificationRecord {
  id: number;
  source: NotificationSource;
  sourceName?: string | undefined;
  title?: string | undefined;
  body: string;
  priority: NotificationPriority;
  tag?: string | undefined;
  dedupeKey?: string | undefined;
  url?: string | undefined;
  clientId?: string | undefined;
  location?: string | undefined;
  everywhere: boolean;
  retain: boolean;
  /** The reminder it came from; not a foreign key, the reminder may be gone. */
  reminderId?: number | undefined;
  /** Asks only. */
  choices?: string[] | undefined;
  answer?: string | undefined;
  status: NotificationStatus;
  createdAt: number;
  deliveredAt?: number | undefined;
  heardAt?: number | undefined;
  readAt?: number | undefined;
  dismissedAt?: number | undefined;
  expiresAt?: number | undefined;
}

export type DeliveryRoute = "live" | "silent" | "push" | "held";
export type DeliveryState = "held" | "shown" | "heard" | "pushed" | "missed" | "dropped" | "failed";

/** How one notification went to one client. */
export interface NotificationDelivery {
  notificationId: number;
  clientId: string;
  route: DeliveryRoute;
  state: DeliveryState;
  at: number;
  until?: number | undefined;
  takenAt?: number | undefined;
}

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
  /** What the agent is to do when it is due, in its own words from when it was set. Without one, the timer only rings. */
  task?: string | undefined;
  /** The person said, when asked by Axis, that the task may click and type on a computer. */
  mayAct?: boolean | undefined;
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
  started_by: string | null;
  speaker: string | null;
  handed_over: number | null;
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
  const reported = JSON.parse(row.capabilities) as Capability[];
  const off = JSON.parse(row.capabilities_off || "[]") as Capability[];
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    capabilities: off.length ? reported.filter((c) => !off.includes(c)) : reported,
    reported,
    off,
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
  /** For a spoken turn, what made the device listen. Absent when the device did not say and there was no wake word. */
  startedBy?: "wake" | "tap" | "hold" | "follow_up" | "question" | undefined;
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
  /** Whose voice it was, when voices are told apart: a known voice's name, "guest" or "unsure". */
  speaker?: string | undefined;
  /** The agent went on too long, so the device stopped waiting and the run was followed in the background. */
  handedOver?: boolean | undefined;
}

/** A token an agent holds for the MCP door. The token itself is never kept. */
export interface AgentTokenRecord {
  id: number;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Long work an agent reported on, once it is over. */
export interface TaskRecord {
  /** When it ended. */
  at: number;
  taskId: string;
  title: string;
  /** The last few words said about it. */
  note: string;
  done?: number;
  total?: number;
  /** done: the agent said so; cleared: taken off by hand; abandoned: nobody reported on it any more. */
  ending: "done" | "cleared" | "abandoned";
  startedAt: number;
}

/** One wake word as a device reported it. */
export interface WakeRecord {
  at: number;
  clientId: string;
  /** The wake word the device was listening with: a stored one's id, or "built-in". */
  word: string;
  /** How sure the device was, 0 to 1. Only wakes over the device's own cutoff are ever reported. */
  score: number;
  /** How loud it was, 0 to 1. */
  level: number;
  /** answered: this device took the turn; stood_down: another device scored better; ignored: a device nearby was speaking. */
  outcome: "answered" | "stood_down" | "ignored";
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
      try {
        this.db = new DatabaseSync(join(dataDir, "axis.sqlite"));
      } catch (error) {
        const who = typeof process.getuid === "function" ? ` (running as user ${process.getuid()})` : "";
        throw new Error(
          `Cannot open ${join(dataDir, "axis.sqlite")}${who}: ${error instanceof Error ? error.message : String(error)}. ` +
            "The data folder must be writable by that user; with Docker, create the folder before the first start or let the image's entrypoint start as root.",
          { cause: error },
        );
      }
      // The file holds the gateway's private key, the push keys and every token's hash: for this user only.
      // Best effort: a data folder on a share may not take modes.
      for (const [path, mode] of [[dataDir, 0o700], [join(dataDir, "axis.sqlite"), 0o600]] as const) {
        try {
          chmodSync(path, mode);
        } catch {
          /* a folder on network storage may not allow it */
        }
      }
      // A rollback journal, not write-ahead logging: WAL needs shared memory
      // between processes and is not safe when the data folder is on network
      // storage, which is a common place to keep it. Axis writes rarely, so
      // nothing is lost by this. An existing WAL database is converted on open.
      this.db.exec("PRAGMA journal_mode = DELETE");
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.renameTypes(RENAMED_TYPES);
  }

  close(): void {
    this.db.close();
  }

  /** Writes a whole, consistent copy of the database to `path`, a few pages at a time so Axis carries on meanwhile. */
  async backupTo(path: string): Promise<void> {
    await backup(this.db, path, { rate: 200 });
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

  /**
   * Moves what is kept under a client type's old name to its new one (clienttypes.ts): the clients, the type layer
   * of settings, what the type described (`schema:`) and the name a person gave it (`type_label:`). Runs every time
   * the store opens and does nothing when there is nothing under an old name. When both names have a row, the new
   * name's wins and the old one is dropped. Returns how many rows moved.
   */
  renameTypes(renamed: Readonly<Record<string, string>>): number {
    let moved = 0;
    for (const [from, to] of Object.entries(renamed)) {
      this.db.exec("BEGIN");
      try {
        moved += Number(this.db.prepare("UPDATE clients SET type = ? WHERE type = ?").run(to, from).changes);
        moved += Number(
          this.db.prepare("UPDATE OR IGNORE settings SET scope_id = ? WHERE scope = 'type' AND scope_id = ?").run(to, from).changes,
        );
        this.db.prepare("DELETE FROM settings WHERE scope = 'type' AND scope_id = ?").run(from);
        for (const prefix of ["schema:", "type_label:"]) {
          moved += Number(this.db.prepare("UPDATE OR IGNORE meta SET key = ? WHERE key = ?").run(prefix + to, prefix + from).changes);
          this.db.prepare("DELETE FROM meta WHERE key = ?").run(prefix + from);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    return moved;
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

  /** Throws away every pairing code not yet used. Returns how many there were. */
  clearPairingCodes(): number {
    return Number(this.db.prepare("DELETE FROM pairing_codes").run().changes);
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
    // A device that has not updated may give its type's old name.
    const type = currentType(input.type);
    const name = this.uniqueName(input.name?.trim() || type);
    this.db
      .prepare(
        "INSERT INTO clients (id, name, type, capabilities, version, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, name, type, JSON.stringify(input.capabilities), input.version, hashSecret(token), now);
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

  /** Sets what an admin switched off of what the client reports. Only takes away: what it does not report it never gains. */
  setCapabilitiesOff(id: string, off: Capability[]): ClientRecord | undefined {
    const changed = this.db.prepare("UPDATE clients SET capabilities_off = ? WHERE id = ?").run(JSON.stringify(off), id);
    return changed.changes === 1 ? this.getClient(id) : undefined;
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
    this.db.prepare("DELETE FROM push_subscriptions WHERE client_id = ?").run(id);
    return true;
  }

  // --- timers -------------------------------------------------------------

  addTimer(timer: Omit<TimerRecord, "id">): TimerRecord {
    const result = this.db
      .prepare("INSERT INTO timers (client_id, label, seconds, due_at, created_at, task, may_act) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(timer.clientId, timer.label, timer.seconds, timer.dueAt, timer.createdAt, timer.task ?? null, timer.mayAct ? 1 : 0);
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
      task: string | null;
      may_act: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      label: r.label,
      seconds: r.seconds,
      dueAt: r.due_at,
      createdAt: r.created_at,
      ...(r.task ? { task: r.task, mayAct: r.may_act === 1 } : {}),
    }));
  }

  removeTimer(id: number): boolean {
    return this.db.prepare("DELETE FROM timers WHERE id = ?").run(id).changes === 1;
  }

  // --- reminders ------------------------------------------------------------

  addReminder(reminder: Omit<ReminderRecord, "id">): ReminderRecord {
    const result = this.db
      .prepare(
        "INSERT INTO reminders (text, due_at, time_of_day, days, client_id, location, everywhere, urgent, attempts, retry_at, missed_at, missed_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        reminder.text,
        reminder.dueAt ?? null,
        reminder.timeOfDay ?? null,
        reminder.days ?? null,
        reminder.clientId ?? null,
        reminder.location ?? null,
        reminder.everywhere ? 1 : 0,
        reminder.urgent ? 1 : 0,
        reminder.attempts,
        reminder.retryAt ?? null,
        reminder.missedAt ?? null,
        reminder.missedCount,
        reminder.createdAt,
      );
    return { ...reminder, id: Number(result.lastInsertRowid) };
  }

  /** Every reminder, soonest due first, those with no due time (missed one-offs) last. */
  listReminders(): ReminderRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM reminders ORDER BY due_at IS NULL, due_at, id")
      .all() as unknown as Array<Record<string, string | number | null>>;
    return rows.map((r) => {
      const opt = <T>(value: T | null): T | undefined => (value === null ? undefined : value);
      return {
        id: r.id as number,
        text: r.text as string,
        dueAt: opt(r.due_at as number | null),
        timeOfDay: opt(r.time_of_day as string | null),
        days: opt(r.days as string | null),
        clientId: opt(r.client_id as string | null),
        location: opt(r.location as string | null),
        everywhere: r.everywhere === 1,
        urgent: r.urgent === 1,
        attempts: r.attempts as number,
        retryAt: opt(r.retry_at as number | null),
        missedAt: opt(r.missed_at as number | null),
        missedCount: r.missed_count as number,
        createdAt: r.created_at as number,
      };
    });
  }

  /** Changes the named fields; a field set to `undefined` is cleared. Returns false when there is no such reminder. */
  updateReminder(id: number, patch: Partial<Omit<ReminderRecord, "id" | "createdAt">>): boolean {
    const columns: Record<string, string> = {
      text: "text", dueAt: "due_at", timeOfDay: "time_of_day", days: "days", clientId: "client_id", location: "location",
      everywhere: "everywhere", urgent: "urgent", attempts: "attempts", retryAt: "retry_at", missedAt: "missed_at", missedCount: "missed_count",
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      const value = (patch as Record<string, unknown>)[key];
      sets.push(`${column} = ?`);
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : ((value as string | number | undefined) ?? null));
    }
    if (sets.length === 0) return this.db.prepare("SELECT 1 FROM reminders WHERE id = ?").get(id) !== undefined;
    return this.db.prepare(`UPDATE reminders SET ${sets.join(", ")} WHERE id = ?`).run(...values, id).changes === 1;
  }

  removeReminder(id: number): boolean {
    return this.db.prepare("DELETE FROM reminders WHERE id = ?").run(id).changes === 1;
  }

  // --- notifications ----------------------------------------------------------

  /**
   * Records a notification. `createdAt` defaults to now; `expiresAt` defaults to the retention rule (7 days for low and normal,
   * none for urgent or retained) and may be given, `null` meaning none. A second row with the same source and dedupe key throws.
   */
  addNotification(
    input: Omit<NotificationRecord, "id" | "createdAt" | "expiresAt"> & { createdAt?: number; expiresAt?: number | null },
  ): NotificationRecord {
    const createdAt = input.createdAt ?? this.now();
    const expiresAt =
      input.expiresAt !== undefined ? input.expiresAt : input.retain || input.priority === "urgent" ? null : createdAt + RETENTION_DAYS * 86_400_000;
    const result = this.db
      .prepare(
        "INSERT INTO notifications (source, source_name, title, body, priority, tag, dedupe_key, url, client_id, location, everywhere, retain, reminder_id, choices, answer, status, created_at, delivered_at, heard_at, read_at, dismissed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.source,
        input.sourceName ?? null,
        input.title ?? null,
        input.body,
        input.priority,
        input.tag ?? null,
        input.dedupeKey ?? null,
        input.url ?? null,
        input.clientId ?? null,
        input.location ?? null,
        input.everywhere ? 1 : 0,
        input.retain ? 1 : 0,
        input.reminderId ?? null,
        input.choices ? JSON.stringify(input.choices) : null,
        input.answer ?? null,
        input.status,
        createdAt,
        input.deliveredAt ?? null,
        input.heardAt ?? null,
        input.readAt ?? null,
        input.dismissedAt ?? null,
        expiresAt,
      );
    const { createdAt: _created, expiresAt: _expires, ...rest } = input;
    return { ...rest, id: Number(result.lastInsertRowid), createdAt, expiresAt: expiresAt ?? undefined };
  }

  /** Changes the named fields; a field set to `undefined` is cleared. Returns false when there is no such notification. */
  updateNotification(id: number, patch: Partial<Omit<NotificationRecord, "id" | "createdAt" | "source">>): boolean {
    const columns: Record<string, string> = {
      sourceName: "source_name", title: "title", body: "body", priority: "priority", tag: "tag", dedupeKey: "dedupe_key", url: "url",
      clientId: "client_id", location: "location", everywhere: "everywhere", retain: "retain", reminderId: "reminder_id", choices: "choices",
      answer: "answer", status: "status", deliveredAt: "delivered_at", heardAt: "heard_at", readAt: "read_at", dismissedAt: "dismissed_at",
      expiresAt: "expires_at",
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      const value = (patch as Record<string, unknown>)[key];
      sets.push(`${column} = ?`);
      if (Array.isArray(value)) values.push(JSON.stringify(value));
      else values.push(typeof value === "boolean" ? (value ? 1 : 0) : ((value as string | number | undefined) ?? null));
    }
    if (sets.length === 0) return this.db.prepare("SELECT 1 FROM notifications WHERE id = ?").get(id) !== undefined;
    return this.db.prepare(`UPDATE notifications SET ${sets.join(", ")} WHERE id = ?`).run(...values, id).changes === 1;
  }

  /**
   * Records how a notification went to one client, replacing an earlier record for the same pair. A new `held` delivery keeps only the
   * HELD_CAP newest held ones of that client; the older are marked `dropped`.
   */
  setDelivery(delivery: NotificationDelivery): void {
    this.db
      .prepare(
        "INSERT INTO notification_deliveries (notification_id, client_id, route, state, at, until, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (notification_id, client_id) DO UPDATE SET route = excluded.route, state = excluded.state, at = excluded.at, until = excluded.until, taken_at = excluded.taken_at",
      )
      .run(delivery.notificationId, delivery.clientId, delivery.route, delivery.state, delivery.at, delivery.until ?? null, delivery.takenAt ?? null);
    if (delivery.state !== "held") return;
    this.db
      .prepare(
        "UPDATE notification_deliveries SET state = 'dropped' WHERE client_id = ? AND state = 'held' AND notification_id NOT IN (SELECT notification_id FROM notification_deliveries WHERE client_id = ? AND state = 'held' ORDER BY at DESC, notification_id DESC LIMIT ?)",
      )
      .run(delivery.clientId, delivery.clientId, HELD_CAP);
  }

  /** One notification, or undefined. */
  getNotification(id: number): NotificationRecord | undefined {
    return this.notificationsWhere("n.id = ?", [id], "n.id", true)[0];
  }

  /** The deliveries of one notification, by client. */
  deliveriesOf(notificationId: number): NotificationDelivery[] {
    const rows = this.db
      .prepare("SELECT * FROM notification_deliveries WHERE notification_id = ? ORDER BY client_id")
      .all(notificationId) as unknown as Array<Record<string, string | number | null>>;
    return rows.map((r) => this.deliveryFromRow(r));
  }

  /** Notifications held for a client and still inside their delivery window, oldest first. */
  held(clientId: string, now: number): NotificationRecord[] {
    return this.notificationsWhere("d.client_id = ? AND d.state = 'held' AND (d.until IS NULL OR d.until > ?)", [clientId, now], "d.at, n.id");
  }

  /** Notifications pushed to a client's closed browser that it has not fetched yet, oldest first. */
  pushedUntaken(clientId: string, now: number): NotificationRecord[] {
    return this.notificationsWhere(
      "d.client_id = ? AND d.state = 'pushed' AND d.taken_at IS NULL AND (d.until IS NULL OR d.until > ?)",
      [clientId, now],
      "d.at, n.id",
    );
  }

  /** Asks a client missed and has not been told about yet, oldest first. */
  missedAsksUntaken(clientId: string, now: number): NotificationRecord[] {
    return this.notificationsWhere(
      "n.source = 'ask' AND d.client_id = ? AND d.state = 'missed' AND d.taken_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > ?)",
      [clientId, now],
      "d.at, n.id",
    );
  }

  /** Marks a client's untaken deliveries on the given routes as taken, and their notifications as read. Returns the notification ids. */
  takeDeliveries(clientId: string, routes: DeliveryRoute[], now: number): number[] {
    if (routes.length === 0) return [];
    const marks = routes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT notification_id FROM notification_deliveries WHERE client_id = ? AND taken_at IS NULL AND route IN (${marks}) ORDER BY at, notification_id`)
      .all(clientId, ...routes) as unknown as Array<{ notification_id: number }>;
    const ids = rows.map((r) => r.notification_id);
    for (const id of ids) {
      this.db.prepare("UPDATE notification_deliveries SET taken_at = ? WHERE notification_id = ? AND client_id = ?").run(now, id, clientId);
      this.db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL").run(now, id);
    }
    return ids;
  }

  /** How many deliveries a client has in a state. */
  countDeliveries(clientId: string, state: DeliveryState): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM notification_deliveries WHERE client_id = ? AND state = ?")
      .get(clientId, state) as { n: number };
    return row.n;
  }

  /** Marks `dropped` every held notification with no delivery still held (the cap or a quiet hour dropped them all). Returns how many. */
  dropUnheldNotifications(): number {
    const result = this.db
      .prepare(
        "UPDATE notifications SET status = 'dropped' WHERE status = 'held' AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.notification_id = notifications.id AND d.state = 'held')",
      )
      .run();
    return Number(result.changes);
  }

  /**
   * Deletes notifications past `expiresAt`, then those beyond SOURCE_CAP per source, oldest first. A pending or held one is never
   * removed by the cap. Returns how many rows went; their deliveries go with them.
   */
  sweepNotifications(now: number): number {
    const expired = this.db.prepare("DELETE FROM notifications WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now).changes;
    const capped = this.db
      .prepare(
        "DELETE FROM notifications WHERE status NOT IN ('pending', 'held') AND id IN (SELECT n.id FROM notifications n WHERE (SELECT COUNT(*) FROM notifications m WHERE m.source = n.source AND (m.created_at > n.created_at OR (m.created_at = n.created_at AND m.id > n.id))) >= ?)",
      )
      .run(SOURCE_CAP).changes;
    return Number(expired) + Number(capped);
  }

  /** Every notification a reminder produced, oldest first. */
  notificationsForReminder(reminderId: number): NotificationRecord[] {
    return this.notificationsWhere("n.reminder_id = ?", [reminderId], "n.created_at, n.id", true);
  }

  /** Notifications, newest first; for tests and the admin page. */
  listNotifications(filter: { source?: NotificationSource; limit?: number } = {}): NotificationRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM notifications ${filter.source ? "WHERE source = ?" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...(filter.source ? [filter.source] : []), filter.limit ?? 200) as unknown as Array<Record<string, string | number | null>>;
    return rows.map((r) => this.notificationFromRow(r));
  }

  /** `where` may use `n` (notifications) and, unless `plain`, `d` (notification_deliveries). */
  private notificationsWhere(where: string, params: Array<string | number>, order: string, plain = false): NotificationRecord[] {
    const from = plain ? "notifications n" : "notifications n JOIN notification_deliveries d ON d.notification_id = n.id";
    const rows = this.db.prepare(`SELECT n.* FROM ${from} WHERE ${where} ORDER BY ${order}`).all(...params) as unknown as Array<Record<string, string | number | null>>;
    return rows.map((r) => this.notificationFromRow(r));
  }

  private notificationFromRow(r: Record<string, string | number | null>): NotificationRecord {
    const opt = <T>(value: T | null): T | undefined => (value === null ? undefined : value);
    return {
      id: r.id as number,
      source: r.source as NotificationSource,
      sourceName: opt(r.source_name as string | null),
      title: opt(r.title as string | null),
      body: r.body as string,
      priority: r.priority as NotificationPriority,
      tag: opt(r.tag as string | null),
      dedupeKey: opt(r.dedupe_key as string | null),
      url: opt(r.url as string | null),
      clientId: opt(r.client_id as string | null),
      location: opt(r.location as string | null),
      everywhere: r.everywhere === 1,
      retain: r.retain === 1,
      reminderId: opt(r.reminder_id as number | null),
      choices: r.choices === null ? undefined : (JSON.parse(r.choices as string) as string[]),
      answer: opt(r.answer as string | null),
      status: r.status as NotificationStatus,
      createdAt: r.created_at as number,
      deliveredAt: opt(r.delivered_at as number | null),
      heardAt: opt(r.heard_at as number | null),
      readAt: opt(r.read_at as number | null),
      dismissedAt: opt(r.dismissed_at as number | null),
      expiresAt: opt(r.expires_at as number | null),
    };
  }

  private deliveryFromRow(r: Record<string, string | number | null>): NotificationDelivery {
    const opt = <T>(value: T | null): T | undefined => (value === null ? undefined : value);
    return {
      notificationId: r.notification_id as number,
      clientId: r.client_id as string,
      route: r.route as DeliveryRoute,
      state: r.state as DeliveryState,
      at: r.at as number,
      until: opt(r.until as number | null),
      takenAt: opt(r.taken_at as number | null),
    };
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
        "INSERT INTO turns (at, client_id, kind, outcome, error, speech_ms, stt_ms, agent_ms, first_audio_ms, total_ms, heard, started_by, speaker, handed_over) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.at, t.clientId, t.kind, t.outcome, t.error ?? null, t.speechMs ?? null, t.sttMs ?? null, t.agentMs ?? null,
        t.firstAudioMs ?? null, t.totalMs, t.heard ? 1 : 0, t.startedBy ?? null, t.speaker ?? null, t.handedOver ? 1 : null);
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
      ...(r.started_by ? { startedBy: r.started_by as NonNullable<TurnRecord["startedBy"]> } : {}),
      ...(r.speaker ? { speaker: r.speaker } : {}),
      ...(r.handed_over ? { handedOver: true } : {}),
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

  addWake(w: WakeRecord): void {
    this.db
      .prepare("INSERT INTO wakes (at, client_id, word, score, level, outcome) VALUES (?, ?, ?, ?, ?, ?)")
      .run(w.at, w.clientId, w.word, w.score, w.level, w.outcome);
  }

  /** Wake words reported since `from`, newest first. */
  wakesSince(from: number, limit = 500): WakeRecord[] {
    const rows = this.db.prepare("SELECT * FROM wakes WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?").all(from, limit) as unknown as {
      at: number;
      client_id: string;
      word: string;
      score: number;
      level: number;
      outcome: WakeRecord["outcome"];
    }[];
    return rows.map((r) => ({ at: r.at, clientId: r.client_id, word: r.word, score: r.score, level: r.level, outcome: r.outcome }));
  }

  // --- voices ---------------------------------------------------------------

  listVoices(): VoiceRecord[] {
    const rows = this.db
      .prepare(
        "SELECT v.id, v.name, v.created_at, COUNT(s.id) AS samples, COALESCE(SUM(s.seconds), 0) AS seconds " +
          "FROM voices v LEFT JOIN voice_samples s ON s.voice_id = v.id GROUP BY v.id ORDER BY v.id",
      )
      .all() as { id: number; name: string; created_at: number; samples: number; seconds: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, samples: r.samples, seconds: Math.round(r.seconds * 10) / 10 }));
  }

  /** Adds a voice by name. Undefined when the name is taken. */
  addVoice(name: string): VoiceRecord | undefined {
    if (this.db.prepare("SELECT 1 FROM voices WHERE name = ? COLLATE NOCASE").get(name)) return undefined;
    const at = this.now();
    const id = Number(this.db.prepare("INSERT INTO voices (name, created_at) VALUES (?, ?)").run(name, at).lastInsertRowid);
    return { id, name, createdAt: at, samples: 0, seconds: 0 };
  }

  removeVoice(id: number): boolean {
    return this.db.prepare("DELETE FROM voices WHERE id = ?").run(id).changes > 0;
  }

  addVoiceSample(voiceId: number, embedding: Float32Array, seconds: number, source: string): number | undefined {
    if (!this.db.prepare("SELECT 1 FROM voices WHERE id = ?").get(voiceId)) return undefined;
    const blob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    return Number(
      this.db
        .prepare("INSERT INTO voice_samples (voice_id, embedding, seconds, source, at) VALUES (?, ?, ?, ?, ?)")
        .run(voiceId, blob, seconds, source, this.now()).lastInsertRowid,
    );
  }

  removeVoiceSample(id: number): boolean {
    return this.db.prepare("DELETE FROM voice_samples WHERE id = ?").run(id).changes > 0;
  }

  /** Every recording's voiceprint, oldest first, for one voice or all. */
  voiceSamples(voiceId?: number): VoiceSample[] {
    const rows = (
      voiceId === undefined
        ? this.db.prepare("SELECT * FROM voice_samples ORDER BY id").all()
        : this.db.prepare("SELECT * FROM voice_samples WHERE voice_id = ? ORDER BY id").all(voiceId)
    ) as { id: number; voice_id: number; embedding: Uint8Array; seconds: number; source: string; at: number }[];
    return rows.map((r) => {
      const bytes = Uint8Array.from(r.embedding);
      return { id: r.id, voiceId: r.voice_id, embedding: new Float32Array(bytes.buffer), seconds: r.seconds, source: r.source, at: r.at };
    });
  }

  addTask(t: TaskRecord): void {
    this.db
      .prepare("INSERT INTO tasks (at, task_id, title, note, done, total, ending, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.at, t.taskId, t.title, t.note, t.done ?? null, t.total ?? null, t.ending, t.startedAt);
  }

  /** Tasks that are over, the latest first. */
  tasksEnded(limit = 50): TaskRecord[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY at DESC, id DESC LIMIT ?").all(limit) as unknown as {
      at: number;
      task_id: string;
      title: string;
      note: string;
      done: number | null;
      total: number | null;
      ending: TaskRecord["ending"];
      started_at: number;
    }[];
    return rows.map((r) => ({
      at: r.at,
      taskId: r.task_id,
      title: r.title,
      note: r.note,
      ...(r.done !== null ? { done: r.done } : {}),
      ...(r.total !== null ? { total: r.total } : {}),
      ending: r.ending,
      startedAt: r.started_at,
    }));
  }

  /** Clients a notification can be sent to. */
  pushClientIds(): string[] {
    return (this.db.prepare("SELECT client_id FROM push_subscriptions").all() as { client_id: string }[]).map((r) => r.client_id);
  }

  /** How many clients have a push subscription. */
  pushSubscriptionCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n);
  }

  /** Removes turns, events, wake reports and ended tasks older than `before`. */
  pruneActivity(before: number): void {
    this.db.prepare("DELETE FROM tasks WHERE at < ?").run(before);
    this.db.prepare("DELETE FROM wakes WHERE at < ?").run(before);
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

  // --- agent tokens ------------------------------------------------------------

  addAgentToken(name: string, tokenHash: string): number {
    return Number(this.db.prepare("INSERT INTO agent_tokens (name, token_hash, created_at) VALUES (?, ?, ?)").run(name, tokenHash, this.now()).lastInsertRowid);
  }

  listAgentTokens(): AgentTokenRecord[] {
    const rows = this.db.prepare("SELECT id, name, created_at, last_used_at FROM agent_tokens ORDER BY id").all() as unknown as {
      id: number;
      name: string;
      created_at: number;
      last_used_at: number | null;
    }[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  findAgentToken(tokenHash: string): AgentTokenRecord | undefined {
    const r = this.db.prepare("SELECT id, name, created_at, last_used_at FROM agent_tokens WHERE token_hash = ?").get(tokenHash) as
      | { id: number; name: string; created_at: number; last_used_at: number | null }
      | undefined;
    return r ? { id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at } : undefined;
  }

  touchAgentToken(id: number): void {
    this.db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").run(this.now(), id);
  }

  removeAgentToken(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM agent_tokens WHERE id = ?").run(id).changes) === 1;
  }

  // --- push subscriptions ---------------------------------------------------

  getPushSubscription(clientId: string): { endpoint: string; p256dh: string; auth: string } | undefined {
    return this.db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE client_id = ?").get(clientId) as
      | { endpoint: string; p256dh: string; auth: string }
      | undefined;
  }

  /** Saves a client's subscription, replacing any earlier one; undefined forgets it. */
  setPushSubscription(clientId: string, subscription: { endpoint: string; p256dh: string; auth: string } | undefined): void {
    if (!subscription) {
      this.db.prepare("DELETE FROM push_subscriptions WHERE client_id = ?").run(clientId);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO push_subscriptions (client_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(client_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at",
      )
      .run(clientId, subscription.endpoint, subscription.p256dh, subscription.auth, Date.now());
  }

  // --- settings -----------------------------------------------------------

  settingsVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'settings_version'").get() as { value: string };
    return Number(row.value);
  }

  /** Marks the settings as changed, so every client takes them again. Used when what a client is sent changes without an edit, as at the start and end of quiet hours. */
  touchSettings(): number {
    return this.bumpSettingsVersion();
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
