import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A firmware build Axis holds for one client type. */
export interface FirmwareInfo {
  type: string;
  version: string;
  size: number;
  /** MD5 of the file, which is what the ESP32 updater checks a download against. */
  md5: string;
  uploadedAt: number;
}

/** Everything held for one client type: its builds, newest first, and the one devices are sent. */
export interface FirmwareShelf {
  type: string;
  /** The version devices are told to install. Undefined when the type has no builds. */
  current: string | undefined;
  builds: FirmwareInfo[];
}

export const MAX_FIRMWARE_BYTES = 8 * 1024 * 1024;
/** Builds kept per type. The oldest go first; the current one is never dropped. */
export const KEPT_BUILDS = 5;
const TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/**
 * Firmware files kept in the data folder: for each client type the last few
 * builds somebody uploaded, one of them marked as current. Devices fetch the
 * current one over HTTP with their own token when Axis tells them to update.
 * Keeping older builds is what makes going back possible: mark an older one
 * current and update again.
 *
 * On disk: `firmware/<type>/<version>.bin`, `<version>.json` beside it, and
 * `current` holding a version.
 */
export class FirmwareStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir === ":memory:" ? join(tmpdir(), `vortex-axis-firmware-${process.pid}`) : dataDir, "firmware");
    this.adoptOldLayout();
  }

  /** Before builds were kept per version there was one `<type>.bin` per type. Move those in. */
  private adoptOldLayout(): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const type = name.slice(0, -5);
      try {
        const info = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as FirmwareInfo;
        if (!TYPE.test(type) || !VERSION.test(info.version)) continue;
        mkdirSync(join(this.dir, type), { recursive: true });
        renameSync(join(this.dir, `${type}.bin`), this.path(type, info.version));
        renameSync(join(this.dir, name), join(this.dir, type, `${info.version}.json`));
        writeFileSync(join(this.dir, type, "current"), info.version);
      } catch {
        // A half-written upload from before: leave it, it is not listed.
      }
    }
  }

  /** Every type with at least one build. */
  shelves(): FirmwareShelf[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && TYPE.test(entry.name))
      .map((entry) => this.shelf(entry.name))
      .filter((shelf) => shelf.builds.length > 0)
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  shelf(type: string): FirmwareShelf {
    if (!TYPE.test(type) || !existsSync(join(this.dir, type))) return { type, current: undefined, builds: [] };
    const builds = readdirSync(join(this.dir, type))
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.build(type, name.slice(0, -5)))
      .filter((info): info is FirmwareInfo => Boolean(info))
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
    let current: string | undefined;
    try {
      current = readFileSync(join(this.dir, type, "current"), "utf8").trim();
    } catch {
      current = undefined;
    }
    // A current that points at nothing falls back to the newest build.
    if (!builds.some((b) => b.version === current)) current = builds[0]?.version;
    return { type, current, builds };
  }

  /** One build, or undefined when it is not there or its file does not match its record. */
  build(type: string, version: string): FirmwareInfo | undefined {
    if (!TYPE.test(type) || !VERSION.test(version)) return undefined;
    try {
      const info = JSON.parse(readFileSync(join(this.dir, type, `${version}.json`), "utf8")) as FirmwareInfo;
      return statSync(this.path(type, version)).size === info.size ? info : undefined;
    } catch {
      return undefined;
    }
  }

  /** The build devices of this type are sent. */
  info(type: string): FirmwareInfo | undefined {
    const current = this.shelf(type).current;
    return current ? this.build(type, current) : undefined;
  }

  /** Where a build's file is. Only meaningful when `build(type, version)` returned something. */
  path(type: string, version: string): string {
    return join(this.dir, type, `${version}.bin`);
  }

  /**
   * Keeps a build and makes it the current one. A build of the same version
   * is replaced. Throws with a reason when the file is not usable.
   */
  save(type: string, version: string, data: Buffer, now = Date.now()): FirmwareInfo {
    if (!TYPE.test(type)) throw new Error("client type must be letters, digits, dot, dash or underscore");
    if (!VERSION.test(version)) throw new Error("version must be 1 to 32 letters, digits, dots, plus or dash");
    if (data.length < 64 * 1024) throw new Error("that file is too small to be firmware");
    if (data.length > MAX_FIRMWARE_BYTES) throw new Error("firmware can be at most 8 MB");
    // Every ESP32 application image starts with this byte. It catches a wrong file, not a wrong board.
    if (data[0] !== 0xe9) throw new Error("that is not an ESP32 application image (use firmware.bin from the build)");
    mkdirSync(join(this.dir, type), { recursive: true });
    const info: FirmwareInfo = {
      type,
      version,
      size: data.length,
      md5: createHash("md5").update(data).digest("hex"),
      uploadedAt: now,
    };
    writeFileSync(this.path(type, version), data);
    writeFileSync(join(this.dir, type, `${version}.json`), JSON.stringify(info));
    writeFileSync(join(this.dir, type, "current"), version);
    for (const old of this.shelf(type).builds.slice(KEPT_BUILDS)) this.removeBuild(type, old.version);
    return info;
  }

  /** Where a build's factory image is kept: the whole flash for a new board, written at offset 0 by cable. */
  factoryPath(type: string, version: string): string {
    return join(this.dir, type, `${version}.factory`);
  }

  /**
   * Keeps the factory image that goes with a build already on the shelf (bootloader, partitions and that
   * application in one file), for the flasher page. Throws with a reason when it is not usable.
   */
  saveFactory(type: string, version: string, data: Buffer): void {
    if (!this.build(type, version)) throw new Error("upload the build itself first: there is no such version on the shelf");
    if (data.length < 64 * 1024) throw new Error("that file is too small to be a factory image");
    if (data.length > MAX_FIRMWARE_BYTES) throw new Error("a factory image can be at most 8 MB");
    // It starts with the bootloader, an ESP32 image like any other.
    if (data[0] !== 0xe9) throw new Error("that is not an ESP32 image (use firmware.factory.bin from the build)");
    writeFileSync(this.factoryPath(type, version), data);
  }

  /** The current build of a type, when its factory image is here too: what the flasher page installs. */
  factory(type: string): { type: string; version: string; size: number } | undefined {
    const info = this.info(type);
    if (!info) return undefined;
    try {
      return { type, version: info.version, size: statSync(this.factoryPath(type, info.version)).size };
    } catch {
      return undefined;
    }
  }

  /** Chooses which build devices are sent. False when there is no such build. */
  setCurrent(type: string, version: string): boolean {
    if (!this.build(type, version)) return false;
    writeFileSync(join(this.dir, type, "current"), version);
    return true;
  }

  /** Removes one build. When it was the current one, the newest that is left takes its place. */
  removeBuild(type: string, version: string): boolean {
    if (!this.build(type, version)) return false;
    rmSync(this.path(type, version), { force: true });
    rmSync(join(this.dir, type, `${version}.json`), { force: true });
    rmSync(this.factoryPath(type, version), { force: true });
    const left = this.shelf(type);
    if (!left.builds.length) rmSync(join(this.dir, type), { recursive: true, force: true });
    else if (left.current) writeFileSync(join(this.dir, type, "current"), left.current);
    return true;
  }

  /** Removes every build of a type. */
  remove(type: string): boolean {
    if (!this.shelf(type).builds.length) return false;
    rmSync(join(this.dir, type), { recursive: true, force: true });
    return true;
  }
}
