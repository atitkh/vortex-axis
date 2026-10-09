// Web client for VorteX Axis. It is an ordinary client: it pairs with a code
// and speaks the same protocol over the same socket as a firmware client.

import { Vortex } from "/web/vortex.js";

const $ = (id) => document.getElementById(id);
const PROTOCOL = 1;
const VERSION = "0.1.0";
const IDENTITY_KEY = "axis-client-identity";
const SETTINGS_KEY = "axis-client-settings";
const MIC_RATE = 16000;
/** Samples per upstream frame: 100 ms of audio. */
const MIC_FRAME = 1600;
const MAX_UTTERANCE_MS = 30000;

// A browser only hands out the microphone on https or on localhost.
const micAvailable = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);
const capabilities = [...(micAvailable ? ["mic"] : []), "speaker", "screen", "buttons"];

let identity = JSON.parse(localStorage.getItem(IDENTITY_KEY) || "null");
let settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{"version":0,"values":{}}');
let socket;
let online = false;
let reconnectTimer;
let turnCount = 0;
let upstream = { openclaw: "unknown", stt: "unknown", tts: "unknown" };
let turnState = "idle";
const face = new Vortex($("face"));
face.setIdleOff(settings.values.idleLooksOff);
// A failed turn shows the problem look for a while, then the face settles again.
let errorUntil = 0;

// --- small helpers ---------------------------------------------------------

function show(id, visible) {
  $(id).classList.toggle("hidden", !visible);
}

/** Adds a line to the history drawer. Text always goes in as text. */
function bubble(kind, text) {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.textContent = text;
  $("log").append(el);
  $("log").scrollTop = $("log").scrollHeight;
  show("history-toggle", true);
  return el;
}

// --- the words under the face ------------------------------------------------

let fadeTimer;
/** What was heard (dim) and what was said back (bright), as the board shows them. */
function caption(heard, said, kind = "") {
  if (heard !== undefined) $("heard").textContent = heard;
  if (said !== undefined) {
    $("said").textContent = said;
    $("said").className = `said ${kind}`.trim();
  }
  document.body.classList.toggle("has-words", Boolean($("heard").textContent || $("said").textContent));
  $("caption").classList.remove("faded");
  clearTimeout(fadeTimer);
  // Old words fade, so a glance tells whether they are fresh.
  fadeTimer = setTimeout(() => $("caption").classList.add("faded"), 30000);
}

const UPSTREAM_NAMES = { openclaw: "the agent", stt: "speech recognition", tts: "speech synthesis" };

/** The face, the hint and the Stop button follow what is going on. */
function renderFace() {
  const playing = Boolean(player.turnId);
  const mode = !identity
    ? "setup"
    : !online
      ? "offline"
      : capture || turnState === "listening"
        ? "listening"
        : playing || turnState === "speaking"
          ? "speaking"
          : turnState === "transcribing" || turnState === "thinking"
            ? "thinking"
            : Date.now() < errorUntil
              ? "error"
              : "idle";
  face.setMode(mode);
  document.body.classList.toggle("busy", ["listening", "speaking", "thinking"].includes(mode));
  document.body.classList.toggle("pairing", !identity);
  const down = Object.entries(upstream).filter(([, v]) => v === "down").map(([k]) => UPSTREAM_NAMES[k]);
  $("mic").setAttribute("aria-label", mode === "listening" ? "Tap to finish" : mode === "idle" ? "Tap to talk" : "Tap to stop");
  $("hint").textContent =
    !identity ? ""
    : !online ? "Can't reach Axis. Trying again…"
    : mode === "listening" ? "Listening. Tap to finish."
    : mode === "thinking" ? "Thinking. Tap to stop."
    : mode === "speaking" ? "Tap to stop."
    : down.length ? `${down.join(" and ")} ${down.length === 1 ? "is" : "are"} down.`
    : micAvailable ? "Tap the vortex to talk."
    : "The microphone needs https or localhost. Type below.";
}

