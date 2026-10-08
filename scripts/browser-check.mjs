// Drives the admin page and the web client in headless Chrome against a real
// Axis server, with a stub standing in for the agent.
//
//   npm run build && TTS=http://host/v1/audio/speech STT=http://host/v1/audio/transcriptions node scripts/browser-check.mjs
//
// TTS and STT are optional; without them the speech steps report "not set".
// Needs google-chrome on the PATH, or CHROME set to another Chromium browser. Exits non-zero if a step fails.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startApp } from "../server/dist/app.js";
import { loadConfig } from "../server/dist/config.js";

const chat = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.method !== "POST") return void res.writeHead(200).end("{}");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "It is nine o'clock. " } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Anything else?" } }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
});
await new Promise((r) => chat.listen(0, "127.0.0.1", r));

const dataDir = mkdtempSync(join(tmpdir(), "axischeck-data-"));
const profile = mkdtempSync(join(tmpdir(), "axischeck-chrome-"));
const app = await startApp(
  loadConfig({
    AXIS_HOST: "127.0.0.1",
    AXIS_PORT: "0",
    AXIS_DATA_DIR: dataDir,
    AXIS_ADMIN_TOKEN: "browser-check",
    AXIS_STT_URL: process.env.STT,
    AXIS_TTS_URL: process.env.TTS,
    AXIS_HEALTH_INTERVAL_MS: "2000",
    AXIS_AGENT_URL: `http://127.0.0.1:${chat.address().port}/v1/chat/completions`,
    AXIS_AGENT_MODEL: "stub",
  }),
);
// localhost, not 127.0.0.1 by name only: both count as secure, so the microphone is allowed.
const base = `http://localhost:${app.port}`;

const chrome = spawn(
  process.env.CHROME || "google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    // The strict policy real browsers apply: no sound until someone clicks or types on the page.
    "--autoplay-policy=document-user-activation-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const debugUrl = await new Promise((resolve, reject) => {
  let err = "";
  chrome.stderr.on("data", (d) => {
    err += d;
    const found = err.match(/DevTools listening on (ws:\/\/\S+)/);
    if (found) resolve(found[1]);
  });
  setTimeout(() => reject(new Error(`chrome did not start: ${err.slice(0, 300)}`)), 15000);
});

