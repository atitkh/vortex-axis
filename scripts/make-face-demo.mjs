// Puts the live face demo (docs/demo/index.html) in a folder that can be served as it is, with the
// face code beside it.
//
//   node scripts/make-face-demo.mjs [folder]        (default: docs/demo, in place)
//
// The page imports `./vortex.js` and `./icons.js`. They are copies of `web/vortex.js` and `web/icons.js`
// (the first one's import path is pointed at the second), so a demo never draws anything but the real face.
// Run it again after a look changes. The copies in docs/demo are ignored by git.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(process.argv[2] ?? join(root, "docs", "demo"));
mkdirSync(target, { recursive: true });

const vortex = readFileSync(join(root, "web", "vortex.js"), "utf8");
if (!vortex.includes('"/web/icons.js"')) throw new Error('web/vortex.js no longer imports "/web/icons.js"; update this script');
writeFileSync(join(target, "vortex.js"), vortex.replace('"/web/icons.js"', '"./icons.js"'));
copyFileSync(join(root, "web", "icons.js"), join(target, "icons.js"));
if (target !== join(root, "docs", "demo")) copyFileSync(join(root, "docs", "demo", "index.html"), join(target, "index.html"));
console.log(`face demo in ${target}`);
