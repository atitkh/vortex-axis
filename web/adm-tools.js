// Pictures and live tools on the admin page: the vortex face, a sketch of a device as Axis understands it,
// the edge glow drawn the way the boards draw it, and the microphone level meter. Ported from the classic admin.js.
// The face and the device screens stay black in either theme: they are what the devices show.

import { html, useEffect, useMemo, useRef, useState } from "/web/preact.js";
import { Vortex } from "/web/vortex.js";
import { ago, api, enc, kept, set, store } from "/web/adm-core.js";

// --- the face -----------------------------------------------------------------------------------

/** The live vortex face. With `client`, it wears that device's idle-look and tool-icon settings. */
export function Face({ mode = "idle", client, calm = true }) {
  const ref = useRef();
  const face = useRef();
  useEffect(() => {
    face.current = new Vortex(ref.current);
    face.current.calm = calm && face.current.calm;
    return () => face.current.stop();
  }, []);
  useEffect(() => {
    const f = face.current;
    if (client) {
      f.calm = false;
      f.setIdleOff(client.settings.idleLooksOff);
      f.setIconStyle(client.settings.toolIcons);
      f.setIconTuning(client.settings.toolIconMs, client.settings.toolIconDots);
    }
    f.setMode(mode);
  });
  return html`<canvas class="face" ref=${ref} aria-hidden="true"></canvas>`;
}

// --- a sketch of the device -----------------------------------------------------------------------