const cdp = new WebSocket(debugUrl);
await new Promise((r) => cdp.on("open", r));
let nextId = 0;
const waiting = new Map();
const problems = [];
cdp.on("message", (data) => {
  const m = JSON.parse(data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    problems.push(`exception: ${(d.exception?.description || d.text).slice(0, 200)}`);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 200)}`);
  }
});
const call = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    cdp.send(JSON.stringify({ id, method, params, sessionId }));
  });

async function openPage(url) {
  const { result: { targetId } } = await call("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await call("Target.attachToTarget", { targetId, flatten: true });
  await call("Runtime.enable", {}, sessionId);
  await call("Page.enable", {}, sessionId);
  await call("Page.navigate", { url }, sessionId);
  const run = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const failed = r.result.exceptionDetails;
    if (failed) throw new Error(`eval failed: ${failed.exception?.description || failed.text}`);
    return r.result.result.value;
  };
  const until = async (expression, what, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await run(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  await until("document.readyState === 'complete'", "page load");
  // The admin page stops polling in a background tab, so the page under test is brought forward.
  // A click sent through the debugger counts as a real one, which is what unlocks sound.
  const click = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId);
    }
  };
  return { run, until, click, front: () => call("Page.bringToFront", {}, sessionId) };
}

const pills = (selector) =>
  `[...document.querySelectorAll('${selector} .pill, ${selector} .stat')].map(p => p.textContent + '=' + (p.classList[1] || '-')).join(' | ')`;
const byId = (id) => `document.getElementById('${id}')`;
const report = [];
const step = (label, value) => report.push(`${label}: ${value}`);
let failed = false;

try {
  // --- admin page ---------------------------------------------------------
  const admin = await openPage(`${base}/admin`);
  await admin.run(`${byId("token")}.value = 'wrong'; ${byId("signin-form")}.requestSubmit()`);
  step("wrong admin token", await admin.until(`${byId("signin-error")}.textContent`, "sign-in error"));
  await admin.run(`${byId("token")}.value = 'browser-check'; ${byId("signin-form")}.requestSubmit()`);
  await admin.until(`!${byId("app")}.classList.contains('hidden') && document.querySelectorAll('#summary .stat').length === 4`, "the admin page");
  step("summary", await admin.until(`(t => /agent=good/.test(t) && t)(${pills("#summary")})`, "upstream health"));
  step("gateway links", await admin.run(pills("#gw-pills")));
  step("commands listed", await admin.run(`${byId("gw-commands")}.textContent`));
  step("agent form", await admin.run(`'backend=' + ${byId("agent-backend")}.value + ', chat fields shown=' + !${byId("agent-openai")}.classList.contains('hidden')`));
  await admin.run(`${byId("speech-test")}.click()`);
  step("speech test", await admin.until(`(t => /Synthesis/.test(t) && t)(${byId("speech-note")}.textContent)`, "the speech test", 60000));
  await admin.run(`${byId("gw-code")}.value = 'junk'; ${byId("gw-pair")}.click()`);
  step("bad setup code", await admin.until(`${byId("gw-note")}.textContent`, "the setup code error"));
  step("known settings listed", await admin.until(`[...document.querySelectorAll('#settings-known .mono')].map(e => e.textContent).join(', ')`, "the known settings"));
  await admin.run(`(i => { i.value = 'nova'; i.dispatchEvent(new Event('change')); })(document.querySelector('#settings-known input'))`);
  await admin.until(`document.querySelector('#settings-known input').value === 'nova' && document.activeElement !== document.querySelector('#settings-known input')`, "the voice setting to save");
  await admin.run(`${byId("set-key")}.value = 'ledColor'; ${byId("set-value")}.value = 'blue'; ${byId("set-add")}.click()`);
  step("other setting saved", await admin.until(`document.querySelector('#settings-table tr')?.textContent`, "the settings row"));
  await admin.run(`document.querySelector('#settings-table button').click()`);
  await admin.until(`document.querySelector('#settings-table .empty')`, "the setting to clear");
  await admin.run(`${byId("code-new")}.click()`);
  const code = await admin.until(`${byId("code-value")}.textContent`, "a pairing code");
  step("pairing code looks right", /^\d{3}-\d{3}$/.test(code));

  // --- web client ---------------------------------------------------------
  const client = await openPage(`${base}/`);
  await client.until(`!${byId("pair")}.classList.contains('hidden')`, "the pairing form");
  await client.run(`${byId("pair-code")}.value = '000-000'; ${byId("pair-form")}.requestSubmit()`);
  step("wrong pairing code", await client.until(`${byId("pair-error")}.textContent`, "the pairing error"));
  await client.run(`${byId("pair-code")}.value = ${JSON.stringify(code)}; ${byId("pair-name")}.value = 'Browser <b>test</b>'; ${byId("pair-form")}.requestSubmit()`);
  await client.until(`document.querySelector('#pills .pill')?.textContent === 'idle'`, "the client to connect");
  step("client state", await client.until(`(t => /agent=good/.test(t) && t)(${pills("#pills")})`, "client health"));
  step("microphone allowed", await client.run(`!${byId("mic")}.disabled`));

  // Nobody has clicked on this page yet, so the browser holds its sound back.
  await client.until(`!${byId("sound-note")}.classList.contains('hidden')`, "the sound notice");
  step("sound notice shown before any click", true);
  if (process.env.TTS) {
    const session = [...app.hub.sessions()][0];
    const muted = await app.hub.say(session, "Can anyone hear this?");
    step("agent speech on an unclicked page", `heard=${muted.heard}`);
    if (muted.heard) throw new Error("speech on a page nobody clicked was reported as heard");
    await client.click(30, 30);
    await client.until(`${byId("sound-note")}.classList.contains('hidden')`, "the sound notice to clear after a click");
    const audible = await app.hub.say(session, "And now?");
    step("agent speech after a click", `heard=${audible.heard}`);
    if (!audible.heard) throw new Error("speech after a click was not reported as heard");
  } else {
    await client.click(30, 30);
  }

  // Record what the page sends, to check the protocol side of each action.
  await client.run(`window.sent = []; window.micBytes = 0; (() => { const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { if (typeof d === 'string') window.sent.push(JSON.parse(d)); else window.micBytes += d.byteLength; return send.call(this, d); }; })()`);

  const started = Date.now();
  await client.run(`${byId("say")}.value = 'what time is it'; ${byId("say-form")}.requestSubmit()`);
  const reply = await client.until(`(b => b.length && /Anything else/.test(b[b.length - 1].textContent) && b[b.length - 1].textContent)(document.querySelectorAll('.bubble.axis'))`, "the reply", 30000);
  step("typed turn reply", `${reply} (${Date.now() - started} ms)`);
  if (process.env.TTS) {
    await client.until(`window.sent.some(m => m.t === 'playback' && m.state === 'finished')`, "playback to finish", 30000);
    step("playback reported", `${await client.run(`window.sent.filter(m => m.t === 'playback').map(m => m.state).join(', ')`)} (${Date.now() - started} ms)`);
  }
  await client.until(`document.querySelector('#pills .pill')?.textContent === 'idle'`, "idle after the turn");

  // Chrome's fake microphone plays a repeating beep, so recognition hears little or nothing.
  await client.run(`${byId("mic")}.click()`);
  await client.until(`window.sent.some(m => m.t === 'audio.start')`, "audio.start");
  await client.until(`window.micBytes > 32000`, "a second of microphone audio");
  await client.run(`${byId("mic")}.click()`);
  await client.until(`window.sent.some(m => m.t === 'audio.end')`, "audio.end");
  step("spoken turn", `${await client.run("window.micBytes")} bytes sent, ended by ${await client.run(`window.sent.find(m => m.t === 'audio.end').reason`)}`);
  await client.until(`document.querySelector('#pills .pill')?.textContent === 'idle'`, "idle after speaking", 20000);
  step("last entries", await client.run(`[...document.querySelectorAll('.bubble')].slice(-2).map(b => b.className.replace('bubble ', '') + ': ' + b.textContent.slice(0, 50)).join(' | ')`));

  // --- back on the admin page ---------------------------------------------
  await admin.front();
  step("client listed", await admin.until(`document.querySelector('#client-table tbody tr')?.textContent.replace(/\\s+/g, ' ').slice(0, 80)`, "the client row"));
  step("name shown as text, not markup", await admin.run(`document.querySelectorAll('#client-table b').length === 0`));
  // The device editor. A real board describes its settings itself; here the schema is stored directly.
  app.store.saveSchema("web", {
    settings: [
      { key: "volume", label: "Volume", kind: "number", group: "Sound", min: 0, max: 100, default: 60, unit: "%" },
      { key: "listenCue", label: "Listening cue", kind: "toggle", group: "Sound", default: 1 },
      { key: "rotation", label: "Rotation", kind: "choice", group: "Screen", options: [0, 90, 180, 270], default: 90 },
    ],
    actions: [{ name: "diag", label: "Diagnostics" }],
    links: [],
  });
  await admin.run(`document.querySelector('#client-table tbody a').click()`);
  step("device editor", await admin.until(`${byId("device")}.classList.contains('on') && (t => /volume/.test(t) && t)([...document.querySelectorAll('#device-settings .mono')].map(e => e.textContent).join(', '))`, "the device settings (the page polls every 3 s)"));
  // Volume on the device layer, then check where it comes from on each layer.
  await admin.run(`(i => { i.value = '35'; i.dispatchEvent(new Event('change')); })(document.querySelector('#device-settings input[data-edit=volume]'))`);
  step("device value", await admin.until(`(t => /\\(this device\\)/.test(t) && t)([...document.querySelectorAll('#device-settings tr')].find(r => /Volume/.test(r.textContent))?.textContent.replace(/\\s+/g, ' '))`, "the volume to save"));
  await admin.run(`(i => { i.value = '150'; i.dispatchEvent(new Event('change')); })(document.querySelector('#device-settings input[data-edit=volume]'))`);
  step("range refused", await admin.until(`(t => /at most 100/.test(t) && t)(${byId("device-note")}.textContent)`, "the range error"));
  await admin.run(`[...document.querySelectorAll('#device-tabs button')].find(b => /web devices/.test(b.textContent)).click()`);
  await admin.run(`(s => { s.value = '0'; s.dispatchEvent(new Event('change')); })(document.querySelector('#device-settings select[data-edit=listenCue]'))`);
  step("type layer toggle", await admin.until(`(t => /off \\(type\\)/.test(t) && t)([...document.querySelectorAll('#device-settings tr')].find(r => /Listening cue/.test(r.textContent))?.textContent.replace(/\\s+/g, ' '))`, "the type toggle to save"));
  await admin.run(`[...document.querySelectorAll('#device-settings button')].find(b => b.textContent === 'Reset').click()`);
  step("reset", await admin.until(`(t => /on \\(default\\)/.test(t) && t)([...document.querySelectorAll('#device-settings tr')].find(r => /Listening cue/.test(r.textContent))?.textContent.replace(/\\s+/g, ' '))`, "the reset"));
  await admin.run(`window.confirm = () => true; ${byId("device-remove")}.click()`);
  await client.front();
  step("client after removal", await client.until(`${byId("pair-error")}.textContent`, "the client to notice", 10000));
} catch (error) {
  failed = true;
  report.push(`FAILED: ${error.message}`);
}

console.log(report.join("\n"));
console.log("page errors:", problems.length ? problems : "none");
chrome.kill();
await app.close();
chat.close();
await new Promise((r) => setTimeout(r, 800));
for (const dir of [dataDir, profile]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // Chrome can still be letting go of its profile. The folder is in the temp directory.
  }
}
process.exit(failed || problems.length ? 1 : 0);
