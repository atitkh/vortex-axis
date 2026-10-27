// Screenshots of the new admin page (/admin-next) against a throwaway Axis with pretend devices: two boards that
// describe themselves with the real boards' setting tables (read from their main.cpp), a Windows computer, a Mac and
// a browser. Writes PNGs to the folder given (default: /tmp/admin-next-shots).
//   npm run build && node docs/admin-revamp/shots.mjs [folder] [name-filter]
// Needs google-chrome (or CHROME). Nothing touches a real hub.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startApp } from "../../server/dist/app.js";
import { loadConfig } from "../../server/dist/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2] || "/tmp/admin-next-shots";
const only = process.argv[3] || "";
mkdirSync(out, { recursive: true });
const TOKEN = "shots-admin-token-0123456789";

/** A board's settings and actions, from its firmware's tables. */
function boardTables(folder) {
  const src = readFileSync(join(root, "firmware", folder, "src", "main.cpp"), "utf8");
  const str = (v) => (v === "nullptr" ? undefined : JSON.parse(v));
  const settings = [];
  for (const m of src.matchAll(/^\s*\{("[^"]+"), ("[^"]+"), ("[^"]+"), ("[^"]+"), ("(?:[^"\\]|\\.)*"|nullptr), ("[^"]*"), (-?\d+), (-?\d+), ("[^"]*"|nullptr), ("[^"]*"|nullptr)\},/gm)) {
    const kind = str(m[3]);
    const options = str(m[10])?.split(",").map((o) => (/^-?\d+$/.test(o) ? Number(o) : o));
    const raw = str(m[6]);
    const def = { key: str(m[1]), label: str(m[2]), kind, group: str(m[4]), help: str(m[5]), default: kind === "number" || kind === "toggle" || options?.every((o) => typeof o === "number") ? Number(raw) : raw };
    if (kind === "number") Object.assign(def, { min: Number(m[7]), max: Number(m[8]) });
    if (str(m[9])) def.unit = str(m[9]);
    if (options) def.options = options;
    settings.push(Object.fromEntries(Object.entries(def).filter(([, v]) => v !== undefined)));
  }
  const actions = [...src.matchAll(/^\s*\{"(\w+)", "([^"]+)", "([^"]*)", (true|false)\},/gm)].map((m) => ({ name: m[1], label: m[2], help: m[3], ...(m[4] === "true" ? { confirm: true } : {}) }));
  actions.push({ name: "diag", label: "Diagnostics" }, { name: "reboot", label: "Reboot", confirm: true });
  return { settings, actions, links: [{ label: "Device log", path: "/logs" }, { label: "Device page", path: "/" }] };
}

const dataDir = mkdtempSync(join(tmpdir(), "shots-data-"));
const profile = mkdtempSync(join(tmpdir(), "shots-chrome-"));
const app = await startApp(loadConfig({ AXIS_HOST: "127.0.0.1", AXIS_PORT: "0", AXIS_DATA_DIR: dataDir, AXIS_ADMIN_TOKEN: TOKEN, AXIS_AGENT_URL: "http://127.0.0.1:9/v1/chat/completions" }));
const base = `http://localhost:${app.port}`;
const admin = (method, path, body) =>
  fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