// The face swells with the voice: the microphone while listening, the reply while speaking.
// Like the board, it rises at once and falls over about a tenth of a second, so it follows
// syllables without shaking from one frame to the next.
let shownLevel = 0;
let lastLevelAt = 0;
function followLevel(time) {
  requestAnimationFrame(followLevel);
  const dt = Math.min(0.1, lastLevelAt ? (time - lastLevelAt) / 1000 : 0);
  lastLevelAt = time;
  const target = capture ? capture.voice : player.turnId ? player.level() : -1;
  if (target < 0) {
    shownLevel = 0;
    return face.setLevel(-1);
  }
  shownLevel = target > shownLevel ? shownLevel + (target - shownLevel) * Math.min(1, dt / 0.03) : shownLevel + (target - shownLevel) * (1 - Math.exp(-dt / 0.1));
  face.setLevel(shownLevel);
}
requestAnimationFrame(followLevel);

function renderPills() {
  const pill = (label, kind) => {
    const el = document.createElement("span");
    el.className = `pill ${kind}`;
    el.textContent = label;
    return el;
  };
  const stateDot = () => {
    const el = pill(online ? turnState : "offline", online ? (turnState === "error" ? "bad" : turnState === "idle" ? "good" : "warn") : "bad");
    if (online) el.dataset.state = turnState;
    return el;
  };
  const health = (name, value) => {
    const el = pill(name, value === "up" ? "good" : value === "down" ? "bad" : "");
    el.classList.add("service");
    el.title = `${name}: ${value}`;
    return el;
  };
  $("pills").replaceChildren(
    stateDot(),
    health("agent", upstream.openclaw),
    health("recognition", upstream.stt),
    health("synthesis", upstream.tts),
  );
  renderFace();
}

const newTurnId = () => `web-${Date.now().toString(36)}-${++turnCount}`;

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** Tells Axis the size of this window, so the admin page can draw this client at its real shape. */
function reportScreen() {
  send({ t: "sense", readings: { screenW: window.innerWidth, screenH: window.innerHeight } });
}
let resizeReport;
window.addEventListener("resize", () => {
  clearTimeout(resizeReport);
  resizeReport = setTimeout(reportScreen, 500);
});

// --- pairing ---------------------------------------------------------------

function forget(message = "") {
  // The browser's push address belonged to this pairing: drop it, or it would keep getting notifications for a client that is gone.
  worker?.pushManager.getSubscription().then((subscription) => subscription?.unsubscribe()).catch(() => undefined);
  identity = null;
  localStorage.removeItem(IDENTITY_KEY);
  localStorage.removeItem(SETTINGS_KEY);
  settings = { version: 0, values: {} };
  clearTimeout(reconnectTimer);
  socket?.close();
  online = false;
  show("talk", false);
  show("footer", false);
  show("history-toggle", false);
  $("log").replaceChildren();
  caption("", "");
  show("pair", true);
  $("pair-error").textContent = message;
  renderPills();
}

$("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("pair-error").textContent = "";
  const name = $("pair-name").value.trim();
  try {
    const res = await fetch("/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: $("pair-code").value.trim(),
        type: "web",
        version: VERSION,
        capabilities,
        ...(name ? { name } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "pairing failed");
    identity = data;
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    $("pair-code").value = "";
    start();
  } catch (error) {
    $("pair-error").textContent = error.message;
  }
});

$("forget").addEventListener("click", () => {
  if (confirm("Forget this pairing? The hub keeps the client until it is removed on the admin page.")) forget();
});

// --- connection ------------------------------------------------------------

// Any click or key press on the page is what the browser waits for before it allows sound.
for (const type of ["pointerdown", "keydown"]) {
  document.addEventListener(type, () => identity && player.ensure(), { passive: true });
}

