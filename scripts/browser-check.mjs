// Drives the admin page (the classic /admin and the new /admin-next) and the web client in headless Chrome against a real
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
  // --- admin page ---------------------------------------------------------
  const admin = await openPage(`${base}/admin`);
  await admin.run(`${byId("token")}.value = 'wrong'; ${byId("signin-form")}.requestSubmit()`);
  step("wrong admin token", await admin.until(`${byId("signin-error")}.textContent`, "sign-in error"));
  await admin.run(`${byId("token")}.value = 'browser-check-admin-token-0123'; ${byId("remember")}.checked = true; ${byId("signin-form")}.requestSubmit()`);
  await admin.until(`!${byId("app")}.classList.contains('hidden') && document.querySelectorAll('#summary .stat').length === 4`, "the admin page");
  step("token remembered on this device", await admin.run(`localStorage.getItem('axis-admin-token') === 'browser-check-admin-token-0123' && sessionStorage.getItem('axis-admin-token') === null`));
  step("summary", await admin.until(`(t => /agent=good/.test(t) && t)(${pills("#summary")})`, "upstream health"));
  step("gateway links", await admin.run(pills("#gw-pills")));
  step("commands listed", await admin.run(`${byId("gw-commands")}.textContent`));
  step("agent form", await admin.run(`'backend=' + ${byId("agent-backend")}.value + ', chat fields shown=' + !${byId("agent-openai")}.classList.contains('hidden')`));
  await admin.run(`${byId("speech-test")}.click()`);
  step("speech test", await admin.until(`(t => /Synthesis/.test(t) && t)(${byId("speech-note")}.textContent)`, "the speech test", 60000));
  // Realtime voice is offered only through an OpenClaw gateway; with the stub agent here the page says so and hides the controls.
  step("realtime voice", await admin.until(`${byId("talk-state")}.textContent === 'needs OpenClaw' && ${byId("talk-body")}.classList.contains('hidden') && ${byId("talk-note")}.textContent`, "the realtime voice section"));
  await admin.run(`${byId("gw-code")}.value = 'junk'; ${byId("gw-pair")}.click()`);
  step("bad setup code", await admin.until(`${byId("gw-note")}.textContent`, "the setup code error"));
  await admin.run(`location.hash = '#settings'`);
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

  // --- back on the admin page ---------------------------------------------
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
    // The bar is as far along as the steps, and a press on the line lists them with the one in hand marked.
    step("agent task bar and steps", await client.until(`(() => { const fill = ${byId("task-fill")}.style.width; if (fill !== '40%') return ''; ${byId("task-line")}.click(); const items = [...${byId("task-list")}.children]; return !${byId("task-list")}.classList.contains('hidden') && items.length === 5 && items[2].dataset.state === 'running' && 'bar ' + fill + ', ' + items.map(i => i.dataset.state[0] + ':' + i.textContent).join(' ') })()`, "the task's bar and steps"));
    // A second task that waits for the person takes the line; the first is counted and named in the list.
    app.progress.update({ id: "report", title: "Report", note: "which month?", state: "blocked" });
    step("two agent tasks", await client.until(`(() => { const items = [...${byId("task-list")}.children]; return ${byId("task-title")}.textContent === 'Report' && ${byId("task-more")}.textContent === '+1' && items.length === 1 && items[0].dataset.state === 'task' && ${byId("task-title")}.textContent + ' ' + ${byId("task-more")}.textContent + '; list starts "' + items[0].textContent + '"' })()`, "the second task on the line"));
    app.progress.clear("report");
    await client.until(`${byId("task-more")}.textContent === '' && ${byId("task-title")}.textContent === 'Backup'`, "the first task back on the line");
    await admin.front();
    const adminWas = await admin.run(`location.hash`);
    await admin.run(`location.replace('#live')`);
    step("agent task on the Live page", await admin.until(`(t => /Agent task/.test(t) && /Step 2 of 5: copying/.test(t) && 'listed')(${byId("live-now")}.textContent)`, "the task in Now"));
    await admin.run(`location.replace(${JSON.stringify(adminWas)} || '#overview')`);
    await client.front();
    app.progress.clear();
    await client.until(`${byId("task")}.classList.contains('hidden')`, "the task line to go");
    await admin.front();
    await admin.run(`location.replace('#live')`);
    step("agent task once over", await admin.until(`(t => /Backup/.test(t) && /cleared/.test(t) && /step 2 of 5/.test(t) && 'kept under finished tasks')(${byId("live-tasks")}.textContent)`, "the ended task on the Live page"));
    await admin.run(`location.replace(${JSON.stringify(adminWas)} || '#overview')`);
    await client.front();

    // A timer is one small chip under the words.
    const timer = app.timers.set(session, 600, "tea");
    step("timer chip", await client.until(`(t => !t.classList.contains('hidden') && /^9:5\\d$/.test(${byId("timer-text")}.textContent) && ${byId("timer-label")}.textContent + ' ' + ${byId("timer-text")}.textContent + ', ' + Math.round(t.getBoundingClientRect().height) + ' px tall, ' + getComputedStyle(t).fontSize)(${byId("timer")})`, "the timer chip"));
    app.timers.cancel({ id: timer.id });
    await client.until(`${byId("timer")}.classList.contains('hidden')`, "the timer to go");
  }
  await admin.front();
  step("client listed", await admin.until(`document.querySelector('#client-table tbody tr')?.textContent.replace(/\\s+/g, ' ').slice(0, 80)`, "the client row"));
  step("name shown as text, not markup", await admin.run(`document.querySelectorAll('#client-table b').length === 0`));
  // The overview and the activity page, after the turns above.
  // The live view: the turns just made, step by step, as the stream hands them over.
  await admin.run(`location.hash = '#live'`);
  step("live view", await admin.until(`document.querySelectorAll('#live-turns .turn-card').length >= 2 && /watching/.test(${byId("live-state")}.textContent) && [...document.querySelectorAll('#live-turns .turn-card')].find(c => /Typed/.test(c.textContent))?.textContent.replace(/\\s+/g, ' ').slice(0, 200)`, "the live turns"));
  await admin.run(`location.hash = '#integrations'`);
  step("integrations", await admin.until(`[...document.querySelectorAll('.integration-head')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`, "the integrations"));
  // A field edited where it is shown: the history length, saved from its own card.
  await admin.run(`(i => { i.value = '5'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('.integration').querySelector('button.primary').click(); })(document.querySelector('.integration input[name="activityDays"]'))`);
  step("integration setting saved", await admin.until(`(t => /saved/.test(t) && t)(${byId("toast")}.textContent)`, "the save"));
  const hubSaved = await fetch(`${base}/admin/integrations`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.json());
  if (hubSaved.settings.activityDays !== 5) throw new Error(`activityDays was saved as ${hubSaved.settings.activityDays}`);
  // Agent tools: a token made on the page lets an MCP client in; a tool switched off there is gone for it.
  {
    await admin.run(`location.hash = '#tools'`);
    await admin.until(`document.querySelectorAll('#tools-list tbody tr').length === 11 && ${byId("mcp-url")}.value.endsWith('/mcp')`, "the tools page");
    await admin.run(`${byId("mcp-token-name")}.value = 'Browser check'; ${byId("mcp-token-new")}.click()`);
    const agentToken = await admin.until(`!${byId("mcp-token-made")}.classList.contains('hidden') && ${byId("mcp-token-value")}.value`, "the new token");
    await admin.until(`/Browser check/.test(${byId("mcp-tokens")}.textContent)`, "the token in the list");
    const mcp = (method, params) =>
      fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
    // A switch is its drawn size, with its knob inside it, here and at a phone's width.
    const switchShape = `(i => { const r = i.getBoundingClientRect(), k = getComputedStyle(i, '::after'); return Math.round(r.width) + 'x' + Math.round(r.height) + ' knob ' + k.width + ' at ' + k.left; })(document.querySelector('#tools-list .switch input:checked'))`;
    const wide = await admin.run(switchShape);
    await admin.phone(true);
    const narrow = await admin.run(switchShape);
    await admin.phone(false);
    if (wide !== "34x20 knob 14px at 16px" || narrow !== wide) throw new Error(`a switch is drawn wrong: ${wide} on a desktop, ${narrow} on a phone`);
    step("switches", `${wide}, the same on a phone`);
    const before = (await mcp("tools/list")).result.tools.length;
    await admin.run(`document.querySelector('#tools-list input[aria-label="vortex_axis_admin"]').click()`);
    await admin.until(`/vortex_axis_admin is off/.test(${byId("tools-note")}.textContent)`, "the tool to be switched off");
    const after = (await mcp("tools/list")).result.tools.map((t) => t.name);
    const listed = (await mcp("tools/call", { name: "vortex_axis_clients", arguments: {} })).result;
    if (after.includes("vortex_axis_admin") || listed.isError) throw new Error("the MCP door did not follow the page");
    step("agent tools by MCP", `token made on the page works; ${before} tools, ${after.length} after switching admin off; clients tool answered with ${listed.structuredContent.clients.length} device(s)`);
    await admin.run(`document.querySelector('#tools-list input[aria-label="vortex_axis_admin"]').click()`);
    await admin.until(`/vortex_axis_admin is on/.test(${byId("tools-note")}.textContent)`, "the tool to be switched back on");
    // Trying a tool from the page: the say form offers every device, and the clients tool answers in the page.
    await admin.run(`[...document.querySelectorAll('#tools-list tr')].find(r => r.textContent.includes('vortex_axis_say')).querySelector('button').click()`);
    await admin.until(`[...document.querySelectorAll('#try-fields option')].some(o => o.value === 'everywhere') && document.querySelector('#try-fields textarea')`, "the say form");
    await admin.run(`document.querySelector('#try-fields select').value = 'everywhere'; document.querySelector('#try-fields textarea').value = 'hello'; document.querySelector('#try-fields textarea').dispatchEvent(new Event('input'))`);
    const sends = await admin.run(`${byId("try-args")}.textContent`);
    if (sends !== '{"everywhere":true,"text":"hello"}') throw new Error(`the say form would send ${sends}`);
    await admin.run(`${byId("try-tool")}.value = 'vortex_axis_clients'; ${byId("try-tool")}.dispatchEvent(new Event('change')); ${byId("try-run")}.click()`);
    await admin.until(`/"clients"/.test(document.querySelector('#try-result pre')?.textContent ?? '')`, "the clients tool's answer");
    step("trying a tool", `say form sends ${sends}; clients tool answered on the page`);
    // The call just tried is on the Live page, with who made it.
    await admin.run(`location.hash = '#live'`);
    await admin.until(`[...document.querySelectorAll('#live-calls tbody tr')].some(r => r.textContent.includes('vortex_axis_clients') && r.textContent.includes('Admin page'))`, "the tool call on the Live page");
    step("tool calls on the live page", await admin.run(`document.querySelector('#live-calls tbody tr').textContent`));
    await admin.run(`location.hash = '#integrations'`);
    await admin.until(`document.querySelectorAll('.integration').length >= 5`, "the integrations page again");
  }
  // Backup: made from its card, into the folder this run was given.
  await admin.run(`[...document.querySelectorAll('.integration button')].find(b => b.textContent === 'Back up now').click()`);
  step("backup from the page", await admin.until(`(t => /Backup made/.test(t) && t)(${byId("toast")}.textContent) && [...document.querySelectorAll('.integration-head')].find(e => /^Backup/.test(e.textContent)).textContent.replace(/\\s+/g, ' ')`, "the backup", 20000));
  if (!existsSync(join(backupDir, "axis.sqlite"))) throw new Error("the backup made from the page left no database copy");
  // Clearing the live view deletes the words Axis holds, and the page shows it.
  await admin.run(`location.hash = '#live'`);
  await admin.until(`document.querySelectorAll('#live-turns .turn-card').length >= 2 && ${byId("live-now")}.textContent`, "the live page again");
  await admin.run(`${byId("live-clear")}.click()`);
  step("live view cleared", await admin.until(`document.querySelectorAll('#live-turns .turn-card').length === 0 && ${byId("live-turns")}.textContent.slice(0, 40)`, "the turns to go"));
  await admin.run(`location.hash = '#wakewords'`);
  step("wake scores", await admin.until(`${byId("wake-scores")}.textContent.slice(0, 50)`, "the wake scores"));
  // One message to every device, from the overview.
  await admin.run(`location.hash = '#overview'`);
  await admin.until(`${byId("announce-target")}.options.length >= 2`, "the places to say something");
  await admin.run(`${byId("announce-text")}.value = 'Testing, one two.'; ${byId("announce-send")}.click()`);
  step("announce to every device", await admin.until(`document.querySelector('#announce-result table')?.textContent.replace(/\\s+/g, ' ')`, "the announcement to be delivered", 40000));

  await admin.run(`location.hash = '#overview'`);
  step("overview", await admin.until(`${byId("overview-tiles")}.textContent.replace(/\\s+/g, ' ').trim() && document.querySelector('#overview-strips .strip') && ${byId("overview-tiles")}.textContent.replace(/\\s+/g, ' ')`, "the overview"));
  step("attention", await admin.run(`[...document.querySelectorAll('#attention li')].map(l => l.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`));
  step("activity turns", await admin.until(`document.querySelectorAll('#activity-turns tbody tr').length >= 2 && [...document.querySelectorAll('#activity-turns tbody tr')].map(r => r.children[2].textContent + ':' + r.children[3].textContent.trim()).join(', ')`, "the turns on the activity page"));
  step("activity chart drawn", await admin.until(`document.querySelector('#chart-turns svg') && 'yes'`, "the turns chart"));
  // The words of a turn must never reach the activity log: not on the page, not from the API.
  const wordsKept = await admin.run(`fetch('/admin/activity?hours=24', { headers: { authorization: 'Bearer browser-check-admin-token-0123' } })
    .then(r => r.text()).then(t => /what time is it|nine o'clock/.test(t + document.getElementById('activity-turns').textContent + document.getElementById('activity-events').textContent))`);
  step("no words stored", !wordsKept);
  if (wordsKept) throw new Error("what was said turned up in the activity log");
  await admin.run(`location.hash = '#clients'`);
  // The device editor. A real board describes its settings itself; here the schema is stored directly.
  app.store.saveSchema("web", {
    settings: [
      { key: "volume", label: "Volume", kind: "number", group: "Sound", min: 0, max: 100, default: 60, unit: "%" },
      { key: "listenCue", label: "Listening cue", kind: "toggle", group: "Sound", default: 1 },
      { key: "rotation", label: "Rotation", kind: "choice", group: "Screen", options: [0, 90, 180, 270], default: 90 },
    ],
    actions: [{ name: "diag", label: "Diagnostics" }, { name: "mic", label: "Microphone levels" }],
    links: [],
  });
  await admin.run(`document.querySelector('#client-table tbody a').click()`);
  step("device editor", await admin.until(`${byId("device")}.classList.contains('on') && (t => /volume/.test(t) && t)([...document.querySelectorAll('#device-settings .mono')].map(e => e.textContent).join(', '))`, "the device settings (the page polls every 3 s)"));
  // The microphone level panel, for a device offering `mic`: the web client does not, so its answer is a refusal, shown.
  await admin.run(`${byId("device-mic-go")}.click()`);
  step("microphone levels", await admin.until(`${byId("device-mic-go")}.textContent === 'Stop' && /bad/.test(${byId("device-mic-note")}.className) && ${byId("device-mic-note")}.textContent`, "the mic panel to read and show the answer"));
  await admin.run(`${byId("device-mic-go")}.click()`);
  step("microphone levels stopped", await admin.until(`${byId("device-mic-go")}.textContent === 'Start' && 'stopped'`, "the mic panel to stop"));
  const row = (box, key) => `document.querySelector('${box} tr[data-key=${key}]')?.textContent.replace(/\\s+/g, ' ')`;
  // Where a value comes from: "this device", "this type", "type", "all devices" or "default".
  const source = (box, key) => `document.querySelector('${box} tr[data-key=${key}] td.src')?.textContent`;
  const change = (selector, value) => `(i => { if (i.type === 'checkbox') i.checked = ${JSON.stringify(value)}; else i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('change')); })(document.querySelector('${selector}'))`;
  // A value on this device only, then one the server refuses.
  await admin.run(change("#device-settings input[data-edit=volume]", "35"));
  step("device value", await admin.until(`${source("#device-settings", "volume")} === 'this device' && ${row("#device-settings", "volume")}`, "the volume to save"));
  await admin.run(change("#device-settings input[data-edit=volume]", "150"));
  step("range refused", await admin.until(`(t => /at most 100/.test(t) && t)(${byId("toast")}.textContent)`, "the range error"));
  // Rename and location, at the top of the device page.
  await admin.run(change("#device-head input[data-edit=name]", "Browser renamed"));
  step("renamed", await admin.until(`(t => t === 'Browser renamed' && t)(${byId("device-title")}.textContent)`, "the new name"));
  await admin.run(change("#device-head input[data-edit=location]", "office"));
  step("location", await admin.until(`(t => /office/.test(t) && t)(document.querySelector('#client-table tbody tr')?.textContent)`, "the location in the list"));
  // The sketch beside the details: a browser frame for the web client, its state and what it has.
  step("device sketch", await admin.until(`${byId("device-frame")}.classList.contains('browser') && ${byId("device-doing")}.textContent && document.querySelectorAll('#device-can .chip').length === 3 && (${byId("device-frame")}.className + ', ' + ${byId("device-doing")}.textContent)`, "the device sketch"));
  // The type page: a value every web device shares, which the device then shows as coming from its type.
  await admin.run(`location.hash = '#type/web'`);
  await admin.until(`document.querySelector('#type-settings input[data-edit=listenCue]')`, "the type page");
  step("type page lists the device", await admin.run(`${byId("type-devices")}.textContent.replace(/\\s+/g, ' ')`));
  step("type page shows who differs", await admin.until(`(t => /differs on/.test(t) && t)(${row("#type-settings", "volume")})`, "the volume override on the type page"));
  await admin.run(change("#type-settings input[data-edit=listenCue]", false));
  step("type layer toggle", await admin.until(`${source("#type-settings", "listenCue")} === 'this type' && ${row("#type-settings", "listenCue")}`, "the type toggle to save"));
  await admin.run(`history.back()`);
  step("device follows its type", await admin.until(`${source("#device-settings", "listenCue")} === 'type' && ${row("#device-settings", "listenCue")}`, "the device to show the type's value"));
  // Back to shared: the device's volume, then the type's cue.
  await admin.run(`document.querySelector('#device-settings tr[data-key=volume] button[title^="Remove"]').click()`);
  step("device back to shared", await admin.until(`${source("#device-settings", "volume")} === 'default' && ${row("#device-settings", "volume")}`, "the volume to follow the default again"));
  await admin.run(`location.hash = '#type/web'`);
  await admin.until(`${byId("type")}.classList.contains('on') && document.querySelector('#type-settings tr[data-key=listenCue] button')`, "the type page again");
  await admin.run(`document.querySelector('#type-settings tr[data-key=listenCue] button').click()`);
  step("type reset", await admin.until(`${source("#type-settings", "listenCue")} === 'default' && ${row("#type-settings", "listenCue")}`, "the type reset"));
  // The firmware page: upload a build from the page's own form, see it listed as the one that is sent.
  await admin.run(`location.hash = '#firmware'`);
  await admin.until(`${byId("firmware")}.classList.contains('on') && ${byId("firmware-shelves")}.textContent.includes('No builds held')`, "the firmware page");
  await admin.run(`(() => {
    const bytes = new Uint8Array(70000); bytes[0] = 0xe9;
    const files = new DataTransfer(); files.items.add(new File([bytes], 'firmware.bin'));
    ${byId("firmware-file")}.files = files.files;
    ${byId("firmware-type")}.value = 'web';
    ${byId("firmware-version")}.value = '9.9.9';
    ${byId("firmware-upload")}.click();
  })()`);
  step("firmware uploaded", await admin.until(`${byId("firmware-shelves")}.textContent.includes('sent to devices') && ${byId("firmware-shelves")}.textContent.replace(/\\s+/g, ' ')`, "the build to be listed"));
  await admin.run(`window.confirm = () => true; [...document.querySelectorAll('#firmware-shelves button')].find((b) => b.textContent === 'Remove').click()`);
  // Every page at a phone's width: nothing may stick out past the screen except inside a box that scrolls.
  {
    await admin.phone(true);
    const known = await fetch(`${base}/admin/clients`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.json());
    const pages = ["overview", "live", "tools", "clients", `clients/${known.clients[0].id}`, "type/web", "settings", "pair", "openclaw", "agent", "speech", "firmware", "wakewords", "face", "integrations"];
    const wide = [];
    for (const page of pages) {
      await admin.run(`location.replace('#${page}')`);
      await new Promise((r) => setTimeout(r, 700));
      const found = JSON.parse(await admin.run(`(() => {
        const w = document.documentElement.clientWidth, out = [];
        for (const el of document.querySelectorAll('.bar, .bar *, main *')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || r.right <= w + 1) continue;
          let p = el.parentElement, boxed = false;
          for (; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') { boxed = true; break; }
          if (!boxed) out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '') + '@' + Math.round(r.right));
        }
        const small = [...document.querySelectorAll('main button, main a.button, .bar button')].filter(b => b.offsetWidth && b.offsetHeight < 32).length;
        // When the page is too wide and nothing in it explains why, name whatever reaches furthest, wherever it is.
        if (!out.length && document.documentElement.scrollWidth > w) {
          // Text can run out of a box that itself fits, so the box's own scroll width is what gives it away.
          const far = [...document.querySelectorAll('body *')].filter((el) => el.offsetWidth && (el.getBoundingClientRect().right > w + 1 || el.getBoundingClientRect().left + el.scrollWidth > w + 1) && getComputedStyle(el).overflowX === 'visible').slice(-4);
          out.push(...far.map((el) => 'far:' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '') + '@' + Math.round(el.getBoundingClientRect().right)));
        }
        return JSON.stringify({ over: document.documentElement.scrollWidth - w, who: out.slice(0, 5), small });
      })()`));
      if (found.over > 0 || found.who.length || found.small) wide.push(`${page}: ${found.over}px over, ${found.who.join(" ")}${found.small ? `, ${found.small} small buttons` : ""}`);
    }
    // The sidebar is a drawer here: shut until the menu button is pressed, and shut again once a page is chosen.
    const shut = await admin.run(`getComputedStyle(${byId("nav")}).visibility === 'hidden' && getComputedStyle(${byId("menu")}).display !== 'none'`);
    await admin.run(`location.replace('#firmware')`);
    await admin.run(`${byId("menu")}.click()`);
    const opened = await admin.until(`getComputedStyle(${byId("nav")}).visibility === 'visible'`, "the menu to open");
    await admin.run(`document.querySelector('#nav a[data-view="firmware"]').click()`);
    await admin.until(`getComputedStyle(${byId("nav")}).visibility === 'hidden' && ${byId("firmware")}.classList.contains('on') && ${byId("where")}.textContent === 'Firmware'`, "the menu to close on a choice");
    await admin.phone(false);
    if (wide.length) throw new Error(`at phone width: ${wide.join(" | ")}`);
    step("phone width", `${pages.length} pages fit in 390 px; menu drawer shut=${shut}, opens=${opened}, closes on a choice`);
  }
  step("firmware removed", await admin.until(`${byId("firmware-shelves")}.textContent.includes('No builds held') && 'gone'`, "the build to go"));

  // The face viewer: every look as a tile, and choosing one fills in its numbers.
  await admin.run(`location.hash = '#face'`);
  await admin.until(`document.querySelectorAll('.face-tile').length >= 20`, "the face tiles");
  await admin.run(`document.querySelector('.face-tile[data-look="galaxy"]').click()`);
  step("face viewer", await admin.until(`${byId("face-name")}.textContent.startsWith('galaxy') && document.querySelectorAll('#face-numbers tr').length === 13 && (document.querySelectorAll('.face-tile').length + ' looks, galaxy chosen')`, "a look to be chosen"));
  // Switching an idle look off saves it for every device, and the tile dims.
  await admin.run(`document.querySelector('.face-cell[data-look="curl"] input').click()`);
  step("idle look off", await admin.until(`document.querySelector('.face-cell[data-look="curl"]').classList.contains('off') && ${byId("face-note")}.textContent`, "the look to be switched off"));
  const shared = await fetch(`${base}/admin/settings/global`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.json());
  if (shared.values.idleLooksOff !== "curl") throw new Error(`idleLooksOff was saved as ${JSON.stringify(shared.values.idleLooksOff)}`);
  // Tool icons: one tile per kind, shown large when chosen, and the style saved for every device.
  await admin.run(`document.querySelector('.face-tile[data-look="icon:home"]').click()`);
  step("tool icons", await admin.until(`${byId("face-name")}.textContent === 'home (tool icon)' && document.querySelectorAll('#face-icons .face-tile').length === 13 && document.querySelector('#face-icon-style button.on')?.dataset.style === 'dots' && '13 kinds, home chosen, shown as dots'`, "the tool icons"));
  // Something is really drawn in the middle of the large face: with the icon made of dots, the core is gone and the house's roof is lit.
  // The faces only move while their page is the one in front.
  await admin.front();
  step("tool icon drawn", await admin.until(`(() => { const c = ${byId("face-big")}, g = c.getContext('2d'), w = c.width; const lit = (x0, y0, x1, y1) => { const d = g.getImageData(Math.round(w * x0), Math.round(w * y0), Math.round(w * (x1 - x0)), Math.round(w * (y1 - y0))).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) n++; return n; }; const roof = lit(0.4, 0.25, 0.6, 0.37), core = lit(0.45, 0.45, 0.55, 0.55); return roof > 30 && core === 0 && 'roof lit (' + roof + ' px), centre dark'; })()`, "the dots to form the house", 8000));
  // Fewer dots in the shape: saved for every device, and the rest stand off in a ring, so the centre stays dark.
  await admin.run(`(() => { const s = ${byId("face-icon-dots")}; s.value = '36'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  step("tool icon dots", await admin.until(`/36 of 78/.test(${byId("face-icon-dots-note")}.textContent) && /saved/.test(${byId("face-icons-note")}.textContent) && ${byId("face-icon-dots-note")}.textContent`, "the number of dots to be saved"));
  const tuned = await fetch(`${base}/admin/settings/global`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.json());
  if (tuned.values.toolIconDots !== 36) throw new Error(`toolIconDots was saved as ${JSON.stringify(tuned.values.toolIconDots)}`);
  await admin.run(`document.querySelector('#face-icon-style button[data-style="line"]').click()`);
  step("tool icon style", await admin.until(`document.querySelector('#face-icon-style button.on')?.dataset.style === 'line' && ${byId("face-icons-note")}.textContent`, "the style to be saved"));
  const styled = await fetch(`${base}/admin/settings/global`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.json());
  if (styled.values.toolIcons !== "line") throw new Error(`toolIcons was saved as ${JSON.stringify(styled.values.toolIcons)}`);
  // --- the new admin page (/admin-next): the same sign-in, the Devices area -----------------------------
  {
    const next = await openPage(`${base}/admin-next`);
    await next.front();
    // The token the classic page kept serves this page too.
    step("new admin: one sign-in for both", await next.until(`document.querySelector('#main') && document.querySelectorAll('.health .dot').length >= 4 && 'signed in from the classic page\\'s token'`, "the new page to sign in"));
    // Every old address still lands somewhere; #device/<id> is an alias of #clients/<id>.
    const known = await fetch(`${base}/admin/clients`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.json());
    const dev = known.clients[0];
    const routes = [];
    for (const [hash, expect] of [["#clients", "All devices"], [`#clients/${dev.id}`, dev.name], [`#device/${dev.id}`, dev.name], [`#clients/${dev.id}/settings`, dev.name], [`#type/${dev.type}`, null], ["#type", "Defaults for everything"], ["#settings", "Defaults for everything"], ["#pair", "Add a device"], ["#activity", "History"], ["#live", "Live"], ["#openclaw", "OpenClaw gateway"], ["#agent", "Who answers"], ["#tools", "Tools and MCP"], ["#speech", "Speech"], ["#voices", "Voices"], ["#face", "Face and screen"], ["#firmware", "Firmware"], ["#wakewords", "Wake words"], ["#apps", "Apps"], ["#integrations", "Integrations"], ["#system", "System"], ["#system/backup", "System"], ["#nonsense", "Overview"]]) {
      await next.run(`location.hash = ${JSON.stringify(hash)}`);
      const title = await next.until(`(t => t && (${JSON.stringify(expect)} === null || t === ${JSON.stringify(expect)}) && t)(document.querySelector('main h1')?.textContent)`, `the page for ${hash}`);
      routes.push(`${hash.replace(dev.id, "<id>")}→${title}`);
    }
    step("new admin: old addresses", routes.join(", "));
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
    step("new admin: no classic links", "none on seven pages, nor in the health strip, attention list or sidebar");
    // The command bar: Ctrl+K, type, Enter opens the device; Escape closes it.
    await next.run(`location.hash = '#overview'`);
    await next.run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
    await next.until(`document.querySelector('.cmdk input') === document.activeElement`, "the command bar");
    await next.run(`(i => { i.value = ${JSON.stringify(dev.name.slice(0, 5))}; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('.cmdk input'))`);
    await next.until(`document.querySelector('.cmdk-it.on')`, "a result");
    await next.run(`document.querySelector('.cmdk input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    step("new admin: command bar", await next.until(`!document.querySelector('.cmdk') && location.hash.startsWith('#clients/') && 'Ctrl+K, typed, Enter opened ' + document.querySelector('main h1').textContent`, "the device from the command bar"));
    await next.run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
    await next.until(`document.querySelector('.cmdk input')`, "the command bar again");
    await next.run(`document.querySelector('.cmdk input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await next.until(`!document.querySelector('.cmdk')`, "Escape to close the command bar");
    // All devices: a card per device, the filter, the list view.
    await next.run(`location.hash = '#clients'`);
    step("new admin: all devices", await next.until(`document.querySelectorAll('#device-list [data-device]').length === ${known.clients.length} && [...document.querySelectorAll('#device-list .nm span:first-child')].map(e => e.textContent).join(', ')`, "the device cards"));
    step("new admin: names as text", await next.run(`document.querySelectorAll('main b, main .nm b').length === 0 || ![...document.querySelectorAll('main b')].some(b => b.textContent === 'test')`));
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
    step("new admin: staged save", `typed 35, kept through a poll, ${await next.run(`[...document.querySelectorAll('.toast span')].map(t => t.textContent).join(' | ')`)}`);
    await next.run(`[...document.querySelectorAll('.toast button')].find(b => b.textContent === 'Undo').click()`);
    await next.until(`document.querySelector('[data-key=volume] .src-chip')?.textContent !== 'this device'`, "the undo");
    step("new admin: undo", `volume on the device layer is ${JSON.stringify(app.store.getLayer("device", dev.id).volume ?? null)} again`);
    // A value the server refuses: the bar says why and keeps the change.
    await next.run(typeIn("volume", "150"));
    await next.until(`document.querySelector('[data-key=volume] .src-chip')?.textContent === 'refused'`, "the range check");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    step("new admin: range refused", await next.until(`(t => /at most 100/.test(t) && t)(document.querySelector('.save-error')?.textContent ?? '')`, "the refusal"));
    // A value equal to what the layers below give stores nothing (it keeps following the shared value).
    await next.run(typeIn("volume", "60"));
    await next.until(`!document.querySelector('.banner .savebar')`, "typing the inherited value to stage nothing");
    await next.run(typeIn("volume", "61"));
    await next.run(typeIn("volume", "60"));
    step("new admin: inherited value", await next.run(`!document.querySelector('.banner .savebar') && 'typing the value it already follows stages nothing'`));
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
    step("new admin: several changes in one save", `listenCue ${saved.listenCue}, rotation ${saved.rotation}, name ${rec.name}, off ${rec.off.join(",")}`);
    await next.run(`[...document.querySelectorAll('.toast button')].find(b => b.textContent === 'Undo').click()`);
    await next.until(`document.querySelector('#device-title').textContent === ${JSON.stringify(dev.name)}`, "the undo of all four");
    if (app.store.getClient(dev.id).off.length || app.store.getLayer("device", dev.id).listenCue !== undefined) throw new Error("undo left something behind");
    await next.run(typeIn("volume", "20"));
    await next.run(`[...document.querySelectorAll('.banner .savebar button')].find(b => b.textContent === 'Discard').click()`);
    step("new admin: undo all, discard", await next.until(`!document.querySelector('.banner .savebar') && document.querySelector('[data-edit=volume]').value !== '20' && 'undone, discarded'`, "the discard"));
    // Share with type: the device's value becomes its type's.
    await next.run(typeIn("volume", "45"));
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    await next.until(`document.querySelector('[data-key=volume] .src-chip')?.textContent === 'this device'`, "the volume on the device");
    await next.run(`[...document.querySelectorAll('[data-key=volume] button')].find(b => b.textContent === 'Share with type').click()`);
    await next.until(`document.querySelector('[data-key=volume] .src-chip')?.textContent === 'type'`, "the value to move to the type");
    step("new admin: share with type", `type layer volume ${app.store.getLayer("type", dev.type).volume}, device layer ${JSON.stringify(app.store.getLayer("device", dev.id).volume ?? null)}`);
    // The type page: the type's value, who differs, and a reset back to the default.
    await next.run(`location.hash = '#type/${dev.type}/settings'`);
    await next.until(`document.querySelector('.banner[data-layer=type]') && document.querySelector('[data-key=volume] .src-chip')?.textContent === 'this type'`, "the type's settings");
    await next.run(`document.querySelector('[data-reset=volume]').click()`);
    await next.until(`document.querySelector('.banner [data-save]')`, "the reset to be staged");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    await next.until(`document.querySelector('[data-key=volume] .src-chip')?.textContent === 'default'`, "the type value to go");
    step("new admin: type reset", `type layer volume now ${JSON.stringify(app.store.getLayer("type", dev.type).volume ?? null)}, the row says default`);
    // Defaults for everything: every Axis built-in, a raw key added and cleared.
    await next.run(`location.hash = '#settings'`);
    step("new admin: defaults list the built-ins", await next.until(`(k => k.includes('quietFrom') && k.includes('offlineAlert') && k.includes('defaultClient') && k.length + ' keys')([...document.querySelectorAll('[data-key]')].map(r => r.dataset.key))`, "the built-ins"));
    await next.run(`(k => { k.value = 'ledColor'; k.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('#set-key')); (v => { v.value = 'blue'; v.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('#set-value'))`);
    await next.run(`document.querySelector('#set-add').click()`);
    await next.until(`document.querySelector('[data-key=ledColor]') && document.querySelector('.banner [data-save]')`, "the staged raw key");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    await next.until(`document.querySelector('[data-key=ledColor] .src-chip')?.textContent === 'everything'`, "the raw key to save");
    if (app.store.getLayer("global", "").ledColor !== "blue") throw new Error("the raw key was not saved");
    await next.run(`document.querySelector('[data-reset=ledColor]').click()`);
    await next.until(`document.querySelector('.banner [data-save]')`, "the reset to be staged");
    await next.run(`document.querySelector('.banner [data-save]').click()`);
    step("new admin: other keys", await next.until(`!document.querySelector('[data-key=ledColor]') && 'ledColor added and cleared'`, "the raw key to clear"));
    // The device page's tabs: actions, the mic panel (the web client refuses it, shown), the danger zone's typed confirmation.
    await next.run(`location.hash = '#clients/${dev.id}'`);
    await next.until(`document.querySelector('#device-facts')`, "the device overview");
    await next.run(`[...document.querySelectorAll('.dmain .btnrow button')].find(b => b.textContent === 'Diagnostics')?.click()`);
    step("new admin: device action", await next.until(`document.querySelector('#action-note')?.textContent`, "the action's answer"));
    await next.run(`location.hash = '#clients/${dev.id}/tools'`);
    await next.until(`document.querySelector('#mic-go')`, "the mic panel");
    await next.run(`document.querySelector('#mic-go').click()`);
    step("new admin: microphone levels", await next.until(`document.querySelector('#mic-go').textContent === 'Stop' && /bad/.test(document.querySelector('#mic-note').className) && document.querySelector('#mic-note').textContent`, "the mic answer"));
    await next.run(`document.querySelector('#mic-go').click()`);
    await next.run(`location.hash = '#clients/${dev.id}/danger'`);
    await next.until(`document.querySelector('#device-remove')`, "the danger zone");
    await next.run(`document.querySelector('#device-remove').click()`);
    await next.until(`document.querySelector('.dialog .btn.danger-solid')?.disabled === true`, "the typed confirmation");
    await next.run(`document.querySelector('.dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    step("new admin: remove asks for the name", await next.until(`!document.querySelector('.dialog') && 'Remove disabled until the name is typed; Escape closed it'`, "Escape to close the dialog"));
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
    step("new admin: setup string and QR", `${first.replace(/\d{3}-\d{3}/, "<code>")}, then ${tls.replace(/\d{3}-\d{3}/, "<code>")}; the QR code reads back as the setup string`);
    // The theme switch: light, remembered, and back.
    await next.run(`[...document.querySelectorAll('.side .theme button')].find(b => b.textContent === 'Light').click()`);
    step("new admin: theme", await next.until(`document.documentElement.dataset.theme === 'light' && localStorage.getItem('axis.theme') === 'light' && getComputedStyle(document.body).backgroundColor`, "the light theme"));
    await next.run(`[...document.querySelectorAll('.side .theme button')].find(b => b.textContent === 'Dark').click()`);
    // Stage 3: the Overview dashboard, Say something, History and Live, as the classic page's steps above.
    await next.run(`location.hash = '#overview'`);
    step("new admin: overview", await next.until(`(t => /Axis running for/.test(t) && /Turns, last 24 hours\\s*\\d/.test(t) && document.querySelector('#attention') && document.querySelector('#now') && document.querySelectorAll('.ov-devs [data-device]').length && t.replace(/\\s+/g, ' '))(document.querySelector('#kpis')?.innerText ?? '')`, "the overview's numbers"));
    await next.until(`document.querySelectorAll('#say-target option').length >= 2`, "the places to say something");
    await next.run(`document.querySelector('#say-go').click()`);
    await next.until(`/Type what to say first/.test(document.querySelector('.say .msg.bad')?.textContent ?? '')`, "the empty message refused");
    await next.run(`(i => { i.value = 'Testing, one two.'; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('#say-text')); setTimeout(() => document.querySelector('#say-go').click(), 50)`);
    step("new admin: say something", await next.until(`document.querySelector('#say-result')?.textContent.replace(/\\s+/g, ' ')`, "the announcement to be delivered", 40000));
    await next.run(`location.hash = '#activity'`);
    step("new admin: history", await next.until(`document.querySelectorAll('#recent-turns tbody tr').length >= 2 && document.querySelector('#chart-turns svg') && document.querySelector('#strips .strip') && document.querySelectorAll('#events tbody tr').length && [...document.querySelectorAll('#recent-turns tbody tr')].slice(0, 3).map(r => r.children[2].textContent + ':' + r.children[3].textContent.trim()).join(', ')`, "the history page"));
    await next.run(`(s => { s.value = 'client'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('#event-filter'))`);
    await next.until(`[...document.querySelectorAll('#events tbody tr')].every(r => r.children[1].textContent === 'client')`, "the events filtered to connections");
    await next.run(`[...document.querySelectorAll('#range button')].find(b => b.textContent === '7 days').click()`);
    step("new admin: history range", await next.until(`document.querySelector('#range button[aria-pressed=true]')?.textContent === '7 days' && !document.querySelector('#history[aria-busy]') && document.querySelector('#chart-latency') && 'events filtered to connections; 7 days loaded'`, "the 7 day range"));
    if (await next.run(`/what time is it|nine o'clock/.test(document.querySelector('main').textContent)`)) throw new Error("what was said turned up on the new History page");
    // Live: a typed turn on the web client shows up as it happens; Clear now takes the words away.
    await next.run(`location.hash = '#live'`);
    await next.until(`/watching/.test(document.querySelector('#live-state')?.textContent ?? '')`, "the live stream");
    await client.run(`${byId("say")}.value = 'what time is it'; ${byId("say-form")}.requestSubmit()`);
    step("new admin: live", await next.until(`[...document.querySelectorAll('#live-turns .turn-card')].find(c => /Typed/.test(c.textContent) && /answered/.test(c.textContent))?.textContent.replace(/\\s+/g, ' ').slice(0, 160)`, "the typed turn on Live", 20000));
    await next.run(`document.querySelector('#live-clear').click()`);
    step("new admin: live cleared", await next.until(`!document.querySelector('#live-turns .turn-card') && [...document.querySelectorAll('.toast span')].some(t => /Cleared/.test(t.textContent)) && document.querySelector('#live-turns').textContent.slice(0, 40)`, "the turns to go"));
    for (const tab of ["now", "calls", "wakes", "tasks"]) {
      await next.run(`location.hash = '#live/${tab}'`);
      await next.until(`document.querySelector('.tabs a.on')?.getAttribute('href') === '#live/${tab}' && document.querySelector('#live-tab').textContent.trim()`, `the ${tab} tab`);
    }
    step("new admin: live tabs", "now, tool calls, wake words, tasks finished");
    // --- Agent and voice (stage 4): every function of the classic #agent, #openclaw, #tools and #speech pages ---
    const adminGet = (path) => fetch(`${base}${path}`, { headers: { authorization: "Bearer browser-check-admin-token-0123" } }).then((r) => r.json());
    const fill = (selector, value, event = "input") => `(i => { i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })(document.querySelector(${JSON.stringify(selector)}))`;
    const saveBar = `document.querySelector('.savebar.floating')`;
    // The Undo of the newest toast that has one: the save just made.
    const undoToast = `[...document.querySelectorAll('.toast')].filter(t => [...t.querySelectorAll('button')].some(b => b.textContent === 'Undo')).at(-1).querySelector('.btn').click()`;
    const toastTexts = () => next.run(`[...document.querySelectorAll('.toast span')].map(t => t.textContent).join(' | ')`);
    await next.run(`location.hash = '#agent'`);
    step("new admin: who answers", await next.until(`(b => b === 'openai' && document.querySelector('#agent-url') && !document.querySelector('#agent-note') && 'chat endpoint, its fields shown')(document.querySelector('[data-f=backend] button.on')?.dataset.v)`, "the agent form"));
    await next.run(`document.querySelector('#agent-test').click()`);
    step("new admin: test the endpoint", await next.until(`(t => /It works/.test(t) && t.slice(0, 60))(document.querySelector('#agent-test-note')?.textContent ?? '')`, "the endpoint test", 20000));
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
    step("new admin: agent staged save", "model saved after Stay on the leave dialog, then undone");
    await next.run(`location.hash = '#openclaw'`);
    step("new admin: gateway links", await next.until(`(t => /turns:/.test(t) && /commands:/.test(t) && t)(document.querySelector('#gw-pills')?.textContent.replace(/\\s+/g, ' ').trim() ?? '')`, "the gateway page"));
    step("new admin: commands listed", await next.run(`document.querySelector('#gw-commands').textContent + ' · steps open: ' + document.querySelector('#gw-steps').open + ' · ' + document.querySelector('#check-list').textContent.slice(0, 40)`));
    await next.run(`${fill("#gw-code", "junk")}; document.querySelector('#gw-pair').click()`);
    step("new admin: bad setup code", await next.until(`document.querySelector('#gw-pair-note')?.textContent`, "the setup code error"));
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
    step("new admin: progress cards switch", `${cardsBefore} → ${cardsAfter} saved, undone`);
    await next.run(`location.hash = '#tools'`);
    await next.until(`document.querySelectorAll('#tools-list tbody tr').length === 11 && document.querySelector('#mcp-url').value.endsWith('/mcp')`, "the new tools page");
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
    step("new admin: tools by MCP", `token made on the new page works; ${offList.length} tools with admin switched off and saved, ${onList.length} after Undo`);
    await next.run(`[...document.querySelectorAll('#tools-list tr')].find(r => r.textContent.includes('vortex_axis_say')).querySelector('button').click()`);
    await next.until(`document.querySelector('#try-tool').value === 'vortex_axis_say' && [...document.querySelectorAll('[data-try=target] option')].some(o => o.value === 'everywhere')`, "the say form on the new page");
    await next.run(`${fill("[data-try=target]", "everywhere", "change")}; ${fill("[data-try=text] textarea", "hello")}`);
    const nextSends = await next.until(`(t => t.includes('hello') && t)(document.querySelector('#try-args').textContent)`, "the say arguments");
    if (nextSends !== '{"everywhere":true,"text":"hello"}') throw new Error(`the new say form would send ${nextSends}`);
    await next.run(`${fill("#try-tool", "vortex_axis_clients", "change")}`);
    await next.until(`document.querySelector('#try-args').textContent === '{}'`, "the clients form");
    await next.run(`document.querySelector('#try-run').click()`);
    await next.until(`/"clients"/.test(document.querySelector('#try-result pre')?.textContent ?? '')`, "the clients tool's answer on the new page");
    step("new admin: trying a tool", `say form sends ${nextSends}; clients tool answered`);
    await next.run(`location.hash = '#speech'`);
    await next.until(`document.querySelector('#speech-test')`, "the speech page");
    await next.run(`document.querySelector('#speech-test').click()`);
    step("new admin: speech test", await next.until(`(t => /Synthesis/.test(t) && t.slice(0, 80))(document.querySelector('#speech-note')?.textContent ?? '')`, "the new speech test", 60000));
    step("new admin: realtime voice", await next.until(`document.querySelector('#talk-state').textContent === 'needs OpenClaw' && !document.querySelector('#talk-body') && document.querySelector('#talk-note').textContent.slice(0, 50)`, "the realtime voice card"));
    await next.run(fill("#tts-rate", "100"));
    await next.until(`/1 unsaved change/.test(${saveBar}?.textContent ?? '')`, "the save bar for the sample rate");
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    step("new admin: sample rate refused", await next.until(`(t => /8000 to 48000/.test(t) && t)(document.querySelector('.savebar .save-error')?.textContent ?? '')`, "the sample rate refusal"));
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
    step("new admin: voices", `Known from saved as ${knownAt}; a voice added and forgotten after asking; ${await next.run(`document.querySelector('#vp-recent').textContent.slice(0, 50)`)}`);
    await next.run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
    await next.until(`document.querySelector('.cmdk input') === document.activeElement`, "the command bar for an action");
    await next.run(`(i => { i.value = 'reconnect gateway'; i.dispatchEvent(new Event('input', { bubbles: true })); })(document.querySelector('.cmdk input'))`);
    await next.until(`/Reconnect gateway/.test(document.querySelector('.cmdk-it.on')?.textContent ?? '')`, "the reconnect action");
    await next.run(`document.querySelector('.cmdk input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    step("new admin: command bar actions", await next.until(`[...document.querySelectorAll('.toast span')].map(t => t.textContent).find(t => /gateway/i.test(t))`, "the reconnect toast"));
    step("new admin: health links", await next.run(`[...document.querySelectorAll('.health a')].slice(0, 3).map(a => a.getAttribute('href')).join(' ')`));
    // --- stage 5: Face and screen, Firmware, Wake words, Apps, Integrations, System ---------------------
    // Downloads are caught as the blobs the page hands the browser.
    const catchBlobs = `window.blobs = []; if (!window.blobsCaught) { window.blobsCaught = true; const make = URL.createObjectURL; URL.createObjectURL = (b) => { window.blobs.push(b); return make(b); }; }`;
    const confirmDialog = (label) => `[...document.querySelectorAll('.dialog button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`;
    await next.run(`location.hash = '#face'`);
    await next.until(`document.querySelectorAll('.face-tile').length >= 35`, "the face tiles");
    await next.run(`document.querySelector('.face-tile[data-look="galaxy"]').click()`);
    step("new admin: face viewer", await next.until(`document.querySelector('#face-name').textContent.startsWith('galaxy') && document.querySelectorAll('#face-numbers tr').length === 13 && (document.querySelectorAll('.face-tile').length + ' looks and icons, galaxy chosen')`, "a look to be chosen"));
    // The classic steps left curl off, tool icons as a line and 36 dots: the new page shows that, and stages changes to it.
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
    step("new admin: face and tool icons", await next.until(`document.querySelector('#face-name').textContent === 'home (tool icon)' && document.querySelectorAll('#face-icons .face-tile').length === 13 && 'curl back in, dots, 48 dots saved in one go, then undone; 13 icons, home chosen'`, "the tool icon"));
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
    step("new admin: firmware uploaded", await next.until(`(t => /9\\.9\\.8/.test(t) && /sent to devices/.test(t) && /Update 1 device to 9\\.9\\.8|Nothing to update/.test(t) && t.replace(/\\s+/g, ' ').slice(0, 120))(${shelfWeb}?.textContent ?? '')`, "the build on the shelf"));
    await next.run(catchBlobs);
    await next.run(`[...${shelfWeb}.querySelectorAll('button')].find(b => b.textContent === 'Download').click()`);
    const firmwareBlob = await next.until(`window.blobs[0]?.size`, "the firmware download");
    if (firmwareBlob !== 70000) throw new Error(`the firmware download held ${firmwareBlob} bytes`);
    await next.run(`[...${shelfWeb}.querySelectorAll('button')].find(b => b.textContent === 'Remove').click()`);
    await next.until(`document.querySelector('.dialog')`, "the remove dialog");
    await next.run(confirmDialog("Remove"));
    await next.until(`/No builds held/.test(${shelfWeb}?.textContent ?? '')`, "the build to go");
    if ((await adminGet("/admin/firmware")).shelves.some((sh) => sh.builds.length)) throw new Error("the firmware build was not removed");
    step("new admin: firmware download and remove", `downloaded ${firmwareBlob} bytes, removed after the dialog`);
    // Wake words: a manifest fills the form, a model is added, its cutoff staged and saved, then it is removed.
    await next.run(`location.hash = '#wakewords'`);
    step("new admin: wake words", await next.until(`(t => /built-in/.test(t) && document.querySelector('#wake-scores') && t.replace(/\\s+/g, ' ').slice(0, 80))(document.querySelector('#wakewords-list')?.textContent ?? '')`, "the wake words page"));
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
    await next.run(`${catchBlobs}; [...document.querySelectorAll('#wakewords-list tr')].find(r => r.textContent.includes(${JSON.stringify(word.id)})).querySelector('button').click()`);
    const wordBlob = await next.until(`window.blobs[0]?.size`, "the wake word download");
    await next.run(`[...[...document.querySelectorAll('#wakewords-list tr')].find(r => r.textContent.includes(${JSON.stringify(word.id)})).querySelectorAll('button')].find(b => b.textContent === 'Remove').click()`);
    await next.until(`document.querySelector('.dialog')`, "the remove dialog for the wake word");
    await next.run(confirmDialog("Remove"));
    await next.until(`![...document.querySelectorAll('#wakewords-list tr')].some(r => r.textContent.includes(${JSON.stringify(word.id)}))`, "the wake word to go");
    step("new admin: wake word models", `manifest filled the form, ${word.id} added, cutoff 87 → 91 saved, downloaded ${wordBlob} bytes, removed after the dialog`);
    // Apps: the Windows app's download and the Quest and Mac apps' words.
    await next.run(`location.hash = '#apps'`);
    step("new admin: apps", await next.until(`(t => t && document.querySelector('#app-quest') && document.querySelector('#app-mac') && t)(document.querySelector('#apps-desktop-info')?.textContent)`, "the apps page"));
    // Integrations: Home Assistant staged, saved and undone.
    await next.run(`location.hash = '#integrations'`);
    step("new admin: integrations", await next.until(`(t => /Home Assistant/.test(t) && /Notifications to browsers/.test(t) && !/OpenClaw gateway\\s*(connected|check)/.test(t) && t)([...document.querySelectorAll('main .card-h h3')].map(h => h.textContent).join(' | '))`, "the integrations cards"));
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
    step("new admin: integration staged save", "broker 127.0.0.1 saved, then undone");
    // System: history kept saved, a backup made, a copy of the database downloaded; #system/backup scrolls to it.
    await next.run(`location.hash = '#system'`);
    await next.until(`document.querySelector('#sys-activityDays')`, "the system page");
    await next.run(fill("#sys-activityDays", "6"));
    await next.run(`${saveBar}.querySelector('[data-save]').click()`);
    await next.until(`!${saveBar}`, "the system settings to save");
    const daysSaved = (await adminGet("/admin/integrations")).settings.activityDays;
    if (daysSaved !== 6) throw new Error(`activityDays was saved as ${daysSaved}`);
    await next.run(`location.hash = '#system/backup'`);
    await next.until(`(window.scrollY > 0 || Math.abs(document.querySelector('#sys-backup').getBoundingClientRect().top) < 120)`, "the backup card to scroll into view");
    await next.run(`document.querySelector('#backup-now').click()`);
    await next.until(`[...document.querySelectorAll('.toast span')].some(t => /Backup made/.test(t.textContent)) && document.querySelector('#sys-backup-last')`, "the backup from the new page", 20000);
    await next.run(`${catchBlobs}; document.querySelector('#backup-download').click()`);
    const dbHead = await next.until(`window.blobs[0] && window.blobs[0].slice(0, 15).text()`, "the database download", 20000);
    if (dbHead !== "SQLite format 3") throw new Error(`the database download starts ${JSON.stringify(dbHead)}`);
    step("new admin: system", `history kept 6 days saved; backup made (${await next.run(`document.querySelector('#sys-backup .badge')?.textContent`)}); database downloaded (${await next.run("window.blobs[0].size")} bytes)`);
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
    if (wide.length) throw new Error(`new admin at phone width: ${wide.join(" | ")}`);
    step("new admin: phone width", `${narrow.length} pages fit in 390 px; drawer shut=${shut}, opens, closes on a choice`);
  }
  await admin.run(`location.hash = '#type/web'`);
  await admin.until(`${byId("type")}.classList.contains('on')`, "the type page once more");
  await admin.run(`history.go(-4)`);
  await admin.until(`${byId("device")}.classList.contains('on') && !${byId("device-remove")}.disabled`, "the device page again");
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
