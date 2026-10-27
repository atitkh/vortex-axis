// Writes mockup-a.html and mockup-b.html from src/, each one file with nothing fetched from anywhere:
// the shared CSS and script, and the real face (web/icons.js and web/vortex.js) inlined with their imports and exports taken out.
// node docs/admin-revamp/build.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..", "web");
const plain = (code) => code.replace(/^import .*$/gm, "").replace(/^export (const|function|class|let) /gm, "$1 ");
const face = `${plain(readFileSync(join(web, "icons.js"), "utf8"))}\n${plain(readFileSync(join(web, "vortex.js"), "utf8"))}`;
const css = readFileSync(join(here, "src", "shared.css"), "utf8");
const js = readFileSync(join(here, "src", "shared.js"), "utf8");

for (const name of ["mockup-a", "mockup-b"].filter((n) => existsSync(join(here, "src", `${n}.html`)))) {
  const page = readFileSync(join(here, "src", `${name}.html`), "utf8")
    .replace("/*@SHARED_CSS*/", () => css)
    .replace("/*@SCRIPT*/", () => `${face}\n${js}`);
  writeFileSync(join(here, `${name}.html`), page);
  console.log(`wrote ${name}.html (${page.length} bytes)`);
}