function start() {
  show("pair", false);
  show("talk", true);
  show("footer", true);
  $("who").textContent = `Paired as ${identity.name}`;
  // Pairing can happen long after the page loaded; the notification button belongs to a paired client.
  queueMicrotask(() => showNotifyControl());
  renderFace();
  // Find out now whether sound is allowed, so the notice is there before anyone speaks.
  player.ensure();
  setTimeout(() => show("sound-note", !player.audible()), 300);
  connect();
}

function connect() {
  clearTimeout(reconnectTimer);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/v1/client`);
  ws.binaryType = "arraybuffer";
  socket = ws;

  ws.addEventListener("open", () => {
    send({
      t: "hello",
      protocol: PROTOCOL,
      clientId: identity.clientId,
      token: identity.token,
      type: "web",
      version: VERSION,
      capabilities,
      settingsVersion: settings.version,
      maxFrameBytes: 16384,
      audioBufferMs: 4000,
    });
  });

  ws.addEventListener("message", (event) => {
    if (ws !== socket) return;
    if (typeof event.data === "string") onMessage(JSON.parse(event.data));
    else player.push(event.data);
  });

  ws.addEventListener("close", (event) => {
    if (ws !== socket) return;
    online = false;
    turnState = "idle";
    clearAsk();
    nextTimer = undefined;
    renderTimer();
    stopCapture(false);
    player.stop();
    renderPills();
    // 4401: wrong token. 4410: removed on the admin page. Pairing again is the only way back.
    if (event.code === 4401 || event.code === 4410) return forget("This client is no longer paired with the hub.");
    if (identity) reconnectTimer = setTimeout(connect, 2000);
  });
}

let replyBubble;
let replyText = "";

function onMessage(message) {
  switch (message.t) {
    case "welcome":
      online = true;
      reportScreen();
      break;
    case "settings":
      settings = { version: message.version, values: message.values };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      player.setVolume(settings.values.volume);
      face.setIdleOff(settings.values.idleLooksOff);
      break;
    case "status":
      upstream = message.upstream;
      break;
    case "turn":
      turnState = message.state;
      if (message.state === "transcribing") caption("…", "");
      if (message.state === "idle" && message.detail) {
        bubble("info", message.detail);
        caption("", message.detail, "info");
      }
      if (message.state === "error") {
        bubble("error", message.detail || "something went wrong");
        caption(undefined, message.detail || "Something went wrong.", "error");
        errorUntil = Date.now() + 5000;
        setTimeout(renderFace, 5100);
      }
      break;
    case "transcript":
      bubble("you", message.text);
      caption(message.text, "");
      break;
    case "reply.text":
      if (message.final) {
        // A reply the agent chose not to give leaves nothing behind.
        if (!message.text) {
          replyBubble?.remove();
        } else {
          replyBubble ??= bubble("axis", "");
          replyBubble.textContent = message.text;
          caption(undefined, message.text);
        }
        replyBubble = undefined;
        replyText = "";
      } else {
        replyText += (replyText ? " " : "") + message.text;
        replyBubble ??= bubble("axis", "");
        replyBubble.textContent = replyText;
        caption(undefined, replyText);
      }
      $("log").scrollTop = $("log").scrollHeight;
      break;
    case "speak.start":
      player.begin(message.turnId, message.format.sampleRate);
      break;
    case "speak.end":
      player.end(message.turnId);
      break;
    case "stop":
      if (player.stop()) send({ t: "playback", turnId: message.turnId ?? player.turnId, state: "stopped" });
      replyBubble = undefined;
      replyText = "";
      break;
    case "wake.result":
      break;
    case "ask":
      showAsk(message);
      break;
    case "ask.end":
      if (ask?.askId === message.askId) clearAsk();
      break;
    case "command":
      // The only thing Axis asks of this page: which timer is next, so it can count down.
      if (message.name === "timer.next") {
        const ms = Number(message.params?.ms) || 0;
        nextTimer = ms > 0 ? { label: String(message.params.label ?? ""), endsAt: Date.now() + ms, count: Number(message.params.count) || 1, id: message.params.id } : undefined;
        renderTimer();
        send({ t: "command.result", id: message.id, ok: true });
      } else {
        send({ t: "command.result", id: message.id, ok: false, error: "this client does not do that" });
      }
      break;
    case "error":
      // A turn that failed already shows its own message.
      if (turnState !== "error") {
        bubble("error", message.message);
        caption(undefined, message.message, "error");
      }
      break;
  }
  renderPills();
}

// --- questions and timers --------------------------------------------------

let ask;
let nextTimer;

/** Offers the answers to a question as buttons. Saying or typing an answer works too; Axis reads those. */
function showAsk(message) {
  clearAsk();
  ask = { askId: message.askId, timer: setTimeout(clearAsk, message.timeoutMs) };
  const box = $("choices");
  for (const choice of message.choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice;
    button.addEventListener("click", () => {
      send({ t: "answer", askId: message.askId, choice });
      bubble("you", choice);
      clearAsk();
    });
    box.append(button);
  }
  box.classList.toggle("hidden", !message.choices.length);
  $("say").placeholder = "Type your answer";
}

function clearAsk() {
  if (ask) clearTimeout(ask.timer);
  ask = undefined;
  $("choices").replaceChildren();
  $("choices").classList.add("hidden");
  $("say").placeholder = "Or type here";
}

function renderTimer() {
  const left = nextTimer ? Math.max(0, Math.ceil((nextTimer.endsAt - Date.now()) / 1000)) : 0;
  const line = $("timer");
  line.classList.toggle("hidden", !nextTimer || !online);
  if (!nextTimer) return;
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), sec = String(left % 60).padStart(2, "0");
  const clock = h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  $("timer-text").textContent = `${nextTimer.label} ${clock}${nextTimer.count > 1 ? ` (+${nextTimer.count - 1})` : ""}`;
  // An older Axis does not say which timer it is; then there is nothing to cancel by.
  $("timer-cancel").hidden = typeof nextTimer.id !== "number";
}
$("timer-cancel").addEventListener("click", async () => {
  if (!nextTimer || !identity) return;
  $("timer-cancel").disabled = true;
  try {
    await fetch("/v1/timers/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${identity.token}`, "x-axis-client": identity.clientId },
      body: JSON.stringify({ id: nextTimer.id }),
    });
    // Axis sends the next timer, or none, to every screen once it is gone.
  } finally {
    $("timer-cancel").disabled = false;
  }
});
setInterval(renderTimer, 1000);