export const DOING = { listening: "Listening", thinking: "Waiting for the agent", speaking: "Speaking", asked: "Waiting for an answer" };
const clip = (text, length) => (text.length > length ? `…${text.slice(-length)}` : text);
export function countdown(ms) {
  const left = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(left / 3600), minutes = Math.floor((left % 3600) / 60), seconds = String(left % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** What the device is doing now, from the live "now" list. */
export function doingOf(client) {
  const live = store.now?.clients.find((c) => c.clientId === client.id);
  return !client.online ? "Offline" : DOING[live?.state] ?? "Idle";
}

/**
 * The device as Axis understands it: a frame for the kind of thing it is (shaped by the screen size it reports and the
 * way up it stands, round when it says so), the live face in its current state, what is on its screen, and what it has.
 * `size`: "full" with the words and chips, or "mini" for a card or the header.
 */
export function DeviceSketch({ client, size = "full" }) {
  const can = (what) => client.capabilities.includes(what);
  const w = Number(client.readings?.screenW), hgt = Number(client.readings?.screenH);
  const known = can("screen") && w > 0 && hgt > 0;
  const ratio = known ? Math.min(2.4, Math.max(0.42, w / hgt)) : 0;
  const round = known && Number(client.readings?.screenRound) === 1;
  const kind = !can("screen") ? "plain" : client.type === "web" ? "browser" : "board";
  const live = store.now?.clients.find((c) => c.clientId === client.id);
  const doing = live?.state;
  const mode = !client.online ? "offline" : ["listening", "thinking", "speaking"].includes(doing) ? doing : "idle";
  const box = size === "mini" ? 64 : 200;
  const width = known ? Math.round(Math.min(box, (box + 30) * ratio)) + (kind === "browser" ? 12 : size === "mini" ? 10 : 20) : undefined;
  const words = [];
  if (size === "full" && client.online && can("screen")) {
    const screen = store.now?.screens?.[client.id];
    const timer = (store.now?.timers ?? []).slice().sort((x, y) => x.dueAt - y.dueAt)[0];
    if (doing === "asked") {
      words.push(html`<div>${live.question ?? ""}</div>`, html`<div>${(live.choices ?? []).map((c) => html`<span class="pick">${c}</span>`)}</div>`);
    } else if (screen && (doing || Date.now() - screen.at < 20_000)) {
      if (screen.heard) words.push(html`<div class="heard">${clip(screen.heard, 90)}</div>`);
      if (screen.said) words.push(html`<div>${clip(screen.said, 160)}</div>`);
    }
    if (timer) words.push(html`<div class="timer">${timer.label ? `${timer.label} ` : ""}${countdown(timer.dueAt - (store.now?.at ?? Date.now()))}</div>`);
  }
  return html`<div class=${`sketch ${size}`}>
    <div class=${`frame ${kind}${round ? " round" : ""}${known ? " measured" : ""}${client.online ? "" : " is-offline"}`}
      style=${width ? `width:${width}px` : ""} title=${known ? `${w} × ${hgt}${round ? ", round" : ""}` : ""}>
      <div class="screen" style=${known ? `aspect-ratio:${ratio}` : ""}>
        ${can("screen") ? html`<${Face} mode=${mode} client=${client} calm=${false} />` : html`<p>${size === "mini" ? "" : "no screen"}</p>`}
        ${words.length ? html`<div class="words">${words}</div>` : null}
      </div>
    </div>
    ${size === "full"
      ? html`<div class="doing"><b>${doingOf(client)}</b></div>
        <div class="chips">${[["mic", "microphone"], ["speaker", "speaker"], ["screen", "screen"]].map(([k, label]) =>
          html`<span class=${can(k) ? "chip" : "chip no"} title=${can(k) ? `It has a ${label}` : `No ${label}`}>${label}</span>`)}</div>`
      : null}
  </div>`;
}

// --- the edge glow, as the board draws it ------------------------------------------------------------

/**
 * The board's glow (firmware glow.cpp), worked out the same way: how far a pixel is in from the edge, following a
 * curve of `radius` at the corners, fading out DEPTH pixels in, blended over black. Keep the colours, paces and
 * strengths in step with glow.cpp (and the classic admin.js, which has the same table).
 */
const GLOW_DEPTH = 12;
export const GLOW_STATES = [
  { key: "waiting", label: "Needs you", rgb: [1, 0.6, 0.08], hz: 0.5 },
  { key: "question", label: "Question", rgb: [0.2, 0.5, 1], hz: 0.8 },
  { key: "done", label: "Done flash", rgb: [0.34, 1, 0.4], hz: 0 },
  { key: "timer", label: "Timer", rgb: [1, 0.16, 0.1], hz: 0 },
  { key: "find", label: "Find", rgb: [1, 1, 1], hz: 2.5 },
  { key: "hands", label: "Computer in use", rgb: [1, 0.32, 0.62], hz: 1.4 },
  { key: "listening", label: "Listening", rgb: [0.15, 1, 0.55], hz: 1.2 },
  { key: "thinking", label: "Thinking", rgb: [0.62, 0.4, 1], hz: 0.9 },
  { key: "speaking", label: "Speaking", rgb: [0.55, 0.95, 1], hz: 2.4 },
];
const GLASS_KEY = "axis.glassCorner";

function glowMap(w, hgt, radius, round = false) {
  const index = [], fall = [], turn = [];
  for (let py = 0; py < hgt; py++) {
    for (let px = 0; px < w; px++) {
      const cx = Math.min(Math.max(px, radius), w - 1 - radius), cy = Math.min(Math.max(py, radius), hgt - 1 - radius);
      const d = round
        ? Math.min(w, hgt) / 2 - Math.hypot(px - (w - 1) / 2, py - (hgt - 1) / 2)
        : cx !== px && cy !== py ? radius - Math.hypot(px - cx, py - cy) : Math.min(px, py, w - 1 - px, hgt - 1 - py);
      if (d >= GLOW_DEPTH) continue;
      const f = d <= 0 ? 1 : 1 - d / GLOW_DEPTH;
      let t = Math.atan2(px - w / 2, hgt / 2 - py) / (2 * Math.PI);
      if (t < 0) t += 1;
      index.push(py * w + px);
      fall.push(f * f);
      turn.push(t);
    }
  }
  return { index: Int32Array.from(index), fall: Float32Array.from(fall), turn: Float32Array.from(turn) };
}

/**
 * Lays the glow over the RGBA pixels in `data` (a picture or black), as the board's blend: mixed towards the colour by
 * its strength times the fall-off, in 5-6-5 steps. With `sweep` below 1 only that much of the turn is drawn.
 */
function paintGlow(data, { index, fall, turn }, [r, gr, b], strength, sweep = 1) {
  for (let k = 0; k < index.length; k++) {
    if (sweep < 1 && turn[k] > sweep) continue;
    const a = strength * fall[k], o = index[k] * 4;
    data[o] = (Math.round(((data[o] / 255) * (1 - a) + r * a) * 31) * 255) / 31;
    data[o + 1] = (Math.round(((data[o + 1] / 255) * (1 - a) + gr * a) * 63) * 255) / 63;
    data[o + 2] = (Math.round(((data[o + 2] / 255) * (1 - a) + b * a) * 31) * 255) / 31;
  }
}

/** Shades what a round screen's glass hides, outside its circle. */
function roundMask(ctx, w, hgt) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, hgt);
  ctx.arc(w / 2, hgt / 2, Math.min(w, hgt) / 2, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(17,17,17,0.85)";
  ctx.fill("evenodd");
  ctx.restore();
}

/** Whether a device draws the glow:it offers glowCorner, or its screen is round (no corners to set). */
export function glowDef(client) {
  const schema = store.types[client.type];
  const round = Number(client.readings?.screenRound) === 1 && client.capabilities.includes("screen");
  const def = schema?.settings.find((d) => d.key === "glowCorner") ?? (round ? { key: "glowCorner", default: 56 } : undefined);
  return def ? { def, round } : undefined;
}

/**
 * The glow preview. `radius` is the corner curve to draw (a staged value or the saved one); `onRadius` stages a new
 * one (it is saved with the page's other changes). "Show on the device" sends what is drawn.
 */
export function GlowPreview({ client, radius, saved, onRadius }) {
  const { def, round } = glowDef(client);
  const w = Number(client.readings?.screenW) || 368, hgt = Number(client.readings?.screenH) || 448;
  const [state, setState] = useState(GLOW_STATES[0]);
  const [glass, setGlass] = useState(() => Number(kept.get(GLASS_KEY, 40)) || 40);
  const [note, setNote] = useState(["", ""]);
  const canvas = useRef();
  const map = useMemo(() => glowMap(w, hgt, radius, round), [w, hgt, radius, round]);
  const live = useRef({});
  live.current = { state, glass, map, started: live.current.started ?? 0 };
  useEffect(() => {
    live.current.started = performance.now();
  }, [state]);
  useEffect(() => {
    const ctx = canvas.current.getContext("2d");
    const image = ctx.createImageData(w, hgt);
    let frame, last = 0;
    const draw = (now) => {
      frame = requestAnimationFrame(draw);
      // The board draws about twenty times a second; so does this. Not at all while the tab is hidden.
      if (now - last < 50 || document.hidden) return;
      last = now;
      const { state: s, glass: g, map: m, started } = live.current;
      const t = (now - started) / 1000;
      let strength, sweep = 1;
      if (s.key === "done") {
        const into = t % 3;
        strength = into < 1.5 ? 0.9 * (1 - into / 1.5) : 0;
      } else if (s.key === "timer") {
        const left = 10 - (t % 11);
        sweep = Math.max(0, left / 10);
        const beat = left > 0 ? left % 1 : 0;
        strength = 0.35 + 0.6 * beat * beat;
      } else if (s.key === "listening" || s.key === "speaking") {
        const level = Math.max(0, Math.sin(t * 7) * 0.5 + Math.sin(t * 13.3) * 0.3 + 0.3);
        strength = 0.35 + 0.6 * Math.min(1, level);
      } else {
        strength = 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(2 * Math.PI * s.hz * t));
      }
      const data = image.data;
      data.fill(0);
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      paintGlow(data, m, s.rgb, strength, sweep);
      ctx.putImageData(image, 0, 0);
      if (round) {
        roundMask(ctx, w, hgt);
      } else if (g > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, hgt);
        ctx.roundRect(0, 0, w, hgt, g);
        ctx.fillStyle = "rgba(17,17,17,0.85)";
        ctx.fill("evenodd");
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(1, 1, w - 2, hgt - 2, g);
        ctx.stroke();
        ctx.restore();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [w, hgt, round]);
  const show = async () => {
    setNote(["Sending…", ""]);
    try {
      const result = await api("POST", `/admin/clients/${enc(client.id)}/glow`, { kind: state.key, corner: radius });
      if (!result.ok) throw new Error(result.error === "not implemented on this device" ? `${client.name} needs newer firmware to show a glow from here.` : result.error || "the device did not show it");
      setNote([`${client.name} is showing ${state.label.toLowerCase()} for ${result.ms / 1000} s${round ? "" : `, with a ${radius} px curve${radius !== saved ? " (not saved yet)" : ""}`}.`, "good"]);
    } catch (error) {
      setNote([error.message, "bad"]);
    }
  };
  const scale = Math.min(1, 220 / Math.max(w, hgt));
  return html`<div class="glow">
    <div class=${`glow-frame${round ? " round" : ""}`}><canvas ref=${canvas} width=${w} height=${hgt} style=${`width:${Math.round(w * scale)}px;height:${Math.round(hgt * scale)}px`} aria-label=${`Edge glow preview: ${state.label}`} role="img"></canvas></div>
    <div class="glow-controls">
      <div class="glowkinds" role="group" aria-label="Glow">
        ${GLOW_STATES.map((s) => html`<button type="button" key=${s.key} class=${s === state ? "on" : ""} aria-pressed=${s === state} onClick=${() => setState(s)}><i style=${`background:rgb(${s.rgb.map((c) => Math.round(c * 255)).join(",")})`}></i>${s.label}</button>`)}
      </div>
      ${round
        ? html`<p class="help">${w} × ${hgt}, round: no corners to set.</p>`
        : html`
          <label class="slider">Glow corner curve <input type="range" min=${def.min ?? 12} max=${def.max ?? 120} value=${radius} onInput=${(e) => onRadius(Number(e.target.value))} data-edit="glowCorner-slider" /><span class="mono">${radius} px</span></label>
          <label class="slider" title="Only for this preview: where the glass hides the panel's corners. Kept in this browser.">Glass corner (guide) <input type="range" min="0" max="120" value=${glass} onInput=${(e) => (setGlass(Number(e.target.value)), kept.set(GLASS_KEY, Number(e.target.value)))} /><span class="mono">${glass} px</span></label>
          <p class="help">${w} × ${hgt}, the way up it stands now. A new curve is saved with the page's other changes.</p>`}
      <div class="row-acts"><button type="button" class="btn sm" disabled=${!client.online} onClick=${show}>Show on the device</button></div>
      ${note[0] ? html`<p class=${`msg ${note[1]}`} role="status">${note[0]}</p>` : null}
    </div>
  </div>`;
}

// --- the battery, as the boards show it --------------------------------------------------------------------

/*
 * The boards' battery look (docs/face.md section 10): firmware battery_cue.cpp for the mark and when it shows, the
 * sleepy idle in vortex.cpp, the charging swell in main.cpp and glow.cpp. This is the admin page's preview copy;
 * web/vortex.js, the web client's face, has no battery look on purpose (a page has no battery it can rely on).
 * Keep these numbers in step with docs/face.md, as the glow's are.
 */
const BAT = {
  hysteresis: 3, // low clears above the threshold plus this
  pulseBelow: 5, // below this the cells turn red and the mark pulses, once every pulseMs
  pulseMs: 2500,
  cueMs: 3000, // the charging swell
  slow: 0.4, // sleepy: the idle face at 60 % speed
  dim: 0.25, // and 75 % brightness
  easeIn: 1.5,
  easeOut: 8,
  w: 140, // the mark's block
  h: 24,
  // The percent: FreeSans 11 pt on the board (the medium text size), drawn here in a 22 px sans that has the same
  // figure height and widths; the font is an approximation, the colours and places are the board's.
  font: "22px Arial, Helvetica, 'Liberation Sans', sans-serif",
  baseline: 19,
  bottom: 14, // pixels under the block; the round 1.75 keeps it higher, inside the glass
  bottomRound: 26,
  ink: [0.8, 0.82, 0.85],
  amber: [1, 0.6, 0.08],
  red: [1, 0.16, 0.1],
  green: [0.34, 1, 0.4],
  cyan: [0.1, 0.78, 0.95],
};
// The battery (with its tip) and the bolt, as battery_cue.cpp shapes them.
const BAT_SHAPE = { w: 34, h: 16, body: 30, radius: 4, stroke: 2, fillIn: 3.5, gap: 6 };
const BAT_BOLT = [[6.5, 0], [0.5, 10], [5, 10], [3.5, 18], [10.5, 7.5], [6, 7.5], [8.5, 0]];
// The idle face's usual size on a board (main.cpp, IDLE_FACES), in the middle of the screen.
const IDLE_FACE = 264;
export const BATTERY_QUICK = [
  { key: "low", label: "Low", percent: 12, charging: false },
  { key: "critical", label: "Critical", percent: 4, charging: false },
  { key: "charging", label: "Charging", percent: 64, charging: true },
  { key: "none", label: "Full/none" },
];

/** The battery-look setting of a device's type, when its boards have the look. */
export function batteryDef(client) {
  return store.types[client.type]?.settings.find((d) => d.key === "lowBatteryBelow");
}

/** A colour as the board makes it: times its brightness, in 5-6-5 steps. */
const c565 = ([r, g, b], k) =>
  `rgb(${[[r, 31], [g, 63], [b, 31]].map(([c, n]) => Math.round((Math.min(n, Math.max(0, Math.round(c * k * n))) * 255) / n)).join(",")})`;

/** The mark, as battery_cue.cpp lays it out: [bolt] battery percent, centred in its block at (x, y). */
function drawBatteryMark(ctx, x, y, { percent, low, charging, full, k, boltK }) {
  const S = BAT_SHAPE;
  const text = `${percent}%`;
  ctx.save();
  ctx.font = BAT.font;
  const textW = full ? Math.round(ctx.measureText(text).width) : 0;
  const width = (charging ? 11 : 0) + (charging && full ? S.gap : 0) + (full ? S.w + S.gap + textW : 0);
  let at = x + Math.trunc((BAT.w - width) / 2);
  const grey = c565(BAT.ink, k * 0.85);
  const levelK = charging ? 1 : k;
  const level = charging ? c565(BAT.green, 0.8) : percent < BAT.pulseBelow ? c565(BAT.red, levelK) : low ? c565(BAT.amber, levelK) : grey;
  const rounded = (x0, y0, w, h, r) => (ctx.beginPath(), ctx.roundRect(x0, y0, w, h, r));
  if (charging) {
    const top = y + (BAT.h - 18) / 2;
    ctx.beginPath();
    BAT_BOLT.forEach(([px, py], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, at + px, top + py));
    ctx.closePath();
    ctx.fillStyle = c565(BAT.cyan, boltK);
    ctx.fill();
    at += 11 + (full ? S.gap : 0);
  }
  if (full) {
    const top = y + (BAT.h - S.h) / 2;
    ctx.fillStyle = grey;
    rounded(at + S.body - 1, top + S.h / 2 - 3.5, S.w - S.body + 1, 7, 1.5);
    ctx.fill();
    rounded(at, top, S.body, S.h, S.radius);
    ctx.roundRect(at + S.stroke, top + S.stroke, S.body - 2 * S.stroke, S.h - 2 * S.stroke, S.radius - S.stroke);
    ctx.fill("evenodd");
    if (percent > 0) {
      const inside = S.body - 2 * S.fillIn;
      ctx.save();
      rounded(at + S.fillIn, top + S.fillIn, inside, S.h - 2 * S.fillIn, 1.5);
      ctx.clip();
      ctx.fillStyle = level;
      ctx.fillRect(at + S.fillIn, top, Math.max(1.5, (inside * percent) / 100), S.h);
      ctx.restore();
    }
    at += S.w + S.gap;
    ctx.fillStyle = level;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, at, y + BAT.baseline);
  }
  ctx.restore();
}

/** The vortex face, drawn only when the battery preview's own loop says (so it can run slower, as a sleepy board's does). */
class StepVortex extends Vortex {
  frame() {}
}

/**
 * The battery preview: the board's screen at a made-up charge, drawn as the board draws it (the sleepy idle face, the
 * mark, the charging swell and bolt), with "Show on the device" to have the board show the same for a while.
 * `below` and `glyph` are the lowBatteryBelow and batteryGlyph values to draw with (staged or saved); `radius` the
 * glow's corner curve.
 */
export function BatteryPreview({ client, below, glyph = true, radius = 56 }) {
  const round = Number(client.readings?.screenRound) === 1;
  const w = Number(client.readings?.screenW) || 368, hgt = Number(client.readings?.screenH) || 448;
  const [shown, setShown] = useState({ on: true, percent: 12, charging: false, quick: "low" });
  const [note, setNote] = useState(["", ""]);
  const canvas = useRef();
  const threshold = below > 0 ? Math.min(30, Math.max(5, below)) : 0;
  const map = useMemo(() => glowMap(w, hgt, radius, round), [w, hgt, radius, round]);
  const live = useRef({ low: false, sleepy: 0, cueFrom: -Infinity });
  Object.assign(live.current, { shown, threshold, glyph, map });
  // Charging that begins plays the cue, as on the board.
  const wasCharging = useRef(false);
  useEffect(() => {
    const now = shown.on && shown.charging;
    if (now && !wasCharging.current) live.current.cueFrom = performance.now();
    wasCharging.current = now;
  }, [shown]);
  useEffect(() => {
    const ctx = canvas.current.getContext("2d");
    const side = Math.min(IDLE_FACE, w, hgt);
    const faceCanvas = document.createElement("canvas");
    faceCanvas.width = faceCanvas.height = side;
    const face = new StepVortex(faceCanvas);
    face.calm = false;
    face.setIdleOff(client.settings.idleLooksOff);
    face.setMode("idle");
    const fx = ((w - side) / 2) & ~1, fy = ((hgt - side) / 2) & ~1;
    const mx = ((w - BAT.w) / 2) & ~1, my = (hgt - BAT.h - (round ? BAT.bottomRound : BAT.bottom)) & ~1;
    let frame, last = 0;
    const draw = (now) => {
      frame = requestAnimationFrame(draw);
      if (now - last < 33 || document.hidden) return;
      const dt = Math.min(0.1, last ? (now - last) / 1000 : 0);
      last = now;
      const L = live.current, s = L.shown;
      const percent = s.on ? Math.round(s.percent) : -1;
      const charging = s.on && s.charging;
      // Low, with the board's hysteresis: it clears only above the threshold plus 3.
      L.low = percent >= 0 && !charging && L.threshold > 0 && (L.low ? percent <= L.threshold + BAT.hysteresis : percent <= L.threshold);
      const want = L.low ? 1 : 0;
      L.sleepy += (want - L.sleepy) * (1 - Math.exp(-dt * (want > L.sleepy ? BAT.easeIn : BAT.easeOut)));
      if (L.sleepy < 0.01) L.sleepy = 0;
      face.draw(dt * (1 - BAT.slow * L.sleepy));
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, hgt);
      ctx.globalAlpha = 1 - BAT.dim * L.sleepy;
      ctx.drawImage(faceCanvas, fx, fy);
      ctx.globalAlpha = 1;
      const t = charging ? (now - L.cueFrom) / BAT.cueMs : 1;
      const cue = t >= 0 && t < 1 ? Math.sin(Math.PI * t) : -1;
      if (cue >= 0) {
        const image = ctx.getImageData(0, 0, w, hgt);
        paintGlow(image.data, L.map, BAT.cyan, 0.35 + 0.6 * cue);
        ctx.putImageData(image, 0, 0);
      }
      if (percent >= 0 && (cue >= 0 || (L.glyph && (L.low || charging)))) {
        const k = L.low && percent < BAT.pulseBelow ? 0.35 + 0.65 * (0.5 + 0.5 * Math.cos((2 * Math.PI * (now % BAT.pulseMs)) / BAT.pulseMs)) : 1;
        drawBatteryMark(ctx, mx, my, { percent, low: L.low, charging, full: L.glyph || cue < 0, k, boltK: cue >= 0 ? 0.45 + 0.55 * cue : 0.8 });
      }
      if (round) roundMask(ctx, w, hgt);
    };
    frame = requestAnimationFrame(draw);
    return () => (cancelAnimationFrame(frame), face.stop());
  }, [w, hgt, round]);
  const pick = (q) => (q.charging && (live.current.cueFrom = performance.now()), setShown(q.percent === undefined ? { ...shown, on: false, charging: false, quick: q.key } : { on: true, percent: q.percent, charging: q.charging, quick: q.key }));
  const send = async (body, done) => {
    setNote(["Sending…", ""]);
    try {
      const result = await api("POST", `/admin/clients/${enc(client.id)}/battery`, body);
      if (!result.ok) throw new Error(result.error || "the device did not show it");
      setNote([done, "good"]);
    } catch (error) {
      // Firmware from before the battery command answers "not implemented"; an Axis without the route, 404.
      const old = /not implemented/i.test(error.message) || error.status === 404 || error.status === 405;
      setNote([old ? `${client.name} needs newer firmware to show the battery from here.` : error.message, "bad"]);
    }
  };
  const show = () =>
    send(shown.on ? { percent: Math.round(shown.percent), charging: shown.charging } : { off: true },
      shown.on ? `${client.name} is showing ${Math.round(shown.percent)} %${shown.charging ? ", charging" : ""} for 20 s.` : `${client.name} is back to its own battery.`);
  const words = !shown.on ? "No battery look (full, or no battery)" : `${Math.round(shown.percent)} %${shown.charging ? ", charging" : ""}`;
  const scale = Math.min(1, 220 / Math.max(w, hgt));
  return html`<div class="glow battery">
    <div class=${`glow-frame${round ? " round" : ""}`}><canvas ref=${canvas} width=${w} height=${hgt} style=${`width:${Math.round(w * scale)}px;height:${Math.round(hgt * scale)}px`} aria-label=${`Battery preview: ${words}`} role="img" data-battery-canvas></canvas></div>
    <div class="glow-controls">
      <div class="glowkinds" role="group" aria-label="Battery">
        ${BATTERY_QUICK.map((q) => html`<button type="button" key=${q.key} class=${q.key === shown.quick ? "on" : ""} aria-pressed=${q.key === shown.quick} data-battery=${q.key} onClick=${() => pick(q)}>${q.label}</button>`)}
      </div>
      <label class="slider">Charge
        <span class="batrange" style=${threshold ? `--low:${threshold}%` : undefined}>
          <input type="range" min="0" max="100" value=${shown.percent} data-edit="battery-percent" onInput=${(e) => setShown({ ...shown, on: true, percent: Number(e.target.value), quick: "" })} />
          ${threshold ? html`<i class="battick" title=${`Low battery look at or below ${threshold} %`}></i>` : null}
        </span>
        <span class="mono" data-battery-label>${words}</span></label>
      <label class="switch-l"><input type="checkbox" class="switch" checked=${shown.on && shown.charging} data-edit="battery-charging" onChange=${(e) => setShown({ ...shown, on: true, charging: e.currentTarget.checked, quick: "" })} /> Charging</label>
      <p class="help">${threshold ? `The look starts at or below ${threshold} % and clears above ${threshold + BAT.hysteresis} %.` : "The low battery look is off (Low battery look is 0)."}${glyph ? "" : " The battery mark is off: only the sleepy face and the charging cue show."}</p>
      <div class="row-acts">
        <button type="button" class="btn sm" disabled=${!client.online} onClick=${show} data-battery-send>Show on the device</button>
        <button type="button" class="btn sm" disabled=${!client.online} onClick=${() => send({ off: true }, `${client.name} is back to its own battery.`)} data-battery-off>Off</button>
      </div>
      ${note[0] ? html`<p class=${`msg ${note[1]}`} role="status" data-battery-note>${note[0]}</p>` : null}
    </div>
  </div>`;
}

// --- microphone levels: the device's `mic` action, read about once a second for up to a minute ---------------

const MIC_METER_MS = 60_000;
/** The running reading: one at a time, for the device whose page is open; it stops when that page is left. */
let mic;
const micDb = (v) => (v > 0 ? 20 * Math.log10(v / 32768) : -90);

function stopMic(note) {
  if (!mic) return;
  clearTimeout(mic.timer);
  mic = { ...mic, running: false, timer: undefined, note: note ?? (mic.note === "Reading…" ? "" : mic.note) };
  set({});
}

function onThisDevice(id) {
  return location.hash.startsWith(`#clients/${enc(id)}`) || location.hash.startsWith(`#device/${enc(id)}`);
}

async function micTick(m) {
  if (mic !== m || !m.running) return;
  if (!onThisDevice(m.id) || Date.now() > m.until) return stopMic(Date.now() > m.until ? "Stopped after a minute. Start again to read more." : "");
  try {
    const result = await api("POST", `/admin/clients/${enc(m.id)}/commands/mic`);
    if (mic !== m) return;
    if (result.ok) {
      m.last = result.payload || {};
      m.note = typeof m.last.level === "number" ? `Reading, ${Math.ceil((m.until - Date.now()) / 1000)} s left.` : "This device's firmware does not report the current level: room and threshold only (update its firmware for the third bar).";
      m.kind = "";
    } else {
      m.note = result.error || "The device did not answer.";
      m.kind = "bad";
    }
  } catch (error) {
    if (mic !== m) return;
    m.note = error.message;
    m.kind = "bad";
  }
  set({});
  if (mic === m && m.running) m.timer = setTimeout(() => micTick(m), 1000);
}

export function MicPanel({ client }) {
  const mine = mic?.id === client.id ? mic : undefined;
  const start = () => {
    stopMic();
    mic = { id: client.id, until: Date.now() + MIC_METER_MS, running: true, last: undefined, note: "Reading…", kind: "" };
    set({});
    micTick(mic);
  };
  useEffect(() => () => mic?.id === client.id && !onThisDevice(client.id) && stopMic(), [client.id]);
  const rows = mine?.last
    ? [["Room", "Room level", mine.last.room, "var(--dim)"], ["Speech starts", "Speech starts above", mine.last.speechAbove, "var(--warn)"], ["Loudest", "Loudest since last reading", mine.last.level, "var(--good)"]].filter(([, , v]) => typeof v === "number")
    : [];
  return html`<div class="mic">
    <p class="help">Reads the microphone about once a second for a minute: the room's own level, the level speech must pass to start a recording, and the loudest sound since the last reading. Levels only; no sound leaves the device.</p>
    <div class="meters" aria-live="polite">
      ${rows.map(([label, title, v, color]) => {
        const db = micDb(v);
        return html`<div class="meter" key=${label} title=${title}><span>${label}</span><span class="bar"><i style=${`width:${Math.max(0, Math.min(100, ((70 + db) / 70) * 100))}%;background:${color}`}></i></span><span class="v">${v} · ${Math.round(db)} dB</span></div>`;
      })}
    </div>
    <div class="row-acts">
      <button type="button" class="btn sm" id="mic-go" disabled=${!client.online && !mine?.running} onClick=${() => (mine?.running ? stopMic() : start())}>${mine?.running ? "Stop" : "Start"}</button>
      ${mine?.note ? html`<span class=${`msg ${mine.kind ?? ""}`} id="mic-note">${mine.note}</span>` : html`<span class="msg" id="mic-note"></span>`}
    </div>
  </div>`;
}

// --- pictures shown on a screen (the show tool) ---------------------------------------------------

/** Whether a device can show pictures at all: what it reported, before anything was switched off. */
export const showsPictures = (client) => (client.reported ?? client.capabilities ?? []).some((c) => c === "images" || c === "image-frames");

/** Puts a picture on the device's screen for a while, from a file or an https address; Clear takes it down. */
export function ShowPicture({ client, onShown }) {
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState("");
  const [seconds, setSeconds] = useState(10);
  const [alt, setAlt] = useState("");
  const [fit, setFit] = useState("cover");
  const [note, setNote] = useState(["", ""]);
  const round = Number(client.readings?.screenRound) === 1;
  const w = Number(client.readings?.screenW) || 368, hgt = Number(client.readings?.screenH) || 448;
  const scale = Math.min(1, 200 / Math.max(w, hgt));
  const off = (client.off ?? []).some((c) => c === "screen" || c === "images" || c === "image-frames");
  const src = file?.data || (/^https:\/\//i.test(url.trim()) ? url.trim() : "");
  const pickFile = (e) => {
    const chosen = e.currentTarget.files?.[0];
    if (!chosen) return setFile(null);
    if (chosen.size > 5 * 1024 * 1024) return (setFile(null), setNote(["That file is larger than 5 MB.", "bad"]));
    const reader = new FileReader();
    reader.onload = () => (setFile({ name: chosen.name, mime: chosen.type, data: String(reader.result) }), setUrl(""), setNote(["", ""]));
    reader.readAsDataURL(chosen);
  };
  const show = async () => {
    setNote(["Sending…", ""]);
    try {
      const source = file ? { base64: file.data, ...(file.mime ? { mime: file.mime } : {}) } : { url: url.trim() };
      const result = await api("POST", `/admin/clients/${enc(client.id)}/show`, { ...source, seconds: Number(seconds) || 10, fit, ...(alt.trim() ? { alt: alt.trim() } : {}) });
      setNote([result.shown ? `On ${client.name} for ${result.seconds} s.` : result.note, result.shown ? "good" : "bad"]);
      onShown?.();
    } catch (error) {
      setNote([error.status === 404 || error.status === 405 ? "This Axis cannot show pictures yet." : error.message, "bad"]);
    }
  };
  const clear = async () => {
    try {
      const result = await api("POST", `/admin/clients/${enc(client.id)}/show/clear`);
      setNote([result.cleared ? `Taken off ${client.name}'s screen.` : result.note, result.cleared ? "good" : "bad"]);
    } catch (error) {
      setNote([error.message, "bad"]);
    }
  };
  return html`<div class="glow showpic" data-show-picture>
    <div class=${`glow-frame${round ? " round" : ""}`}>
      <div class="showpic-screen" style=${`width:${Math.round(w * scale)}px;height:${Math.round(hgt * scale)}px`}>
        ${src ? html`<img src=${src} alt=${alt || "The picture to show"} style=${`object-fit:${fit}`} data-show-preview />` : html`<span class="dim sm">No picture chosen</span>`}
      </div>
    </div>
    <div class="glow-controls">
      <label class="slider">Picture file (PNG or JPEG${(client.capabilities ?? []).includes("images") ? ", WebP, GIF" : ""}; 5 MB at most)
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-edit="show-file" onChange=${pickFile} /></label>
      <label class="slider">Or an https address
        <input class="field" type="url" placeholder="https://…" value=${url} data-edit="show-url" onInput=${(e) => (setUrl(e.currentTarget.value), setFile(null))} /></label>
      <label class="slider">Seconds on the screen
        <input class="field" type="number" min="1" max="300" value=${seconds} data-edit="show-seconds" onInput=${(e) => setSeconds(e.currentTarget.value)} /></label>
      <label class="slider">What it shows (optional)
        <input class="field" maxlength="200" value=${alt} data-edit="show-alt" onInput=${(e) => setAlt(e.currentTarget.value)} /></label>
      <div class="glowkinds" role="group" aria-label="Fit">
        ${[["contain", "Whole picture"], ["cover", "Fill the screen"]].map(([key, label]) => html`<button type="button" key=${key} class=${fit === key ? "on" : ""} aria-pressed=${fit === key} data-show-fit=${key} onClick=${() => setFit(key)}>${label}</button>`)}
      </div>
      <p class="help">${off ? "Its screen is switched off on the Capabilities card, so nothing will show." : round ? "A round screen: keep what matters inside the middle; a whole picture is fitted inside the circle." : "Shown over the face, silently, also in quiet hours."}</p>
      <div class="row-acts">
        <button type="button" class="btn sm" disabled=${!client.online || !src} onClick=${show} data-show-send>Show</button>
        <button type="button" class="btn sm" disabled=${!client.online} onClick=${clear} data-show-clear>Clear</button>
      </div>
      ${note[0] ? html`<p class=${`msg ${note[1]}`} role="status" data-show-note>${note[0]}</p>` : null}
    </div>
  </div>`;
}

/** The pictures shown lately on any device (kept in memory by Axis, a day at most), each one to show here again. */
export function RecentPictures({ client, stamp }) {
  const [list, setList] = useState(null);
  const [note, setNote] = useState(["", ""]);
  const load = () => api("GET", "/admin/pictures").then((r) => setList(r.pictures ?? []), () => setList([]));
  useEffect(() => void load(), [stamp]);
  const again = async (picture) => {
    try {
      const result = await api("POST", `/admin/pictures/${enc(picture.id)}/show`, { client: client.id });
      setNote([result.shown ? `On ${client.name} again for ${result.seconds} s.` : result.note, result.shown ? "good" : "bad"]);
      load();
    } catch (error) {
      setNote([error.status === 410 ? "That picture is no longer kept." : error.message, "bad"]);
    }
  };
  if (list === null) return html`<p class="dim sm">Loading…</p>`;
  if (!list.length) return html`<p class="dim sm" data-recent-empty>No pictures shown since Axis started.</p>`;
  return html`<div data-recent-pictures>
    <ul class="recentpics">
      ${list.map((p) => html`<li key=${p.id} data-recent-picture>
        <img src=${p.thumb} alt=${p.alt || "A picture shown"} loading="lazy" />
        <div><b>${p.device}</b> <span class="dim sm">${ago(p.at)}, ${p.seconds} s, by ${p.by === "agent" ? "an agent" : "the admin page"}${p.shown ? "" : ", not shown"}</span>
          <div class="sm">${p.alt || html`<span class="dim">No description</span>`}</div></div>
        <button type="button" class="btn sm" disabled=${!client.online || !p.available} title=${p.available ? "" : "No longer kept"} onClick=${() => again(p)} data-show-again>Show again</button>
      </li>`)}
    </ul>
    ${note[0] ? html`<p class=${`msg ${note[1]}`} role="status" data-recent-note>${note[0]}</p>` : null}
  </div>`;
}
