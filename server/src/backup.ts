import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, readdir, rename, rm, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Activity } from "./activity.js";
import type { Config } from "./config.js";
import type { Store } from "./store.js";

/**
 * Copies Axis's data to a second folder on a schedule: the database, as a
 * whole and checked snapshot, and the firmware and wake word files as they
 * are. The folder is one the host mounts into the container beside the data
 * folder (`AXIS_BACKUP_DIR`); with none given there is no backup.
 *
 * The database is first copied to a file beside itself with SQLite's own
 * backup, which is safe while Axis writes, and checked there. Only then is it
 * sent to the backup folder, and everything that touches that folder is
 * asynchronous: it is usually network storage, and a slow share must never
 * hold up a turn.
 *
 *   <backup folder>/axis.sqlite              the latest copy
 *   <backup folder>/daily/axis-YYYY-MM-DD.sqlite   one a day, kept a while
 *   <backup folder>/firmware, wakewords      mirrors
 */

/** The folders of files that are mirrored as they are. */
const MIRRORED = ["firmware", "wakewords"];
const META_KEY = "backup_status";
const DAILY = /^axis-(\d{4}-\d{2}-\d{2})\.sqlite$/;

export interface BackupStatus {
  at: number;
  ok: boolean;
  /** How long it took. */
  ms: number;
  /** Size of the database copy. */
  bytes?: number;
  error?: string;
}

export interface BackupOptions {
  store: Store;
  /** Read each time, so a change made on the admin page is followed without a restart. */
  config: Pick<Config, "dataDir" | "backupDir" | "backupEveryHours" | "backupKeepDays">;
  activity?: Activity | undefined;
  log?: (line: string) => void;
  now?: () => number;
}

export class Backup {
  private readonly now: () => number;
  private running: Promise<BackupStatus> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: BackupOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Looks once a minute whether a copy is due. */
  start(): void {
    this.timer = setInterval(() => {
      if (this.due()) void this.run();
    }, 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  last(): BackupStatus | undefined {
    const saved = this.options.store.getMeta(META_KEY);
    return saved ? (JSON.parse(saved) as BackupStatus) : undefined;
  }

  private due(): boolean {
    const { backupDir, backupEveryHours } = this.options.config;
    if (!backupDir || backupEveryHours <= 0 || this.running) return false;
    const last = this.last();
    return !last || this.now() - last.at >= backupEveryHours * 3_600_000;
  }

  /** Everything the admin page shows about the backup. */
  status() {
    const { backupDir, backupEveryHours, backupKeepDays } = this.options.config;
    const last = this.last();
    // Late by a whole interval, or by a quarter of an hour on top of one: something is stopping it.
    const allowed = backupEveryHours * 3_600_000 + Math.max(15 * 60_000, backupEveryHours * 3_600_000);
    return {
      configured: Boolean(backupDir),
      dir: backupDir ?? null,
      everyHours: backupEveryHours,
      keepDays: backupKeepDays,
      running: Boolean(this.running),
      last: last ?? null,
      overdue: Boolean(backupDir) && backupEveryHours > 0 && Boolean(last) && this.now() - last!.at > allowed,
    };
  }

  /** Makes a copy now. A second call while one is running waits for that one. */
  run(): Promise<BackupStatus> {
    this.running ??= this.copy().finally(() => (this.running = undefined));
    return this.running;
  }

  private async copy(): Promise<BackupStatus> {
    const { store, config, activity } = this.options;
    const log = this.options.log ?? (() => {});
    const started = this.now();
    let status: BackupStatus;
    const snapshot = join(config.dataDir, "axis-backup.tmp");
    try {
      const dir = config.backupDir;
      if (!dir) throw new Error("no backup folder is set up");
      if (config.dataDir === ":memory:") throw new Error("there is no data folder to copy");
      await mkdir(join(dir, "daily"), { recursive: true });

      await rm(snapshot, { force: true });
      await store.backupTo(snapshot);
      // The copy is checked before it replaces the last good one.
      const copy = new DatabaseSync(snapshot, { readOnly: true });
      try {
        const verdict = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
        if (verdict !== "ok") throw new Error(`the copy of the database failed its check: ${verdict}`);
      } finally {
        copy.close();
      }
      const bytes = (await stat(snapshot)).size;

      // Written under another name and moved into place, so a copy cut short never stands where a whole one did.
      await cp(snapshot, join(dir, "axis.sqlite.part"));
      await rename(join(dir, "axis.sqlite.part"), join(dir, "axis.sqlite"));
      const today = join(dir, "daily", `axis-${new Date(started).toISOString().slice(0, 10)}.sqlite`);
      if (!(await exists(today))) await cp(snapshot, today);
      // Copies hold the same keys and token hashes as the file itself: for this user only, where the folder allows it.
      for (const copy of [join(dir, "axis.sqlite"), today]) await chmod(copy, 0o600).catch(() => undefined);
      const oldest = new Date(started - Math.max(1, config.backupKeepDays) * 86_400_000).toISOString().slice(0, 10);
      for (const name of await readdir(join(dir, "daily"))) {
        const day = DAILY.exec(name)?.[1];
        if (day && day < oldest) await rm(join(dir, "daily", name), { force: true });
      }

      for (const part of MIRRORED) await mirror(join(config.dataDir, part), join(dir, part));
      status = { at: this.now(), ok: true, ms: this.now() - started, bytes };
    } catch (error) {
      status = { at: this.now(), ok: false, ms: this.now() - started, error: (error as Error).message.slice(0, 300) };
    } finally {
      await rm(snapshot, { force: true }).catch(() => undefined);
    }
    try {
      store.setMeta(META_KEY, JSON.stringify(status));
    } catch {
      // Axis is shutting down under us; the next start makes a copy.
    }
    log(status.ok ? `backup: copied to ${config.backupDir} in ${status.ms} ms` : `backup: failed: ${status.error}`);
    // Only a change is worth a line in the events: an hourly "it worked" would bury everything else.
    activity?.state("backup", "", status.ok ? "ok" : "failed", status.ok ? `Backup working: copied to ${config.backupDir}` : `Backup failed: ${status.error}`, status.ok ? "info" : "bad");
    return status;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Makes `to` hold the same files as `from`: copies what is new or changed, removes what is gone. */
async function mirror(from: string, to: string): Promise<void> {
  if (!(await exists(from))) return;
  await mkdir(to, { recursive: true });
  const [have, want] = await Promise.all([readdir(to, { withFileTypes: true }), readdir(from, { withFileTypes: true })]);
  const wanted = new Set(want.map((entry) => entry.name));
  for (const entry of have) {
    if (!wanted.has(entry.name)) await rm(join(to, entry.name), { recursive: true, force: true });
  }
  for (const entry of want) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await mirror(source, target);
      continue;
    }
    if (!entry.isFile()) continue;
    const [a, b] = await Promise.all([stat(source), stat(target).catch(() => undefined)]);
    // Same size and not older: it is the file already there.
    if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue;
    await cp(source, `${target}.part`);
    await rename(`${target}.part`, target);
  }
}