// --- speaking the reply ----------------------------------------------------

const player = {
  context: undefined,
  gain: undefined,
  rate: 24000,
  nextAt: 0,
  sources: new Set(),
  turnId: undefined,
  ended: false,
  volume: 1,

  ensure() {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      // The analyser measures the voice for the face BEFORE the volume, as the board does
      // (docs/face.md section 4), so a quiet setting does not shrink the speaking face.
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.samples = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.gain);
      this.gain.connect(this.context.destination);
      // Hide the notice as soon as the browser lets sound through.
      this.context.addEventListener("statechange", () => this.audible() && show("sound-note", false));
    }
    if (this.context.state === "suspended") this.context.resume().catch(() => {});
  },

  /** Loudness of what is playing now, 0 to 1. */
  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let energy = 0;
    for (const v of this.samples) energy += v * v;
    return Math.min(1, Math.sqrt(energy / this.samples.length) * 5);
  },

  /** False while the browser is holding sound back until someone clicks or types on the page. */
  audible() {
    return this.context?.state === "running";
  },

  /** `volume` setting is 0 to 100. */
  setVolume(value) {
    this.volume = typeof value === "number" ? Math.min(1, Math.max(0, value / 100)) : 1;
    if (this.gain) this.gain.gain.value = this.volume;
  },

  begin(turnId, sampleRate) {
    this.ensure();
    this.turnId = turnId;
    this.rate = sampleRate;
    this.ended = false;
    this.nextAt = 0;
    // Give the browser a moment to start the audio, then say honestly whether it did.
    setTimeout(() => {
      if (this.turnId !== turnId) return;
      if (this.audible()) return send({ t: "playback", turnId, state: "started" });
      show("sound-note", true);
      send({ t: "playback", turnId, state: "blocked" });
      this.stop();
    }, 200);
  },

  push(arrayBuffer) {
    if (!this.turnId) return;
    const samples = new Int16Array(arrayBuffer, 0, arrayBuffer.byteLength >> 1);
    if (!samples.length) return;
    const buffer = this.context.createBuffer(1, samples.length, this.rate);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    // Schedule each frame straight after the last, with a short lead for the first.
    const at = Math.max(this.nextAt, this.context.currentTime + 0.06);
    source.start(at);
    this.nextAt = at + buffer.duration;
    this.sources.add(source);
    source.addEventListener("ended", () => {
      this.sources.delete(source);
      this.maybeFinished();
    });
  },

  end(turnId) {
    if (turnId !== this.turnId) return;
    this.ended = true;
    this.maybeFinished();
  },

  maybeFinished() {
    if (!this.ended || this.sources.size || !this.turnId) return;
    send({ t: "playback", turnId: this.turnId, state: "finished" });
    this.turnId = undefined;
    renderFace();
  },

  /** Stops at once and drops what was queued. Returns whether anything was playing. */
  stop() {
    const wasPlaying = Boolean(this.turnId);
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.turnId = undefined;
    this.ended = false;
    if (wasPlaying) setTimeout(renderFace);
    return wasPlaying;
  },
};

