// Pictures and live tools on the new admin page: the vortex face, a sketch of a device as Axis understands it,
// the edge glow drawn the way the boards draw it, and the microphone level meter. Ported from the classic admin.js.
// The face and the device screens stay black in either theme: they are what the devices show.

import { html, useEffect, useMemo, useRef, useState } from "/web/preact.js";
import { Vortex } from "/web/vortex.js";
import { api, enc, kept, set, store } from "/web/adm-core.js";

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

/** Whether a device draws the glow: it offers glowCorner, or its screen is round (no corners to set). */
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
export function GlowPreview({ client, radius, saved, onRadius, compact = false }) {
  const { def, round } = glowDef(client);
  const w = Number(client.readings?.screenW) || 368, hgt = Number(client.readings?.screenH) || 448;
  const [state, setState] = useState(GLOW_STATES[0]);
  const [glass, setGlass] = useState(() => Number(kept.get(GLASS_KEY, 40)) || 40);
  const [note, setNote] = useState(["", ""]);
  const [all, setAll] = useState(!compact);
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
      const { index, fall, turn } = m;
      const [r, gr, b] = s.rgb;
      for (let k = 0; k < index.length; k++) {
        if (sweep < 1 && turn[k] > sweep) continue;
        const a = strength * fall[k], o = index[k] * 4;
        // Over black, as the board's blend: the colour times its strength, in 5-6-5 steps.
        data[o] = (Math.round(r * a * 31) * 255) / 31;
        data[o + 1] = (Math.round(gr * a * 63) * 255) / 63;
        data[o + 2] = (Math.round(b * a * 31) * 255) / 31;
      }
      ctx.putImageData(image, 0, 0);
      if (round) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, hgt);
        ctx.arc(w / 2, hgt / 2, Math.min(w, hgt) / 2, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(17,17,17,0.85)";
        ctx.fill("evenodd");
        ctx.restore();
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
  const scale = Math.min(1, (compact ? 180 : 220) / Math.max(w, hgt));
  const kinds = all ? GLOW_STATES : GLOW_STATES.slice(0, 4);
  return html`<div class="glow">
    <div class=${`glow-frame${round ? " round" : ""}`}><canvas ref=${canvas} width=${w} height=${hgt} style=${`width:${Math.round(w * scale)}px;height:${Math.round(hgt * scale)}px`} aria-label=${`Edge glow preview: ${state.label}`} role="img"></canvas></div>
    <div class="glow-controls">
      <div class="glowkinds" role="group" aria-label="Glow">
        ${kinds.map((s) => html`<button type="button" key=${s.key} class=${s === state ? "on" : ""} aria-pressed=${s === state} onClick=${() => setState(s)}><i style=${`background:rgb(${s.rgb.map((c) => Math.round(c * 255)).join(",")})`}></i>${s.label}</button>`)}
        ${all ? null : html`<button type="button" class="more" onClick=${() => setAll(true)} aria-label="Show every glow">+${GLOW_STATES.length - 4}</button>`}
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
