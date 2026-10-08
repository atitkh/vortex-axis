import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A firmware build Axis holds for one client type, ready to hand to devices of that type. */
export interface FirmwareInfo {
  type: string;
  version: string;
  size: number;
  /** MD5 of the file, which is what the ESP32 updater checks a download against. */
  md5: string;
  uploadedAt: number;
}

export const MAX_FIRMWARE_BYTES = 8 * 1024 * 1024;
const TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/**
 * Firmware files kept in the data folder, one per client type: the newest
 * build somebody uploaded. Devices fetch theirs over plain HTTP with their
 * own token when Axis tells them to update.
 */
export class FirmwareStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir === ":memory:" ? join(tmpdir(), `vortex-axis-firmware-${process.pid}`) : dataDir, "firmware");
  }

  list(): FirmwareInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.info(name.slice(0, -5)))
      .filter((info): info is FirmwareInfo => Boolean(info))
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  info(type: string): FirmwareInfo | undefined {
    if (!TYPE.test(type)) return undefined;
    try {
      const info = JSON.parse(readFileSync(join(this.dir, `${type}.json`), "utf8")) as FirmwareInfo;
      return statSync(this.path(type)).size === info.size ? info : undefined;
    } catch {
      return undefined;
    }
  }

  /** Where the file for a type is. Only meaningful when `info(type)` returned something. */
  path(type: string): string {
    return join(this.dir, `${type}.bin`);
  }

  /** Keeps a build for a type, replacing the one before. Throws with a reason when it is not usable. */
  save(type: string, version: string, data: Buffer, now = Date.now()): FirmwareInfo {
    if (!TYPE.test(type)) throw new Error("client type must be letters, digits, dot, dash or underscore");
    if (!VERSION.test(version)) throw new Error("version must be 1 to 32 letters, digits, dots, plus or dash");
    if (data.length < 64 * 1024) throw new Error("that file is too small to be firmware");
    if (data.length > MAX_FIRMWARE_BYTES) throw new Error("firmware can be at most 8 MB");
    // Every ESP32 application image starts with this byte. It catches a wrong file, not a wrong board.
    if (data[0] !== 0xe9) throw new Error("that is not an ESP32 application image (use firmware.bin from the build)");
    mkdirSync(this.dir, { recursive: true });
    const info: FirmwareInfo = {
      type,
      version,
      size: data.length,
      md5: createHash("md5").update(data).digest("hex"),
      uploadedAt: now,
    };
    writeFileSync(this.path(type), data);
    writeFileSync(join(this.dir, `${type}.json`), JSON.stringify(info));
    return info;
  }

  remove(type: string): boolean {
    if (!this.info(type)) return false;
    rmSync(this.path(type), { force: true });
    rmSync(join(this.dir, `${type}.json`), { force: true });
    return true;
  }
}