// --- microphone ------------------------------------------------------------

let capture;

// One audio context for the microphone, kept for the life of the page and paused between
// recordings. A new one per tap leaked when taps came quickly (each kept processing the
// microphone, which slowed the whole page), and browsers allow only a few at once.
let micContext;
let micModule;
async function micReady() {
  if (!micContext) {
    micContext = new AudioContext();
    micModule = micContext.audioWorklet.addModule("/web/pcm-worklet.js");
  }
  await micModule;
  if (micContext.state === "suspended") await micContext.resume();
  return micContext;
}

/** True while a recording is being set up; taps then are ignored, so only one starts. */
let starting = false;

async function startCapture() {
  if (capture || starting || !online) return;
  starting = true;
  // Speaking over a reply interrupts it, like a button on a device would.
  if (player.stop() || turnState !== "idle") send({ t: "interrupt" });

  let stream;
  let context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    context = await micReady();
  } catch (error) {
    for (const track of stream?.getTracks() ?? []) track.stop();
    starting = false;
    // Say which it was: refused, missing, or taken by something else.
    const why =
      error?.name === "NotAllowedError" || error?.name === "SecurityError" ? "The browser did not allow the microphone. Allow it for this page and try again."
      : error?.name === "NotFoundError" || error?.name === "OverconstrainedError" ? "No microphone was found on this device."
      : error?.name === "NotReadableError" || error?.name === "AbortError" ? "The microphone is in use by another app, or the system would not open it."
      : `The microphone could not be started${error?.message ? `: ${error.message}` : "."}`;
    bubble("error", why);
    caption(undefined, why, "error");
    return;
  }
  starting = false;
  // The connection may have dropped while the browser was asking for the microphone.
  if (!online) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "pcm-capture");
  source.connect(node);

  const turnId = newTurnId();
  capture = { stream, context, source, node, turnId, position: 0, startedAt: Date.now(), spoke: false, quietSince: 0, frame: new Int16Array(MIC_FRAME), filled: 0, room: undefined, voice: 0, last: 0 };
  const step = context.sampleRate / MIC_RATE;

  node.port.onmessage = (event) => {
    if (!capture || capture.turnId !== turnId) return;
    const input = event.data;

    // Resample to 16 kHz by linear interpolation, carrying the position across blocks, and
    // write straight into the outgoing frame: no growing arrays, so the main thread stays free.
    // A step can land just before this batch (position -1 to 0): that point lies between the
    // previous batch's last sample and this batch's first, so the last sample is kept for it.
    let energy = 0;
    let count = 0;
    let at = capture.position;
    for (; at < input.length - 1; at += step) {
      const a = Math.floor(at);
      const left = a < 0 ? capture.last : input[a];
      const sample = left + (input[a + 1] - left) * (at - a);
      energy += sample * sample;
      count++;
      capture.frame[capture.filled++] = Math.max(-1, Math.min(1, sample)) * 32767;
      if (capture.filled === MIC_FRAME) {
        if (socket?.readyState === WebSocket.OPEN) socket.send(capture.frame.buffer);
        capture.frame = new Int16Array(MIC_FRAME);
        capture.filled = 0;
      }
    }
    capture.position = at - input.length;
    capture.last = input[input.length - 1];
    const level = Math.sqrt(energy / Math.max(1, count));
    // The room level carries from batch to batch, so one bad reading must never get into it.
    if (!Number.isFinite(level)) return;

    // The face follows the voice above the room's own level, as on the board, so a fan or a
    // hum does not make it twitch. The room level follows quiet moments quickly, loud ones slowly.
    capture.room = capture.room === undefined ? level : level < capture.room ? capture.room * 0.7 + level * 0.3 : capture.room * 0.995 + level * 0.005;
    // Square root: ordinary speech fills most of the range, not the bottom of it.
    capture.voice = Math.sqrt(Math.min(1, Math.max(0, (level - capture.room * 1.3 - 0.002) / 0.08)));

    // Stop on our own once the speaker goes quiet, or at the length limit.
    const now = Date.now();
    if (level > 0.02) {
      capture.spoke = true;
      capture.quietSince = 0;
    } else if (capture.spoke) {
      capture.quietSince ||= now;
      if (!holding && now - capture.quietSince > 1200) return stopCapture(true, "silence");
    }
    if (now - capture.startedAt > MAX_UTTERANCE_MS) stopCapture(true, "max");
    else if (!holding && !capture.spoke && now - capture.startedAt > 6000) stopCapture(true, "cancel");
  };

  send({ t: "audio.start", turnId, format: { encoding: "pcm_s16le", sampleRate: MIC_RATE, channels: 1 } });
  caption("", "");
  renderFace();
}

