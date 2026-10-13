import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newer } from "./desktopapp.js";
import type { FirmwareStore } from "./firmware.js";

/** One firmware build a release image came with (`bundled/firmware/manifest.json`). */
interface BundledFirmware {
  type: string;
  version: string;
  file: string;
  /** The factory image that goes with it, for the flasher page. */
  factory?: string;
}

/**
 * Takes the firmware a release image came with onto the firmware shelves, so a fresh hub can update boards
 * from the start. A bundled build goes in only when it is newer than every build of its type already kept
 * (and so becomes the current one); one uploaded by hand, or newer, is left alone. Devices are not told to
 * update: that stays the person's choice on the admin page. Returns what was taken.
 */
export function importBundledFirmware(bundledDir: string | undefined, store: FirmwareStore, log: (line: string) => void): string[] {
  if (!bundledDir) return [];
  let manifest: BundledFirmware[];
  try {
    manifest = JSON.parse(readFileSync(join(bundledDir, "firmware", "manifest.json"), "utf8")) as BundledFirmware[];
  } catch {
    return [];
  }
  const taken: string[] = [];
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    if (typeof entry?.type !== "string" || typeof entry.version !== "string" || typeof entry.file !== "string" || entry.file.includes("/") || entry.file.includes("..")) continue;
    const safe = (name: unknown): name is string => typeof name === "string" && !name.includes("/") && !name.includes("..");
    const kept = store.shelf(entry.type).builds.map((b) => b.version);
    if (!kept.some((v) => v === entry.version || newer(v, entry.version))) {
      try {
        store.save(entry.type, entry.version, readFileSync(join(bundledDir, "firmware", entry.file)));
        taken.push(`${entry.type} ${entry.version}`);
        log(`firmware: ${entry.type} ${entry.version} from the image is now current`);
      } catch (error) {
        log(`firmware: ${entry.type} ${entry.version} from the image could not be kept: ${(error as Error).message}`);
        continue;
      }
    }
    // Its factory image, for a build that is on the shelf without one (this one, or the same version put there by hand).
    if (safe(entry.factory) && store.build(entry.type, entry.version) && !existsSync(store.factoryPath(entry.type, entry.version))) {
      try {
        store.saveFactory(entry.type, entry.version, readFileSync(join(bundledDir, "firmware", entry.factory)));
      } catch (error) {
        log(`firmware: the factory image for ${entry.type} ${entry.version} could not be kept: ${(error as Error).message}`);
      }
    }
  }
  return taken;
}
