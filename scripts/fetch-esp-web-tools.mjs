// Fetches the installer the flasher page uses (ESP Web Tools, Apache-2.0) from npm into flasher/esp-web-tools,
// so the page needs nothing from anywhere else. Run once after cloning, and whenever the version below changes.
//   node scripts/fetch-esp-web-tools.mjs [destination]
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "10.4.0";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = process.argv[2] ?? join(root, "flasher", "esp-web-tools");
const work = mkdtempSync(join(tmpdir(), "esp-web-tools-"));
try {
  // npm checks what it downloads against the registry's own checksum.
  const file = execFileSync("npm", ["pack", `esp-web-tools@${VERSION}`, "--silent"], { cwd: work, encoding: "utf8" }).trim().split("\n").pop();
  execFileSync("tar", ["xzf", file], { cwd: work });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(work, "package", "dist", "web"), dest, { recursive: true });
  cpSync(join(work, "package", "LICENSE"), join(dest, "LICENSE"));
  console.log(`esp-web-tools ${VERSION}: ${readdirSync(dest).length} files in ${dest}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
