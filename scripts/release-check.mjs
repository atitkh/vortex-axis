#!/usr/bin/env node
// Checks that a release is consistent before and after it goes out: versions, CHANGELOG, CLAUDE.md, tags,
// what is pushed, what is deployed and what is in the data folder. Prints one line per check; exits 1 on a failure.
//   node scripts/release-check.mjs             everything that can be checked from here
// Warnings (⚠) are things to look at, not failures. docs/release.md says what to do about each.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const sh = (c) => {
  try {
    return execSync(c, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

let failed = 0;
const ok = (m) => console.log(`✓ ${m}`);
const warn = (m) => console.log(`⚠ ${m}`);
const bad = (m) => {
  failed++;
  console.log(`✗ ${m}`);
};
const check = (cond, good, wrong) => (cond ? ok(good) : bad(wrong));

// --- the numbers, where they are written ---------------------------------------------------------------
const axis = JSON.parse(read("package.json")).version;
const serverV = JSON.parse(read("server/package.json")).version;
const protocolV = JSON.parse(read("protocol/package.json")).version;
const desktop = /<Version>(.*?)<\/Version>/.exec(read("clients/windows-desktop/Directory.Build.props"))?.[1];
const mac = /let appVersion = "(.*?)"/.exec(read("clients/macos-desktop/Sources/VortexAxisMac/App.swift"))?.[1];
const firmware = /AXIS_FIRMWARE_VERSION "(.*?)"/.exec(read("firmware/common/src/axis_client.h"))?.[1];

check(axis === serverV && axis === protocolV, `Axis ${axis} (root, server and protocol packages agree)`,
  `package versions differ: root ${axis}, server ${serverV}, protocol ${protocolV} (npm version X --workspaces --include-workspace-root --no-git-tag-version)`);
ok(`Windows app ${desktop}, Mac app ${mac}, board firmware ${firmware}`);

// --- CHANGELOG and CLAUDE.md say the same ---------------------------------------------------------------
const changelog = read("CHANGELOG.md");
const claude = read("CLAUDE.md");
const versionsLine = claude.split("\n").find((l) => l.startsWith("**Versions:**")) ?? "";
for (const [name, heading, version, mention] of [
  ["Axis", "Axis", axis, `Axis ${axis}`],
  ["Windows app", "Desktop app", desktop, `desktop app ${desktop}`],
  ["Mac app", "Mac desktop app", mac, `Mac desktop app ${mac}`],
]) {
  check(changelog.includes(`## ${heading} ${version} (`), `CHANGELOG has ${name} ${version}`, `CHANGELOG has no "## ${heading} ${version} (date)" entry`);
  check(versionsLine.includes(mention), `CLAUDE.md Versions line names ${name} ${version}`, `CLAUDE.md Versions line does not say "${mention}"`);
}
check(versionsLine.includes(`firmware ${firmware}`), `CLAUDE.md names firmware ${firmware}`, `CLAUDE.md Versions line does not say "firmware ${firmware}"`);

// --- git -----------------------------------------------------------------------------------------------
const dirty = sh("git status --porcelain");
check(!dirty, "working tree clean", `uncommitted changes:\n${dirty.split("\n").slice(0, 8).join("\n")}`);
const unpushed = sh("git rev-list --count @{u}..HEAD");
check(unpushed === "0", "everything is pushed", unpushed ? `${unpushed} commit(s) not pushed` : "no upstream branch to compare with");
const tags = new Set(sh("git tag").split("\n"));
const head = sh("git rev-parse HEAD");
const tagAt = (t) => sh(`git rev-parse ${t}^{commit}`);
for (const [tag, what] of [[`v${axis}`, "Axis"], [`desktop-v${desktop}`, "Windows app"]]) {
  if (!tags.has(tag)) warn(`no tag ${tag} for ${what} yet (tag it on the commit that changed it, once released)`);
  else if (tagAt(tag) !== head && !sh(`git merge-base --is-ancestor ${tag} HEAD && echo y`)) bad(`tag ${tag} is not in this branch's history`);
  else ok(`tag ${tag} exists`);
}

// --- what is running and what is on the shelf -----------------------------------------------------------
// The running container knows which commit it was built from (npm run deploy). It is current when it is at or past
// the last commit that touched anything Axis is built from.
const built = sh("docker compose ps -q")
  .split("\n")
  .filter(Boolean)
  .map((id) => /^AXIS_COMMIT=(.+)$/m.exec(sh(`docker inspect ${id} --format '{{range .Config.Env}}{{println .}}{{end}}'`))?.[1])
  .find(Boolean);
const last = sh("git log -1 --format=%h -- server protocol web speech Dockerfile package.json package-lock.json");
if (!built) warn("could not read the running Axis's commit (is Docker up here? deploy with npm run deploy)");
else if (!last) warn("could not find the last commit that changed Axis");
else check(built === last || sh(`git merge-base --is-ancestor ${last} ${built} && echo y`) === "y",
  `deployed Axis is at ${built} (has ${last}, the last change to the server)`,
  `deployed Axis is at ${built} but the server last changed in ${last} (npm run deploy)`);
let data = process.env.AXIS_DATA_PATH;
if (!data && existsSync(join(root, ".env"))) data = /^AXIS_DATA_PATH=(.*)$/m.exec(read(".env"))?.[1];
const shelf = data && join(data, "desktop", "version.json");
if (shelf && existsSync(shelf)) {
  const built = JSON.parse(readFileSync(shelf, "utf8")).version;
  check(built === desktop, `Windows app on the shelf is ${built}`, `Windows app on the shelf is ${built}, the code says ${desktop} (scripts/build-desktop.sh)`);
} else warn("no AXIS_DATA_PATH or desktop/version.json to check the shelf against");
warn(`Mac app ${mac}: built and tried on a Mac only (swift build, then the app); nothing here can check that`);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
