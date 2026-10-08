// The vortex face, the same one the Waveshare board draws (firmware/waveshare-amoled-1.8/src/vortex.cpp):
// dots on three spiral arms that spin slowly when idle, pull inward and go green to listen, spin
// fast and violet to think, and open and pulse with the voice to speak. Looks and colours are
// copied from the firmware so a browser and a board look like the same thing. The specification
// is docs/face.md; change it, this file and vortex.cpp together.

const SIZE = 240; // the firmware's drawing size; everything below is in its units
const ARMS = 3;
const DOTS_PER_ARM = 26;
const MAX_RADIUS = SIZE / 2 - 14;
const KEYS = ["spin", "radius", "twist", "pulse", "pulseHz", "wander", "sparkle", "dot", "r", "g", "b"];

const look = (spin, radius, twist, pulse, pulseHz, wander, sparkle, dot, r, g, b) => ({ spin, radius, twist, pulse, pulseHz, wander, sparkle, dot, r, g, b });

// Idle picks among these at random, so it does not look like a loop.
const IDLE = [
  ["calm", look(0.5, 0.85, 0.9, 0.03, 0.25, 0, 0, 1.0, 0.1, 0.78, 0.95)],
  ["breathe", look(0.35, 0.8, 0.8, 0.2, 0.18, 0, 0, 1.1, 0.15, 0.6, 1.0)],
  ["unwind", look(-0.4, 0.95, 1.25, 0.04, 0.3, 0, 0, 0.9, 0.2, 0.85, 0.8)],
  ["open", look(0.8, 1.0, 0.45, 0.05, 0.3, 0, 0, 1.2, 0.05, 0.7, 1.0)],
  ["curl", look(1.1, 0.58, 1.7, 0.05, 0.4, 0, 0, 0.9, 0.3, 0.55, 1.0)],
  ["drift", look(0.45, 0.75, 1.0, 0.04, 0.25, 14, 0, 1.0, 0.1, 0.85, 0.85)],
  ["shimmer", look(0.3, 0.88, 1.1, 0.03, 0.25, 0, 0.035, 1.0, 0.35, 0.75, 1.0)],
];

const LOOKS = {
  setup: look(0.3, 0.7, 0.9, 0.1, 0.3, 0, 0, 1.0, 1.0, 0.65, 0.1),
  offline: look(0.18, 0.55, 1.1, 0.03, 0.2, 0, 0, 0.9, 0.3, 0.34, 0.42),
  listening: look(1.6, 0.45, 1.8, 0.08, 1.2, 0, 0, 1.2, 0.15, 1.0, 0.55),
  thinking: look(4.6, 0.78, 1.3, 0.05, 0.9, 0, 0.02, 0.9, 0.62, 0.4, 1.0),
  speaking: look(1.1, 0.78, 0.75, 0.22, 2.4, 0, 0, 1.2, 0.55, 0.95, 1.0),
  error: look(0.15, 0.62, 0.7, 0.12, 0.5, 5, 0, 1.0, 1.0, 0.18, 0.12),
};

