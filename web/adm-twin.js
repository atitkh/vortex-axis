// One device as it is now, live: its sketch with the face, gauges for its vitals, what needs attention, the settings in
// effect, its last turns and what it can do (the Overview of the device page, web/adm-devices.js); and the stream both
// that and the system map (web/adm-map.js) are kept current by, GET /admin/map/stream. Read only: nothing here changes
// a setting. A turn is symbolic (where it is), never traffic or words; a wake word is how sure and how loud, never the word.

import { html, useEffect, useState } from "/web/preact.js";
import { PROFILES, ago, api, authHeader, deviceHref, enc, plural, profileLine, refresh, signOut, store, toast } from "/web/adm-core.js";
import { inherited } from "/web/adm-settings.js";
import { DeviceSketch } from "/web/adm-tools.js";

// --- the feed: one stream while the map or a device's overview is on screen ------------------------------------------------

/** How long a finished turn's path stays lit, and how often a redraw may happen at most. */
const FADE_MS = 2000;
const DRAW_MS = 200;
/** How long a wake contest stays on the map after its last report, and how long it then takes to fade. */
const WAKE_SHOW_MS = 6000;
const WAKE_FADE_MS = 600;
export const POLL_MS = 10_000;

/**
 * `link`: live, reconnecting or paused (the tab is hidden). `turns`: running turns by key. `contest`: the latest wake
 * word heard, { id, wakes: clientId → wake, fading }, while it is shown.
 */
export const feed = { map: undefined, link: "paused", error: "", turns: new Map(), contest: undefined, users: 0, stop: undefined, retry: undefined, poll: undefined, tick: undefined, tries: 0 };
const listeners = new Set();
let drawTimer;
/** Redraws the map pages, at most five times a second. */
function changed() {
  if (drawTimer) return;
  drawTimer = setTimeout(() => {
    drawTimer = undefined;
    listeners.forEach((fn) => fn());
  }, DRAW_MS);
}