/** Pairs a pretend device and keeps it connected (answering commands) unless `offline`. */
const sockets = [];
async function device({ name, type, version, capabilities, readings = {}, describe, offline, address }) {
  if (process.env.DEBUG) console.log("device", name);
  const { code } = await admin("POST", "/admin/pairing-codes");
  const paired = await fetch(`${base}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, type, version, capabilities }) }).then((r) => r.json());
  const ws = new WebSocket(`${base.replace("http", "ws")}/v1/client`);
  await new Promise((r) => ws.on("open", r));
  ws.on("message", (data, binary) => {
    if (binary) return;
    const m = JSON.parse(data);
    if (m.t === "command") {
      const payload = m.name === "mic" ? { room: 12 + Math.round(Math.random() * 6), speechAbove: 150, level: 20 + Math.round(Math.random() * 400) } : {};
      ws.send(JSON.stringify({ t: "command.result", id: m.id, ok: true, payload }));
    }
  });
  ws.send(JSON.stringify({ t: "hello", protocol: 1, clientId: paired.clientId, token: paired.token, type, version, capabilities, settingsVersion: 0 }));
  await new Promise((r) => setTimeout(r, 150));
  if (describe) ws.send(JSON.stringify({ t: "describe", ...describe, ...(address ? { address } : {}) }));
  if (Object.keys(readings).length) ws.send(JSON.stringify({ t: "sense", readings }));
  await new Promise((r) => setTimeout(r, 150));
  if (offline) ws.close();
  else sockets.push(ws);
  return paired.clientId;
}

const round = boardTables("waveshare-amoled-1.75");
const rect = boardTables("waveshare-amoled-1.8");
const kitchen = await device({ name: "Kitchen", type: "waveshare-amoled-1.75", version: "0.4.1", capabilities: ["mic", "speaker", "screen", "buttons"], readings: { screenW: 466, screenH: 466, screenRound: 1, axis: "192.168.1.20:8440", rssi: -58 }, describe: round, address: "192.168.1.41" });
const desk = await device({ name: "Desk", type: "waveshare-amoled-1.8", version: "0.19.1", capabilities: ["mic", "speaker", "screen", "buttons"], readings: { screenW: 448, screenH: 368, axis: "192.168.1.20:8440", rssi: -64 }, describe: rect, address: "192.168.1.42" });
await device({ name: "Study PC", type: "windows-desktop", version: "0.13.0", capabilities: ["desktop", "mic", "speaker", "screen"] });
await device({ name: "MacBook", type: "macos-desktop", version: "0.6.0", capabilities: ["desktop", "mic", "speaker", "screen"], offline: true });
await device({ name: "Phone", type: "web", version: "0.52.0", capabilities: ["mic", "speaker", "screen"], offline: true });
// A newer build on the shelf for the 1.8, so Desk is behind; a few saved values on each layer.
const bin = Buffer.alloc(70000); bin[0] = 0xe9;
await fetch(`${base}/admin/firmware/waveshare-amoled-1.8?version=0.20.0`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" }, body: bin });
await admin("PATCH", `/admin/settings/device/${kitchen}`, { values: { brightness: 140, location: "Kitchen", notifyGlow: 0 } });
await admin("PATCH", `/admin/settings/device/${desk}`, { values: { volume: 35, location: "Office" } });
await admin("PATCH", "/admin/settings/type/waveshare-amoled-1.75", { values: { maxFps: 45 } });
await admin("PATCH", "/admin/settings/global", { values: { quietFrom: "22:30", quietTo: "07:00" } });
await admin("PATCH", "/admin/types/waveshare-amoled-1.75", { label: "Round board 1.75" });
await admin("PATCH", "/admin/types/waveshare-amoled-1.8", { label: "Board 1.8" });

// --- Chrome --------------------------------------------------------------------------------------
const chrome = spawn(process.env.CHROME || "google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const debugUrl = await new Promise((resolve, reject) => {
  let err = "";
  chrome.stderr.on("data", (d) => {
    err += d;
    const found = err.match(/DevTools listening on (ws:\/\/\S+)/);
    if (found) resolve(found[1]);
  });
  setTimeout(() => reject(new Error("chrome did not start")), 15000);
});
const cdp = new WebSocket(debugUrl);
await new Promise((r) => cdp.on("open", r));
let id = 0;
const waiting = new Map();
const errors = [];
cdp.on("message", (data) => {
  const m = JSON.parse(data);
  if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
});
const call = (method, params = {}, sessionId) => new Promise((r) => { const n = ++id; waiting.set(n, r); cdp.send(JSON.stringify({ id: n, method, params, sessionId })); });
const { result: { targetId } } = await call("Target.createTarget", { url: "about:blank" });
const { result: { sessionId: s } } = await call("Target.attachToTarget", { targetId, flatten: true });
await call("Runtime.enable", {}, s);
await call("Page.enable", {}, s);
const run = async (expression) => (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s)).result.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await call("Page.navigate", { url: `${base}/admin-next` }, s);
await sleep(600);
await run(`localStorage.setItem('axis-admin-token', ${JSON.stringify(TOKEN)})`);

async function shot(name, hash, { width = 1440, height = 900, theme = "dark", before, full = false } = {}) {
  if (only && !name.includes(only)) return;
  if (process.env.DEBUG) console.log("shot", name);
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 }, s);
  await run(`localStorage.setItem('axis.theme', '${theme}')`);
  // Through a blank page, so every shot is a fresh load (a new hash alone would not reload the page).
  await call("Page.navigate", { url: "about:blank" }, s);
  await sleep(100);
  await call("Page.navigate", { url: `${base}/admin-next${hash}` }, s);
  for (let i = 0; i < 40 && !(await run(`!!document.querySelector('main') && !document.querySelector('.loading')`)); i++) await sleep(150);
  await sleep(700);
  if (before) await run(before);
  await sleep(900);
  const shotHeight = full ? Math.min(4000, await run("document.documentElement.scrollHeight")) : height;
  if (full) await call("Emulation.setDeviceMetricsOverride", { width, height: shotHeight, deviceScaleFactor: 1, mobile: width < 600 }, s);
  const { result } = await call("Page.captureScreenshot", { format: "png" }, s);
  writeFileSync(join(out, `${name}.png`), Buffer.from(result.data, "base64"));
  console.log(`wrote ${name}.png`);
}

const typing = (key, value) => `(i => { i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('.banner ~ .edit-grid [data-edit=${key}], [data-edit=${key}]'))`;
const choose = (key, value) => `(i => { i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('[data-edit=${key}]'))`;
const unsaved = `${typing("brightness", "180")}; ${choose("textSize", "large")}; window.scrollTo(0, 0)`;
for (const theme of ["dark", "light"]) {
  await shot(`overview-${theme}`, "#overview", { theme });
  await shot(`devices-${theme}`, "#clients", { theme });
  await shot(`device-overview-${theme}`, `#clients/${kitchen}`, { theme });
  await shot(`device-settings-${theme}`, `#clients/${kitchen}/settings`, { theme, before: unsaved });
  await shot(`device-tools-${theme}`, `#clients/${desk}/tools`, { theme, before: `document.querySelector('#mic-go')?.click()` });
  await shot(`type-${theme}`, "#type/waveshare-amoled-1.8/settings", { theme });
  await shot(`defaults-${theme}`, "#settings", { theme });
  await shot(`pair-${theme}`, "#pair", { theme, before: `document.querySelector('#code-new').click(); (i => { i.value = '192.168.1.20:8440'; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('#device-address'))` });
  await shot(`cmdk-${theme}`, "#overview", { theme, before: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })); setTimeout(() => { const i = document.querySelector('.cmdk input'); i.value = 'vol'; i.dispatchEvent(new Event('input', { bubbles: true })); }, 100)` });
  await shot(`dialog-${theme}`, `#clients/${kitchen}/danger`, { theme, before: `document.querySelector('#device-remove').click()` });
}
for (const theme of ["dark", "light"]) {
  await shot(`phone-overview-${theme}`, "#overview", { width: 390, height: 844, theme });
  await shot(`phone-device-settings-${theme}`, `#clients/${kitchen}/settings`, { width: 390, height: 844, theme, before: unsaved });
  await shot(`phone-pair-${theme}`, "#pair", { width: 390, height: 844, theme, before: `document.querySelector('#code-new').click(); (i => { i.value = 'https://axis.example.org'; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('#device-address')); setTimeout(() => document.querySelector('#setup-string').scrollIntoView(), 300)` });
  await shot(`phone-nav-${theme}`, "#clients", { width: 390, height: 844, theme, before: `document.querySelector('#menu').click()` });
}
await shot("signin-dark", "#overview", { before: `localStorage.removeItem('axis-admin-token'); location.reload()` });

console.log("page errors:", errors.length ? errors : "none");
chrome.kill();
for (const ws of sockets) ws.close();
await app.close();
await sleep(500);
for (const dir of [dataDir, profile]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
process.exit(0);
