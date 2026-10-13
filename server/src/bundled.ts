import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newer } from "./desktopapp.js";
import type { FirmwareStore } from "./firmware.js";

/** One firmware build a release image came with (`bundled/firmware/manifest.json`). */
interface BundledFirmware {
  type: string;
  version: string;
  file: string;
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
    const kept = store.shelf(entry.type).builds.map((b) => b.version);
    if (kept.some((v) => v === entry.version || newer(v, entry.version))) continue;
    try {
      store.save(entry.type, entry.version, readFileSync(join(bundledDir, "firmware", entry.file)));
      taken.push(`${entry.type} ${entry.version}`);
      log(`firmware: ${entry.type} ${entry.version} from the image is now current`);
    } catch (error) {
      log(`firmware: ${entry.type} ${entry.version} from the image could not be kept: ${(error as Error).message}`);
    }
  }
  return taken;
}