function openFeed() {
  if (!store.signedIn || !feed.users) return;
  if (document.hidden) return pauseFeed();
  if (feed.stop) return;
  clearTimeout(feed.retry);
  const stop = (feed.stop = new AbortController());
  (async () => {
    try {
      const res = await fetch("/admin/map/stream", { headers: authHeader(), signal: stop.signal });
      if (res.status === 401) return signOut("That token was not accepted.");
      if (!res.ok || !res.body) throw new Error(`map stream refused (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        for (let cut = pending.indexOf("\n\n"); cut >= 0; cut = pending.indexOf("\n\n")) {
          const block = pending.slice(0, cut);
          pending = pending.slice(cut + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name && data) mapEvent(name, JSON.parse(data));
        }
      }
    } catch {
      // Dropped, or closed on purpose: the lines below decide.
    }
    if (feed.stop !== stop) return;
    feed.stop = undefined;
    if (!feed.users || document.hidden) return;
    // Back off 1, 2, 4 … 30 s; meanwhile the map is read every 10 s so it does not go stale.
    feed.tries += 1;
    feed.link = "reconnecting";
    startPolling();
    feed.retry = setTimeout(openFeed, Math.min(30_000, 1000 * 2 ** Math.min(feed.tries - 1, 5)));
    changed();
  })();
}

function pauseFeed() {
  feed.stop?.abort();
  feed.stop = undefined;
  clearTimeout(feed.retry);
  stopPolling();
  feed.link = "paused";
  changed();
}

function startPolling() {
  if (feed.poll) return;
  const once = async () => {
    try {
      const map = await api("GET", "/admin/map");
      if (feed.poll) feed.map = map;
      feed.error = "";
    } catch (error) {
      feed.error = error.message || "Axis did not answer.";
    }
    changed();
  };
  feed.poll = setInterval(once, POLL_MS);
  once();
}
function stopPolling() {
  clearInterval(feed.poll);
  feed.poll = undefined;
}

const onVisibility = () => (document.hidden ? pauseFeed() : openFeed());

/** Redraws the calling map page on every change, and keeps the stream open while any map page is on screen. */
export function useMap() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    if (!feed.users++) {
      document.addEventListener("visibilitychange", onVisibility);
      // A running turn's time counts up; nothing else needs a clock.
      feed.tick = setInterval(() => feed.turns.size && changed(), 250);
      openFeed();
    }
    return () => {
      listeners.delete(fn);
      if (--feed.users) return;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(feed.tick);
      pauseFeed();
    };
  }, []);
  return feed;
}

function mapEvent(name, data) {
  if (name === "snapshot") {
    feed.map = data;
    feed.tries = 0;
    feed.error = "";
    feed.link = "live";
    stopPolling();
  } else if (name === "client" && feed.map) {
    const nodes = feed.map.nodes.slice();
    const at = nodes.findIndex((n) => n.id === data.id);
    if (data.removed) at >= 0 && nodes.splice(at, 1);
    else if (at >= 0) nodes[at] = data;
    else nodes.push(data);
    // A device's line to Axis is there while it is connected.
    const edges = [...nodes.filter((n) => n.online).map((n) => ({ from: n.id, to: "axis", kind: "link" })), ...feed.map.edges.filter((e) => e.kind !== "link")];
    feed.map = { ...feed.map, nodes, edges };
  } else if (name === "turn") turnEvent(data);
  else if (name === "wake") wakeEvent(data);
  changed();
}

/** Gathers the reports Axis settled together (the same `contest`); a newer contest replaces the one shown. */
function wakeEvent(w) {
  let c = feed.contest;
  if (c?.id !== w.contest) {
    clearTimeout(c?.timer);
    c = feed.contest = { id: w.contest, wakes: new Map(), fading: false, timer: undefined };
  }
  c.wakes.set(w.clientId, w);
  c.fading = false;
  clearTimeout(c.timer);
  c.timer = setTimeout(() => {
    c.fading = true;
    changed();
    c.timer = setTimeout(() => {
      if (feed.contest === c) feed.contest = undefined;
      changed();
    }, WAKE_FADE_MS);
  }, WAKE_SHOW_MS);
}

/**
 * The contest shown, worked out: each report with its place (`answered`, `stood_down`, `ignored`), the winner, and by
 * how much its score beat the best of the others (negative: it won on loudness, scoring within the margin).
 */
export function wakeContest() {
  const c = feed.contest;
  if (!c) return undefined;
  const wakes = [...c.wakes.values()];
  const winner = wakes.find((w) => w.outcome === "answered");
  const others = wakes.filter((w) => w !== winner && w.outcome !== "ignored");
  const by = winner && others.length ? winner.score - Math.max(...others.map((w) => w.score)) : undefined;
  return { id: c.id, wakes, winner, by, fading: c.fading };
}

/** Which line each stage of a turn is on: the device's line, then speech recognition, the agent, speech synthesis. */
const HOP = { listening: "link", transcribing: "stt", thinking: "agent", speaking: "tts" };

/** Times each stage from when the page heard of it (the stream sends stages as they happen). */
function turnEvent(t) {
  const now = Date.now();
  let run = feed.turns.get(t.key);
  if (!run) feed.turns.set(t.key, (run = { clientId: t.clientId, stage: undefined, since: now, done: {} }));
  if (run.stage && run.stage !== t.stage && HOP[run.stage]) run.done[HOP[run.stage]] = now - run.since;
  run.stage = t.stage;
  run.since = now;
  if (t.stage === "done") {
    run.endedAt = now;
    setTimeout(() => {
      feed.turns.delete(t.key);
      changed();
    }, FADE_MS + 400);
  }
}

/** Lit lines, newest turn winning: id → { ms, now (the current stage), ended }. */
export function litEdges() {
  const lit = new Map();
  const now = Date.now();
  for (const run of feed.turns.values()) {
    const ended = run.endedAt !== undefined;
    const hops = { link: run.done.link, ...run.done };
    if (!ended && HOP[run.stage]) hops[HOP[run.stage]] = now - run.since;
    for (const [hop, ms] of Object.entries(hops)) {
      const id = hop === "link" ? `${run.clientId}>axis` : `axis>${hop}`;
      const current = !ended && (HOP[run.stage] === hop || (run.stage === "speaking" && hop === "link"));
      lit.set(id, { ms, now: current, ended });
    }
  }
  return lit;
}

// --- colours, words and small drawings ---------------------------------------------------------------

export const STATE = {
  idle: ["--good", "Idle"],
  listening: ["--accent", "Listening"],
  thinking: ["--think", "Thinking"],
  asked: ["--think", "Waiting for an answer"],
  speaking: ["--warn", "Speaking"],
  offline: ["--st-off", "Offline"],
};
export const stateOf = (n) => STATE[n.online ? n.state : "offline"] ?? STATE.idle;

const GOOD = new Set(["up", "on", "connected"]);
const BAD = new Set(["down", "unreachable", "auth_failed"]);
const WARN = new Set(["connecting", "pairing_required"]);
export const serviceColour = (s) => (GOOD.has(s.state) ? "--good" : BAD.has(s.state) ? "--bad" : WARN.has(s.state) ? "--warn" : "--st-off");
export const SERVICE_WORDS = { up: "up", down: "down", unknown: "not checked yet", on: "on", off: "off", connected: "connected", connecting: "connecting", pairing_required: "waiting for approval", auth_failed: "refused", unreachable: "unreachable", unconfigured: "not set up" };

export const ms = (n) => (n === undefined ? "" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`);
/** Cuts text to about `px` wide at `size` px. */
export const fit = (text, px, size = 13) => {
  const most = Math.max(4, Math.floor(px / (size * 0.58)));
  return text.length > most ? `${text.slice(0, most - 1)}…` : text;
};

export const KIND_ICON = {
  board: "M3 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1ZM5.5 9.5h3",
  round: "M7 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z",
  browser: "M1.5 2.5h11v9h-11zM1.5 5h11",
  computer: "M1.5 2h11v7.5h-11zM5 12.5h4M7 9.5v3",
  headset: "M1.5 4.5h11v5h-4l-1.5-1.5L5.5 9.5h-4z",
};
export const KIND_WORDS = { board: "Board", round: "Round board", browser: "Web client", computer: "Computer", headset: "Headset" };

export function Bars({ x, y, rssiLabel, size = 3 }) {
  const n = { strong: 4, ok: 3, weak: 2, poor: 1 }[rssiLabel] ?? 0;
  return html`<g class="bars">${[0, 1, 2, 3].map((i) => html`<rect key=${i} x=${x + i * (size + 1.5)} y=${y - (i + 1) * size} width=${size} height=${(i + 1) * size} rx="0.6" class=${i < n ? "on" : "off"} />`)}</g>`;
}


/** The stream's state as a pill: live, reconnecting (read every 10 s meanwhile) or paused while the tab is hidden. */
export function LinkPill() {
  const [kind, text, title] =
    feed.link === "live" ? ["good", "live", "Changes arrive as they happen."]
    : feed.link === "reconnecting" ? ["warn", "reconnecting", `The live stream dropped; trying again, and reading the map every ${POLL_MS / 1000} s meanwhile.${feed.error ? ` ${feed.error}` : ""}`]
    : ["", "paused", "Paused while this tab is hidden."];
  return html`<span class=${`badge ${kind} map-pill`} id="map-link" title=${title}><i class="dot-i"></i>${text}</span>`;
}

// --- one device -------------------------------------------------------------------------------------------

function Ring({ percent, low }) {
  const r = 24, c = 2 * Math.PI * r;
  return html`<svg class=${`ring-g${low ? " low" : ""}`} viewBox="0 0 60 60" width="60" height="60" aria-hidden="true">
    <circle cx="30" cy="30" r=${r} class="track" /><circle cx="30" cy="30" r=${r} class="fill" stroke-dasharray=${`${(c * percent) / 100} ${c}`} transform="rotate(-90 30 30)" />
    <text x="30" y="35" text-anchor="middle">${percent}%</text>
  </svg>`;
}

const Gauge = ({ label, pic, value, note, id }) => html`<div class="gauge" data-gauge=${id}>
  ${pic ? html`<div class="g-pic">${pic}</div>` : null}
  <div><div class="g-l">${label}</div><div class="g-v">${value}</div>${note ? html`<div class="g-n dim">${note}</div>` : null}</div>
</div>`;

function gauges(n) {
  const v = n.vitals ?? {};
  const out = [];
  if (v.battery) {
    const b = v.battery;
    const note = [b.charging ? "charging" : "", b.millivolts ? `${(b.millivolts / 1000).toFixed(2)} V` : ""].filter(Boolean).join(" · ");
    out.push(html`<${Gauge} id="battery" label="Battery" pic=${b.percent !== undefined ? html`<${Ring} percent=${b.percent} low=${b.label === "low"} />` : null} value=${b.percent !== undefined ? `${b.percent}%` : b.label ?? "reported"} note=${note} />`);
  }
  if (v.onPower !== undefined && !v.battery) out.push(html`<${Gauge} id="power" label="Power" value=${v.onPower ? "on power" : "on battery"} />`);
  if (v.signal) out.push(html`<${Gauge} id="signal" label="Wi-Fi" pic=${html`<svg viewBox="0 0 26 22" width="40" height="34" class="bars-g" aria-hidden="true"><${Bars} x=${1} y=${21} rssiLabel=${v.signal.label} size=${5} /></svg>`} value=${v.signal.label} note=${`${v.signal.rssi} dBm`} />`);
  if (v.uptime) out.push(html`<${Gauge} id="uptime" label="Up" value=${v.uptime.text} note=${v.lastRestart ? `last restart: ${v.lastRestart}` : ""} />`);
  if (v.memory) out.push(html`<${Gauge} id="memory" label="Free memory" value=${`${Math.round(v.memory.freeBytes / 1024)} KB`} />`);
  if (v.chipTempC !== undefined) out.push(html`<${Gauge} id="temp" label="Chip temperature" value=${`${Math.round(v.chipTempC)} °C`} />`);
  if (v.usage) {
    const u = v.usage;
    const parts = [u.turnsToday !== undefined ? plural(u.turnsToday, "turn") : "", u.pickupsToday !== undefined ? plural(u.pickupsToday, "pickup") : "", u.touchesToday !== undefined ? plural(u.touchesToday, "touch", "touches") : ""].filter(Boolean);
    if (parts.length) out.push(html`<${Gauge} id="usage" label="Today" value=${parts[0]} note=${parts.slice(1).join(" · ")} />`);
  }
  if (v.sound?.db !== undefined) out.push(html`<${Gauge} id="sound" label="Sound level" value=${`${Math.round(v.sound.db)} dB`} note=${v.sound.active ? "sound now" : ""} />`);
  return out;
}

/** What a board would report and this one did not; computers and browsers are only shown what they report. */
function notReported(n) {
  if (n.kind !== "board" && n.kind !== "round") return [];
  const v = n.vitals ?? {};
  return [["battery", "battery"], ["signal", "Wi-Fi signal"], ["uptime", "uptime"], ["memory", "memory"], ["chipTempC", "temperature"]].filter(([k]) => v[k] === undefined).map(([, w]) => w);
}

const SUMMARY_KEYS = ["volume", "brightness", "maxFps", "listenCue", "wakeWord", "voiceMode", "voice"];

/**
 * The profile switch on a device's overview. Unlike everything else there it applies at once: the choice is saved as
 * the device's own `profile` setting, or removed when it is what the device would follow anyway.
 */
function ProfileSwitch({ client, battery }) {
  const [busy, setBusy] = useState("");
  const def = store.builtIns?.find?.((d) => d.key === "profile") ?? { key: "profile", kind: "choice", default: "auto" };
  const choice = String(client.settings?.profile ?? "auto");
  const pick = async (value) => {
    if (value === choice || busy) return;
    setBusy(value);
    const below = inherited(def, client.layers, "device");
    const saved = below.value !== undefined && String(below.value) === value ? null : value;
    try {
      await api("PATCH", `/admin/settings/device/${enc(client.id)}`, { values: { profile: saved } });
      await refresh();
    } catch (error) {
      toast(error.message, "bad");
    }
    setBusy("");
  };
  const help = PROFILES.find(([v]) => v === choice)?.[2];
  return html`<section class="card" id="profile-card"><div class="card-h"><h3>Profile</h3><span class="dim sm" id="profile-now">${profileLine(client.profile, client.profileReason, battery)}</span></div><div class="card-b">
    <div class="seg" role="group" aria-label="Profile" id="profile-switch">${PROFILES.map(([v, l, h]) => html`<button key=${v} type="button" data-profile=${v} title=${h} class=${v === choice ? "on" : ""} aria-pressed=${v === choice} disabled=${Boolean(busy)} onClick=${() => pick(v)}>${l}</button>`)}</div>
    <p class="help">${help ? `${help} ` : ""}Applies at once.</p>
  </div></section>`;
}
function settingLabel(type, key) {
  const def = store.types[type]?.settings?.find((d) => d.key === key) ?? store.builtIns?.find?.((d) => d.key === key);
  return def?.label ?? key;
}

/**
 * A device's overview: the sketch with its face as it is now, gauges for what it reports, then what needs attention,
 * the settings in effect, its last turns and what it can do. Opens the stream while on screen.
 */
export function DeviceTwin({ client }) {
  useMap();
  const id = client.id;
  const map = feed.map;
  const n = map?.nodes.find((x) => x.id === id);
  if (!n) {
    return html`<div class="map-dev" id="map-device" data-id=${id}><section class="card map-twin">
      <div class="twin-head"><${LinkPill} /></div>
      <div class="twin-pic"><${DeviceSketch} client=${client} /></div>
      ${feed.error ? html`<p class="dim">Axis did not answer: ${feed.error}</p>` : map ? html`<p class="dim">Readings: not reported.</p>` : html`<p class="dim" aria-busy="true">Loading its readings…</p>`}
    </section></div>`;
  }
  const [colour, word] = stateOf(n);
  const shown = gauges(n);
  const missing = notReported(n);
  const values = client.effective ?? client.settings ?? {};
  const settings = SUMMARY_KEYS.filter((k) => values[k] !== undefined && values[k] !== "");
  const turns = (store.activity?.recentTurns ?? []).filter((t) => t.clientId === id).slice(0, 6);
  const lit = [...feed.turns.values()].find((r) => r.clientId === id && r.endedAt === undefined);
  return html`<div class="map-dev" id="map-device" data-id=${id}>
      <section class="card map-twin">
        <div class="twin-head" style=${`--c: var(${colour})`}><i class="st-dot"></i><b>${lit ? STATE[lit.stage]?.[1] ?? word : word}</b>
          <span class="dim">${n.online ? (n.connectedSince ? `connected ${ago(n.connectedSince)}` : "connected") : n.lastSeen ? `last seen ${ago(n.lastSeen)}` : "never connected"}</span><span class="grow"></span><${LinkPill} /></div>
        <div class="twin-pic"><${DeviceSketch} client=${client} /></div>
        <div class="gauges">${shown}</div>
        ${!shown.length ? html`<p class="dim" id="map-no-readings">Readings: not reported.</p>` : missing.length ? html`<p class="help">Not reported: ${missing.join(", ")}.</p>` : null}
      </section>
      <div class="map-side">
        <${ProfileSwitch} client=${client} battery=${n.vitals?.battery?.percent} />
        <section class="card"><div class="card-h"><h3>Needs attention</h3></div><div class="card-b">
          ${n.attention.length ? html`<ul class="att-list">${n.attention.map((a) => html`<li key=${a}>${a}</li>`)}</ul>` : html`<p class="dim">Nothing.</p>`}
        </div></section>
        ${settings.length
          ? html`<section class="card"><div class="card-h"><h3>Settings in effect</h3></div><dl class="facts card-b">${settings.map((k) => html`<div key=${k} class="fact"><dt>${settingLabel(n.type, k)}</dt><dd>${String(values[k])}${client.settings?.[k] !== undefined && String(client.settings[k]) !== String(values[k]) ? html` <span class="dim">(set to ${String(client.settings[k])})</span>` : null}</dd></div>`)}</dl>
              <p class="help card-b">As sent, with the profile and quiet hours applied. Changed under <a href=${deviceHref(id, "settings")}>Settings</a>.</p></section>`
          : null}
        ${turns.length
          ? html`<section class="card"><div class="card-h"><h3>Last turns</h3><a class="sm" href="#activity">History</a></div><div class="card-b"><table class="t"><tbody>
              ${turns.map((t) => html`<tr key=${t.at}><td>${ago(t.at)}</td><td>${t.kind}</td><td>${t.outcome}</td><td class="num">${ms(t.totalMs)}</td></tr>`)}
            </tbody></table></div></section>`
          : null}
        <section class="card"><div class="card-h"><h3>What it can do</h3></div><div class="card-b chips" id="map-caps">
          ${n.capabilities.effective.map((c) => html`<span key=${c} class="chip">${c}</span>`)}
          ${n.capabilities.off.map((c) => html`<span key=${c} class="chip no" title="Switched off in its settings">${c}</span>`)}
          ${!n.capabilities.effective.length && !n.capabilities.off.length ? html`<span class="dim">Nothing reported.</span>` : null}
        </div></section>
      </div>
    </div>`;
}
