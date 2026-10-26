// Puts together the browser flasher: the page, each board's factory image and the manifests ESP Web Tools reads.
//   node scripts/make-flasher.mjs <board folder, built>... <output folder>
// Each board must have been built (pio run) so that its factory image exists. With more than one board the page
// offers a choice (types.json); the first board is also written as manifest.json, for a page that predates that.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boardName, firmwareVersion } from "./firmware-version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const out = args.pop();
const boards = args;
if (!out || boards.length === 0) {
  console.error("usage: node scripts/make-flasher.mjs <board folder>... <output folder>");
  process.exit(2);
}
for (const board of boards) {
  const builds = join(board, ".pio", "build");
  const env = existsSync(builds) ? readdirSync(builds).find((name) => existsSync(join(builds, name, "firmware.factory.bin"))) : undefined;
  if (!env) {
    console.error(`no factory image under ${builds}: run pio run in ${board} first`);
    process.exit(1);
  }
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

const manifest = (name, version, image) =>
  JSON.stringify(
    {
      name,
      version,
      // The person is asked whether to wipe the board first: yes for a board that ran something else,
      // no to keep a VorteX Axis board's Wi-Fi and pairing.
      new_install_prompt_erase: true,
      new_install_improv_wait_time: 0,
      builds: [{ chipFamily: "ESP32-S3", parts: [{ path: image, offset: 0 }] }],
    },
    null,
    2,
  ) + "\n";

const types = [];
boards.forEach((board, i) => {
  const type = basename(resolve(board));
  const name = boardName(board);
  const version = firmwareVersion(board);
  // Not PlatformIO's file as it is: its header has the wrong flash size (see scripts/factory-image.mjs).
  const image = `firmware-${type}-factory.bin`;
  execFileSync(process.execPath, [join(root, "scripts", "factory-image.mjs"), board, join(out, image)], { stdio: "inherit" });
  writeFileSync(join(out, `manifest-${type}.json`), manifest(name, version, image));
  if (i === 0) {
    copyFileSync(join(out, image), join(out, "firmware-factory.bin"));
    writeFileSync(join(out, "manifest.json"), manifest(name, version, "firmware-factory.bin"));
  }
  types.push({ type, name, version, manifest: `manifest-${type}.json` });
  console.log(`flasher: ${name}, firmware ${version}`);
});
writeFileSync(join(out, "types.json"), JSON.stringify(types, null, 2) + "\n");
console.log(`flasher in ${out}`);
