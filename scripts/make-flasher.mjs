// Puts together the browser flasher: the page, a board's factory image and the manifest ESP Web Tools reads.
//   node scripts/make-flasher.mjs <board folder, built> <output folder>
// The board must have been built (pio run) so that its factory image exists.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [board, out] = process.argv.slice(2);
if (!board || !out) {
  console.error("usage: node scripts/make-flasher.mjs <board folder> <output folder>");
  process.exit(2);
}
const builds = join(board, ".pio", "build");
const env = existsSync(builds) ? readdirSync(builds).find((name) => existsSync(join(builds, name, "firmware.factory.bin"))) : undefined;
if (!env) {
  console.error(`no factory image under ${builds}: run pio run in ${board} first`);
  process.exit(1);
}
const version = /#define AXIS_FIRMWARE_VERSION "(.*)"/.exec(readFileSync(join(root, "firmware/common/src/axis_client.h"), "utf8"))?.[1];
if (!version) {
  console.error("could not read AXIS_FIRMWARE_VERSION");
  process.exit(1);
}
mkdirSync(out, { recursive: true });
for (const name of ["index.html", "flash.js"]) copyFileSync(join(root, "flasher", name), join(out, name));
// The installer's own files, fetched by scripts/fetch-esp-web-tools.mjs.
const tools = join(root, "flasher", "esp-web-tools");
if (!existsSync(join(tools, "install-button.js"))) {
  console.error("flasher/esp-web-tools is empty: run node scripts/fetch-esp-web-tools.mjs first");
  process.exit(1);
}
cpSync(tools, join(out, "esp-web-tools"), { recursive: true });
copyFileSync(join(builds, env, "firmware.factory.bin"), join(out, "firmware-factory.bin"));
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      name: "Waveshare ESP32-S3-Touch-AMOLED-1.8",
      version,
      // The person is asked whether to wipe the board first: yes for a board that ran something else,
      // no to keep a VorteX Axis board's Wi-Fi and pairing.
      new_install_prompt_erase: true,
      new_install_improv_wait_time: 0,
      builds: [{ chipFamily: "ESP32-S3", parts: [{ path: "firmware-factory.bin", offset: 0 }] }],
    },
    null,
    2,
  ) + "\n",
);
console.log(`flasher for firmware ${version} in ${out}`);
