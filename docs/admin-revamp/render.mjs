// Renders the mockups to PNGs with headless Chrome, the way scripts/browser-check.mjs finds it (CHROME or google-chrome).
// node docs/admin-revamp/render.mjs   (run build.mjs first)
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shots = [
  ["mockup-a", "overview", 1440, 900, "mockup-a-overview.png"],
  ["mockup-a", "device", 1440, 900, "mockup-a-device.png"],
  ["mockup-a", "cmdk", 1440, 900, "mockup-a-command.png"],
  ["mockup-a", "device", 390, 844, "mockup-a-device-phone.png"],
  ["mockup-b", "overview", 1440, 900, "mockup-b-overview.png"],
  ["mockup-b", "device", 1440, 900, "mockup-b-device.png"],
];
const only = process.argv.slice(2);
for (const [page, view, w, h, out] of shots) {
  if (only.length && !only.some((o) => out.includes(o))) continue;
  const profile = mkdtempSync(join(tmpdir(), "revamp-chrome-"));
  execFileSync(process.env.CHROME || "google-chrome", [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`,
    `--window-size=${w},${h}`, "--force-device-scale-factor=1", "--virtual-time-budget=3000",
    `--screenshot=${join(here, out)}`, `file://${join(here, `${page}.html`)}#${view}`,
  ], { stdio: "ignore" });
  console.log(`wrote ${out}`);
}
