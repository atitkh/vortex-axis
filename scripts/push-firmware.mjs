// Hands a firmware build to a running Axis, and with --update tells the
// devices of that type to install it over Wi-Fi.
//
//   AXIS_ADMIN_TOKEN=... node scripts/push-firmware.mjs waveshare-amoled-1.8 [--update]
//
// Build first (`pio run` in firmware/<type>). AXIS_URL defaults to http://127.0.0.1:8440.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [type, ...flags] = process.argv.slice(2);
const base = (process.env.AXIS_URL ?? "http://127.0.0.1:8440").replace(/\/$/, "");
const token = process.env.AXIS_ADMIN_TOKEN;
if (!type || !token) {
  console.error("usage: AXIS_ADMIN_TOKEN=... node scripts/push-firmware.mjs <client type> [--update]");
  process.exit(2);
}

const version = /AXIS_FIRMWARE_VERSION "([^"]+)"/.exec(readFileSync(join(root, "firmware/common/src/axis_client.h"), "utf8"))?.[1];
if (!version) throw new Error("could not read AXIS_FIRMWARE_VERSION from firmware/common/src/axis_client.h");
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

if (flags.includes("--update")) {
  const { clients } = await call("GET", "/admin/clients");
  for (const client of clients.filter((c) => c.type === type)) {
    if (!client.online) console.log(`${client.name}: offline, skipped`);
    else if (client.version === version) console.log(`${client.name}: already on ${version}`);
    else {
      try {
        const told = await call("POST", `/admin/clients/${client.id}/update`);
        console.log(`${told.client}: updating ${told.from} -> ${told.to}`);
      } catch (error) {
        console.log(`${client.name}: ${error.message}`);
      }
    }
  }
}
