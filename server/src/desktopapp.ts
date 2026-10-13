import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Hub, Session } from "./hub.js";

/** The client type of the Windows desktop app, as it introduces itself. */
export const DESKTOP_TYPE = "windows-desktop";

export interface DesktopBuild {
  version: string;
  size: number;
  sha256: string;
  /** Where computers fetch it, on Axis. */
  path: string;
  /** The program file on this machine. */
  file: string;
  builtAt?: string;
}

/** "0.5.1" > "0.5.0"; anything that is not numbers compares as older, so it never blocks an update. */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * The desktop app build in the data folder (`desktop/`, put there by scripts/build-desktop.sh), and keeping
 * computers on it: a computer that connects with an older version, or is connected when a newer build lands,
 * is told to update itself unless its "Update automatically" setting is off.
 */
export class DesktopApp {
  private readonly cached = new Map<string, { key: string; build: DesktopBuild }>();
  /** Version last offered to each computer, so a computer that refuses is not asked again every minute. */
  private offered = new Map<string, string>();

  constructor(
    private readonly dataDir: string,
    private readonly hub: Hub,
    private readonly log: (line: string) => void = (line) => console.log(line),
    /** Where a release image keeps the build it came with (`bundled/desktop`). */
    private readonly bundledDir?: string,
  ) {}

  /** The folders a build may be in: one built on this hub (scripts/build-desktop.sh), and the one the image came with. */
  private folders(): string[] {
    return [join(this.dataDir, "desktop"), ...(this.bundledDir ? [join(this.bundledDir, "desktop")] : [])];
  }

  /** The program file of the current build. */
  get exe(): string {
    return this.build()?.file ?? join(this.dataDir, "desktop", "VortexAxisDesktop.exe");
  }

  /** The current build: the newer of the hub's own and the image's, or undefined when there is neither. */
  build(): DesktopBuild | undefined {
    let best: DesktopBuild | undefined;
    for (const folder of this.folders()) {
      const found = this.read(folder);
      if (found && (!best || newer(found.version, best.version))) best = found;
    }
    return best;
  }

  private read(folder: string): DesktopBuild | undefined {
    try {
      const file = join(folder, "VortexAxisDesktop.exe");
      const stat = statSync(file);
      const key = `${file}:${stat.size}:${stat.mtimeMs}`;
      const known = this.cached.get(folder);
      if (known?.key === key) return known.build;
      const info = JSON.parse(readFileSync(join(folder, "version.json"), "utf8")) as { version?: unknown; builtAt?: unknown };
      if (typeof info.version !== "string") return undefined;
      const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      const build: DesktopBuild = {
        version: info.version,
        size: stat.size,
        sha256,
        path: "/v1/desktop/app",
        file,
        ...(typeof info.builtAt === "string" ? { builtAt: info.builtAt } : {}),
      };
      this.cached.set(folder, { key, build });
      return build;
    } catch {
      return undefined;
    }
  }

  /** Watches connections, and looks again every few minutes for a newer build. Returns the stop. */
  start(): () => void {
    let stopped = false;
    const waiting = new Set<NodeJS.Timeout>();
    const check = (session: Session) => {
      if (!stopped) void this.check(session).catch(() => {});
    };
    this.hub.onConnect((session) => {
      // After the hello, so the computer has its settings first.
      const timer = setTimeout(() => {
        waiting.delete(timer);
        check(session);
      }, 1000);
      timer.unref();
      waiting.add(timer);
    });
    const timer = setInterval(() => {
      for (const session of this.hub.sessions()) check(session);
    }, 5 * 60_000);
    timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
      for (const t of waiting) clearTimeout(t);
    };
  }

  /** Tells one computer to update, if it is behind and has not switched that off. */
  async check(session: Session): Promise<void> {
    if (session.client.type !== DESKTOP_TYPE) return;
    const auto = this.hub.settings(session).autoUpdate;
    if (auto === 0 || auto === false || auto === "0") return;
    const build = this.build();
    if (!build || !newer(build.version, session.client.version)) return;
    if (this.offered.get(session.client.id) === build.version) return;
    this.offered.set(session.client.id, build.version);
    try {
      await this.update(session);
    } catch (error) {
      this.log(`desktop app: ${session.client.name} did not take ${build.version}: ${(error as Error).message}`);
    }
  }

  /** Sends the update command. Resolves once the computer says it has the new app and is restarting. */
  async update(session: Session): Promise<{ from: string; to: string }> {
    const build = this.build();
    if (!build) throw new Error("the desktop app has not been built on this hub");
    const outcome = await this.hub.command(
      session,
      "update",
      { version: build.version, size: build.size, sha256: build.sha256, path: build.path },
      120_000,
    );
    if (!outcome.ok) throw new Error(outcome.error ?? "refused");
    this.log(`desktop app: ${session.client.name} updating from ${session.client.version} to ${build.version}`);
    return { from: session.client.version, to: build.version };
  }
}
