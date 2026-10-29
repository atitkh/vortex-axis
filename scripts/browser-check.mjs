// Drives the admin page (/admin) and the web client in headless Chrome against a real
// Axis server, with a stub standing in for the agent.
//
//   npm run build && TTS=http://host/v1/audio/speech STT=http://host/v1/audio/transcriptions node scripts/browser-check.mjs
//
// TTS and STT are optional. Without them a stub stands in: recognition always hears
// "what time is it" and synthesis answers with a short tone, so every step runs anywhere.
// Needs google-chrome on the PATH, or CHROME set to another Chromium browser. Exits non-zero if a step fails.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startApp } from "../server/dist/app.js";
import { loadConfig } from "../server/dist/config.js";
import { readQr } from "./qr-read.mjs";

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

// OpenAI-style speech endpoints, for when no real ones are given.
const speech = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url === "/v1/audio/transcriptions") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ text: "what time is it" }));
    }
    if (req.url === "/v1/audio/speech") {
      // 0.4 s of a quiet 440 Hz tone, 24 kHz 16-bit mono, as Axis asks for raw PCM.
      const pcm = Buffer.alloc(24000 * 2 * 0.4);
      for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 3000), i * 2);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return void res.end(pcm);
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise((r) => speech.listen(0, "127.0.0.1", r));
const stub = `http://127.0.0.1:${speech.address().port}`;
const realSpeech = Boolean(process.env.STT && process.env.TTS);

