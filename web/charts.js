// Small SVG charts for the admin page. No library: a timeline strip, a line chart, a column
// chart and one stacked bar, each with a hover readout. Every label goes in as text.
//
// Colours are CSS custom properties from admin.css (--s1..--s3 for series, --st-* for state),
// so light and dark mode swap in one place.

const SVG = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function html(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// --- formatting --------------------------------------------------------------

/** 850 ms, 2.4 s, 12 s. */
export function ms(value) {
  if (value === null || value === undefined) return "–";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  // 5 s, not 5.0 s: a tick or a round value reads cleaner without the zero.
  return `${Number.isInteger(seconds) || seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)} s`;
}

/** 45 s, 12 min, 3 h 20 min, 2 d 4 h. */
export function duration(value) {
  const s = Math.round(value / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** "1 PM" or "13", for axis ticks where space is short. */
function hourLabel(at, withDay) {
  const date = new Date(at);
  const hour = date.toLocaleTimeString([], { hour: "numeric" });
  return withDay ? `${date.toLocaleDateString([], { weekday: "short" })} ${hour}` : hour;
}

export function clock(at, withDay = false) {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return withDay ? `${date.toLocaleDateString([], { weekday: "short", day: "numeric" })} ${time}` : time;
}

export const percent = (share) => (share === null || share === undefined ? "–" : `${(share * 100).toFixed(share >= 0.9995 || share === 0 ? 0 : 1)} %`);

// --- tooltip -----------------------------------------------------------------

let tip;
/** Shows the readout near the pointer. `rows` are [value, label, colour var or null]. */
function showTip(event, title, rows) {
  if (!tip) {
    tip = html("div", { class: "viz-tip", role: "status" });
    document.body.append(tip);
  }
  tip.replaceChildren(
    html("div", { class: "viz-tip-title" }, title),
    ...rows.map(([value, label, color]) =>
      html("div", { class: "viz-tip-row" }, color ? html("span", { class: "key", style: `background:var(${color})` }) : null, html("b", {}, value), " ", html("span", {}, label)),
    ),
  );
  tip.style.display = "block";
  const pad = 14;
  const x = event.clientX + pad + tip.offsetWidth > window.innerWidth ? event.clientX - pad - tip.offsetWidth : event.clientX + pad;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, event.clientY - tip.offsetHeight - 10)}px`;
}
export function hideTip() {
  if (tip) tip.style.display = "none";
}

/** Gives a mark a readout on hover and on keyboard focus. */
function hover(el, title, rows) {
  el.setAttribute("tabindex", "0");
  el.addEventListener("pointermove", (e) => showTip(e, title(), rows()));
  el.addEventListener("pointerleave", hideTip);
  el.addEventListener("focus", () => {
    const r = el.getBoundingClientRect();
    showTip({ clientX: r.left + r.width / 2, clientY: r.top }, title(), rows());
  });
  el.addEventListener("blur", hideTip);
}

// --- timeline strip ------------------------------------------------------------

/** What each state looks like and is called. */
export const STATES = {
  up: ["up", "--st-good"],
  online: ["online", "--st-good"],
  connected: ["connected", "--st-good"],
  connecting: ["connecting", "--st-warn"],
  pairing_required: ["waiting for approval", "--st-warn"],
  down: ["down", "--st-bad"],
  auth_failed: ["refused", "--st-bad"],
  unreachable: ["unreachable", "--st-bad"],
  offline: ["offline", "--st-off"],
  unconfigured: ["not set up", "--st-off"],
  axis_down: ["Axis not running", "--st-axis"],
  unknown: ["no record", "--st-none"],
};
const stateOf = (s) => STATES[s] ?? [s.replace(/_/g, " "), "--st-off"];

/** One row of uptime: coloured spans over [from, to], each with its own readout. */
export function strip(segments, from, to) {
  const W = 1000;
  const box = svg("svg", { viewBox: `0 0 ${W} 14`, preserveAspectRatio: "none", class: "strip", role: "img" });
  const span = to - from;
  const described = [];
  for (const s of segments) {
    const x = ((s.from - from) / span) * W;
    const w = Math.max(((s.to - s.from) / span) * W, 0.8);
    const [label, color] = stateOf(s.state);
    const rect = svg("rect", { x, y: 0, width: w, height: 14, style: `fill:var(${color})` });
    hover(rect, () => label, () => [[duration(s.to - s.from), `${clock(s.from, span > 86_400_000)} – ${clock(s.to, span > 86_400_000)}`, null]]);
    box.append(rect);
    described.push(`${label} ${clock(s.from)}–${clock(s.to)}`);
  }
  box.setAttribute("aria-label", described.join(", "));
  return box;
}

/** Time ticks under a set of strips. */
export function stripAxis(from, to) {
  const span = to - from;
  const step = span <= 26 * 3_600_000 ? 6 * 3_600_000 : span <= 80 * 3_600_000 ? 12 * 3_600_000 : 24 * 3_600_000;
  const first = Math.ceil(from / step) * step;
  const ticks = [];
  for (let t = first; t < to; t += step) ticks.push(t);
  return html(
    "div",
    { class: "strip-axis" },
    ticks.map((t) => html("span", { style: `left:${((t - from) / span) * 100}%` }, hourLabel(t, span > 26 * 3_600_000))),
    html("span", { class: "now" }, "now"),
  );
}

/** A legend for the states that actually appear, one entry per colour. */
export function stateLegend(states) {
  const byColor = new Map();
  for (const s of new Set(states)) {
    if (s === "unknown") continue;
    const [label, color] = stateOf(s);
    byColor.set(color, [...(byColor.get(color) ?? []), label]);
  }
  return html(
    "div",
    { class: "legend" },
    [...byColor].map(([color, labels]) => html("span", {}, html("i", { class: "swatch", style: `background:var(${color})` }), labels.join(", "))),
  );
}

// --- line chart ----------------------------------------------------------------

/**
 * Lines over time buckets, one shared millisecond axis. `series` is
 * [{ key, label, color }], read from each bucket by key. Gaps where a bucket has no value.
 */
export function lineChart(buckets, bucketMs, series, width) {
  const W = Math.max(280, width);
  const H = 170;
  const m = { l: 44, r: 12, t: 10, b: 22 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const values = buckets.flatMap((b) => series.map((s) => b[s.key])).filter((v) => typeof v === "number");
  const top = niceMax(Math.max(1000, ...values));
  const x = (i) => m.l + (buckets.length === 1 ? pw / 2 : (i / (buckets.length - 1)) * pw);
  const y = (v) => m.t + ph - (v / top) * ph;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "chart", role: "img" });

  // Recessive grid with clean ticks.
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i;
    root.append(
      svg("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }),
      svg("text", { x: m.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, ms(v)),
    );
  }
  root.append(...timeTicks(buckets, bucketMs, x, H - 6, pw));

  for (const s of series) {
    let d = "";
    let pen = false;
    buckets.forEach((b, i) => {
      const v = b[s.key];
      if (typeof v !== "number") return void (pen = false);
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    root.append(svg("path", { d, class: "line", style: `stroke:var(${s.color})` }));
    // A lone value between gaps has no line, so every value also gets a dot.
    buckets.forEach((b, i) => {
      const v = b[s.key];
      if (typeof v === "number") root.append(svg("circle", { cx: x(i), cy: y(v), r: 3.5, class: "dot", style: `fill:var(${s.color})` }));
    });
  }

  // Crosshair: the pointer finds the nearest bucket and the readout lists every series there.
  const cross = svg("line", { y1: m.t, y2: m.t + ph, class: "cross", visibility: "hidden" });
  const hit = svg("rect", { x: m.l, y: m.t, width: pw, height: ph, fill: "transparent" });
  hit.addEventListener("pointermove", (e) => {
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(buckets.length - 1, Math.round(((px - m.l) / pw) * (buckets.length - 1))));
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    const b = buckets[i];
    showTip(e, bucketLabel(b.at, bucketMs), [
      ...series.map((s) => [ms(b[s.key]), s.label, s.color]),
      [String(b.count), b.count === 1 ? "turn" : "turns", null],
    ]);
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    hideTip();
  });
  root.append(cross, hit);
  root.setAttribute("aria-label", `${series.map((s) => s.label).join(" and ")} per ${duration(bucketMs)}`);
  return figure(root, series.length > 1 ? legend(series, "line") : null);
}

// --- column chart ----------------------------------------------------------------

/** Stacked columns per bucket. `stacks` is [{ key, label, color }], bottom first. */
export function columnChart(buckets, bucketMs, stacks, width) {
  const W = Math.max(280, width);
  const H = 140;
  const m = { l: 44, r: 12, t: 10, b: 22 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const total = (b) => stacks.reduce((n, s) => n + (b[s.key] || 0), 0);
  const top = niceMax(Math.max(4, ...buckets.map(total)));
  const slot = pw / buckets.length;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const x = (i) => m.l + slot * i + slot / 2;
  const y = (v) => m.t + ph - (v / top) * ph;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "chart", role: "img" });
  for (let i = 0; i <= 2; i++) {
    const v = (top / 2) * i;
    root.append(
      svg("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }),
      svg("text", { x: m.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, String(Math.round(v))),
    );
  }
  root.append(...timeTicks(buckets, bucketMs, x, H - 6, pw));
  buckets.forEach((b, i) => {
    const g = svg("g", { class: "col" });
    let base = 0;
    const parts = stacks.filter((s) => b[s.key] > 0);
    parts.forEach((s, j) => {
      const v = b[s.key];
      const y0 = y(base);
      const y1 = y(base + v);
      // A 2px gap in the surface colour between stacked parts; the top end is rounded.
      const gap = j > 0 ? 2 : 0;
      const hgt = Math.max(1, y0 - y1 - gap);
      const last = j === parts.length - 1;
      g.append(svg("path", { d: barPath(x(i) - bw / 2, y1, bw, hgt, last ? Math.min(4, bw / 2, hgt) : 0), style: `fill:var(${s.color})` }));
      base += v;
    });
    // The hit area is the whole column slot, not just the painted part.
    const hit = svg("rect", { x: x(i) - slot / 2, y: m.t, width: slot, height: ph, fill: "transparent" });
    hover(hit, () => bucketLabel(b.at, bucketMs), () => stacks.map((s) => [String(b[s.key] || 0), s.label, s.color]));
    g.append(hit);
    root.append(g);
  });
  root.setAttribute("aria-label", `${stacks.map((s) => s.label).join(", ")} per ${duration(bucketMs)}`);
  return figure(root, legend(stacks, "rect"));
}

// --- one stacked bar -------------------------------------------------------------

/** Parts of a whole, side by side in one bar, each labelled under the bar. */
export function partsBar(parts) {
  const known = parts.filter((p) => typeof p.value === "number" && p.value > 0);
  const total = known.reduce((n, p) => n + p.value, 0);
  if (!total) return html("p", { class: "help" }, "Not enough turns yet.");
  const bar = html("div", { class: "parts", role: "img", "aria-label": known.map((p) => `${p.label} ${ms(p.value)}`).join(", ") });
  for (const p of known) {
    const seg = html("span", { style: `flex:${p.value} 1 0;background:var(${p.color})` });
    hover(seg, () => p.label, () => [[ms(p.value), `${Math.round((p.value / total) * 100)} % of the wait`, p.color]]);
    bar.append(seg);
  }
  // Values always shown in text beside their key, so no colour has to carry them alone.
  const keys = html(
    "div",
    { class: "legend" },
    known.map((p) => html("span", {}, html("i", { class: "swatch", style: `background:var(${p.color})` }), `${p.label} `, html("b", {}, ms(p.value)))),
  );
  return html("div", {}, bar, keys);
}

// --- shared pieces -----------------------------------------------------------------

function figure(chart, legendEl) {
  return html("div", { class: "figure" }, legendEl, chart);
}

function legend(series, shape) {
  return html(
    "div",
    { class: "legend" },
    series.map((s) => html("span", {}, html("i", { class: shape === "line" ? "linekey" : "swatch", style: `background:var(${s.color})` }), s.label)),
  );
}

/** Time labels under a chart, as many as fit without touching. */
function timeTicks(buckets, bucketMs, x, yPos, plotWidth) {
  const days = bucketMs > 3_600_000;
  const room = Math.max(2, Math.floor(plotWidth / (days ? 80 : 56)));
  const every = Math.max(1, Math.ceil(buckets.length / room));
  return buckets
    .map((b, i) => (i % every === 0 ? svg("text", { x: x(i), y: yPos, class: "tick", "text-anchor": "middle" }, hourLabel(b.at, days)) : null))
    .filter(Boolean);
}

function bucketLabel(at, bucketMs) {
  return `${clock(at, bucketMs > 3_600_000)} – ${clock(at + bucketMs)}`;
}

/** A round number at or above `v`, for the top of an axis. */
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= v) return f * p;
  return 10 * p;
}

/** A bar with only its top corners rounded, square at the baseline. */
function barPath(x, y, w, h, r) {
  if (!r) return `M${x},${y}h${w}v${h}h${-w}z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}z`;
}
