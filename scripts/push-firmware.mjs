// Hands a firmware build to a running Axis, and with --update starts a staged
// rollout of it to the devices of that type over Wi-Fi.
//
//   AXIS_ADMIN_TOKEN=... node scripts/push-firmware.mjs waveshare-amoled-1.8 [--update]   (or waveshare-amoled-1.75)
//
// Build first (`pio run` in firmware/<type>). AXIS_URL defaults to http://127.0.0.1:8440.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { firmwareVersion } from "./firmware-version.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [type, ...flags] = process.argv.slice(2);
const base = (process.env.AXIS_URL ?? "http://127.0.0.1:8440").replace(/\/$/, "");
const token = process.env.AXIS_ADMIN_TOKEN;
if (!type || !token) {
  console.error("usage: AXIS_ADMIN_TOKEN=... node scripts/push-firmware.mjs <client type> [--update]");
  process.exit(2);
}

// Each board type counts its own version (scripts/firmware-version.mjs).
const version = firmwareVersion(type);
const buildDir = join(root, "firmware", type, ".pio/build");
const env = readdirSync(buildDir, { withFileTypes: true }).find((entry) => entry.isDirectory());
if (!env) throw new Error(`nothing built in ${buildDir}; run pio there first`);
const image = readFileSync(join(buildDir, env.name, "firmware.bin"));

const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error ?? res.status}`);
  return data;
};

const saved = await call("POST", `/admin/firmware/${encodeURIComponent(type)}?version=${encodeURIComponent(version)}`, image);
console.log(`uploaded ${saved.type} ${saved.version}, ${saved.size} bytes, md5 ${saved.md5}`);
// The factory image too, so the hub's flasher page (/flash) can put this version on a new board.
try {
  // Not PlatformIO's file as it is: its header has the wrong flash size (see scripts/factory-image.mjs).
  const made = join(tmpdir(), `axis-factory-${process.pid}.bin`);
  execFileSync(process.execPath, [join(root, "scripts", "factory-image.mjs"), join(root, "firmware", type), made], { stdio: "inherit" });
  const factory = readFileSync(made);
  rmSync(made, { force: true });
  await call("POST", `/admin/firmware/${encodeURIComponent(type)}?version=${encodeURIComponent(version)}&part=factory`, factory);
  console.log(`uploaded its factory image, ${factory.length} bytes`);
} catch (error) {
  console.log(`no factory image uploaded: ${error.message}`);
}

// --update starts the hub's staged rollout over this type's boards that are behind: one first, the rest once it is
// proven. It runs on the hub; this only starts it.
if (flags.includes("--update")) {
  const { clients } = await call("GET", "/admin/clients");
  const ids = clients.filter((c) => c.type === type && c.updateAvailable).map((c) => c.id);
  if (!ids.length) console.log("no board of this type is behind");
  else {
    const { rollout } = await call("POST", "/admin/updates/rollout", JSON.stringify({ ids }));
    for (const d of rollout.devices) console.log(`${d.name}: ${d.status}${d.detail ? ` (${d.detail})` : ""}${d.canary ? ", goes first" : ""}`);
    console.log("rollout started on the hub; follow it on the admin page's Firmware page or GET /admin/updates/rollout");
  }
}
