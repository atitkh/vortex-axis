// Renders the vortex face to GIFs for the README, docs and anything else that wants to show it.
//
//   node scripts/make-face-gifs.mjs [outdir]        (default: docs/media)
//
// It draws the real face (`web/vortex.js`, the same code the web client and the admin Face page run)
// in headless Chrome, one frame at a time with a fixed step, so the result does not depend on the
// machine's speed. Frames are encoded with ffmpeg. Needs google-chrome on the PATH (or CHROME set)
// and ffmpeg. Run it again whenever a look in docs/face.md changes.
//
// Output:
//   face-idle.gif       a few idle looks one after another
//   face-listening.gif  green, pulled in, swelling with a voice
//   face-thinking.gif   violet, fast, a little sparkle
//   face-speaking.gif   open and pulsing with the voice of the reply
//   face-states.gif     idle -> listening -> thinking -> speaking -> idle, with the state named
//   face-states-card.gif  the same, 9:16, for a tall card that crops its picture (the portfolio)
//
// The four single-state files loop without a visible seam: the length is picked so the figure comes
// back to where it started (the arms repeat every third of a turn). The face has no randomness of its own
// that matters here except a little sparkle, which is seeded.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? join(root, "docs", "media"));
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "axis-face-gifs-"));
const chrome = process.env.CHROME ?? "google-chrome";

const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
<canvas id="face"></canvas><canvas id="out"></canvas>
<script type="module">
import { Vortex, LOOKS, IDLE } from "/web/vortex.js";

const FPS = 25, DT = 1 / FPS, ARM = (2 * Math.PI) / 3;
const idle = Object.fromEntries(IDLE);
const wrap = (x, m) => ((x % m) + m + m / 2) % m - m / 2; // into [-m/2, m/2)