function stopCapture(tellHub, reason = "silence") {
  if (!capture) return;
  const { stream, context, source, node, turnId } = capture;
  capture = undefined;
  node.port.onmessage = null;
  source.disconnect();
  node.disconnect();
  for (const track of stream.getTracks()) track.stop();
  // Paused, not closed: the next recording reuses it.
  context.suspend().catch(() => {});
  if (tellHub) send({ t: "audio.end", turnId, reason });
  renderFace();
}

// Holding the face is the other way to talk: it listens for as long as it is held and sends what was
// said on release, with no waiting for a pause. A short press is still a tap.
const HOLD_MS = 350;
let holding = false;
let holdTimer;
let heldAt = 0;
/** Set when a press turned into a hold, so the click that follows the release does nothing. */
let swallowClick = false;

function endHold() {
  clearTimeout(holdTimer);
  if (!holding) return;
  holding = false;
  $("mic").classList.remove("held");
  // The microphone may still be starting (the browser asking for permission); then stop it as soon as it is up.
  if (capture) stopCapture(true, capture.spoke || Date.now() - heldAt > 900 ? "silence" : "cancel");
}

$("mic").addEventListener("pointerdown", (event) => {
  if (event.button > 0 || !identity || !online || !micAvailable || capture || starting) return;
  if (player.turnId || ["transcribing", "thinking", "speaking"].includes(turnState)) return; // a tap stops those
  clearTimeout(holdTimer);
  holdTimer = setTimeout(async () => {
    holding = true;
    swallowClick = true;
    heldAt = Date.now();
    $("mic").classList.add("held");
    player.ensure();
    await startCapture();
    if (!holding && capture) stopCapture(true, "cancel"); // let go before the microphone was ready
  }, HOLD_MS);
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) $("mic").addEventListener(type, endHold);
$("mic").addEventListener("contextmenu", (event) => event.preventDefault());

// The face works like the board's screen: tap to talk, tap to finish, tap to stop it.
$("mic").addEventListener("click", () => {
  if (swallowClick) return void (swallowClick = false);
  player.ensure(); // a click is what lets the browser play sound later
  if (!identity || !online || starting) return;
  if (capture) return stopCapture(true, capture.spoke ? "silence" : "cancel");
  // Only a reply on its way is stopped by a tap. After a failed turn the state stays "error"
  // until the next one, and a tap then must start listening, not just stop.
  if (player.turnId || ["transcribing", "thinking", "speaking"].includes(turnState)) return stopEverything();
  if (micAvailable) startCapture();
  else $("say").focus();
});

$("sound-enable").addEventListener("click", () => player.ensure());

function toggleHistory(open) {
  show("history", open);
  $("history-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("log").scrollTop = $("log").scrollHeight;
}
$("history-toggle").addEventListener("click", () => toggleHistory($("history").classList.contains("hidden")));
$("history-close").addEventListener("click", () => toggleHistory(false));
document.addEventListener("keydown", (event) => event.key === "Escape" && toggleHistory(false));

// --- typing and stopping ---------------------------------------------------

$("say-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("say").value.trim();
  if (!text || !online) return;
  player.ensure();
  player.stop();
  stopCapture(true, "cancel");
  bubble("you", text);
  caption(text, "");
  send({ t: "text", turnId: newTurnId(), text });
  $("say").value = "";
});

function stopEverything() {
  stopCapture(true, "cancel");
  player.stop();
  send({ t: "interrupt" });
  replyBubble = undefined;
  replyText = "";
}
$("stop").addEventListener("click", stopEverything);

renderPills();
// --- keeping the screen on -------------------------------------------------------------------
// A phone dims and locks in the middle of a conversation. While this page is in front, ask the
// system to keep the screen on; it lets go by itself when the page is hidden, so ask again each time.

let wakeLock;
async function keepAwake() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || !identity) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // Low battery or the system saying no: the page still works, it just dims.
  }
}
document.addEventListener("visibilitychange", keepAwake);
keepAwake();

