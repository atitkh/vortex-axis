// The system map (#map) and one device's map page (#map/<id>): the devices, Axis and the services behind it, drawn
// in fixed columns from GET /admin/map and kept current by GET /admin/map/stream. Read only: nothing here changes a
// setting. A turn lights its path stage by stage; it is symbolic (where the turn is), never traffic or words.

import { html, useEffect, useRef, useState } from "/web/preact.js";
import { ago, api, authHeader, clientById, deviceHref, plural, signOut, span, store, typeName, useStore } from "/web/adm-core.js";
import { DeviceSketch } from "/web/adm-tools.js";
import { PageHead } from "/web/adm-shell.js";

// --- the feed: one stream while a map page is on screen ------------------------------------------------

/** How long a finished turn's path stays lit, and how often a redraw may happen at most. */
const FADE_MS = 2000;
const DRAW_MS = 200;
const POLL_MS = 10_000;

/** `link`: live, reconnecting or paused (the tab is hidden). `turns`: running turns by key. */
const feed = { map: undefined, link: "paused", error: "", turns: new Map(), users: 0, stop: undefined, retry: undefined, poll: undefined, tick: undefined, tries: 0 };
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
function useMap() {
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
  changed();
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
function litEdges() {
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

const STATE = {
  idle: ["--good", "Idle"],
  listening: ["--accent", "Listening"],
  thinking: ["--think", "Thinking"],
  asked: ["--think", "Waiting for an answer"],
  speaking: ["--warn", "Speaking"],
  offline: ["--st-off", "Offline"],
};
const stateOf = (n) => STATE[n.online ? n.state : "offline"] ?? STATE.idle;

const GOOD = new Set(["up", "on", "connected"]);
const BAD = new Set(["down", "unreachable", "auth_failed"]);
const WARN = new Set(["connecting", "pairing_required"]);
const serviceColour = (s) => (GOOD.has(s.state) ? "--good" : BAD.has(s.state) ? "--bad" : WARN.has(s.state) ? "--warn" : "--st-off");
const SERVICE_WORDS = { up: "up", down: "down", unknown: "not checked yet", on: "on", off: "off", connected: "connected", connecting: "connecting", pairing_required: "waiting for approval", auth_failed: "refused", unreachable: "unreachable", unconfigured: "not set up" };

export const ms = (n) => (n === undefined ? "" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`);
/** Cuts text to about `px` wide at `size` px. */
const fit = (text, px, size = 13) => {
  const most = Math.max(4, Math.floor(px / (size * 0.58)));
  return text.length > most ? `${text.slice(0, most - 1)}…` : text;
};

const KIND_ICON = {
  board: "M2 3h10v8H2zM5 13h4",
  round: "M7 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z",
  browser: "M1.5 2.5h11v9h-11zM1.5 5h11",
  computer: "M1.5 2h11v7.5h-11zM5 12.5h4M7 9.5v3",
  headset: "M1.5 4.5h11v5h-4l-1.5-1.5L5.5 9.5h-4z",
};
const KIND_WORDS = { board: "Board", round: "Round board", browser: "Web client", computer: "Computer", headset: "Headset" };

function Bars({ x, y, rssiLabel, size = 3 }) {
  const n = { strong: 4, ok: 3, weak: 2, poor: 1 }[rssiLabel] ?? 0;
  return html`<g class="bars">${[0, 1, 2, 3].map((i) => html`<rect key=${i} x=${x + i * (size + 1.5)} y=${y - (i + 1) * size} width=${size} height=${(i + 1) * size} rx="0.6" class=${i < n ? "on" : "off"} />`)}</g>`;
}

// --- the layout: fixed columns, or one column on a phone ----------------------------------------------

const CARD_H = 72, SVC_H = 56, AX_H = 100, GAP = 10, PAD = 12;

function places(nodes) {
  const by = new Map();
  for (const n of nodes) {
    const place = String(n.location ?? "").trim() || "";
    if (!by.has(place)) by.set(place, []);
    by.get(place).push(n);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b))
    .map(([place, list]) => ({ place: place || "Unplaced", nodes: list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)) }));
}

function layout(map, width) {
  const W = Math.max(320, Math.round(width));
  const narrow = W < 720;
  const heads = [], devices = [], services = [], edges = [];
  const groups = places(map.nodes);
  const curve = (x1, y1, x2, y2) => {
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  };
  let H, axis;
  if (!narrow) {
    const devW = Math.min(300, Math.round(W * 0.31)), svcW = devW, axW = Math.min(180, Math.round(W * 0.18));
    let y = PAD;
    for (const g of groups) {
      heads.push({ text: g.place, x: PAD + 2, y: y + 13 });
      y += 22;
      for (const n of g.nodes) {
        devices.push({ n, x: PAD, y, w: devW, h: CARD_H });
        y += CARD_H + GAP;
      }
      y += 8;
    }
    const svcTotal = map.services.length * (SVC_H + 14) - 14;
    // Axis and the services sit level with the top of a long device list, not halfway down it.
    const band = Math.max(svcTotal + 2 * PAD, AX_H + 2 * PAD, Math.min(y, 560));
    H = Math.max(y, band, 260);
    axis = { x: Math.round((W - axW) / 2), y: Math.round((band - AX_H) / 2), w: axW, h: AX_H };
    let sy = Math.round((band - svcTotal) / 2);
    for (const s of map.services) {
      services.push({ s, x: W - PAD - svcW, y: sy, w: svcW, h: SVC_H });
      sy += SVC_H + 14;
    }
    const ay = axis.y + axis.h / 2;
    for (const e of map.edges) {
      const d = devices.find((p) => p.n.id === e.from);
      const s = services.find((p) => p.s.id === e.to);
      if (d) edges.push({ e, id: `${e.from}>axis`, d: curve(d.x + d.w, d.y + d.h / 2, axis.x, ay), label: [(d.x + d.w + axis.x) / 2, (d.y + d.h / 2 + ay) / 2 - 6], anchor: "middle" });
      else if (s && e.from === "axis") edges.push({ e, s: s.s, id: `axis>${e.to}`, d: curve(axis.x + axis.w, ay, s.x, s.y + s.h / 2), label: [(axis.x + axis.w + s.x) / 2, (ay + s.y + s.h / 2) / 2 - 6], anchor: "middle" });
    }
  } else {
    // Devices on top, Axis, then the services; lines run down a lane at the right (devices) and the left (services).
    const lane = 18, cardW = W - 2 * PAD - lane;
    let y = PAD;
    for (const g of groups) {
      heads.push({ text: g.place, x: PAD + 2, y: y + 13 });
      y += 22;
      for (const n of g.nodes) {
        devices.push({ n, x: PAD, y, w: cardW, h: CARD_H });
        y += CARD_H + GAP;
      }
      y += 8;
    }
    const axW = Math.min(240, cardW - 20);
    axis = { x: Math.round((W - axW) / 2), y: y + 8, w: axW, h: AX_H };
    y = axis.y + axis.h + 24;
    for (const s of map.services) {
      services.push({ s, x: PAD + lane, y, w: cardW, h: SVC_H });
      y += SVC_H + GAP;
    }
    H = y + PAD;
    const ay = axis.y + axis.h / 2, right = W - PAD - 6, left = PAD + 6;
    for (const e of map.edges) {
      const d = devices.find((p) => p.n.id === e.from);
      const s = services.find((p) => p.s.id === e.to);
      if (d) edges.push({ e, id: `${e.from}>axis`, d: `M${d.x + d.w} ${d.y + d.h / 2}H${right}V${ay}H${axis.x + axis.w}`, label: [d.x + d.w - 10, d.y + d.h - 10], anchor: "end" });
      else if (s && e.from === "axis") edges.push({ e, s: s.s, id: `axis>${e.to}`, d: `M${axis.x} ${ay}H${left}V${s.y + s.h / 2}H${s.x}`, label: [s.x + s.w - 10, s.y + s.h - 10], anchor: "end" });
    }
  }
  return { W, H, narrow, heads, devices, services, edges, axis };
}

// --- the overview --------------------------------------------------------------------------------------

/** The stream's state as a pill: live, reconnecting (read every 10 s meanwhile) or paused while the tab is hidden. */
function LinkPill() {
  const [kind, text, title] =
    feed.link === "live" ? ["good", "live", "Changes arrive as they happen."]
    : feed.link === "reconnecting" ? ["warn", "reconnecting", `The live stream dropped; trying again, and reading the map every ${POLL_MS / 1000} s meanwhile.${feed.error ? ` ${feed.error}` : ""}`]
    : ["", "paused", "Paused while this tab is hidden."];
  return html`<span class=${`badge ${kind} map-pill`} id="map-link" title=${title}><i class="dot-i"></i>${text}</span>`;
}

function DeviceNode({ p }) {
  const { n, x, y, w, h } = p;
  const [colour, word] = stateOf(n);
  const v = n.vitals ?? {};
  const busy = n.online && n.state !== "idle";
  const vitals = [];
  let vx = x + 14;
  if (v.battery?.percent !== undefined) {
    vitals.push(html`<g key="b" class=${v.battery.label === "low" ? "warn" : ""}><rect x=${vx} y=${y + 52} width="14" height="8" rx="1.5" class="glyph" /><rect x=${vx + 14} y=${y + 54.5} width="1.6" height="3" class="glyph-fill" /><rect x=${vx + 1.5} y=${y + 53.5} width=${Math.max(0.5, 11 * v.battery.percent / 100)} height="5" class="glyph-fill" />
      <text x=${vx + 20} y=${y + 60} class="t-sm">${v.battery.percent}%${v.battery.charging ? " ⚡" : ""}</text></g>`);
    vx += 58;
  }
  if (v.signal) {
    vitals.push(html`<g key="s"><${Bars} x=${vx} y=${y + 61} rssiLabel=${v.signal.label} /><title>Wi-Fi ${v.signal.rssi} dBm, ${v.signal.label}</title></g>`);
    vx += 24;
  }
  if (n.version) vitals.push(html`<text key="v" x=${vx} y=${y + 60} class="t-sm dim">${fit(n.version, x + w - vx - 8, 11.5)}</text>`);
  const since = n.online ? "" : n.lastSeen ? ` · ${ago(n.lastSeen)}` : " · never connected";
  return html`<a href=${`#map/${encodeURIComponent(n.id)}`} class=${`node dev${busy ? " busy" : ""}${n.online ? "" : " off"}`} data-id=${n.id} style=${`--c: var(${colour})`}>
    <title>${n.name}: ${word}${n.attention.length ? ` · ${n.attention.join("; ")}` : ""}</title>
    <rect x=${x} y=${y} width=${w} height=${h} rx="10" class="card" />
    <circle cx=${x + 16} cy=${y + 19} r="4.5" class="st" />
    <path d=${KIND_ICON[n.kind] ?? KIND_ICON.board} transform=${`translate(${x + 27} ${y + 12})`} class="kind" />
    <text x=${x + 46} y=${y + 24} class="t-name">${fit(n.name, w - 46 - (n.attention.length ? 34 : 12), 13.5)}</text>
    <text x=${x + 14} y=${y + 42} class="t-sm st-t">${word}<tspan class="dim">${since} · ${KIND_WORDS[n.kind] ?? typeName(n.type)}</tspan></text>
    ${vitals}
    ${n.attention.length ? html`<g class="att"><circle cx=${x + w - 16} cy=${y + 18} r="9" /><text x=${x + w - 16} y=${y + 22} text-anchor="middle">${n.attention.length}</text></g>` : null}
  </a>`;
}

function ServiceNode({ p }) {
  const { s, x, y, w, h } = p;
  const words = [SERVICE_WORDS[s.state] ?? s.state];
  if (s.lastMs !== undefined) words.push(`last ${ms(s.lastMs)}`);
  return html`<g class="node svc" data-id=${s.id} style=${`--c: var(${serviceColour(s)})`}>
    <title>${s.name}: ${words.join(", ")}${s.lastAt ? ` (${ago(s.lastAt)})` : ""}${s.error ? ` · ${s.error}` : ""}</title>
    <rect x=${x} y=${y} width=${w} height=${h} rx="10" class="card" />
    <circle cx=${x + 16} cy=${y + 21} r="4.5" class="st" />
    <text x=${x + 28} y=${y + 25} class="t-name">${fit(s.name, w - 40, 13.5)}</text>
    <text x=${x + 28} y=${y + 44} class="t-sm dim">${fit(words.join(" · "), w - 40, 12)}</text>
  </g>`;
}

function AxisNode({ a, map }) {
  const cx = a.x + a.w / 2;
  return html`<g class="node axis" data-id="axis" style=${`--c: var(${feed.link === "live" ? "--accent" : "--warn"})`}>
    <rect x=${a.x} y=${a.y} width=${a.w} height=${a.h} rx="14" class="card" />
    <circle cx=${cx} cy=${a.y + 26} r="11" class="ring" /><circle cx=${cx} cy=${a.y + 26} r="4" class="st" />
    <text x=${cx} y=${a.y + 58} text-anchor="middle" class="t-name">VorteX Axis</text>
    <text x=${cx} y=${a.y + 77} text-anchor="middle" class="t-sm dim">${map.axis?.version ? `${map.axis.version} · ` : ""}up ${span(Date.now() - (map.axis?.startedAt ?? Date.now()))}</text>
  </g>`;
}

function Edge({ g, lit, deviceColour }) {
  const colour = g.e.kind === "link" ? deviceColour : serviceColour(g.s);
  const label = lit?.ms !== undefined ? ms(lit.ms) : g.s?.lastMs !== undefined && !lit ? ms(g.s.lastMs) : "";
  return html`<g class=${`edge ${g.e.kind}${lit ? " lit" : ""}${lit?.now ? " now" : ""}${lit?.ended ? " ended" : ""}`} data-edge=${g.id} style=${`--c: var(${colour})`}>
    <path d=${g.d} class="base" />
    ${lit ? html`<path d=${g.d} class="glow" />` : null}
    ${label ? html`<text x=${g.label[0]} y=${g.label[1]} text-anchor=${g.anchor} class=${`t-xs ${lit ? "lit-t" : "dim"}`}>${label}</text>` : null}
  </g>`;
}

/** Follows the width of its box, so the drawing is laid out for it (one column under 720 px). */
function useWidth() {
  const ref = useRef();
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const box = ref.current;
    const measure = () => setWidth(box.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}

function MapDrawing({ map }) {
  const [ref, width] = useWidth();
  const L = width ? layout(map, width) : undefined;
  const lit = litEdges();
  const colourOf = (id) => stateOf(map.nodes.find((n) => n.id === id) ?? { online: false })[0];
  return html`<div class="map-box" ref=${ref}>
    ${L
      ? html`<svg class=${`map-svg${L.narrow ? " narrow" : ""}`} id="map-svg" viewBox=${`0 0 ${L.W} ${L.H}`} width=${L.W} height=${L.H} role="img" aria-label=${`System map: ${plural(map.nodes.length, "device")}, Axis and ${plural(map.services.length, "service")}`}>
          <g class="edges">${L.edges.map((g) => html`<${Edge} key=${g.id} g=${g} lit=${lit.get(g.id)} deviceColour=${colourOf(g.e.from)} />`)}</g>
          ${L.heads.map((h) => html`<text key=${h.text} x=${h.x} y=${h.y} class="t-head">${h.text}</text>`)}
          ${L.devices.map((p) => html`<${DeviceNode} key=${p.n.id} p=${p} />`)}
          <${AxisNode} a=${L.axis} map=${map} />
          ${L.services.map((p) => html`<${ServiceNode} key=${p.s.id} p=${p} />`)}
        </svg>`
      : null}
  </div>`;
}

const Legend = () => html`<div class="map-legend sm dim" aria-label="Colours">
  ${["idle", "listening", "thinking", "speaking", "offline"].map((k) => html`<span key=${k} style=${`--c: var(${STATE[k][0]})`}><i></i>${STATE[k][1]}</span>`)}
  <span class="lit-key"><b></b>a turn's path, with each stage's time</span>
</div>`;

export function MapPage({ id }) {
  useStore();
  useMap();
  if (id) return html`<${MapDevice} id=${id} />`;
  const map = feed.map;
  return html`<${PageHead} title="Map" purpose="The devices, Axis and the services behind it, as they are now. Select a device for its own page.">
      <${LinkPill} />
    </${PageHead}>
    ${!map
      ? feed.error
        ? html`<div class="card empty-card" id="map-error"><p>Axis did not answer: ${feed.error}</p><p class="help">The map tries again on its own.</p></div>`
        : html`<div class="loading" aria-busy="true"><span class="spinner"></span> Loading the map…</div>`
      : html`<${Legend} />
        ${map.nodes.length ? null : html`<div class="card empty-card" id="map-empty"><p>No devices yet. Paired devices appear on the left, grouped by their location.</p><a class="btn" href="#pair">Add a device</a></div>`}
        <div class="card map-card"><${MapDrawing} map=${map} /></div>
        <p class="help">Lines show what is connected now. A turn lights its way from the device through speech recognition, the agent and speech synthesis, with the time of each stage as this page saw it; nothing is drawn that Axis did not report. Settings are changed on each device's own page.</p>`}`;
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

const SUMMARY_KEYS = ["volume", "brightness", "wakeWord", "voiceMode", "voice", "profile"];
function settingLabel(type, key) {
  const def = store.types[type]?.settings?.find((d) => d.key === key) ?? store.builtIns?.find?.((d) => d.key === key);
  return def?.label ?? key;
}

function MapDevice({ id }) {
  const map = feed.map;
  const n = map?.nodes.find((x) => x.id === id);
  const client = clientById(id);
  const crumb = html`<a href="#map">Map</a>`;
  if (!n) {
    if (!map) return html`<${PageHead} title=${client?.name ?? "Device"} crumb=${crumb}><${LinkPill} /></${PageHead}>
      ${feed.error ? html`<div class="card empty-card"><p>Axis did not answer: ${feed.error}</p></div>` : html`<div class="loading" aria-busy="true"><span class="spinner"></span> Loading…</div>`}`;
    return html`<${PageHead} title="No such device" crumb=${crumb} purpose="It may have been removed, or the address is wrong." />`;
  }
  const [colour, word] = stateOf(n);
  const shown = gauges(n);
  const missing = notReported(n);
  const settings = client ? SUMMARY_KEYS.filter((k) => client.settings?.[k] !== undefined && client.settings[k] !== "") : [];
  const turns = (store.activity?.recentTurns ?? []).filter((t) => t.clientId === id).slice(0, 6);
  const lit = [...feed.turns.values()].find((r) => r.clientId === id && r.endedAt === undefined);
  return html`<${PageHead} title=${n.name} crumb=${crumb} purpose=${[KIND_WORDS[n.kind] ?? typeName(n.type), typeName(n.type), n.location].filter(Boolean).filter((x, i, all) => all.indexOf(x) === i).join(" · ")}>
      <${LinkPill} />
      <a class="btn" href=${deviceHref(id)} id="map-device-page">Device page</a>
    </${PageHead}>
    <div class="map-dev" id="map-device" data-id=${id}>
      <section class="card map-twin">
        <div class="twin-head" style=${`--c: var(${colour})`}><i class="st-dot"></i><b>${lit ? STATE[lit.stage]?.[1] ?? word : word}</b>
          <span class="dim">${n.online ? (n.connectedSince ? `connected ${ago(n.connectedSince)}` : "connected") : n.lastSeen ? `last seen ${ago(n.lastSeen)}` : "never connected"}</span></div>
        ${client ? html`<div class="twin-pic"><${DeviceSketch} client=${client} /></div>` : null}
        <div class="gauges">${shown}</div>
        ${!shown.length ? html`<p class="dim" id="map-no-readings">Readings: not reported.</p>` : missing.length ? html`<p class="help">Not reported: ${missing.join(", ")}.</p>` : null}
      </section>
      <div class="map-side">
        <section class="card"><div class="card-h"><h3>Needs attention</h3></div><div class="card-b">
          ${n.attention.length ? html`<ul class="att-list">${n.attention.map((a) => html`<li key=${a}>${a}</li>`)}</ul>` : html`<p class="dim">Nothing.</p>`}
        </div></section>
        <section class="card"><div class="card-h"><h3>Version</h3></div><div class="card-b">
          <p>${n.version || html`<span class="dim">not reported</span>`}${n.updateAvailable ? html` <span class="badge warn">${n.updateAvailable} available</span>` : null}</p>
        </div></section>
        ${settings.length
          ? html`<section class="card"><div class="card-h"><h3>Settings in effect</h3></div><dl class="facts card-b">${settings.map((k) => html`<div key=${k} class="fact"><dt>${settingLabel(n.type, k)}</dt><dd>${String(client.settings[k])}</dd></div>`)}</dl>
              <p class="help card-b">Changed on the <a href=${deviceHref(id, "settings")}>device page</a>.</p></section>`
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
