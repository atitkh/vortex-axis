// Makes a board's factory image for the flasher: the whole flash in one file, written at offset 0.
//   node scripts/factory-image.mjs <board folder, built> <output file>
//
// PlatformIO's own firmware.factory.bin says in its header that the flash is the size the generic board
// definition has (8 MB), not the size this board is built for (board_build.flash_size in platformio.ini).
// A cable upload corrects that on the way; a browser flasher writes the file as it is, and the board then
// refuses its own partition table ("exceeds flash chip size") and never starts. So the header is set here,
// with esptool, which also renews the image's checksum.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [board, out] = process.argv.slice(2);
if (!board || !out) {
  console.error("usage: node scripts/factory-image.mjs <board folder> <output file>");
  process.exit(2);
}
const builds = join(board, ".pio", "build");
const env = existsSync(builds) ? readdirSync(builds).find((name) => existsSync(join(builds, name, "firmware.factory.bin"))) : undefined;
if (!env) {
  console.error(`no factory image under ${builds}: run pio run in ${board} first`);
  process.exit(1);
}
const size = /^\s*board_build\.flash_size\s*=\s*(\S+)/m.exec(readFileSync(join(board, "platformio.ini"), "utf8"))?.[1];
if (!size) {
  console.error(`${board}/platformio.ini does not say board_build.flash_size`);
  process.exit(1);
}

// esptool: on the path (pip install esptool), or the one PlatformIO brought.
const tools = [
  ["esptool.py"],
  ["esptool"],
  [join(homedir(), ".platformio", "penv", "bin", "esptool.py")],
  ["python3", "-m", "esptool"],
];
const args = ["--chip", "esp32s3", "merge_bin", "--flash_mode", "keep", "--flash_freq", "keep", "--flash_size", size, "-o", out, "0x0", join(builds, env, "firmware.factory.bin")];
let done = false;
for (const [command, ...first] of tools) {
  try {
    execFileSync(command, [...first, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    done = true;
    break;
  } catch (error) {
    if (error.code !== "ENOENT" && error.status !== 127 && !/No module named/.test(String(error.stderr))) {
      console.error(`${command} failed: ${String(error.stderr || error.message).trim()}`);
      process.exit(1);
    }
  }
}
if (!done) {
  console.error("esptool was not found: pip install esptool");
  process.exit(1);
}
// Make sure of it: the fourth byte's upper half is the flash size (4 is 16 MB, 3 is 8 MB, ...).
const SIZES = { "1MB": 0, "2MB": 1, "4MB": 2, "8MB": 3, "16MB": 4, "32MB": 5, "64MB": 6, "128MB": 7 };
const got = readFileSync(out)[3] >> 4;
if (got !== SIZES[size]) {
  console.error(`the image's header still says another flash size (${got}) than ${size}`);
  process.exit(1);
}
console.log(`factory image for ${size} flash: ${out}`);
