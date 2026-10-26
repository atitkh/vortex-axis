// Board firmware versions are counted per board type. A board folder that counts its own sets
// `-D AXIS_FIRMWARE_VERSION=\"x.y.z\"` in its platformio.ini; otherwise it has the client core's default
// in firmware/common/src/axis_client.h (the Waveshare 1.8's).
//   node scripts/firmware-version.mjs <board folder>     prints that board's version
//   node scripts/firmware-version.mjs --name <board folder>   prints the board's name (platformio.ini's first line)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The version a board folder (a path, or a type such as "waveshare-amoled-1.8") builds. */
export function firmwareVersion(board) {
  const dir = existsSync(board) ? board : join(root, "firmware", board);
  const ini = join(dir, "platformio.ini");
  const own = existsSync(ini) ? /AXIS_FIRMWARE_VERSION=\\?"([^"\\]+)\\?"/.exec(readFileSync(ini, "utf8"))?.[1] : undefined;
  if (own) return own;
  const common = /#define AXIS_FIRMWARE_VERSION "(.*?)"/.exec(readFileSync(join(root, "firmware/common/src/axis_client.h"), "utf8"))?.[1];
  if (!common) throw new Error("could not read AXIS_FIRMWARE_VERSION");
  return common;
}

/** The board's name for people, from the first line of its platformio.ini ("; Waveshare ESP32-S3-Touch-AMOLED-1.8 (...)"). */
export function boardName(board) {
  const dir = existsSync(board) ? board : join(root, "firmware", board);
  const first = readFileSync(join(dir, "platformio.ini"), "utf8").split("\n")[0] ?? "";
  return first.replace(/^;\s*/, "").replace(/\s*\(.*$/, "").trim() || basename(resolve(dir));
}

/** Every board folder in firmware/, by type. */
export function boardTypes() {
  return readdirSync(join(root, "firmware"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, "firmware", e.name, "platformio.ini")))
    .map((e) => e.name)
    .sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const name = args[0] === "--name";
  const board = name ? args[1] : args[0];
  if (!board) {
    console.error("usage: node scripts/firmware-version.mjs [--name] <board folder>");
    process.exit(2);
  }
  console.log(name ? boardName(board) : firmwareVersion(board));
}