const dataDir = mkdtempSync(join(tmpdir(), "axischeck-data-"));
const backupDir = mkdtempSync(join(tmpdir(), "axischeck-backup-"));
const profile = mkdtempSync(join(tmpdir(), "axischeck-chrome-"));
const app = await startApp(
  loadConfig({
    AXIS_HOST: "127.0.0.1",
    AXIS_PORT: "0",
    AXIS_DATA_DIR: dataDir,
    AXIS_BACKUP_DIR: backupDir,
    AXIS_ADMIN_TOKEN: "browser-check-admin-token-0123",
    AXIS_STT_URL: process.env.STT || `${stub}/v1/audio/transcriptions`,
    AXIS_TTS_URL: process.env.TTS || `${stub}/v1/audio/speech`,
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
  // Makes the page a phone's size, or its own again.
  const phone = (on) =>
    on
      ? call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId)
      : call("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  return { run, until, click, phone, front: () => call("Page.bringToFront", {}, sessionId) };
}

const pills = (selector) =>
  `[...document.querySelectorAll('${selector} .pill, ${selector} .stat')].map(p => p.textContent + '=' + (p.classList[1] || '-')).join(' | ')`;
const byId = (id) => `document.getElementById('${id}')`;
const report = [];
const step = (label, value) => report.push(`${label}: ${value}`);
step("speech services", realSpeech ? "real (STT and TTS given)" : "stub");
let failed = false;

try {
  // --- the admin page (/admin): sign-in, then a pairing code from Add a device ----------------------------
  const next = await openPage(`${base}/admin`);
  await next.until(`${byId("signin-form")}`, "the sign-in form");
  // The form is drawn by Preact, so a value counts once its input event has run.
  const typeToken = (t) => `(i => { i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input', { bubbles: true })); })(${byId("token")})`;
  await next.run(typeToken("wrong"));
  await new Promise((r) => setTimeout(r, 200)); // Preact draws the typed value on its next tick
  await next.run(`${byId("signin-form")}.requestSubmit()`);
  step("wrong admin token", await next.until(`${byId("signin-error")}?.textContent`, "sign-in error"));
  await next.run(`${typeToken("browser-check-admin-token-0123")}; ${byId("remember")}.click()`);
  await next.until(`${byId("remember")}.checked && ${byId("token")}.value`, "the token typed and Remember ticked");
  await new Promise((r) => setTimeout(r, 200));
  await next.run(`${byId("signin-form")}.requestSubmit()`);
  await next.until(`document.querySelector('#main') && document.querySelectorAll('.health .dot').length >= 4`, "the admin page to sign in");
  step("token remembered on this device", await next.run(`localStorage.getItem('axis-admin-token') === 'browser-check-admin-token-0123' && sessionStorage.getItem('axis-admin-token') === null`));
  await next.run(`location.hash = '#pair'`);
  await next.until(`document.querySelector('#code-new')`, "Add a device");
  await next.run(`document.querySelector('#code-new').click()`);
  const code = await next.until(`document.querySelector('#code-value')?.textContent`, "a pairing code");
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
  {
    const session = [...app.hub.sessions()][0];
    const muted = await app.hub.say(session, "Can anyone hear this?");
    step("agent speech on an unclicked page", `heard=${muted.heard}`);
    if (muted.heard) throw new Error("speech on a page nobody clicked was reported as heard");
    await client.click(30, 30);
    await client.until(`${byId("sound-note")}.classList.contains('hidden')`, "the sound notice to clear after a click");
    const audible = await app.hub.say(session, "And now?");
    step("agent speech after a click", `heard=${audible.heard}`);
    if (!audible.heard) throw new Error("speech after a click was not reported as heard");
  }

  // Record what the page sends, to check the protocol side of each action.
  await client.run(`window.sent = []; window.micBytes = 0; (() => { const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { if (typeof d === 'string') window.sent.push(JSON.parse(d)); else window.micBytes += d.byteLength; return send.call(this, d); }; })()`);

  const started = Date.now();
  await client.run(`${byId("say")}.value = 'what time is it'; ${byId("say-form")}.requestSubmit()`);
  const reply = await client.until(`(b => b.length && /Anything else/.test(b[b.length - 1].textContent) && b[b.length - 1].textContent)(document.querySelectorAll('.bubble.axis'))`, "the reply", 30000);
  step("typed turn reply", `${reply} (${Date.now() - started} ms)`);
  {
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

  // Holding the face: it listens while held and ends on release, and the click that follows the release does nothing.
  const endsBefore = await client.run(`window.sent.filter(m => m.t === 'audio.end').length`);
  const startsBefore = await client.run(`window.sent.filter(m => m.t === 'audio.start').length`);
  await client.run(`${byId("mic")}.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))`);
  await client.until(`window.sent.filter(m => m.t === 'audio.start').length > ${startsBefore} && ${byId("mic")}.classList.contains('held')`, "listening while the face is held");
  await new Promise((r) => setTimeout(r, 1800)); // longer than the pause that ends a tapped turn
  if ((await client.run(`window.sent.filter(m => m.t === 'audio.end').length`)) !== endsBefore) throw new Error("a held turn ended before the face was let go");
  await client.run(`${byId("mic")}.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); ${byId("mic")}.click()`);
  await client.until(`window.sent.filter(m => m.t === 'audio.end').length > ${endsBefore}`, "the turn to end on release");
  step("hold to talk", `ended on release (${await client.run(`window.sent.filter(m => m.t === 'audio.end').at(-1).reason`)}), starts ${await client.run(`window.sent.filter(m => m.t === 'audio.start').length - ${startsBefore}`)}`);
  await client.until(`document.querySelector('#pills .pill')?.textContent === 'idle'`, "idle after the held turn", 20000);

  // --- more of the web client -------------------------------------------------
  // The history keeps what arrived unasked apart from the conversation, marked and timed, in this browser.
  {
    const session = app.hub.session((await client.run(`JSON.parse(localStorage.getItem('axis-client-identity')).clientId`)));
    step("announcements kept apart", await client.until(`(n => n.length >= 2 && n.every(b => /^announcement · /.test(b.dataset.meta)) && JSON.parse(localStorage.getItem('axis-client-inbox')).length === n.length && n.length + ' kept, last: ' + n[n.length - 1].dataset.meta.replace(/\\d.*/, 'time'))([...document.querySelectorAll('#log .bubble[data-cat="note"]')])`, "the kept announcements"));
    await client.run(`document.querySelector('#history-filter [data-filter="note"]').click()`);
    step("history filter", await client.run(`(shown => shown.length && shown.every(b => b.dataset.cat === 'note') && shown.length + ' shown, all notifications')([...document.querySelectorAll('#log .bubble')].filter(b => getComputedStyle(b).display !== 'none'))`));
    await client.run(`document.querySelector('#history-filter [data-filter="all"]').click()`);

    // A question nobody answers is left in the history as not answered; one that is answered says with what.
    const unanswered = app.hub.ask(session, "Still there?", ["Yes", "No"], 1500);
    await client.until(`document.querySelectorAll('#choices button').length === 2`, "the choices");
    step("question unanswered", `${JSON.stringify((await unanswered).answer)} → ${await client.until(`(b => b && /not answered/.test(b.dataset.meta) && b.classList.contains('missed') && b.textContent + ' / ' + b.dataset.meta.replace(/· .* ·/, '·'))([...document.querySelectorAll('#log .bubble.ask')].at(-1))`, "the question to be marked")}`);
    const answered = app.hub.ask(session, "Tea or coffee?", ["Tea", "Coffee"], 20000);
    await client.until(`document.querySelectorAll('#choices button').length === 2`, "the choices again");
    await client.run(`document.querySelectorAll('#choices button')[1].click()`);
    step("question answered", `${(await answered).answer} → ${await client.until(`(b => /answered: Coffee/.test(b.dataset.meta) && b.dataset.meta.replace(/· .* ·/, '·'))([...document.querySelectorAll('#log .bubble.ask')].at(-1))`, "the answer to be marked")}`);
    // The question is listed once, as a question, not also as the announcement that spoke it.
    if (await client.run(`[...document.querySelectorAll('#log .bubble[data-cat="note"]')].filter(b => b.textContent === 'Tea or coffee?').length`) !== 1) throw new Error("the question is in the history twice");

    // The client's own volume goes to Axis and comes back; mute tells Axis nothing is being played.
    await client.run(`(v => { v.value = '40'; v.dispatchEvent(new Event('input')); v.dispatchEvent(new Event('change')); })(${byId("volume")})`);
    await client.until(`JSON.parse(localStorage.getItem('axis-client-settings')).values.volume === 40`, "the volume to come back from Axis");
    step("volume from the client", `${app.store.getLayer("device", session.client.id).volume} % on Axis`);
    // The controls are out of sight until the mark in the corner is pressed.
    const tucked = await client.run(`${byId("sound-pop")}.classList.contains('hidden') && !${byId("sound")}.classList.contains('hidden') && document.querySelector('#footer #volume, #footer #mute') === null`);
    await client.run(`${byId("sound")}.click()`);
    if (!tucked || await client.run(`${byId("sound-pop")}.classList.contains('hidden')`)) throw new Error("the sound controls are not tucked behind the corner mark");
    await client.run(`${byId("mute")}.click()`);
    const mutedAt = Date.now();
    const whileMuted = await app.hub.say(session, "This one is not heard.");
    step("muted", `heard=${whileMuted.heard} in ${Date.now() - mutedAt} ms, button says ${await client.run(`${byId("mute")}.textContent`)}, corner mark ${await client.run(`${byId("sound")}.className`)}, shown: ${await client.run(`${byId("said")}.textContent`)}`);
    if (whileMuted.heard || Date.now() - mutedAt > 4000) throw new Error("a muted client was treated as playing the speech");
    await client.run(`${byId("mute")}.click()`);
    await client.run(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    if (!(await client.run(`${byId("sound-pop")}.classList.contains('hidden')`))) throw new Error("the sound controls stayed open after a press elsewhere");
    // The pairing: its name at the bottom opens the way out, which takes two presses and is not taken here.
    await client.run(`${byId("who")}.click()`);
    await client.run(`${byId("forget")}.click()`);
    const armed = await client.run(`!${byId("who-pop")}.classList.contains('hidden') && ${byId("forget")}.textContent`);
    await client.run(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    step("corner controls", `footer shows only "${await client.run(`[...${byId("footer")}.children].filter(e => !e.classList.contains('hidden')).map(e => e.textContent.trim()).join(' | ')`)}"; forget asks first: "${armed}", put away again=${await client.run(`${byId("who-pop")}.classList.contains('hidden') && ${byId("forget")}.textContent === 'Forget this pairing' && localStorage.getItem('axis-client-identity') !== null`)}; bell shown=${await client.run(`!${byId("bell")}.classList.contains('hidden')`)} (${await client.run(`${byId("bell")}.className`)})`);
    await app.store.patchLayer("device", session.client.id, { volume: null });
    app.hub.pushSettings();

    // Long work an agent reports on shows as one quiet line, and on the admin page's Live view.
    app.progress.update({ title: "Backup", note: "copying", done: 2, steps: ["Stop", "Snapshot", "Copy", "Check", "Start"] });
    step("agent task on the client", await client.until(`!${byId("task")}.classList.contains('hidden') && ${byId("task")}.textContent.replace(/\\s+/g, ' ').trim() + ' / ' + Math.round(${byId("task")}.getBoundingClientRect().height) + ' px'`, "the task line"));
    // The same task is listed under Now on the admin page's Live view while it runs.
    await next.front();
    await next.run(`location.hash = '#live/now'`);
    step("agent task on the admin's Live view", await next.until(`(t => /Backup/.test(t) && /Agent task · step 2 of 5: copying/.test(t) && 'listed under Now')(document.querySelector('#now')?.textContent ?? '')`, "the task in Now"));
    await client.front();
    // The bar is as far along as the steps, and a press on the line lists them with the one in hand marked.
    step("agent task bar and steps", await client.until(`(() => { const fill = ${byId("task-fill")}.style.width; if (fill !== '40%') return ''; ${byId("task-line")}.click(); const items = [...${byId("task-list")}.children]; return !${byId("task-list")}.classList.contains('hidden') && items.length === 5 && items[2].dataset.state === 'running' && 'bar ' + fill + ', ' + items.map(i => i.dataset.state[0] + ':' + i.textContent).join(' ') })()`, "the task's bar and steps"));
    // A second task that waits for the person takes the line; the first is counted and named in the list.
    app.progress.update({ id: "report", title: "Report", note: "which month?", state: "blocked" });
    step("two agent tasks", await client.until(`(() => { const items = [...${byId("task-list")}.children]; return ${byId("task-title")}.textContent === 'Report' && ${byId("task-more")}.textContent === '+1' && items.length === 1 && items[0].dataset.state === 'task' && ${byId("task-title")}.textContent + ' ' + ${byId("task-more")}.textContent + '; list starts "' + items[0].textContent + '"' })()`, "the second task on the line"));
    app.progress.clear("report");
    await client.until(`${byId("task-more")}.textContent === '' && ${byId("task-title")}.textContent === 'Backup'`, "the first task back on the line");
    app.progress.clear();
    // Once over it leaves Now and is kept under Tasks finished.
    await next.front();
    await next.run(`location.hash = '#live/now'`);
    await next.until(`!/Backup/.test(document.querySelector('#now')?.textContent ?? 'Backup')`, "the task to leave Now");
    await next.run(`location.hash = '#live/tasks'`);
    step("agent task once over", await next.until(`(t => /Backup/.test(t) && /step 2 of 5/.test(t) && 'gone from Now, kept under Tasks finished')(document.querySelector('#live-tasks')?.textContent ?? '')`, "the ended task under Tasks finished"));
    await next.run(`location.hash = '#overview'`);
    await client.front();
    await client.until(`${byId("task")}.classList.contains('hidden')`, "the task line to go");

    // A timer is one small chip under the words.
    const timer = app.timers.set(session, 600, "tea");
    step("timer chip", await client.until(`(t => !t.classList.contains('hidden') && /^9:5\\d$/.test(${byId("timer-text")}.textContent) && ${byId("timer-label")}.textContent + ' ' + ${byId("timer-text")}.textContent + ', ' + Math.round(t.getBoundingClientRect().height) + ' px tall, ' + getComputedStyle(t).fontSize)(${byId("timer")})`, "the timer chip"));
    app.timers.cancel({ id: timer.id });
    await client.until(`${byId("timer")}.classList.contains('hidden')`, "the timer to go");
  }
  // The words of a turn must never reach the activity log.
  {
    const kept = await fetch(`${base}/admin/activity?hours=24`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.text());
    step("no words stored", !/what time is it|nine o'clock/.test(kept));
    if (/what time is it|nine o'clock/.test(kept)) throw new Error("what was said turned up in the activity log");
  }
  // A real board describes its settings itself; here the schema is stored directly.
  app.store.saveSchema("web", {
    settings: [
      { key: "volume", label: "Volume", kind: "number", group: "Sound", min: 0, max: 100, default: 60, unit: "%" },
      { key: "listenCue", label: "Listening cue", kind: "toggle", group: "Sound", default: 1 },
      { key: "rotation", label: "Rotation", kind: "choice", group: "Screen", options: [0, 90, 180, 270], default: 90 },
    ],
    actions: [{ name: "diag", label: "Diagnostics" }, { name: "mic", label: "Microphone levels" }],
    links: [],
  });
  // --- the admin page again: every area -----------------------------------------------------------------
  {
    await next.front();
    // The token kept on this device signs the page in again after a reload.
    await next.run(`location.reload()`);
    step("admin: sign-in kept", await next.until(`document.querySelector('#main') && document.querySelectorAll('.health .dot').length >= 4 && 'signed in from the kept token'`, "the page to sign in again"));
    // Every old address still lands somewhere; #device/<id> is an alias of #clients/<id>.
    const known = await fetch(`${base}/admin/clients`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.json());
    const dev = known.clients[0];
    const routes = [];
    for (const [hash, expect] of [["#clients", "All devices"], [`#clients/${dev.id}`, dev.name], [`#device/${dev.id}`, dev.name], [`#map/${dev.id}`, dev.name], [`#clients/${dev.id}/settings`, dev.name], [`#type/${dev.type}`, null], ["#type", "Defaults for everything"], ["#settings", "Defaults for everything"], ["#pair", "Add a device"], ["#activity", "History"], ["#live", "Live"], ["#openclaw", "OpenClaw gateway"], ["#agent", "Who answers"], ["#tools", "Tools and MCP"], ["#speech", "Speech"], ["#voices", "Voices"], ["#face", "Face and screen"], ["#firmware", "Firmware"], ["#wakewords", "Wake words"], ["#apps", "Apps"], ["#integrations", "Integrations"], ["#system", "System"], ["#system/backup", "System"], ["#nonsense", "Overview"]]) {
      await next.run(`location.hash = ${JSON.stringify(hash)}`);
      const title = await next.until(`(t => t && (${JSON.stringify(expect)} === null || t === ${JSON.stringify(expect)}) && t)(document.querySelector('main h1')?.textContent)`, `the page for ${hash}`);
      routes.push(`${hash.replace(dev.id, "<id>")}→${title}`);
    }
    step("admin: old addresses", routes.join(", "));
    // The system map: Axis, the paired device and the services in one drawing, the stream live; a typed turn lights its
    // path. A pretend second device (paired here, removed after) and Axis's live feed stage a wake contest between the
    // two, then a wake heard by one. The device page's Overview is the live view of the device.
    const code = app.store.createPairingCode(60_000).code;
    const other = app.store.pair({ code, type: "waveshare-amoled-1.8", version: "0.0.0", capabilities: ["mic", "speaker"], name: "Pretend board" }).client;
    await next.run(`location.hash = '#map'`);
    step("admin: map", await next.until(`(s => s && s.querySelector('[data-id="axis"]') && s.querySelector('a.node[data-id="${dev.id}"]')?.getAttribute('href') === '#clients/${encodeURIComponent(dev.id)}' && s.querySelector('a.node[data-id="${other.id}"]') && s.querySelectorAll('.node.svc').length >= 3 && s.querySelector('[data-edge="${dev.id}>axis"]') && document.querySelector('#map-link')?.textContent.trim() === 'live' && (s.querySelectorAll('.node.svc').length + ' services, two devices and a line, Axis; stream live; a node opens the device page'))(document.querySelector('#map-svg'))`, "the map"));
    const now = Date.now();
    app.live.wake({ at: now, clientId: dev.id, word: "built-in", score: 0.91, level: 0.6, outcome: "answered" }, dev.name);
    app.live.wake({ at: now + 5, clientId: other.id, word: "built-in", score: 0.79, level: 0.4, outcome: "stood_down" }, other.name);
    step("admin: map wake contest", await next.until(`(c => c && c.querySelectorAll('.wake').length === 2 && c.querySelector('.wake.answered[data-wake="${dev.id}"]') && c.querySelector('.wake.stood_down[data-wake="${other.id}"]') && document.querySelector('#map-svg .node.heard-answered[data-id="${dev.id}"]') && document.querySelector('#map-svg .node.heard-stood_down[data-id="${other.id}"]') && /won by 0\.12/.test(c.textContent) && document.querySelector('#map-wake').textContent)(document.querySelector('#map-contest'))`, "the wake contest"));
    step("admin: map wake fades", await next.until(`!document.querySelector('#map-contest') && 'gone after ' + Math.round((Date.now() - ${now}) / 100) / 10 + ' s'`, "the contest to fade", 15000));
    app.live.wake({ at: Date.now(), clientId: other.id, word: "built-in", score: 0.7, level: 0.5, outcome: "answered" }, other.name);
    step("admin: map wake alone", await next.until(`(c => c && c.querySelectorAll('.wake').length === 1 && c.querySelector('.wake.answered[data-wake="${other.id}"] .w-out')?.textContent === 'answered' && document.querySelector('#map-wake').textContent)(document.querySelector('#map-contest'))`, "a single wake"));
    await fetch(`${base}/admin/clients/${other.id}`, { method: "DELETE", headers: { authorization: "Bearer browser-check-admin-token-0123" } });
    await client.run(`${byId("say")}.value = 'what time is it'; ${byId("say-form")}.requestSubmit()`);
    step("admin: map lights a turn", await next.until(`(lit => lit.length && 'lit: ' + lit.join(', '))([...document.querySelectorAll('#map-svg .edge.lit')].map(e => e.dataset.edge.replace(${JSON.stringify(dev.id)}, 'device')))`, "a lit path on the map", 30000));
    await next.run(`location.hash = '#clients/${encodeURIComponent(dev.id)}'`);
    step("admin: device overview", await next.until(`(m => m && document.querySelector('main h1')?.textContent === ${JSON.stringify(dev.name)} && document.querySelector('#map-caps .chip') && document.querySelector('#map-device .map-twin #device-facts') && ![...document.querySelectorAll('main h3')].some(h => h.textContent === 'About this device') && document.querySelector('#map-device .twin-head a[href$="/settings"]') && document.querySelector('#device-map')?.getAttribute('href') === '#map?device=${encodeURIComponent(dev.id)}' && !document.querySelector('.dgrid .rail') && (document.querySelectorAll('#map-caps .chip').length + ' capabilities, ' + (document.querySelectorAll('.gauge').length ? document.querySelectorAll('.gauge').length + ' gauges' : 'readings not reported') + ', the facts in the same card, then Actions and the last 24 hours'))(document.querySelector('#map-device'))`, "the device's overview"));
    await next.run(`document.querySelector('#device-map').click()`);
    step("admin: on the map", await next.until(`document.querySelector('#map-svg .node.focus[data-id="${dev.id}"]') && 'the device picked out'`, "the device picked out on the map"));
    // The address the page had while it was built sends a bookmark on to /admin with its #route.
    await next.run(`location.href = '/admin-next#clients/${dev.id}'`);
    step("admin: /admin-next bookmark", await next.until(`location.pathname === '/admin' && location.hash === '#clients/${dev.id}' && document.querySelector('main h1')?.textContent === ${JSON.stringify(dev.name)} && 'lands on /admin#clients/<id>'`, "the /admin-next redirect"));
    // Every page is ported: no "still in the classic admin" card, and no link anywhere leads back to /admin.
    const classicLinks = `[...document.querySelectorAll('a')].map(a => a.getAttribute('href') ?? '').filter(h => /^\\/admin(#|$)/.test(h))`;
    const stray = [];
    for (const page of ["overview", "firmware", "wakewords", "face", "integrations", "system", "apps"]) {
      await next.run(`location.hash = '#${page}'`);
      await next.until(`document.querySelector('main h1')?.textContent !== 'Overview' || ${JSON.stringify(page)} === 'overview'`, `the ${page} page`);
      await new Promise((r) => setTimeout(r, 200));
      stray.push(...(await next.run(`[...${classicLinks}, ...[...document.querySelectorAll('.classic-card')].map(() => 'card')]`)).map((h) => `${page}: ${h}`));
    }
    if (stray.length) throw new Error(`classic links left on the new page: ${stray.join(", ")}`);
    const toClassic = await next.run(`[...document.querySelectorAll('a[href^="/admin-classic"]')].map(a => a.textContent)`);
    if (toClassic.length) throw new Error(`links to /admin-classic: ${JSON.stringify(toClassic)}`);
    if ((await fetch(`${base}/admin-classic`)).status !== 404) throw new Error("/admin-classic still answers");
    step("admin: no classic links", "none on seven pages, and /admin-classic is gone (404)");
    // The command bar: Ctrl+K, type, Enter opens the device; Escape closes it.
    await next.run(`location.hash = '#overview'`);
    await next.run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
    await next.until(`document.querySelector('.cmdk input') === document.activeElement`, "the command bar");
    await next.run(`(i => { i.value = ${JSON.stringify(dev.name.slice(0, 5))}; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('.cmdk input'))`);
    await next.until(`document.querySelector('.cmdk-it.on')`, "a result");
    await next.run(`document.querySelector('.cmdk input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    step("admin: command bar", await next.until(`!document.querySelector('.cmdk') && location.hash.startsWith('#clients/') && 'Ctrl+K, typed, Enter opened ' + document.querySelector('main h1').textContent`, "the device from the command bar"));
    await next.run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
    await next.until(`document.querySelector('.cmdk input')`, "the command bar again");
    await next.run(`document.querySelector('.cmdk input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await next.until(`!document.querySelector('.cmdk')`, "Escape to close the command bar");
    // Profiles: a pretend board on a socket reports a low battery and goes to power saver by the rule; its Overview says
    // why, the map and the device list carry a chip. The Overview's switch applies at once: Silent, then back to Auto.
    const boardCode = app.store.createPairingCode(60_000).code;
    const board = app.store.pair({ code: boardCode, type: "waveshare-amoled-1.8", version: "0.0.0", capabilities: ["mic", "speaker", "screen"], name: "Battery board" });
    const sock = new WebSocket(`ws://localhost:${app.port}/v1/client`);
    const got = [];
    sock.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r, j) => (sock.once("open", r), sock.once("error", j)));
    sock.send(JSON.stringify({ t: "hello", protocol: 1, clientId: board.client.id, token: board.token, type: "waveshare-amoled-1.8", version: "0.0.0", capabilities: ["mic", "speaker", "screen"], settingsVersion: 0 }));
    sock.send(JSON.stringify({ t: "describe", settings: [
      { key: "brightness", label: "Brightness", kind: "number", group: "Screen", min: 10, max: 255, default: 200 },
      { key: "volume", label: "Volume", kind: "number", group: "Sound", min: 0, max: 100, default: 60 },
      { key: "listenCue", label: "Listening cue", kind: "toggle", group: "Sound", default: 1 },
    ], actions: [], links: [] }));
    sock.send(JSON.stringify({ t: "sense", readings: { battery: 17, charging: 0 } }));
    const sentValues = () => got.filter((m) => m.t === "settings").at(-1)?.values ?? {};
    await next.run(`location.hash = '#clients/${encodeURIComponent(board.client.id)}'`);
    step("admin: profile by the battery rule", await next.until(`(t => t === 'on power saver (battery 17%)' && document.querySelector('#profile-switch [data-profile="auto"]')?.getAttribute('aria-pressed') === 'true' && t)(document.querySelector('#profile-now')?.textContent)`, "power saver (battery 17%) on the Overview", 15000));
    await next.run(`document.querySelector('#profile-switch [data-profile="silent"]').click()`);
    step("admin: Overview switch to silent", await next.until(`(t => t === 'on silent (manual)' && [...document.querySelectorAll('#map-device .fact')].some(f => f.querySelector('dt')?.textContent === 'Volume' && f.querySelector('dd')?.textContent.startsWith('0')) && t + ', volume 0 in effect')(document.querySelector('#profile-now')?.textContent)`, "silent (manual) and volume 0 in effect", 15000));
    if (sentValues().volume !== 0 || sentValues().listenCue !== 0) throw new Error(`the board was not sent silent's values: ${JSON.stringify(sentValues())}`);
    step("admin: profile chip on the map", (await next.run(`(location.hash = '#map', true)`)) && await next.until(`document.querySelector('#map-svg a.node[data-id="${board.client.id}"] [data-profile-chip="silent"]') && 'silent'`, "a silent chip on the map node"));
    await next.run(`location.hash = '#clients'`);
    step("admin: profile chip in the list", await next.until(`document.querySelector('[data-device="${board.client.id}"] [data-profile-chip="silent"]')?.textContent`, "a silent chip on the device card"));
    await next.run(`location.hash = '#clients/${encodeURIComponent(board.client.id)}'`);
    await next.until(`document.querySelector('#profile-switch [data-profile="auto"]')`, "the profile switch");
    await next.run(`document.querySelector('#profile-switch [data-profile="auto"]').click()`);
    step("admin: Overview switch back to auto", await next.until(`(t => t === 'on power saver (battery 17%)' && t)(document.querySelector('#profile-now')?.textContent)`, "back on auto, power saver by the battery", 15000));
    if (app.store.getLayer("device", board.client.id).profile !== undefined) throw new Error("Auto left a profile saved on the device");
    if (sentValues().volume === 0) throw new Error("the board kept silent's volume after Auto");
    // Dock: chosen by hand, the hub's charge limit (80 %) sent as chargeLimit; the charger line and USB volts on the Overview.
    await next.run(`document.querySelector('#profile-switch [data-profile="dock"]').click()`);
    step("admin: Overview switch to dock", await next.until(`(t => t === 'Dock: charging held at 80%' && t)(document.querySelector('#profile-now')?.textContent)`, "Dock on the Overview", 15000));
    if (sentValues().chargeLimit !== 80) throw new Error(`the board was not sent Dock's charge limit: ${JSON.stringify(sentValues())}`);
    sock.send(JSON.stringify({ t: "sense", readings: { battery: 80, charging: 0, chargerState: 5, chargeHeld: 1, usbMv: 4980 } }));
    step("admin: charger gauge", await next.until(`(g => g && /held at 80% by the charge limit/.test(g.textContent) && /USB 4\.98 V/.test(g.textContent) && g.textContent)(document.querySelector('[data-gauge=charger]'))`, "the charger line and USB volts", 15000));
    await next.run(`document.querySelector('#profile-switch [data-profile="auto"]').click()`);
    await next.until(`/^on (normal|power saver)/.test(document.querySelector('#profile-now')?.textContent ?? '')`, "back on auto after dock", 15000);
    if (sentValues().chargeLimit !== 100) throw new Error(`the board kept Dock's charge limit after Auto: ${JSON.stringify(sentValues())}`);
    sock.close();
    await fetch(`${base}/admin/clients/${board.client.id}`, { method: "DELETE", headers: { authorization: "Bearer browser-check-admin-token-0123" } });
    // The battery preview, on a board that declares the battery look; the route is answered in the page, so the
    // check covers the page whatever the firmware or Axis build: the body sent, and each kind of refusal shown.
    const batCode = app.store.createPairingCode(60_000).code;
    const bat = app.store.pair({ code: batCode, type: "waveshare-amoled-1.8", version: "0.0.0", capabilities: ["mic", "speaker", "screen"], name: "Glyph board" });
    const batSock = new WebSocket(`ws://localhost:${app.port}/v1/client`);
    await new Promise((r, j) => (batSock.once("open", r), batSock.once("error", j)));
    batSock.send(JSON.stringify({ t: "hello", protocol: 1, clientId: bat.client.id, token: bat.token, type: "waveshare-amoled-1.8", version: "0.0.0", capabilities: ["mic", "speaker", "screen"], settingsVersion: 0 }));
    batSock.send(JSON.stringify({ t: "describe", settings: [
      { key: "lowBatteryBelow", label: "Low battery look", kind: "number", group: "Screen", min: 0, max: 30, default: 15 },
      { key: "batteryGlyph", label: "Battery mark", kind: "toggle", group: "Screen", default: 1 },
    ], actions: [], links: [] }));
    batSock.send(JSON.stringify({ t: "sense", readings: { screenW: 368, screenH: 448 } }));
    await next.run(`(() => { window.__bat = []; window.__batAnswer = [200, { ok: true }]; const f = window.fetch; window.fetch = (u, o) => String(u).endsWith('/battery') ? (window.__bat.push(JSON.parse(o.body)), Promise.resolve(new Response(JSON.stringify(window.__batAnswer[1]), { status: window.__batAnswer[0], headers: { 'content-type': 'application/json' } }))) : f(u, o); return true; })()`);
    await next.run(`location.hash = '#clients/${encodeURIComponent(bat.client.id)}/tools'`);
    await next.until(`document.querySelector('[data-battery-canvas]') && document.querySelector('[data-battery-send]') && !document.querySelector('[data-battery-send]').disabled`, "the battery preview");
    // The mark at 12 % (below the default 15): an amber fill inside the battery's outline and amber figures beside it.
    step("admin: battery preview draws", await next.until(`(c => { const d = c.getContext('2d').getImageData(114, 448 - 38, 140, 24).data; const xs = []; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 100 && d[i + 1] < 180 && d[i + 2] < 60) xs.push((i / 4) % 140); if (!xs.length) return false; const fill = xs.filter((x) => x < 70).length, text = xs.filter((x) => x >= 70).length; return fill > 4 && text > 20 && 'amber fill ' + fill + ' px, amber percent ' + text + ' px'; })(document.querySelector('[data-battery-canvas]'))`, "the battery mark on the preview canvas"));
    const batLabel = (key, want) => next.run(`document.querySelector('[data-battery=${key}]').click()`).then(() => next.until(`document.querySelector('[data-battery-label]').textContent === ${JSON.stringify(want)} && ${JSON.stringify(want)}`, `the label after ${key}`));
    step("admin: battery quick buttons", [await batLabel("critical", "4 %"), await batLabel("charging", "64 %, charging"), await batLabel("none", "No battery look (full, or no battery)"), await batLabel("low", "12 %")].join(" / "));
    await next.run(`document.querySelector('[data-battery-send]').click()`);
    await next.until(`document.querySelector('[data-battery-note].good')`, "the battery sent");
    await batLabel("charging", "64 %, charging");
    await next.run(`document.querySelector('[data-battery-send]').click()`);
    await next.until(`window.__bat.length === 2`, "the second send");
    await next.run(`document.querySelector('[data-battery-off]').click()`);
    const batSent = await next.until(`window.__bat.length === 3 && JSON.stringify(window.__bat)`, "the off send");
    if (batSent !== JSON.stringify([{ percent: 12, charging: false }, { percent: 64, charging: true }, { off: true }])) throw new Error(`battery bodies: ${batSent}`);
    step("admin: battery Show on the device", batSent);
    const batRefusal = async (status, body, want) => {
      await next.run(`(window.__batAnswer = [${status}, ${JSON.stringify(body)}], document.querySelector('[data-battery-send]').click(), true)`);
      return next.until(`(n => n && /bad/.test(n.className) && ${want}.test(n.textContent) && n.textContent)(document.querySelector('[data-battery-note]'))`, `the note after ${status}`);
    };
    const old = await batRefusal(504, { error: "not implemented on this device" }, /newer firmware/);
    const none = await batRefusal(400, { error: "Glyph board has no battery look" }, /no battery look/);
    await batRefusal(404, { error: "not found" }, /newer firmware/);
    step("admin: battery refusals", `${old} / ${none}`);
    step("admin: battery threshold tick", await next.until(`(t => t && getComputedStyle(t.parentElement).getPropertyValue('--low').trim() === '15%' && 'tick at 15 %')(document.querySelector('.battick'))`, "the tick at lowBatteryBelow"));
    // Show a picture, on a pretend board that takes pictures over its socket: a file chosen on its Tools tab goes out as
    // image.start with the seconds asked for, Recent pictures lists it with a thumbnail, Show again sends it again, Clear
    // sends image.clear. The real routes, not answered in the page.
    const picCode = app.store.createPairingCode(60_000).code;
    const pic = app.store.pair({ code: picCode, type: "picture-board", version: "0.0.0", capabilities: ["screen", "image-frames"], name: "Picture board" });
    const picSock = new WebSocket(`ws://localhost:${app.port}/v1/client`);
    await new Promise((r, j) => (picSock.once("open", r), picSock.once("error", j)));
    const picGot = [];
    picSock.on("message", (data, binary) => { if (!binary) picGot.push(JSON.parse(String(data))); });
    picSock.send(JSON.stringify({ t: "hello", protocol: 1, clientId: pic.client.id, token: pic.token, type: "picture-board", version: "0.0.0", capabilities: ["screen", "image-frames"], settingsVersion: 0 }));
    picSock.send(JSON.stringify({ t: "sense", readings: { screenW: 368, screenH: 448 } }));
    await next.run(`location.hash = '#clients/${encodeURIComponent(pic.client.id)}/tools'`);
    await next.until(`document.querySelector('[data-show-picture] [data-edit=show-file]') && document.querySelector('[data-recent-empty], [data-recent-pictures]')`, "the Show a picture card");
    await next.run(`(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 20; const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 40, 20); c.toBlob((b) => { const input = document.querySelector('[data-edit=show-file]'); const dt = new DataTransfer(); dt.items.add(new File([b], 'red.png', { type: 'image/png' })); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); }, 'image/png'); return true; })()`);
    await next.until(`document.querySelector('[data-show-preview]')?.complete && !document.querySelector('[data-show-send]').disabled`, "the chosen picture in the preview");
    await next.run(`(s => { s.value = '25'; s.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('[data-edit=show-seconds]'))`);
    await next.run(`(s => { s.value = 'a red box'; s.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('[data-edit=show-alt]'))`);
    await next.run(`document.querySelector('[data-show-send]').click()`);
    await next.until(`(n => n && /good/.test(n.className) && n.textContent)(document.querySelector('[data-show-note]'))`, "the picture shown");
    // 40 by 20, enlarged at most twice.
    const picStart = picGot.find((m) => m.t === "image.start");
    if (!picStart || picStart.seconds !== 25 || !/^say-/.test(picStart.turnId) || picStart.width !== 80) throw new Error(`image.start: ${JSON.stringify(picStart)}`);
    step("admin: Show a picture", `image.start ${picStart.width}x${picStart.height}, ${picStart.seconds} s, ${picStart.turnId}`);
    step("admin: Recent pictures", await next.until(`(li => li && li.querySelector('img')?.naturalWidth > 0 && /Picture board/.test(li.textContent) && /a red box/.test(li.textContent) && li.querySelector('b').textContent + ': ' + li.querySelector('.sm:last-child').textContent)(document.querySelector('[data-recent-picture]'))`, "the picture in Recent pictures"));
    await next.run(`document.querySelector('[data-show-again]').click()`);
    await next.until(`document.querySelectorAll('[data-recent-picture]').length === 2`, "Show again listed");
    if (picGot.filter((m) => m.t === "image.start").length !== 2) throw new Error("Show again sent no second picture");
    await next.run(`document.querySelector('[data-show-clear]').click()`);
    await next.until(`/Taken off/.test(document.querySelector('[data-show-note]')?.textContent ?? '')`, "the picture cleared");
    const picClear = picGot.find((m) => m.t === "image.clear");
    if (!picClear || picClear.turnId !== picGot.filter((m) => m.t === "image.start")[1].turnId) throw new Error(`image.clear: ${JSON.stringify(picClear)}`);
    step("admin: Show again and Clear", `image.clear ${picClear.turnId}`);
    picSock.close();
    await fetch(`${base}/admin/clients/${pic.client.id}`, { method: "DELETE", headers: { authorization: "Bearer browser-check-admin-token-0123" } });
    // The Settings tab's side column holds the device sketch only; the previews are on the Tools tab, linked from the rows.
    await next.run(`(location.hash = '#clients/${encodeURIComponent(bat.client.id)}/settings', true)`);
    // The charge limit in the Battery group beside the board's low battery look: a list by fives, 100 named No limit, staged and saved.
    step("admin: charge limit control", await next.until(`(r => r && r.closest('details') === document.querySelector('[data-key=lowBatteryBelow]')?.closest('details') && r.closest('details').id === 'group-battery' && [...r.querySelectorAll('option')].map(o => o.textContent).join(',') === '50 %,55 %,60 %,65 %,70 %,75 %,80 %,85 %,90 %,95 %,No limit' && 'Battery group, 50 % to No limit')(document.querySelector('[data-key=chargeLimit]'))`, "the charge limit beside the low battery look"));
    await next.run(`(s => { s.value = '85'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('[data-edit=chargeLimit]'))`);
    await next.until(`/1 unsaved change/.test(document.querySelector('.banner .savebar')?.textContent ?? '')`, "the charge limit staged");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    await next.until(`!document.querySelector('.banner .savebar') && document.querySelector('[data-key=chargeLimit] .src-chip')?.textContent === 'this device'`, "the charge limit saved");
    if (app.store.getLayer("device", bat.client.id).chargeLimit !== 85) throw new Error(`chargeLimit saved as ${app.store.getLayer("device", bat.client.id).chargeLimit}`);
    // Its toast's Undo takes it back (and leaves no Undo behind for the later checks).
    await next.run(`[...document.querySelectorAll('.toast')].find(t => /Charge limit/.test(t.textContent))?.querySelector('button')?.click()`);
    await next.until(`document.querySelector('[data-key=chargeLimit] .src-chip')?.textContent !== 'this device' && ![...document.querySelectorAll('.toast')].some(t => /Charge limit/.test(t.textContent) && t.querySelector('button'))`, "the charge limit undone");
    step("admin: charge limit saved", `85 % on the device layer, undone to ${JSON.stringify(app.store.getLayer("device", bat.client.id).chargeLimit ?? null)}`);
    step("admin: settings rail sketch only", await next.until(`(r => r && r.querySelectorAll('.card').length === 1 && !r.querySelector('.glow, [data-battery-canvas], #mic-go') && document.querySelector('[data-key=lowBatteryBelow] .hlp a[href$="/tools"]') && 'sketch, Tools link on the battery row')(document.querySelector('aside.rail'))`, "the settings rail"));
    batSock.close();
    await fetch(`${base}/admin/clients/${bat.client.id}`, { method: "DELETE", headers: { authorization: "Bearer browser-check-admin-token-0123" } });
    // All devices: a card per device, the filter, the list view.
    await next.run(`location.hash = '#clients'`);
    step("admin: all devices", await next.until(`document.querySelectorAll('#device-list [data-device]').length === ${known.clients.length} && [...document.querySelectorAll('#device-list .nm span:first-child')].map(e => e.textContent).join(', ')`, "the device cards"));
    step("admin: names as text", await next.run(`document.querySelectorAll('main b, main .nm b').length === 0 || ![...document.querySelectorAll('main b')].some(b => b.textContent === 'test')`));
    // The staged settings editor: type a value, the save bar counts it, the poll does not wipe it, Save sends it, Undo takes it back.
    await next.run(`location.hash = '#clients/${dev.id}/settings'`);
    await next.until(`document.querySelector('.banner [data-edit], [data-edit=volume]')`, "the settings editor");
    const typeIn = (key, value) => `(i => { i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('[data-edit=${key}]'))`;
    await next.run(typeIn("volume", "35"));
    await next.until(`/1 unsaved change/.test(document.querySelector('.banner .savebar')?.textContent ?? '')`, "the save bar");
    await new Promise((r) => setTimeout(r, 3500)); // a poll goes by
    const kept = await next.run(`document.querySelector('[data-edit=volume]').value === '35' && document.activeElement === document.querySelector('[data-edit=volume]') && document.querySelector('[data-key=volume] .src-chip').textContent`);
    if (kept !== "unsaved") throw new Error(`the poll wiped or moved what was typed (${kept})`);
    const before = app.store.getLayer("device", dev.id).volume;
    if (before !== undefined && before !== 35) throw new Error("the value was saved before Save");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    await next.until(`!document.querySelector('.banner .savebar') && document.querySelector('[data-key=volume] .src-chip')?.textContent === 'this device'`, "the save");
    if (app.store.getLayer("device", dev.id).volume !== 35) throw new Error(`volume saved as ${app.store.getLayer("device", dev.id).volume}`);
    step("admin: staged save", `typed 35, kept through a poll, ${await next.run(`[...document.querySelectorAll('.toast span')].map(t => t.textContent).join(' | ')`)}`);
    await next.run(`[...document.querySelectorAll('.toast button')].find(b => b.textContent === 'Undo').click()`);
    await next.until(`document.querySelector('[data-key=volume] .src-chip')?.textContent !== 'this device'`, "the undo");
    step("admin: undo", `volume on the device layer is ${JSON.stringify(app.store.getLayer("device", dev.id).volume ?? null)} again`);
    // A value the server refuses: the bar says why and keeps the change.
    await next.run(typeIn("volume", "150"));
    await next.until(`document.querySelector('[data-key=volume] .src-chip')?.textContent === 'refused'`, "the range check");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    step("admin: range refused", await next.until(`(t => /at most 100/.test(t) && t)(document.querySelector('.save-error')?.textContent ?? '')`, "the refusal"));
    // A value equal to what the layers below give stores nothing (it keeps following the shared value).
    await next.run(typeIn("volume", "60"));
    await next.until(`!document.querySelector('.banner .savebar')`, "typing the inherited value to stage nothing");
    await next.run(typeIn("volume", "61"));
    await next.run(typeIn("volume", "60"));
    step("admin: inherited value", await next.run(`!document.querySelector('.banner .savebar') && 'typing the value it already follows stages nothing'`));
    // Several changes at once (a toggle, a choice, the name, a capability), saved in one go; then Discard.
    await next.run(`(i => i.click())(document.querySelector('[data-edit=listenCue]'))`);
    await next.run(`(s => { s.value = '180'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('[data-edit=rotation]'))`);
    await next.run(typeIn("name", "Browser next"));
    await next.run(`document.querySelector('[data-edit="capability-screen"]').click()`);
    await next.until(`/4 unsaved changes/.test(document.querySelector('.banner .savebar').textContent)`, "four staged changes");
    // Leaving with unsaved changes asks first; Stay keeps them.
    await next.run(`location.hash = '#clients'`);
    await next.until(`document.querySelector('.dialog')`, "the leave dialog");
    await next.run(`[...document.querySelectorAll('.dialog button')].find(b => b.textContent === 'Stay').click()`);
    await next.until(`!document.querySelector('.dialog') && location.hash.endsWith('/settings') && document.querySelector('.banner .savebar')`, "staying");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    await next.until(`!document.querySelector('.banner .savebar') && document.querySelector('#device-title').textContent === 'Browser next'`, "the four changes to save");
    const saved = app.store.getLayer("device", dev.id);
    const rec = app.store.getClient(dev.id);
    if (saved.listenCue !== 0 || saved.rotation !== 180 || !rec.off.includes("screen")) throw new Error(`saved ${JSON.stringify(saved)} off=${rec.off}`);
    step("admin: several changes in one save", `listenCue ${saved.listenCue}, rotation ${saved.rotation}, name ${rec.name}, off ${rec.off.join(",")}`);
    await next.run(`[...document.querySelectorAll('.toast button')].find(b => b.textContent === 'Undo').click()`);
    await next.until(`document.querySelector('#device-title').textContent === ${JSON.stringify(dev.name)}`, "the undo of all four");
    if (app.store.getClient(dev.id).off.length || app.store.getLayer("device", dev.id).listenCue !== undefined) throw new Error("undo left something behind");
    await next.run(typeIn("volume", "20"));
    await next.run(`[...document.querySelectorAll('.banner .savebar button')].find(b => b.textContent === 'Discard').click()`);
    step("admin: undo all, discard", await next.until(`!document.querySelector('.banner .savebar') && document.querySelector('[data-edit=volume]').value !== '20' && 'undone, discarded'`, "the discard"));
    // Share with type: the device's value becomes its type's.
    await next.run(typeIn("volume", "45"));
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    await next.until(`document.querySelector('[data-key=volume] .src-chip')?.textContent === 'this device'`, "the volume on the device");
    await next.run(`[...document.querySelectorAll('[data-key=volume] button')].find(b => b.textContent === 'Share with type').click()`);
    await next.until(`document.querySelector('[data-key=volume] .src-chip')?.textContent === 'type'`, "the value to move to the type");
    step("admin: share with type", `type layer volume ${app.store.getLayer("type", dev.type).volume}, device layer ${JSON.stringify(app.store.getLayer("device", dev.id).volume ?? null)}`);
    // The type page: the type's value, who differs, and a reset back to the default.
    await next.run(`location.hash = '#type/${dev.type}/settings'`);
    await next.until(`document.querySelector('.banner[data-layer=type]') && document.querySelector('[data-key=volume] .src-chip')?.textContent === 'this type'`, "the type's settings");
    await next.run(`document.querySelector('[data-reset=volume]').click()`);
    await next.until(`document.querySelector('.banner [data-save]')`, "the reset to be staged");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    await next.until(`document.querySelector('[data-key=volume] .src-chip')?.textContent === 'default'`, "the type value to go");
    step("admin: type reset", `type layer volume now ${JSON.stringify(app.store.getLayer("type", dev.type).volume ?? null)}, the row says default`);
    // Defaults for everything: every Axis built-in, a raw key added and cleared.
    await next.run(`location.hash = '#settings'`);
    step("admin: defaults list the built-ins", await next.until(`(k => k.includes('quietFrom') && k.includes('offlineAlert') && k.includes('defaultClient') && k.length + ' keys')([...document.querySelectorAll('[data-key]')].map(r => r.dataset.key))`, "the built-ins"));
    await next.run(`(k => { k.value = 'ledColor'; k.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('#set-key')); (v => { v.value = 'blue'; v.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('#set-value'))`);
    await next.run(`document.querySelector('#set-add').click()`);
    await next.until(`document.querySelector('[data-key=ledColor]') && document.querySelector('.banner [data-save]')`, "the staged raw key");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    await next.until(`document.querySelector('[data-key=ledColor] .src-chip')?.textContent === 'everything'`, "the raw key to save");
    if (app.store.getLayer("global", "").ledColor !== "blue") throw new Error("the raw key was not saved");
    await next.run(`document.querySelector('[data-reset=ledColor]').click()`);
    await next.until(`document.querySelector('.banner [data-save]')`, "the reset to be staged");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    step("admin: other keys", await next.until(`!document.querySelector('[data-key=ledColor]') && 'ledColor added and cleared'`, "the raw key to clear"));
    // The device page's tabs: actions, the mic panel (the web client refuses it, shown), the danger zone's typed confirmation.
    await next.run(`location.hash = '#clients/${dev.id}'`);
    await next.until(`document.querySelector('#device-facts')`, "the device overview");
    await next.run(`[...document.querySelectorAll('.dmain .btnrow button')].find(b => b.textContent === 'Diagnostics')?.click()`);
    step("admin: device action", await next.until(`document.querySelector('#action-note')?.textContent`, "the action's answer"));
    await next.run(`location.hash = '#clients/${dev.id}/tools'`);
    await next.until(`document.querySelector('#mic-go')`, "the mic panel");
    await next.run(`document.querySelector('#mic-go').click()`);
    step("admin: microphone levels", await next.until(`document.querySelector('#mic-go').textContent === 'Stop' && /bad/.test(document.querySelector('#mic-note').className) && document.querySelector('#mic-note').textContent`, "the mic answer"));
    await next.run(`document.querySelector('#mic-go').click()`);
    await next.run(`location.hash = '#clients/${dev.id}/danger'`);
    await next.until(`document.querySelector('#device-remove')`, "the danger zone");
    await next.run(`document.querySelector('#device-remove').click()`);
    await next.until(`document.querySelector('.dialog .btn.danger-solid')?.disabled === true`, "the typed confirmation");
    await next.run(`document.querySelector('.dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    step("admin: remove asks for the name", await next.until(`!document.querySelector('.dialog') && 'Remove disabled until the name is typed; Escape closed it'`, "Escape to close the dialog"));
    if (!app.store.getClient(dev.id)) throw new Error("the device went without the name typed");
    // Add a device: a code, the setup string and its QR code, drawn again when the code changes.
    await next.run(`location.hash = '#pair'`);
    await next.until(`document.querySelector('#code-new')`, "Add a device");
    await next.run(`(i => { i.value = '192.168.1.20:8440'; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('#device-address')); document.querySelector('#code-new').click()`);
    const first = await next.until(`(s => /^axis:\\/\\/192\\.168\\.1\\.20:8440\\/\\d{3}-\\d{3}$/.test(s) && document.querySelector('svg.qr')?.dataset.text === s && s)(document.querySelector('#setup-string').value)`, "the setup string and QR");
    await next.run(`(i => { i.value = 'https://axis.example.org'; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('#device-address'))`);
    const tls = await next.until(`(s => s.startsWith('axis+tls://axis.example.org/') && document.querySelector('svg.qr').dataset.text === s && s)(document.querySelector('#setup-string').value)`, "the tls setup string");
    // The QR code really says the setup string: its modules are read back by the decoder in scripts/qr-read.mjs.
    const modules = await next.run(`(() => { const svg = document.querySelector('svg.qr'); const n = Number(svg.dataset.modules); const grid = Array.from({ length: n }, () => Array(n).fill(0)); for (const m of svg.querySelector('path').getAttribute('d').matchAll(/M(\\d+) (\\d+)/g)) grid[Number(m[2]) - 4][Number(m[1]) - 4] = 1; return grid.map(r => r.join('')); })()`);
    const read = readQr(modules);
    if (read !== tls) throw new Error(`the QR code reads ${JSON.stringify(read)}, not ${tls}`);
    step("admin: setup string and QR", `${first.replace(/\d{3}-\d{3}/, "<code>")}, then ${tls.replace(/\d{3}-\d{3}/, "<code>")}; the QR code reads back as the setup string`);
    // The theme switch: light, remembered, and back.
    await next.run(`[...document.querySelectorAll('.side .theme button')].find(b => b.textContent === 'Light').click()`);
    step("admin: theme", await next.until(`document.documentElement.dataset.theme === 'light' && localStorage.getItem('axis.theme') === 'light' && getComputedStyle(document.body).backgroundColor`, "the light theme"));
    await next.run(`[...document.querySelectorAll('.side .theme button')].find(b => b.textContent === 'Dark').click()`);
    // Stage 3: the Overview dashboard, Say something, History and Live, as the classic page's steps did.
    await next.run(`location.hash = '#overview'`);
    step("admin: overview", await next.until(`(t => /Axis running for/.test(t) && /Turns, last 24 hours\\s*\\d/.test(t) && document.querySelector('#attention') && document.querySelector('#now') && document.querySelectorAll('.ov-devs [data-device]').length && t.replace(/\\s+/g, ' '))(document.querySelector('#kpis')?.innerText ?? '')`, "the overview's numbers"));
    await next.until(`document.querySelectorAll('#say-target option').length >= 2`, "the places to say something");
    await next.run(`document.querySelector('#say-go').click()`);
    await next.until(`/Type what to say first/.test(document.querySelector('.say .msg.bad')?.textContent ?? '')`, "the empty message refused");
    await next.run(`(i => { i.value = 'Testing, one two.'; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('#say-text')); setTimeout(() => document.querySelector('#say-go').click(), 50)`);
    step("admin: say something", await next.until(`document.querySelector('#say-result')?.textContent.replace(/\\s+/g, ' ')`, "the announcement to be delivered", 40000));
    await next.run(`location.hash = '#activity'`);
    step("admin: history", await next.until(`document.querySelectorAll('#recent-turns tbody tr').length >= 2 && document.querySelector('#chart-turns svg') && document.querySelector('#strips .strip') && document.querySelectorAll('#events tbody tr').length && [...document.querySelectorAll('#recent-turns tbody tr')].slice(0, 3).map(r => r.children[2].textContent + ':' + r.children[3].textContent.trim()).join(', ')`, "the history page"));
    await next.run(`(s => { s.value = 'client'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('#event-filter'))`);
    await next.until(`[...document.querySelectorAll('#events tbody tr')].every(r => r.children[1].textContent === 'client')`, "the events filtered to connections");
    await next.run(`[...document.querySelectorAll('#range button')].find(b => b.textContent === '7 days').click()`);
    step("admin: history range", await next.until(`document.querySelector('#range button[aria-pressed=true]')?.textContent === '7 days' && !document.querySelector('#history[aria-busy]') && document.querySelector('#chart-latency') && 'events filtered to connections; 7 days loaded'`, "the 7 day range"));
    if (await next.run(`/what time is it|nine o'clock/.test(document.querySelector('main').textContent)`)) throw new Error("what was said turned up on the new History page");
    // Live: a typed turn on the web client shows up as it happens; Clear now takes the words away.
    await next.run(`location.hash = '#live'`);
    await next.until(`/watching/.test(document.querySelector('#live-state')?.textContent ?? '')`, "the live stream");
    await client.run(`${byId("say")}.value = 'what time is it'; ${byId("say-form")}.requestSubmit()`);
    step("admin: live", await next.until(`[...document.querySelectorAll('#live-turns .turn-card')].find(c => /Typed/.test(c.textContent) && /answered/.test(c.textContent))?.textContent.replace(/\\s+/g, ' ').slice(0, 160)`, "the typed turn on Live", 20000));
    // Clear keeps a turn still running (its words go, the turn stays), so wait for the playback to end first.
    for (const until = Date.now() + 20000; app.live.snapshot().some((t) => t.endedAt === undefined) && Date.now() < until; ) await new Promise((r) => setTimeout(r, 150));
    await next.run(`document.querySelector('#live-clear').click()`);
    step("admin: live cleared", await next.until(`!document.querySelector('#live-turns .turn-card') && [...document.querySelectorAll('.toast span')].some(t => /Cleared/.test(t.textContent)) && document.querySelector('#live-turns').textContent.slice(0, 40)`, "the turns to go"));
    for (const tab of ["now", "calls", "wakes", "tasks"]) {
      await next.run(`location.hash = '#live/${tab}'`);
      await next.until(`document.querySelector('.tabs a.on')?.getAttribute('href') === '#live/${tab}' && document.querySelector('#live-tab').textContent.trim()`, `the ${tab} tab`);
    }
    step("admin: live tabs", "now, tool calls, wake words, tasks finished");
    // --- Agent and voice (stage 4): every function of the classic #agent, #openclaw, #tools and #speech pages ---
    const adminGet = (path) => fetch(`${base}${path}`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.json());
    const fill = (selector, value, event = "input") => `(i => { i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })(document.querySelector(${JSON.stringify(selector)}))`;
    const saveBar = `document.querySelector('.savebar.floating')`;
    // The Undo of the newest toast that has one: the save just made.
    const undoToast = `[...document.querySelectorAll('.toast')].filter(t => [...t.querySelectorAll('button')].some(b => b.textContent === 'Undo')).at(-1).querySelector('.btn').click()`;
    const toastTexts = () => next.run(`[...document.querySelectorAll('.toast span')].map(t => t.textContent).join(' | ')`);
    await next.run(`location.hash = '#agent'`);
    step("admin: who answers", await next.until(`(b => b === 'openai' && document.querySelector('#agent-url') && !document.querySelector('#agent-note') && 'chat endpoint, its fields shown')(document.querySelector('[data-f=backend] button.on')?.dataset.v)`, "the agent form"));
    await next.run(`document.querySelector('#agent-test').click()`);
    step("admin: test the endpoint", await next.until(`(t => /It works/.test(t) && t.slice(0, 60))(document.querySelector('#agent-test-note')?.textContent ?? '')`, "the endpoint test", 20000));
    await next.run(fill("#agent-model", "stub-check"));
    await next.until(`/1 unsaved change/.test(${saveBar}?.textContent ?? '')`, "the save bar for the agent");
    await next.run(`location.hash = '#overview'`);
    await next.until(`document.querySelector('.dialog')`, "the leave dialog on Who answers");
    await next.run(`[...document.querySelectorAll('.dialog button')].find(b => b.textContent === 'Stay').click()`);
    await next.until(`!document.querySelector('.dialog') && location.hash === '#agent'`, "staying on Who answers");
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`!${saveBar}`, "the agent to save");
    const modelSaved = (await adminGet("/admin/config")).agent.model;
    const savedToasts = await toastTexts();
    await next.run(undoToast);
    await next.until(`[...document.querySelectorAll('.toast span')].some(t => /Put back/.test(t.textContent))`, "the undo of the agent");
    const modelBack = (await adminGet("/admin/config")).agent.model;
    if (modelSaved !== "stub-check" || modelBack !== "stub") throw new Error(`the agent model was saved as ${modelSaved}, then put back as ${modelBack} (toasts: ${savedToasts} → ${await toastTexts()})`);
    step("admin: agent staged save", "model saved after Stay on the leave dialog, then undone");
    await next.run(`location.hash = '#openclaw'`);
    step("admin: gateway links", await next.until(`(t => /turns:/.test(t) && /commands:/.test(t) && t)(document.querySelector('#gw-pills')?.textContent.replace(/\\s+/g, ' ').trim() ?? '')`, "the gateway page"));
    step("admin: commands listed", await next.run(`document.querySelector('#gw-commands').textContent + ' · steps open: ' + document.querySelector('#gw-steps').open + ' · ' + document.querySelector('#check-list').textContent.slice(0, 40)`));
    await next.run(`${fill("#gw-code", "junk")}; document.querySelector('#gw-pair').click()`);
    step("admin: bad setup code", await next.until(`document.querySelector('#gw-pair-note')?.textContent`, "the setup code error"));
    await next.until(`document.querySelector('[data-f=mirrorCards]')`, "the mirror switches");
    const cardsBefore = (await adminGet("/admin/mcp")).mirrorCards;
    await next.run(`document.querySelector('[data-f=mirrorCards]').click()`);
    await next.until(`/1 unsaved change/.test(${saveBar}?.textContent ?? '')`, "the save bar for the gateway");
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`!${saveBar}`, "the switch to save");
    const cardsAfter = (await adminGet("/admin/mcp")).mirrorCards;
    await next.run(undoToast);
    await next.until(`[...document.querySelectorAll('.toast span')].filter(t => /Put back/.test(t.textContent)).length`, "the undo of the switch");
    await new Promise((r) => setTimeout(r, 300));
    if (cardsAfter === cardsBefore || (await adminGet("/admin/mcp")).mirrorCards !== cardsBefore) throw new Error("the progress cards switch did not save or undo");
    step("admin: progress cards switch", `${cardsBefore} → ${cardsAfter} saved, undone`);
    await next.run(`location.hash = '#tools'`);
    await next.until(`document.querySelectorAll('#tools-list tbody tr').length === 12 && document.querySelector('#mcp-url').value.endsWith('/mcp')`, "the new tools page");
    await next.run(`${fill("#mcp-token-name", "Browser check next")}; document.querySelector('#mcp-token-new').click()`);
    const nextToken = await next.until(`document.querySelector('#mcp-token-value')?.value`, "the new token on the new page");
    await next.until(`/Browser check next/.test(document.querySelector('#mcp-tokens').textContent)`, "the token in the new list");
    const nextMcp = (method) =>
      fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${nextToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) }).then((r) => r.json());
    await next.run(`document.querySelector('[data-f="tool:vortex_axis_admin"]').click()`);
    await next.until(`/1 unsaved change/.test(${saveBar}?.textContent ?? '')`, "the save bar for a tool");
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`[...document.querySelectorAll('.toast span')].some(t => /vortex_axis_admin is off for every agent/.test(t.textContent))`, "the tool switched off");
    const offList = (await nextMcp("tools/list")).result.tools.map((t) => t.name);
    await next.run(undoToast);
    await next.until(`document.querySelector('[data-f="tool:vortex_axis_admin"]').checked`, "the tool back on");
    const onList = (await nextMcp("tools/list")).result.tools.map((t) => t.name);
    if (offList.includes("vortex_axis_admin") || !onList.includes("vortex_axis_admin")) throw new Error("the new tools page's switch did not reach MCP");
    step("admin: tools by MCP", `token made on the new page works; ${offList.length} tools with admin switched off and saved, ${onList.length} after Undo`);
    await next.run(`[...document.querySelectorAll('#tools-list tr')].find(r => r.textContent.includes('vortex_axis_say')).querySelector('button').click()`);
    await next.until(`document.querySelector('#try-tool').value === 'vortex_axis_say' && [...document.querySelectorAll('[data-try=target] option')].some(o => o.value === 'everywhere')`, "the say form on the new page");
    await next.run(`${fill("[data-try=target]", "everywhere", "change")}; ${fill("[data-try=text] textarea", "hello")}`);
    const nextSends = await next.until(`(t => t.includes('hello') && t)(document.querySelector('#try-args').textContent)`, "the say arguments");
    if (nextSends !== '{"everywhere":true,"text":"hello"}') throw new Error(`the new say form would send ${nextSends}`);
    await next.run(`${fill("#try-tool", "vortex_axis_clients", "change")}`);
    await next.until(`document.querySelector('#try-args').textContent === '{}'`, "the clients form");
    await next.run(`document.querySelector('#try-run').click()`);
    await next.until(`/"clients"/.test(document.querySelector('#try-result pre')?.textContent ?? '')`, "the clients tool's answer on the new page");
    step("admin: trying a tool", `say form sends ${nextSends}; clients tool answered`);
    await next.run(`location.hash = '#speech'`);
    await next.until(`document.querySelector('#speech-test')`, "the speech page");
    await next.run(`document.querySelector('#speech-test').click()`);
    step("admin: speech test", await next.until(`(t => /Synthesis/.test(t) && t.slice(0, 80))(document.querySelector('#speech-note')?.textContent ?? '')`, "the new speech test", 60000));
    step("admin: realtime voice", await next.until(`document.querySelector('#talk-state').textContent === 'needs OpenClaw' && !document.querySelector('#talk-body') && document.querySelector('#talk-note').textContent.slice(0, 50)`, "the realtime voice card"));
    await next.run(fill("#tts-rate", "100"));
    await next.until(`/1 unsaved change/.test(${saveBar}?.textContent ?? '')`, "the save bar for the sample rate");
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    step("admin: sample rate refused", await next.until(`(t => /8000 to 48000/.test(t) && t)(document.querySelector('.savebar .save-error')?.textContent ?? '')`, "the sample rate refusal"));
    await next.run(`[...${saveBar}.querySelectorAll('button')].find(b => b.textContent === 'Discard').click()`);
    await next.until(`!${saveBar}`, "the discard on Speech");
    await next.run(`location.hash = '#voices'`);
    await next.until(`document.querySelector('#vp-state')?.textContent === 'off'`, "the voices page");
    await next.run(fill("#vp-known", "0.8"));
    await next.until(`/1 unsaved change/.test(${saveBar}?.textContent ?? '')`, "the save bar for Known from");
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`!${saveBar}`, "the voice settings to save");
    const knownAt = (await adminGet("/admin/voices")).settings.knownAt;
    if (knownAt !== 0.8) throw new Error(`Known from was saved as ${knownAt}`);
    await next.run(`${fill("#vp-name", "Check voice")}; document.querySelector('#vp-add').click()`);
    await next.until(`/Check voice/.test(document.querySelector('#vp-voices')?.textContent ?? '')`, "the new voice");
    await next.run(`[...document.querySelectorAll('#vp-voices button')].find(b => b.textContent === 'Forget').click()`);
    await next.until(`document.querySelector('.dialog')`, "the forget dialog");
    await next.run(`[...document.querySelectorAll('.dialog button')].find(b => b.textContent === 'Forget').click()`);
    await next.until(`!/Check voice/.test(document.querySelector('#vp-voices')?.textContent ?? '')`, "the voice to be forgotten");
    step("admin: voices", `Known from saved as ${knownAt}; a voice added and forgotten after asking; ${await next.run(`document.querySelector('#vp-recent').textContent.slice(0, 50)`)}`);
    await next.run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
    await next.until(`document.querySelector('.cmdk input') === document.activeElement`, "the command bar for an action");
    await next.run(`(i => { i.value = 'reconnect gateway'; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('.cmdk input'))`);
    await next.until(`/Reconnect gateway/.test(document.querySelector('.cmdk-it.on')?.textContent ?? '')`, "the reconnect action");
    await next.run(`document.querySelector('.cmdk input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    step("admin: command bar actions", await next.until(`[...document.querySelectorAll('.toast span')].map(t => t.textContent).find(t => /gateway/i.test(t))`, "the reconnect toast"));
    step("admin: health links", await next.run(`[...document.querySelectorAll('.health a')].slice(0, 3).map(a => a.getAttribute('href')).join(' ')`));
    // --- stage 5: Face and screen, Firmware, Wake words, Apps, Integrations, System ---------------------
    // Downloads are caught as the blobs the page hands the browser.
    const catchBlobs = `window.blobs = []; if (!window.blobsCaught) { window.blobsCaught = true; const make = URL.createObjectURL; URL.createObjectURL = (b) => { window.blobs.push(b); return make(b); }; }`;
    const confirmDialog = (label) => `[...document.querySelectorAll('.dialog button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`;
    await next.run(`location.hash = '#face'`);
    await next.until(`document.querySelectorAll('.face-tile').length >= 35`, "the face tiles");
    await next.run(`document.querySelector('.face-tile[data-look="galaxy"]').click()`);
    step("admin: face viewer", await next.until(`document.querySelector('#face-name').textContent.startsWith('galaxy') && document.querySelectorAll('#face-numbers tr').length === 13 && (document.querySelectorAll('.face-tile').length + ' looks and icons, galaxy chosen')`, "a look to be chosen"));
    // Curl off, tool icons as a line and 36 dots, set behind the page's back: the page shows that, and stages changes to it.
    app.store.patchLayer("global", "", { idleLooksOff: "curl", toolIcons: "line", toolIconDots: 36 });
    app.hub.pushSettings();
    await next.until(`document.querySelector('.face-cell[data-look="curl"]').classList.contains('off') && document.querySelector('#face-icon-style button[aria-pressed=true]')?.dataset.v === 'line'`, "the face settings as saved");
    await next.run(`document.querySelector('.face-cell[data-look="curl"] input').click()`);
    await next.until(`/1 unsaved change/.test(${saveBar}?.textContent ?? '') && !document.querySelector('.face-cell[data-look="curl"]').classList.contains('off')`, "the idle look staged");
    await next.run(`document.querySelector('#face-icon-style button[data-v="dots"]').click()`);
    await next.until(`document.querySelector('#face-icon-dots')`, "the dots slider");
    await next.run(fill("#face-icon-dots", "48"));
    await next.until(`/3 unsaved changes/.test(${saveBar}?.textContent ?? '') && /48 of 78/.test(document.querySelector('#face-icon-dots-note').textContent)`, "three face changes staged");
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`!${saveBar}`, "the face to save");
    const faceSaved = (await adminGet("/admin/settings/global")).values;
    if (faceSaved.idleLooksOff != null || faceSaved.toolIcons !== "dots" || faceSaved.toolIconDots !== 48) throw new Error(`the face was saved as ${JSON.stringify(faceSaved)}`);
    await next.run(undoToast);
    await next.until(`[...document.querySelectorAll('.toast span')].some(t => /Put back/.test(t.textContent))`, "the undo of the face");
    const faceBack = (await adminGet("/admin/settings/global")).values;
    if (faceBack.idleLooksOff !== "curl" || faceBack.toolIcons !== "line" || faceBack.toolIconDots !== 36) throw new Error(`the face was put back as ${JSON.stringify(faceBack)}`);
    await next.run(`document.querySelector('.face-tile[data-look="icon:home"]').click()`);
    step("admin: face and tool icons", await next.until(`document.querySelector('#face-name').textContent === 'home (tool icon)' && document.querySelectorAll('#face-icons .face-tile').length === 13 && 'curl back in, dots, 48 dots saved in one go, then undone; 13 icons, home chosen'`, "the tool icon"));
    // Firmware: upload a build, download it, send it, remove it after a dialog.
    await next.run(`location.hash = '#firmware'`);
    await next.until(`document.querySelector('#firmware-upload')`, "the firmware page");
    await next.run(`(() => {
      const bytes = new Uint8Array(70000); bytes[0] = 0xe9;
      const files = new DataTransfer(); files.items.add(new File([bytes], 'firmware.bin'));
      document.querySelector('#firmware-file').files = files.files;
    })(); ${fill("#firmware-type", "web")}; ${fill("#firmware-version", "9.9.8")}`);
    await next.run(`document.querySelector('#firmware-upload').click()`);
    const shelfWeb = `document.querySelector('.shelf[data-type="web"]')`;
    step("admin: firmware uploaded", await next.until(`(t => /9\\.9\\.8/.test(t) && /sent to devices/.test(t) && /Update 1 device to 9\\.9\\.8|Nothing to update/.test(t) && t.replace(/\\s+/g, ' ').slice(0, 120))(${shelfWeb}?.textContent ?? '')`, "the build on the shelf"));
    await next.run(catchBlobs);
    await next.run(`[...${shelfWeb}.querySelectorAll('button')].find(b => b.textContent === 'Download').click()`);
    const firmwareBlob = await next.until(`window.blobs[0]?.size`, "the firmware download");
    if (firmwareBlob !== 70000) throw new Error(`the firmware download held ${firmwareBlob} bytes`);
    await next.run(`[...${shelfWeb}.querySelectorAll('button')].find(b => b.textContent === 'Remove').click()`);
    await next.until(`document.querySelector('.dialog')`, "the remove dialog");
    await next.run(confirmDialog("Remove"));
    await next.until(`/No builds held/.test(${shelfWeb}?.textContent ?? '')`, "the build to go");
    if ((await adminGet("/admin/firmware")).shelves.some((sh) => sh.builds.length)) throw new Error("the firmware build was not removed");
    step("admin: firmware download and remove", `downloaded ${firmwareBlob} bytes, removed after the dialog`);
    // Update all as a staged rollout: two pretend boards on an old build; the one with the stronger Wi-Fi goes first,
    // restarts on the new build and sends readings, then the other follows. The rollout card shows both proven.
    {
      const bytes = Buffer.alloc(70000, 3);
      bytes[0] = 0xe9;
      const up = await fetch(`${base}/admin/firmware/rollout-board?version=2.0.0`, { method: "POST", headers: { authorization: "Bearer browser-check-admin-token-0123", "content-type": "application/octet-stream" }, body: bytes });
      if (up.status !== 201) throw new Error(`the rollout build upload answered ${up.status}`);
      const told = [];
      const pretend = (name, rssi) => {
        const paired = app.store.pair({ code: app.store.createPairingCode(60_000).code, type: "rollout-board", version: "1.0.0", capabilities: ["speaker", "screen"], name });
        const open = (version) => {
          const ws = new WebSocket(`ws://localhost:${app.port}/v1/client`);
          ws.on("open", () => {
            ws.send(JSON.stringify({ t: "hello", protocol: 1, clientId: paired.client.id, token: paired.token, type: "rollout-board", version, capabilities: ["speaker", "screen"], settingsVersion: 0 }));
            setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "sense", readings: { rssi } })), 200);
          });
          ws.on("message", (d) => {
            const m = JSON.parse(String(d));
            if (m.t !== "command" || m.name !== "update") return;
            told.push(name);
            ws.send(JSON.stringify({ t: "command.result", id: m.id, ok: true }));
            // "Installs" and comes back on the new build, as a board that keeps it does.
            setTimeout(() => (ws.close(), setTimeout(() => open(String(m.params.version)), 300)), 300);
          });
        };
        open("1.0.0");
        return paired.client;
      };
      const strong = pretend("Strong board", -48);
      pretend("Weak board", -77);
      await next.run(`location.hash = '#firmware'`);
      const shelfR = `document.querySelector('.shelf[data-type="rollout-board"]')`;
      await next.until(`/Update 2 devices to 2\\.0\\.0/.test(${shelfR}?.textContent ?? '')`, "Update all on the rollout shelf", 15000);
      await next.run(`[...${shelfR}.querySelectorAll('button')].find(b => /^Update 2/.test(b.textContent)).click()`);
      await next.until(`/One board goes first/.test(document.querySelector('.dialog')?.textContent ?? '')`, "the rollout dialog");
      await next.run(confirmDialog("Start"));
      step("admin: rollout running", await next.until(`(c => c && /running/.test(c.textContent) && c.querySelector('[data-rollout="${strong.id}"]')?.textContent.includes('first') && c.textContent.replace(/\\s+/g, ' ').slice(0, 90))(document.querySelector('#rollout'))`, "the rollout card while it runs", 15000));
      step("admin: rollout finished", await next.until(`(c => c?.dataset.state === 'done' && c.querySelectorAll('.badge.good').length === 3 && c.textContent.replace(/\\s+/g, ' ').slice(0, 140))(document.querySelector('#rollout'))`, "both boards proven", 30000));
      if (told.join() !== "Strong board,Weak board") throw new Error(`the boards were told to update in this order: ${told.join()}`);
      const last = (await adminGet("/admin/updates/rollout")).rollout;
      if (last.canary !== strong.id || !last.devices.every((d) => d.status === "proven" && d.version === "2.0.0")) throw new Error(`the rollout ended as ${JSON.stringify(last)}`);
    }
    // Wake words: a manifest fills the form, a model is added, its cutoff staged and saved, then it is removed.
    await next.run(`location.hash = '#wakewords'`);
    step("admin: wake words", await next.until(`(t => /built-in/.test(t) && document.querySelector('#wake-scores') && t.replace(/\\s+/g, ' ').slice(0, 80))(document.querySelector('#wakewords-list')?.textContent ?? '')`, "the wake words page"));
    await next.run(`(() => {
      const files = new DataTransfer(); files.items.add(new File([JSON.stringify({ wake_word: 'Hey Check', micro: { probability_cutoff: 0.87, sliding_window_size: 4, feature_step_size: 10 } })], 'hey_check.json'));
      const i = document.querySelector('#wake-manifest'); i.files = files.files; i.dispatchEvent(new Event('change', { bubbles: true }));
      const model = new Uint8Array(8192); model.set([84, 70, 76, 51], 4);
      const m = new DataTransfer(); m.items.add(new File([model], 'hey_check.tflite'));
      document.querySelector('#wake-file').files = m.files;
    })()`);
    await next.until(`document.querySelector('#wake-name').value === 'Hey Check' && document.querySelector('#wake-cutoff').value === '87' && document.querySelector('#wake-window').value === '4'`, "the manifest to fill the form");
    await next.run(`document.querySelector('#wake-upload').click()`);
    await next.until(`/is stored as/.test(document.querySelector('#wake-note').textContent)`, "the wake word to be stored");
    const word = (await adminGet("/admin/wakewords")).wakeWords.find((w) => w.name === "Hey Check");
    if (!word || word.cutoff !== 87 || word.window !== 4) throw new Error(`the wake word was stored as ${JSON.stringify(word)}`);
    await next.until(`document.querySelector('[data-f="${word.id}.cutoff"]')`, "the new wake word's row");
    await next.run(fill(`[data-f="${word.id}.cutoff"]`, "91"));
    await next.until(`/1 unsaved change/.test(${saveBar}?.textContent ?? '')`, "the cutoff staged");
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`!${saveBar}`, "the cutoff to save");
    const tuned91 = (await adminGet("/admin/wakewords")).wakeWords.find((w) => w.id === word.id).cutoff;
    if (tuned91 !== 91) throw new Error(`the cutoff was saved as ${tuned91}`);
    // The hub's wake margin, in points of score on the page, a fraction on the hub.
    await next.until(`document.querySelector('[data-f="hub.wakeMargin"]')?.value === '10'`, "the wake margin field at 10");
    await next.run(fill(`[data-f="hub.wakeMargin"]`, "15"));
    await next.until(`/1 unsaved change/.test(${saveBar}?.textContent ?? '')`, "the margin staged");
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`!${saveBar}`, "the margin to save");
    const margin = (await adminGet("/admin/integrations")).settings.wakeMargin;
    if (margin !== 0.15) throw new Error(`the wake margin was saved as ${margin}`);
    step("admin: wake margin saved", "15 points");
    await next.run(`${catchBlobs}; [...document.querySelectorAll('#wakewords-list tr')].find(r => r.textContent.includes(${JSON.stringify(word.id)})).querySelector('button').click()`);
    const wordBlob = await next.until(`window.blobs[0]?.size`, "the wake word download");
    await next.run(`[...[...document.querySelectorAll('#wakewords-list tr')].find(r => r.textContent.includes(${JSON.stringify(word.id)})).querySelectorAll('button')].find(b => b.textContent === 'Remove').click()`);
    await next.until(`document.querySelector('.dialog')`, "the remove dialog for the wake word");
    await next.run(confirmDialog("Remove"));
    await next.until(`![...document.querySelectorAll('#wakewords-list tr')].some(r => r.textContent.includes(${JSON.stringify(word.id)}))`, "the wake word to go");
    step("admin: wake word models", `manifest filled the form, ${word.id} added, cutoff 87 → 91 saved, downloaded ${wordBlob} bytes, removed after the dialog`);
    // Apps: the Windows app's download and the Quest and Mac apps' words.
    await next.run(`location.hash = '#apps'`);
    step("admin: apps", await next.until(`(t => t && document.querySelector('#app-quest') && document.querySelector('#app-mac') && t)(document.querySelector('#apps-desktop-info')?.textContent)`, "the apps page"));
    // Integrations: Home Assistant staged, saved and undone.
    await next.run(`location.hash = '#integrations'`);
    step("admin: integrations", await next.until(`(t => /Home Assistant/.test(t) && /Notifications to browsers/.test(t) && !/OpenClaw gateway\\s*(connected|check)/.test(t) && t)([...document.querySelectorAll('main .card-h h3')].map(h => h.textContent).join(' | '))`, "the integrations cards"));
    await next.run(fill("#ha-host", "127.0.0.1"));
    await next.until(`/1 unsaved change/.test(${saveBar}?.textContent ?? '')`, "the broker staged");
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`!${saveBar}`, "Home Assistant to save");
    const hostSaved = (await adminGet("/admin/integrations")).settings.mqtt.host;
    await next.run(undoToast);
    await next.until(`[...document.querySelectorAll('.toast span')].some(t => /Put back/.test(t.textContent))`, "the undo of Home Assistant");
    await new Promise((r) => setTimeout(r, 300));
    const hostBack = (await adminGet("/admin/integrations")).settings.mqtt.host;
    if (hostSaved !== "127.0.0.1" || hostBack !== "") throw new Error(`the broker was saved as ${hostSaved}, then put back as ${JSON.stringify(hostBack)}`);
    step("admin: integration staged save", "broker 127.0.0.1 saved, then undone");
    // System: history kept saved, a backup made, a copy of the database downloaded; #system/backup scrolls to it.
    await next.run(`location.hash = '#system'`);
    await next.until(`document.querySelector('#sys-activityDays')`, "the system page");
    await next.run(fill("#sys-activityDays", "6"));
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`!${saveBar}`, "the system settings to save");
    const daysSaved = (await adminGet("/admin/integrations")).settings.activityDays;
    if (daysSaved !== 6) throw new Error(`activityDays was saved as ${daysSaved}`);
    // The Dock charge limit beside Power saver below.
    await next.until(`document.querySelector('#sys-power #sys-dockChargeLimit') && document.querySelector('#sys-power #sys-powerSaverBelow')`, "the Dock charge limit on System");
    await next.run(fill("#sys-dockChargeLimit", "75"));
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`!${saveBar}`, "the Dock charge limit to save");
    const dockSaved = (await adminGet("/admin/integrations")).settings.dockChargeLimit;
    if (dockSaved !== 75) throw new Error(`dockChargeLimit was saved as ${dockSaved}`);
    step("admin: Dock charge limit", "75 % saved on System");
    await next.run(`location.hash = '#system/backup'`);
    await next.until(`(window.scrollY > 0 || Math.abs(document.querySelector('#sys-backup').getBoundingClientRect().top) < 120)`, "the backup card to scroll into view");
    await next.run(`document.querySelector('#backup-now').click()`);
    await next.until(`[...document.querySelectorAll('.toast span')].some(t => /Backup made/.test(t.textContent)) && document.querySelector('#sys-backup-last')`, "the backup from the new page", 20000);
    await next.run(`${catchBlobs}; document.querySelector('#backup-download').click()`);
    const dbHead = await next.until(`window.blobs[0] && window.blobs[0].slice(0, 15).text()`, "the database download", 20000);
    if (dbHead !== "SQLite format 3") throw new Error(`the database download starts ${JSON.stringify(dbHead)}`);
    step("admin: system", `history kept 6 days saved; backup made (${await next.run(`document.querySelector('#sys-backup .badge')?.textContent`)}); database downloaded (${await next.run("window.blobs[0].size")} bytes)`);
    // Every ported page at a phone's width: nothing sticks out, the drawer opens and shuts.
    await next.phone(true);
    const wide = [];
    const narrow = ["overview", "live", "live/now", "activity", "clients", `clients/${dev.id}`, `clients/${dev.id}/settings`, `clients/${dev.id}/tools`, `clients/${dev.id}/danger`, `type/${dev.type}`, `type/${dev.type}/settings`, `type/${dev.type}/firmware`, "settings", "pair", "agent", "openclaw", "tools", "speech", "voices", "face", "firmware", "wakewords", "apps", "integrations", "system"];
    for (const page of narrow) {
      await next.run(`location.replace('#${page}')`);
      await new Promise((r) => setTimeout(r, 600));
      const over = await next.run(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      if (over > 0) wide.push(`${page}: ${over}px over`);
    }
    const shut = await next.run(`getComputedStyle(document.querySelector('#nav')).visibility === 'hidden'`);
    await next.run(`document.querySelector('#menu').click()`);
    await next.until(`getComputedStyle(document.querySelector('#nav')).visibility === 'visible'`, "the drawer to open");
    await next.run(`document.querySelector('#nav a[href="#pair"]').click()`);
    await next.until(`getComputedStyle(document.querySelector('#nav')).visibility === 'hidden' && document.querySelector('#where').textContent === 'Add a device'`, "the drawer to close on a choice");
    await next.phone(false);
    if (wide.length) throw new Error(`admin at phone width: ${wide.join(" | ")}`);
    step("admin: phone width", `${narrow.length} pages fit in 390 px; drawer shut=${shut}, opens, closes on a choice`);
  }
  // Removing the web client from the admin page: its name typed into the dialog, and the client notices.
  {
    const known = await fetch(`${base}/admin/clients`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.json());
    const web = known.clients.find((c) => c.type === "web") ?? known.clients[0];
    await next.run(`location.hash = '#clients/${web.id}/danger'`);
    await next.until(`document.querySelector('#device-remove') && !document.querySelector('#device-remove').disabled`, "the danger zone again");
    await next.run(`document.querySelector('#device-remove').click()`);
    await next.until(`document.querySelector('.dialog .btn.danger-solid')`, "the remove dialog");
    await next.run(`(i => { i.value = document.querySelector('.dialog .dlabel b').textContent; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('.dialog input'))`);
    await next.until(`document.querySelector('.dialog .btn.danger-solid')?.disabled === false`, "Remove to be enabled");
    await next.run(`document.querySelector('.dialog .btn.danger-solid').click()`);
  }
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
speech.close();
await new Promise((r) => setTimeout(r, 800));
for (const dir of [dataDir, backupDir, profile]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // Chrome can still be letting go of its profile. The folder is in the temp directory.
  }
}
process.exit(failed || problems.length ? 1 : 0);
