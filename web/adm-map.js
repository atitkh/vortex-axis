// The system map (#map): the devices, Axis and the services behind it, drawn in fixed columns from GET /admin/map and
// kept current by GET /admin/map/stream (web/adm-twin.js). Read only: nothing here changes a setting. A turn lights its
// path stage by stage, and a wake word heard by several devices shows who answered; both symbolic, never words.

import { html, useEffect, useRef, useState } from "/web/preact.js";
import { ago, deviceHref, plural, span, typeName, useStore } from "/web/adm-core.js";
import { PageHead } from "/web/adm-shell.js";
import { Bars, KIND_ICON, KIND_WORDS, LinkPill, STATE, SERVICE_WORDS, feed, fit, litEdges, ms, serviceColour, stateOf, useMap, wakeContest } from "/web/adm-twin.js";

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


function DeviceNode({ p, focus, wake }) {
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
  const heard = wake ? ` heard-${wake.outcome}` : "";
  return html`<a href=${deviceHref(n.id)} class=${`node dev${busy ? " busy" : ""}${n.online ? "" : " off"}${focus ? " focus" : ""}${heard}`} data-id=${n.id} style=${`--c: var(${colour})`}>
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

const WAKE_WORDS = { answered: "answered", stood_down: "stood down", ignored: "ignored" };
const PANEL_W = 92, PANEL_H = 58;

/**
 * One device's part in a wake contest, beside its card (inside it, at the right, when there is no room beside it): two bars, how sure it
 * was and how loud, and what came of it; the one that answered says by how much it won.
 */
function WakePanel({ p, w, contest, inside }) {
  const x = inside ? p.x + p.w - PANEL_W - 8 : p.x + p.w + 8;
  const y = inside ? p.y + p.h - PANEL_H - 4 : p.y + (p.h - PANEL_H) / 2;
  const bar = (i, value, cls) => {
    const full = PANEL_H - 16;
    const hgt = Math.max(1.5, full * Math.min(1, Math.max(0, value)));
    return html`<g class=${cls}><rect x=${x + 8 + i * 11} y=${y + 8} width="7" height=${full} rx="2" class="track" /><rect x=${x + 8 + i * 11} y=${y + 8 + full - hgt} width="7" height=${hgt} rx="2" class="fill" /></g>`;
  };
  const winner = contest.winner === w;
  const note = winner && contest.wakes.length > 1 ? (contest.by >= 0 ? `won by ${contest.by.toFixed(2)}` : "won on loudness") : `sure ${w.score.toFixed(2)}`;
  return html`<g class=${`wake ${w.outcome}`} data-wake=${w.clientId}>
    <title>${w.client}: ${WAKE_WORDS[w.outcome]}; sure ${Math.round(w.score * 100)}%, loudness ${Math.round(w.level * 100)}%</title>
    <rect x=${x} y=${y} width=${PANEL_W} height=${PANEL_H} rx="8" class="panel" />
    ${bar(0, w.score, "b-score")}${bar(1, w.level, "b-level")}
    <text x=${x + 32} y=${y + 24} class="t-xs w-out">${WAKE_WORDS[w.outcome]}</text>
    <text x=${x + 32} y=${y + 40} class="t-xs dim">${note}</text>
  </g>`;
}

/** The latest wake word in words, for the line above the drawing and for screen readers. */
function wakeSentence(contest) {
  const { wakes, winner, by } = contest;
  const heard = wakes.length > 1 ? `Wake word heard by ${plural(wakes.length, "device")}` : `Wake word heard by ${wakes[0].client}`;
  if (!winner) return `${heard}; none answered.`;
  if (wakes.length === 1) return `${heard}; it answered.`;
  return `${heard}: ${winner.client} answered${by === undefined ? "" : by >= 0 ? `, won by ${by.toFixed(2)}` : ", the loudest within the margin"}.`;
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

function MapDrawing({ map, focus, contest }) {
  const [ref, width] = useWidth();
  const L = width ? layout(map, width) : undefined;
  const heard = (id) => contest?.wakes.find((w) => w.clientId === id);
  const lit = litEdges();
  const colourOf = (id) => stateOf(map.nodes.find((n) => n.id === id) ?? { online: false })[0];
  return html`<div class="map-box" ref=${ref}>
    ${L
      ? html`<svg class=${`map-svg${L.narrow ? " narrow" : ""}`} id="map-svg" viewBox=${`0 0 ${L.W} ${L.H}`} width=${L.W} height=${L.H} role="img" aria-label=${`System map: ${plural(map.nodes.length, "device")}, Axis and ${plural(map.services.length, "service")}`}>
          <g class="edges">${L.edges.map((g) => html`<${Edge} key=${g.id} g=${g} lit=${lit.get(g.id)} deviceColour=${colourOf(g.e.from)} />`)}</g>
          ${L.heads.map((h) => html`<text key=${h.text} x=${h.x} y=${h.y} class="t-head">${h.text}</text>`)}
          ${L.devices.map((p) => html`<${DeviceNode} key=${p.n.id} p=${p} focus=${p.n.id === focus} wake=${heard(p.n.id)} />`)}
          ${contest
            ? html`<g class=${`contest${contest.fading ? " fading" : ""}`} id="map-contest" key=${contest.id}>${L.devices.map((p) => heard(p.n.id) && html`<${WakePanel} key=${p.n.id} p=${p} w=${heard(p.n.id)} contest=${contest} inside=${L.narrow || L.axis.x - (p.x + p.w) < PANEL_W + 16} />`)}</g>`
            : null}
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

/** `focus`: a device to pick out, from its device page's "On the map". */
export function MapPage({ focus }) {
  useStore();
  useMap();
  const map = feed.map;
  const contest = wakeContest();
  return html`<${PageHead} title="Map" purpose="The devices, Axis and the services behind it, as they are now. Select a device for its page.">
      <${LinkPill} />
    </${PageHead}>
    ${!map
      ? feed.error
        ? html`<div class="card empty-card" id="map-error"><p>Axis did not answer: ${feed.error}</p><p class="help">The map tries again on its own.</p></div>`
        : html`<div class="loading" aria-busy="true"><span class="spinner"></span> Loading the map…</div>`
      : html`<${Legend} />
        ${map.nodes.length ? null : html`<div class="card empty-card" id="map-empty"><p>No devices yet. Paired devices appear on the left, grouped by their location.</p><a class="btn" href="#pair">Add a device</a></div>`}
        <p class=${`map-wake sm${contest ? "" : " none"}${contest?.fading ? " fading" : ""}`} id="map-wake" aria-live="polite">${contest ? wakeSentence(contest) : ""}</p>
        <div class="card map-card"><${MapDrawing} map=${map} focus=${focus} contest=${contest} /></div>
        <p class="help">Lines show what is connected now. A turn lights its way from the device through speech recognition, the agent and speech synthesis, with the time of each stage as this page saw it; nothing is drawn that Axis did not report. When devices hear the wake word, each shows how sure it was and how loud for a few seconds, the one that answered outlined and the others dimmed. Settings are changed on each device's page.</p>`}`;
}