// --- notifications while the page is closed ------------------------------------------------
// A browser can be reached with its page closed if the person allows notifications. Axis then sends
// what an agent wanted said here as a notification, and questions with their choices. An iPhone only
// offers this to a page that was added to the Home Screen.

const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const installed = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
const isApplePhone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let worker;

const asClient = () => ({ authorization: `Bearer ${identity.token}`, "x-axis-client": identity.clientId });

/** Turns a base64url key into the bytes the browser wants. */
function keyBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function showNotifyControl() {
  const button = $("notify");
  const noteEl = $("notify-note");
  noteEl.textContent = "";
  if (!identity) return show("notify", false);
  if (!pushSupported) {
    show("notify", false);
    // The one case worth explaining: an iPhone can do it, but only from the Home Screen.
    if (isApplePhone && !installed) noteEl.textContent = "To get notifications: Share, then Add to Home Screen, and open it from there.";
    return;
  }
  const subscription = await worker?.pushManager.getSubscription();
  show("notify", true);
  button.textContent = subscription ? "Notifications on" : "Turn on notifications";
  button.dataset.on = subscription ? "1" : "";
  if (Notification.permission === "denied") {
    button.disabled = true;
    noteEl.textContent = "Notifications are blocked for this page in the browser's settings.";
  }
}

