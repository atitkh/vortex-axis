import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { newer } from "./desktopapp.js";
import type { Hub, Session } from "./hub.js";

/** The client type of the Quest panel client, as it introduces itself. */
export const QUEST_TYPE = "quest-panels";

export interface QuestBuild {
  version: string;
  size: number;
  sha256: string;
  /** Where headsets fetch it, on Axis. */
  path: string;
  /** The APK on this machine. */
  file: string;
  builtAt?: string;
}

/**
 * The Quest panel client's build in the data folder (`quest/`, put there by scripts/build-quest-client.sh), and
 * keeping headsets on it, as `DesktopApp` does for computers: a headset that connects with an older version, or
 * is connected when a newer build lands, is told to update itself unless its "Update automatically" setting is
 * off. Never an older build: a headset already on the build's version or a newer one is not asked.
 */
export class QuestApp {
  private readonly cached = new Map<string, { key: string; build: QuestBuild }>();
  /** Version last offered to each headset, so a headset that refuses is not asked again every few minutes. */
  private offered = new Map<string, string>();

  constructor(
    private readonly dataDir: string,
    private readonly hub: Hub,
    private readonly log: (line: string) => void = (line) => console.log(line),
    /** Where a release image keeps the build it came with (`bundled/quest`). */
    private readonly bundledDir?: string,
  ) {}

  private folders(): string[] {
    return [join(this.dataDir, "quest"), ...(this.bundledDir ? [join(this.bundledDir, "quest")] : [])];
  }

  /** The current build: the newer of the hub's own and the image's, or undefined when there is neither. */
  build(): QuestBuild | undefined {
    let best: QuestBuild | undefined;
    for (const folder of this.folders()) {
      const found = this.read(folder);
      if (found && (!best || newer(found.version, best.version))) best = found;
    }
    return best;
  }

  private read(folder: string): QuestBuild | undefined {
    try {
      const file = join(folder, "quest-client.apk");
      const stat = statSync(file);
      const key = `${file}:${stat.size}:${stat.mtimeMs}`;
      const known = this.cached.get(folder);
      if (known?.key === key) return known.build;
      const info = JSON.parse(readFileSync(join(folder, "version.json"), "utf8")) as { version?: unknown; builtAt?: unknown };
      if (typeof info.version !== "string") return undefined;
      const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      const build: QuestBuild = {
        version: info.version,
        size: stat.size,
        sha256,
        path: "/v1/quest/app",
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
      // After the hello, so the headset has its settings first.
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

  /** Tells one headset to update, if it is behind and has not switched that off. */
  async check(session: Session): Promise<void> {
    if (session.client.type !== QUEST_TYPE) return;
    const auto = this.hub.settings(session).autoUpdate;
    if (auto === 0 || auto === false || auto === "0") return;
    const build = this.build();
    if (!build || !newer(build.version, session.client.version)) return;
    if (this.offered.get(session.client.id) === build.version) return;
    this.offered.set(session.client.id, build.version);
    try {
      await this.update(session);
    } catch (error) {
      this.log(`quest app: ${session.client.name} did not take ${build.version}: ${(error as Error).message}`);
    }
  }

  /** Sends the update command. Resolves once the headset says it has the new app and is installing it. */
  async update(session: Session): Promise<{ from: string; to: string }> {
    const build = this.build();
    if (!build) throw new Error("the Quest app has not been built on this hub");
    if (!newer(build.version, session.client.version)) {
      throw new Error(`it is on ${session.client.version}, and the hub's build is ${build.version}; never an older one`);
    }
    const outcome = await this.hub.command(
      session,
      "update",
      { version: build.version, size: build.size, sha256: build.sha256, path: build.path },
      120_000,
    );
    if (!outcome.ok) throw new Error(outcome.error ?? "refused");
    this.log(`quest app: ${session.client.name} updating from ${session.client.version} to ${build.version}`);
    return { from: session.client.version, to: build.version };
  }
}
