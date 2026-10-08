// Web client for VorteX Axis. It is an ordinary client: it pairs with a code
// and speaks the same protocol over the same socket as a firmware client.

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

// --- small helpers ---------------------------------------------------------

function show(id, visible) {
  $(id).classList.toggle("hidden", !visible);
}

function bubble(kind, text) {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.textContent = text;
  $("log").append(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}

function renderPills() {
  const pill = (label, kind) => {
    const el = document.createElement("span");
    el.className = `pill ${kind}`;
    el.textContent = label;
    return el;
  };
  const health = (name, value) => pill(name, value === "up" ? "good" : value === "down" ? "bad" : "");
  $("pills").replaceChildren(
    pill(online ? turnState : "offline", online ? (turnState === "error" ? "bad" : turnState === "idle" ? "good" : "warn") : "bad"),
    health("agent", upstream.openclaw),
    health("recognition", upstream.stt),
    health("synthesis", upstream.tts),
  );
}

const newTurnId = () => `web-${Date.now().toString(36)}-${++turnCount}`;

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// --- pairing ---------------------------------------------------------------

function forget(message = "") {
  identity = null;
  localStorage.removeItem(IDENTITY_KEY);
  localStorage.removeItem(SETTINGS_KEY);
  settings = { version: 0, values: {} };
  clearTimeout(reconnectTimer);
  socket?.close();
  online = false;
  show("talk", false);
  show("footer", false);
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

function start() {
  show("pair", false);
  show("talk", true);
  show("footer", true);
  $("who").textContent = `Paired as ${identity.name}`;
  $("mic").disabled = !micAvailable;
  $("hint").textContent = micAvailable
    ? "Click the microphone, speak, and it stops when you go quiet. This page has no wake word."
    : "The microphone is off: browsers only allow it on https or on localhost. Typing still works.";
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
      break;
    case "settings":
      settings = { version: message.version, values: message.values };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      player.setVolume(settings.values.volume);
      break;
    case "status":
      upstream = message.upstream;
      break;
    case "turn":
      turnState = message.state;
      if (message.state === "idle" && message.detail) bubble("info", message.detail);
      if (message.state === "error") bubble("error", message.detail || "something went wrong");
      break;
    case "transcript":
      bubble("you", message.text);
      break;
    case "reply.text":
      if (message.final) {
        replyBubble ??= bubble("axis", "");
        replyBubble.textContent = message.text;
        replyBubble = undefined;
        replyText = "";
      } else {
        replyText += (replyText ? " " : "") + message.text;
        replyBubble ??= bubble("axis", "");
        replyBubble.textContent = replyText;
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
    case "error":
      // A turn that failed already shows its own message.
      if (turnState !== "error") bubble("error", message.message);
      break;
  }
  renderPills();
}

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
      this.gain.connect(this.context.destination);
    }
    if (this.context.state === "suspended") this.context.resume();
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
    send({ t: "playback", turnId, state: "started" });
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
    source.connect(this.gain);
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
    return wasPlaying;
  },
};

// --- microphone ------------------------------------------------------------

let capture;

async function startCapture() {
  if (capture || !online) return;
  // Speaking over a reply interrupts it, like a button on a device would.
  if (player.stop() || turnState !== "idle") send({ t: "interrupt" });

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    bubble("error", "The browser did not allow the microphone.");
    return;
  }
  const context = new AudioContext();
  await context.audioWorklet.addModule("/web/pcm-worklet.js");
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "pcm-capture");
  source.connect(node);

  const turnId = newTurnId();
  capture = { stream, context, turnId, pending: [], pendingLength: 0, position: 0, startedAt: Date.now(), spoke: false, quietSince: 0 };
  const step = context.sampleRate / MIC_RATE;

  node.port.onmessage = (event) => {
    if (!capture || capture.turnId !== turnId) return;
    const input = event.data;

    // Resample to 16 kHz by linear interpolation, carrying the position across blocks.
    const out = [];
    let at = capture.position;
    for (; at < input.length - 1; at += step) {
      const a = Math.floor(at);
      out.push(input[a] + (input[a + 1] - input[a]) * (at - a));
    }
    capture.position = at - input.length;

    let energy = 0;
    for (const sample of out) energy += sample * sample;
    const level = Math.sqrt(energy / Math.max(1, out.length));

    capture.pending.push(...out);
    while (capture.pending.length >= MIC_FRAME) {
      const frame = capture.pending.splice(0, MIC_FRAME);
      const pcm = new Int16Array(frame.length);
      for (let i = 0; i < frame.length; i++) pcm[i] = Math.max(-1, Math.min(1, frame[i])) * 32767;
      if (socket?.readyState === WebSocket.OPEN) socket.send(pcm.buffer);
    }

    // Stop on our own once the speaker goes quiet, or at the length limit.
    const now = Date.now();
    if (level > 0.02) {
      capture.spoke = true;
      capture.quietSince = 0;
    } else if (capture.spoke) {
      capture.quietSince ||= now;
      if (now - capture.quietSince > 1200) return stopCapture(true, "silence");
    }
    if (now - capture.startedAt > MAX_UTTERANCE_MS) stopCapture(true, "max");
    else if (!capture.spoke && now - capture.startedAt > 6000) stopCapture(true, "cancel");
  };

  send({ t: "audio.start", turnId, format: { encoding: "pcm_s16le", sampleRate: MIC_RATE, channels: 1 } });
  $("mic").classList.add("live");
}

function stopCapture(tellHub, reason = "silence") {
  if (!capture) return;
  const { stream, context, turnId } = capture;
  capture = undefined;
  for (const track of stream.getTracks()) track.stop();
  context.close();
  $("mic").classList.remove("live");
  if (tellHub) send({ t: "audio.end", turnId, reason });
}

$("mic").addEventListener("click", () => {
  player.ensure(); // a click is what lets the browser play sound later
  if (capture) stopCapture(true, capture.spoke ? "silence" : "cancel");
  else startCapture();
});

// --- typing and stopping ---------------------------------------------------

$("say-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("say").value.trim();
  if (!text || !online) return;
  player.ensure();
  player.stop();
  stopCapture(true, "cancel");
  bubble("you", text);
  send({ t: "text", turnId: newTurnId(), text });
  $("say").value = "";
});

$("stop").addEventListener("click", () => {
  stopCapture(true, "cancel");
  player.stop();
  send({ t: "interrupt" });
  replyBubble = undefined;
  replyText = "";
});

renderPills();
if (identity) start();
else show("pair", true);
