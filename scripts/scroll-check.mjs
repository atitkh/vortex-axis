// The Speech page must not jump back up, or rebuild its entry cards, while its 10 s status poll runs.
// Starts the hub with a stub ElevenLabs account (300 voices), scrolls the TTS card, waits through the polls and
// checks scrollY, the identity of the entry's <select>/<li> nodes, and what was removed or added in the list.
//   npm run build && node scripts/scroll-check.mjs        (takes about 35 s; needs google-chrome or CHROME)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startApp } from "../server/dist/app.js";
import { loadConfig } from "../server/dist/config.js";

const WAIT_MS = Number(process.env.WAIT_MS || 26000);
const TOKEN = "scroll-check-admin-token-0123";
const hits = {};
const eleven = createServer((req, res) => {
  req.resume();
  res.setHeader("content-type", "application/json");
  const p = req.url.split("?")[0];
  hits[p] = (hits[p] || 0) + 1;
  const bad = Math.floor(Date.now() / 3500) % 2 === 1; // the account flips between answering and failing
  if (p.startsWith("/v2/voices")) {
    // same content every time, but a fresh order and long names, as a real account answers
    const voices = Array.from({ length: 300 }, (_, i) => ({ voice_id: `v${i}`, name: `Voice ${String(i).padStart(3, "0")} with a rather long descriptive name`, category: "premade" }));
    if (Date.now() % 2) voices.reverse();
    return void res.end(JSON.stringify({ voices, has_more: false }));
  }
  if (bad && p === "/v1/user") { res.statusCode = 503; return void res.end(JSON.stringify({ detail: "upstream flapping: the service is temporarily unavailable, please try again in a while" })); }
  if (req.url.startsWith("/v1/models")) return void res.end(JSON.stringify([{ model_id: "eleven_turbo_v2_5", name: "Turbo", can_do_text_to_speech: true }]));
  res.end("{}");
});
await new Promise((r) => eleven.listen(0, "127.0.0.1", r));
const stub = `http://127.0.0.1:${eleven.address().port}`;
const dirs = ["data", "backup", "chrome"].map((n) => mkdtempSync(join(tmpdir(), `scrollcheck-${n}-`)));
const app = await startApp(loadConfig({ AXIS_HOST: "127.0.0.1", AXIS_PORT: "0", AXIS_DATA_DIR: dirs[0], AXIS_BACKUP_DIR: dirs[1], AXIS_ADMIN_TOKEN: TOKEN, AXIS_HEALTH_INTERVAL_MS: "2000" }));
const base = `http://localhost:${app.port}`;
const chrome = spawn(process.env.CHROME || "google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${dirs[2]}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const debugUrl = await new Promise((resolve, reject) => {
  let err = "";
  chrome.stderr.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\S+)/.exec(err); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error(`chrome did not start: ${err.slice(0, 300)}`)), 15000);
});
const cdp = new WebSocket(debugUrl);
await new Promise((r) => cdp.on("open", r));
let id = 0;
const waiting = new Map();
cdp.on("message", (d) => { const m = JSON.parse(d); if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id)); });
const call = (method, params = {}, sessionId) => new Promise((resolve) => { const i = ++id; waiting.set(i, resolve); cdp.send(JSON.stringify({ id: i, method, params, sessionId })); });
let failed = false;
try {
  // A saved ElevenLabs entry (with a key) pointing at the stub, so the voice and model dropdowns fill.
  const r = await fetch(`${base}/admin/config`, { method: "PATCH", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ tts: { entries: [{ enabled: true, kind: "elevenlabs", url: stub, model: "eleven_turbo_v2_5", voice: "v5", apiKey: "stub-key" }] } }) });
  if (!r.ok) throw new Error(`seeding the config failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const { result: { targetId } } = await call("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await call("Target.attachToTarget", { targetId, flatten: true });
  await call("Runtime.enable", {}, sessionId);
  await call("Page.enable", {}, sessionId);
  await call("Page.bringToFront", {}, sessionId);
  await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 500, deviceScaleFactor: 1, mobile: false }, sessionId);
  const run = async (expression) => {
    const x = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (x.result.exceptionDetails) throw new Error(`eval failed: ${x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text}`);
    return x.result.result.value;
  };
  const until = async (expr, what, ms = 20000) => {
    for (const end = Date.now() + ms; ; ) {
      const v = await run(expr).catch(() => undefined);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem('axis-admin-token', ${JSON.stringify(TOKEN)})` }, sessionId);
  await call("Page.navigate", { url: `${base}/admin#speech` }, sessionId);
  await until(`document.querySelector('#tts-card select[id$="-voice"] option:nth-child(100)')`, "the voice list");
  // Pad below so there is room to scroll, scroll to the voice select, and mark the nodes.
  await run(`(() => {
    const sel = document.querySelector('#tts-card select[id$="-voice"]');
    const li = sel.closest('li');
    sel.dataset.mark = 'orig'; li.dataset.mark = 'orig';
    window.__removed = []; window.__added = 0;
    new MutationObserver((ms) => { for (const m of ms) { for (const n of m.removedNodes) if (n.nodeType === 1) window.__removed.push(n.tagName + '.' + (n.className || n.id || '')); window.__added += [...m.addedNodes].filter((n) => n.nodeType === 1).length; } })
      .observe(document.querySelector('#main') ?? document.body, { childList: true, subtree: true });
    window.__sel = sel; window.__li = li;
    window.__maxDrop = 0; window.__top = 0;
    // The select itself: option nodes replaced or changed, focus lost, the document height over time.
    window.__selMut = []; window.__heights = new Set(); window.__focusLost = 0;
    new MutationObserver((ms) => { for (const m of ms) window.__selMut.push(m.target.tagName + ":" + m.type + ":" + (m.attributeName || m.addedNodes.length + '/' + m.removedNodes.length)); }).observe(sel, { childList: true, attributes: true, subtree: true });
    sel.focus();
    sel.addEventListener('blur', () => window.__focusLost++);
    setInterval(() => window.__heights.add(document.documentElement.scrollHeight), 100);
    window.scrollTo(0, sel.getBoundingClientRect().top + scrollY - 120);
    window.__top = scrollY;
    addEventListener('scroll', () => { window.__maxDrop = Math.max(window.__maxDrop, window.__top - scrollY); });
  })()`);
  const start = await run("scrollY");
  if (start < 100) throw new Error(`could not scroll the page (scrollY ${start})`);
  await new Promise((r) => setTimeout(r, WAIT_MS));
  const after = await run(`({ y: scrollY, maxDrop: window.__maxDrop, sameSel: document.querySelector('#tts-card select[id$="-voice"]') === window.__sel, sameLi: document.querySelector('#tts-card .sp-entry') === window.__li,
    hidden: document.hidden, polls: performance.getEntriesByType('resource').filter((e) => e.name.includes('speech-status')).length, selConnected: window.__sel.isConnected, removed: window.__removed.length, added: window.__added, removedList: [...new Set(window.__removed)].slice(0, 8), selMut: window.__selMut.length, selMutKinds: [...new Set(window.__selMut)].slice(0, 6), focusLost: window.__focusLost, focused: document.activeElement === window.__sel, heights: [...window.__heights].length, height: document.documentElement.scrollHeight })`);
  console.log(`start scrollY=${start}`, JSON.stringify(after));
  console.log("stub hits", JSON.stringify(hits));
  if (after.hidden || after.polls < 3) throw new Error(`the page did not poll (hidden=${after.hidden}, status requests=${after.polls}), so the check proves nothing`);
  if (after.y < start - 2 || after.maxDrop > 2) throw new Error(`the page scrolled back up (from ${start} to ${after.y}, largest drop ${after.maxDrop})`);
  if (!after.sameSel || !after.sameLi) throw new Error("the entry card or its voice select was replaced by a re-render");
  if (after.selMut) throw new Error(`the voice select was mutated ${after.selMut} times during the polls (${after.selMutKinds.join(", ")})`);
  if (after.focusLost || !after.focused) throw new Error("the voice select lost focus during the polls");
  if (after.heights > 1) throw new Error(`the page height changed during the polls (${after.heights} different heights)`);
  if (after.removed) throw new Error(`${after.removed} elements were removed from the page during the poll: ${after.removedList.join(", ")}`);
  console.log("scroll-check: ok");
} catch (error) {
  failed = true;
  console.log(`FAILED: ${error.message}`);
}
chrome.kill();
await app.close();
eleven.close();
await new Promise((r) => setTimeout(r, 800));
for (const d of dirs) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
process.exit(failed ? 1 : 0);