let seed = 1;
Math.random = () => { // mulberry32, so every run draws the same sparkle
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// A made-up voice: syllables with gaps and word pauses. Square-rooted and given a quick rise and a
// fall over about a tenth of a second, the way docs/face.md section 4 measures a real one.
function voice(n, from, to, amp, seedAt, periodic) {
  const save = seed; seed = seedAt;
  const env = new Float32Array(n);
  let t = from;
  let left = 2 + Math.floor(Math.random() * 3);
  while (t < to) {
    const d = 0.13 + Math.random() * 0.1, a = amp[0] + Math.random() * (amp[1] - amp[0]);
    for (let i = Math.floor(t * FPS); i <= Math.ceil((t + d) * FPS); i++) {
      const j = periodic ? ((i % n) + n) % n : i;
      if (j < 0 || j >= n) continue;
      const x = (i / FPS - t) / d;
      if (x < 0 || x > 1) continue;
      env[j] = Math.max(env[j], a * Math.pow(Math.sin(Math.PI * x), 1.3));
    }
    t += d + 0.02 + Math.random() * 0.05;
    if (--left <= 0) { t += 0.16 + Math.random() * 0.2; left = 2 + Math.floor(Math.random() * 3); }
  }
  seed = save;
  const level = new Float32Array(n);
  let x = 0;
  for (let pass = 0; pass < (periodic ? 2 : 1); pass++) {
    for (let i = 0; i < n; i++) {
      const want = Math.sqrt(env[i]);
      x = want >= x ? want : x + (want - x) * (1 - Math.exp(-DT / 0.1));
      level[i] = x;
    }
  }
  return level;
}

const NAMES = { idle: "idle", listening: "listening", thinking: "thinking", speaking: "speaking" };

// A clip: where the figure starts, when a look is held, and how long it should be at least.
const clips = {
  "face-idle": {
    size: 320, face: 320, from: idle.calm, mode: "idle", warm: 0, minSec: 11.5,
    events: [[3.2, idle.galaxy, "idle"], [6.4, idle.bloom, "idle"], [9.6, idle.calm, "idle"]],
  },
  "face-listening": {
    size: 320, face: 320, from: LOOKS.listening, mode: "listening", warm: 1.5, minSec: 3.6, events: [],
    level: (n) => voice(n, 0.1, n / FPS - 0.1, [0.45, 1], 11, true),
  },
  "face-thinking": {
    size: 320, face: 320, from: LOOKS.thinking, mode: "thinking", warm: 1.5, minSec: 3.2, events: [],
  },
  "face-speaking": {
    size: 320, face: 320, from: LOOKS.speaking, mode: "speaking", warm: 1.5, minSec: 4, events: [],
    level: (n) => voice(n, 0.05, n / FPS - 0.05, [0.5, 1], 23, true),
  },
  "face-states": {
    size: [480, 360], face: 300, at: [90, 8], label: true, from: idle.calm, mode: "idle", warm: 0, minSec: 14.2,
    events: [
      [2.2, LOOKS.listening, "listening"],
      [5.0, LOOKS.thinking, "thinking"],
      [7.4, LOOKS.speaking, "speaking"],
      [11.4, idle.calm, "idle"],
    ],
    // The microphone while he speaks, then the reply being played: one array over the whole clip.
    level: (n) => {
      const mic = voice(n, 2.35, 4.85, [0.45, 1], 5, false);
      const say = voice(n, 7.55, 11.25, [0.5, 1], 17, false);
      return mic.map((v, i) => Math.max(v, say[i]));
    },
  },
  // The same, tall and narrow, for a card that shows its picture 9:16 and crops the rest (the portfolio).
  "face-states-card": {
    size: [270, 480], face: 250, at: [10, 100], labelY: 388, label: true, from: idle.calm, mode: "idle", warm: 0, minSec: 14.2,
    events: [
      [2.2, LOOKS.listening, "listening"],
      [5.0, LOOKS.thinking, "thinking"],
      [7.4, LOOKS.speaking, "speaking"],
      [11.4, idle.calm, "idle"],
    ],
    // The microphone while he speaks, then the reply being played: one array over the whole clip.
    level: (n) => {
      const mic = voice(n, 2.35, 4.85, [0.45, 1], 5, false);
      const say = voice(n, 7.55, 11.25, [0.5, 1], 17, false);
      return mic.map((v, i) => Math.max(v, say[i]));
    },
  },
};

const face = document.getElementById("face");
const out = document.getElementById("out");
const v = new Vortex(face);
v.stop();

const KEYS = Object.keys(LOOKS.calm ?? LOOKS.listening);

function reset(c) {
  face.width = face.height = c.face;
  const [w, h] = Array.isArray(c.size) ? c.size : [c.size, c.size];
  out.width = w; out.height = h;
  Object.assign(v, { phase: 0, pulsePhase: 0, wanderPhase: 0, wavePhase: 0, tiltPhase: 0, level: -1, icon: undefined, iconShown: 0, flowPhase: 0, last: 0 });
  v.flash.fill(0);
  v.now = { ...c.from };
  v.hold(c.from, c.mode);
  seed = 7;
}

// One run of n frames. With capture, every frame goes to the server. Returns the figure's phases.
async function run(name, c, n, capture, fix) {
  reset(c);
  const level = c.level ? c.level(n) : null;
  const octx = out.getContext("2d");
  for (let i = 0; i < Math.round(c.warm * FPS); i++) {
    v.setLevel(level && (v.mode === "listening" || v.mode === "speaking") ? level[i % n] : -1);
    v.draw(DT);
  }
  const start = { phase: v.phase, pulse: v.pulsePhase };
  let label = c.mode, color = c.from;
  const events = c.events.map(([t, look, mode]) => ({ at: Math.round(t * FPS), look, mode }));
  const keep = Math.round(1.4 * FPS);
  for (let i = 0; i < n; i++) {
    for (const e of events) if (e.at === i) { v.hold(e.look, e.mode); label = e.mode; color = e.look; }
    v.setLevel(level && (v.mode === "listening" || v.mode === "speaking") ? level[i] : -1);
    if (fix && i >= n - keep) { v.phase += fix.phase / keep; v.pulsePhase += fix.pulse / keep; }
    v.draw(DT);
    if (!capture) continue;
    const g = face.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "destination-over";
    g.fillStyle = "#000";
    g.fillRect(0, 0, face.width, face.height);
    g.globalCompositeOperation = "source-over";
    octx.fillStyle = "#000";
    octx.fillRect(0, 0, out.width, out.height);
    const [x, y] = c.at ?? [0, 0];
    octx.drawImage(face, x, y);
    if (c.label) {
      octx.font = "500 15px system-ui, 'DejaVu Sans', sans-serif";
      octx.letterSpacing = "3px";
      octx.textAlign = "center";
      octx.fillStyle = "rgb(" + [color.r, color.g, color.b].map((k) => Math.round((0.35 + k * 0.65) * 255)).join(",") + ")";
      octx.fillText(NAMES[label] ?? label, out.width / 2 + 1.5, c.labelY ?? out.height - 24);
    }
    const blob = await new Promise((r) => out.toBlob(r, "image/png"));
    await fetch("/frame?clip=" + name + "&i=" + i, { method: "POST", body: blob });
  }
  return {
    phase: wrap(start.phase - v.phase, ARM),
    pulse: wrap(start.pulse - v.pulsePhase, 2 * Math.PI),
  };
}

// The length that brings the figure back to where it started with the least nudging.
async function pick(name, c) {
  const span = 110, first = Math.ceil(c.minSec * FPS);
  let best = null;
  for (let n = first; n < first + span; n++) {
    const miss = await run(name, c, n, false, null);
    // A voiced look is drawn from the level, not the breathing phase, so only the turn matters there.
    const cost = Math.abs(miss.phase) + (c.level ? 0 : 0.15) * Math.abs(miss.pulse);
    if (!best || cost < best.cost) best = { n, cost, miss };
  }
  return best;
}

const wanted = new URLSearchParams(location.search).get("only")?.split(",");
for (const [name, c] of Object.entries(clips)) {
  if (wanted && !wanted.includes(name)) continue;
  const { n, miss } = await pick(name, c);
  await run(name, c, n, true, miss);
  await fetch("/clip?name=" + name + "&frames=" + n + "&fps=" + FPS, { method: "POST" });
}
await fetch("/done", { method: "POST" });
</script>`;

const clipsDone = [];
let finish;
const finished = new Promise((r) => (finish = r));

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/render") {
    res.writeHead(200, { "content-type": "text/html" }).end(page);
    return;
  }
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (url.pathname === "/frame") {
        const dir = join(work, url.searchParams.get("clip"));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `f${String(url.searchParams.get("i")).padStart(4, "0")}.png`), Buffer.concat(chunks));
      } else if (url.pathname === "/clip") {
        clipsDone.push({ name: url.searchParams.get("name"), frames: +url.searchParams.get("frames"), fps: +url.searchParams.get("fps") });
      } else if (url.pathname === "/done") {
        finish();
      }
      res.writeHead(204).end();
    });
    return;
  }
  // Everything else is a file of the repository (web/vortex.js, web/icons.js).
  const path = join(root, url.pathname);
  if (!path.startsWith(join(root, "web") + "/") || !existsSync(path)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(path));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), "axis-face-chrome-"));
const only = process.env.ONLY ? `?only=${process.env.ONLY}` : "";
const browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`, "--no-first-run", `http://127.0.0.1:${port}/render${only}`], { stdio: "ignore" });
browser.on("exit", (code) => code && console.error(`chrome exited with ${code}`));
const timer = setTimeout(() => { console.error("timed out"); process.exit(1); }, 15 * 60 * 1000);
await finished;
clearTimeout(timer);
browser.kill();
server.close();

function ffmpeg(args) {
  return new Promise((ok, fail) => {
    const p = spawn("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg ${code}`))));
  });
}

for (const clip of clipsDone) {
  const dir = join(work, clip.name);
  const file = join(outDir, `${clip.name}.gif`);
  const filter = "split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
  await ffmpeg(["-framerate", String(clip.fps), "-i", join(dir, "f%04d.png"), "-vf", filter, "-loop", "0", file]);
  console.log(`${clip.name}.gif  ${clip.frames} frames, ${(clip.frames / clip.fps).toFixed(1)} s, ${(statSync(file).size / 1024).toFixed(0)} KB`);
}
rmSync(work, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
