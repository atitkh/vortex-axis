// Drives the admin page and the web client in headless Chrome against a real
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
    AXIS_ADMIN_TOKEN: "browser-check",
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
  await admin.run(`${byId("token")}.value = 'browser-check'; ${byId("remember")}.checked = true; ${byId("signin-form")}.requestSubmit()`);
  await admin.until(`!${byId("app")}.classList.contains('hidden') && document.querySelectorAll('#summary .stat').length === 4`, "the admin page");
  step("token remembered on this device", await admin.run(`localStorage.getItem('axis-admin-token') === 'browser-check' && sessionStorage.getItem('axis-admin-token') === null`));
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
  const hubSaved = await fetch(`${base}/admin/integrations`, { headers: { authorization: "Bearer browser-check" } }).then((r) => r.json());
  if (hubSaved.settings.activityDays !== 5) throw new Error(`activityDays was saved as ${hubSaved.settings.activityDays}`);
  // Agent tools: a token made on the page lets an MCP client in; a tool switched off there is gone for it.
  {
    await admin.run(`location.hash = '#tools'`);
    await admin.until(`document.querySelectorAll('#tools-list tbody tr').length === 9 && ${byId("mcp-url")}.value.endsWith('/mcp')`, "the tools page");
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
  const wordsKept = await admin.run(`fetch('/admin/activity?hours=24', { headers: { authorization: 'Bearer browser-check' } })
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
    actions: [{ name: "diag", label: "Diagnostics" }],
    links: [],
  });
  await admin.run(`document.querySelector('#client-table tbody a').click()`);
  step("device editor", await admin.until(`${byId("device")}.classList.contains('on') && (t => /volume/.test(t) && t)([...document.querySelectorAll('#device-settings .mono')].map(e => e.textContent).join(', '))`, "the device settings (the page polls every 3 s)"));
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
    const known = await fetch(`${base}/admin/clients`, { headers: { authorization: "Bearer browser-check" } }).then((r) => r.json());
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
  const shared = await fetch(`${base}/admin/settings/global`, { headers: { authorization: "Bearer browser-check" } }).then((r) => r.json());
  if (shared.values.idleLooksOff !== "curl") throw new Error(`idleLooksOff was saved as ${JSON.stringify(shared.values.idleLooksOff)}`);
  // Tool icons: one tile per kind, shown large when chosen, and the style saved for every device.
  await admin.run(`document.querySelector('.face-tile[data-look="icon:home"]').click()`);
  step("tool icons", await admin.until(`${byId("face-name")}.textContent === 'home (tool icon)' && document.querySelectorAll('#face-icons .face-tile').length === 12 && document.querySelector('#face-icon-style button.on')?.dataset.style === 'dots' && '12 kinds, home chosen, shown as dots'`, "the tool icons"));
  // Something is really drawn in the middle of the large face: with the icon made of dots, the core is gone and the house's roof is lit.
  // The faces only move while their page is the one in front.
  await admin.front();
  step("tool icon drawn", await admin.until(`(() => { const c = ${byId("face-big")}, g = c.getContext('2d'), w = c.width; const lit = (x0, y0, x1, y1) => { const d = g.getImageData(Math.round(w * x0), Math.round(w * y0), Math.round(w * (x1 - x0)), Math.round(w * (y1 - y0))).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) n++; return n; }; const roof = lit(0.4, 0.25, 0.6, 0.37), core = lit(0.45, 0.45, 0.55, 0.55); return roof > 30 && core === 0 && 'roof lit (' + roof + ' px), centre dark'; })()`, "the dots to form the house", 8000));
  // Fewer dots in the shape: saved for every device, and the rest stand off in a ring, so the centre stays dark.
  await admin.run(`(() => { const s = ${byId("face-icon-dots")}; s.value = '36'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  step("tool icon dots", await admin.until(`/36 of 78/.test(${byId("face-icon-dots-note")}.textContent) && /saved/.test(${byId("face-icons-note")}.textContent) && ${byId("face-icon-dots-note")}.textContent`, "the number of dots to be saved"));
  const tuned = await fetch(`${base}/admin/settings/global`, { headers: { authorization: "Bearer browser-check" } }).then((r) => r.json());
  if (tuned.values.toolIconDots !== 36) throw new Error(`toolIconDots was saved as ${JSON.stringify(tuned.values.toolIconDots)}`);
  await admin.run(`document.querySelector('#face-icon-style button[data-style="line"]').click()`);
  step("tool icon style", await admin.until(`document.querySelector('#face-icon-style button.on')?.dataset.style === 'line' && ${byId("face-icons-note")}.textContent`, "the style to be saved"));
  const styled = await fetch(`${base}/admin/settings/global`, { headers: { authorization: "Bearer browser-check" } }).then((r) => r.json());
  if (styled.values.toolIcons !== "line") throw new Error(`toolIcons was saved as ${JSON.stringify(styled.values.toolIcons)}`);
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