async function toggleNotifications() {
  const button = $("notify");
  button.disabled = true;
  try {
    const existing = await worker.pushManager.getSubscription();
    if (existing) {
      await fetch("/v1/push/subscription", { method: "DELETE", headers: asClient() });
      await existing.unsubscribe();
    } else {
      if ((await Notification.requestPermission()) !== "granted") return;
      const { key } = await (await fetch("/v1/push/key")).json();
      const subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      const saved = await fetch("/v1/push/subscription", {
        method: "POST",
        headers: { "content-type": "application/json", ...asClient() },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!saved.ok) {
        await subscription.unsubscribe();
        throw new Error("Axis did not accept it");
      }
    }
  } catch (error) {
    $("notify-note").textContent = `Could not change notifications: ${error.message}`;
  } finally {
    button.disabled = false;
    await showNotifyControl();
  }
}
$("notify").addEventListener("click", toggleNotifications);

/**
 * A question that arrived as a notification, opened here: offer its choices. The answer goes back
 * over plain HTTP with the one-time token from the notification, since it was asked while this page
 * was closed and is not part of any turn on the socket.
 */
function showNotifiedAsk(ask) {
  if (!ask || !Array.isArray(ask.choices)) return;
  caption("", ask.question);
  const box = $("choices");
  box.replaceChildren(
    ...ask.choices.map((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice";
      button.textContent = choice;
      button.addEventListener("click", async () => {
        box.classList.add("hidden");
        box.replaceChildren();
        const res = await fetch("/v1/push/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: ask.id, token: ask.token, choice }),
        }).catch(() => undefined);
        caption("", res?.ok ? `You answered: ${choice}` : "That question is no longer open.", res?.ok ? "" : "error");
      });
      return button;
    }),
  );
  box.classList.remove("hidden");
}

/**
 * Asks Axis whether a question is waiting for this client, and shows it. A phone does not reliably tell
 * the page which notification opened it (an iPhone opens the app at its start page and says nothing),
 * so the page asks whenever it is opened or brought forward.
 */
let shownAsk = "";
async function checkOpenAsks() {
  if (!identity || document.visibilityState !== "visible") return;
  // The page is being looked at: nothing is unread any more.
  navigator.clearAppBadge?.().catch(() => undefined);
  worker?.getNotifications?.().then((shown) => shown.forEach((n) => !n.data?.ask && n.close())).catch(() => undefined);
  try {
    const res = await fetch("/v1/push/asks", { headers: asClient() });
    if (!res.ok) return;
    const { asks, messages } = await res.json();
    // What arrived as notifications while the page was closed: shown here, and kept in the history.
    for (const text of messages ?? []) bubble("axis", text);
    if (messages?.length) caption("", messages[messages.length - 1]);
    const ask = asks[asks.length - 1];
    if (ask && ask.id !== shownAsk) {
      shownAsk = ask.id;
      showNotifiedAsk(ask);
    }
  } catch {
    // Offline for the moment: the next time the page comes forward will do.
  }
}
document.addEventListener("visibilitychange", checkOpenAsks);
window.addEventListener("pageshow", checkOpenAsks);
window.addEventListener("focus", checkOpenAsks);

if (pushSupported) {
  navigator.serviceWorker
    .register("/sw.js")
    .then(async (registration) => {
      worker = registration;
      await navigator.serviceWorker.ready;
      showNotifyControl();
    })
    .catch(() => showNotifyControl());
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.ask) {
      shownAsk = event.data.ask.id;
      showNotifiedAsk(event.data.ask);
    }
  });
} else showNotifyControl();

// Opened from a notification that carried a question.
if (location.hash.startsWith("#ask=")) {
  try {
    showNotifiedAsk(JSON.parse(decodeURIComponent(location.hash.slice(5))));
  } catch {
    // A mangled link is not worth a message.
  }
  history.replaceState(null, "", "/");
}

checkOpenAsks();

if (identity) start();
else show("pair", true);