export class Vortex {
  /** Draws into `canvas` until stopped. Modes: setup, offline, idle, listening, thinking, speaking, error. */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mode = "offline";
    this.now = { ...LOOKS.offline };
    this.target = { ...LOOKS.offline };
    this.idleIndex = 0;
    this.idleRemaining = 0;
    this.phase = 0;
    this.pulsePhase = 0;
    this.wanderPhase = 0;
    this.level = -1;
    this.flash = new Float32Array(ARMS * DOTS_PER_ARM);
    this.last = 0;
    // Someone who asked for less motion gets the same face, turning slowly and without sparkle.
    this.calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "idle") this.pickIdle();
    else this.target = { ...(LOOKS[mode] ?? LOOKS.offline) };
  }

  /** Loudness of the voice, 0 to 1. Negative: not known, the face pulses on its own. */
  setLevel(level) {
    this.level = level;
  }

  pickIdle() {
    let next = this.idleIndex;
    while (next === this.idleIndex) next = Math.floor(Math.random() * IDLE.length);
    this.idleIndex = next;
    this.idleRemaining = 7 + Math.random() * 10;
    this.target = { ...IDLE[next][1] };
  }

  frame(time) {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, this.last ? (time - this.last) / 1000 : 0);
    this.last = time;
    this.fit();
    this.draw(dt);
  }

  /** Keeps the drawing sharp at whatever size and pixel density the page gives the canvas. */
  fit() {
    const ratio = window.devicePixelRatio || 1;
    const side = Math.round(this.canvas.clientWidth * ratio);
    if (side && (this.canvas.width !== side || this.canvas.height !== side)) {
      this.canvas.width = side;
      this.canvas.height = side;
    }
  }

  draw(dt) {
    const { ctx, canvas } = this;
    if (this.mode === "idle") {
      this.idleRemaining -= dt;
      if (this.idleRemaining <= 0) this.pickIdle();
    }
    // Leaving idle should feel immediate; drifting between idle looks should not.
    const rate = this.mode === "idle" ? 1.2 : 5.0;
    const k = 1 - Math.exp(-dt * rate);
    for (const key of KEYS) this.now[key] += (this.target[key] - this.now[key]) * k;
    const now = this.now;

    const motion = this.calm ? 0.3 : 1;
    this.phase += now.spin * dt * motion;
    this.pulsePhase += now.pulseHz * 2 * Math.PI * dt * motion;
    this.wanderPhase += 0.6 * dt * motion;

    // With a known loudness, the voice drives the size instead of a sine wave.
    const voiced = (this.mode === "speaking" || this.mode === "listening") && this.level >= 0;
    const voiceSwell = this.mode === "listening" ? 0.4 : now.pulse;
    const cx = SIZE / 2 + now.wander * Math.sin(this.wanderPhase);
    const cy = SIZE / 2 + now.wander * Math.sin(this.wanderPhase * 1.7 + 1);

    const scale = canvas.width / SIZE;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // Overlapping dots add up to light, the way they glow on the board's panel.
    ctx.globalCompositeOperation = "lighter";

    const color = (r, g, b) => `rgb(${clamp(r) * 255 | 0},${clamp(g) * 255 | 0},${clamp(b) * 255 | 0})`;
    for (let arm = 0; arm < ARMS; arm++) {
      // Outer dots first, so the bright inner ones are drawn on top.
      for (let i = DOTS_PER_ARM - 1; i >= 0; i--) {
        const t = (i + 1) / DOTS_PER_ARM;
        const at = arm * DOTS_PER_ARM + i;
        if (!this.calm && now.sparkle > 0 && Math.random() < now.sparkle) this.flash[at] = 1;
        this.flash[at] *= 0.86;
        const spark = this.flash[at];

        const swell = voiced ? voiceSwell * this.level : now.pulse * Math.sin(this.pulsePhase - t * 3);
        const radius = MAX_RADIUS * now.radius * (1 + swell) * Math.pow(t, 0.85);
        const angle = this.phase + arm * ((2 * Math.PI) / ARMS) - now.twist * 2 * Math.PI * t;
        const glow = Math.min(1, 1 - 0.72 * t + spark);
        ctx.fillStyle = color(now.r * glow + spark * 0.5, now.g * glow + spark * 0.5, now.b * glow + spark * 0.5);
        ctx.beginPath();
        ctx.arc(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), now.dot * (1.4 + 4.2 * t), 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    const core = 7 + (this.mode === "listening" ? 6 : 3) * (voiced ? this.level : Math.sin(this.pulsePhase));
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = color(0.55 + now.r * 0.45, 0.55 + now.g * 0.45, 0.55 + now.b * 0.45);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, core), 0, 2 * Math.PI);
    ctx.fill();
  }
}

const clamp = (v) => Math.min(1, Math.max(0, v));
