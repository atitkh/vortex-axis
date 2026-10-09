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

/**
 * Adds a line to the history drawer. Text always goes in as text. `cat` is which half of the history it
 * belongs to ("talk": the conversation; "note": notifications and questions), and `meta` is the small
 * line above it, kept in an attribute so that setting the line's text never disturbs it.
 */
function bubble(kind, text, { cat = "talk", meta } = {}) {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.dataset.cat = cat;
  if (meta) el.dataset.meta = meta;
  el.textContent = text;
  $("log").append(el);
  $("log").scrollTop = $("log").scrollHeight;
  show("history-toggle", true);
  markEmpty();
  return el;
}

// --- notifications and questions, kept in this browser ---------------------------------------
// The conversation lives in the page and goes when it is reloaded. What arrived unasked (something an
// agent said, a notification, a question and whether it was answered) is worth finding again, so the
// last few are kept in this browser's own storage. Axis keeps none of it.

const INBOX_KEY = "axis-client-inbox";
const INBOX_MAX = 20;
let inbox = [];
try {
  inbox = JSON.parse(localStorage.getItem(INBOX_KEY) || "[]").filter((e) => e && typeof e.text === "string");
} catch {
  // Unreadable: start again with none.
}
/** The line drawn for each entry, by entry id. */
const inboxLines = new Map();
let inboxCount = 0;

const saveInbox = () => localStorage.setItem(INBOX_KEY, JSON.stringify(inbox));

/** "3:04 PM" for today, "8 Oct, 3:04 PM" for another day. */
function when(at) {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

const ASK_STATES = { open: "waiting for an answer", missed: "not answered" };
const metaOf = (entry) =>
  entry.kind === "ask"
    ? `question · ${when(entry.at)} · ${entry.state === "answered" ? `answered: ${entry.answer}` : ASK_STATES[entry.state] ?? ""}`
    : `${entry.tag} · ${when(entry.at)}`;

function drawInbox(entry) {
  const el = bubble(entry.kind === "ask" ? "axis ask" : "axis", entry.text, { cat: "note", meta: metaOf(entry) });
  el.classList.toggle("missed", entry.state === "missed");
  inboxLines.set(entry.id, el);
}

/** Adds an entry: `{kind: "note", tag, text, at}` or `{kind: "ask", text, at, state, askId?}`. */
function inboxAdd(entry) {
  entry.id = `${Date.now().toString(36)}-${++inboxCount}`;
  inbox.push(entry);
  for (const dropped of inbox.splice(0, Math.max(0, inbox.length - INBOX_MAX))) {
    inboxLines.get(dropped.id)?.remove();
    inboxLines.delete(dropped.id);
  }
  saveInbox();
  drawInbox(entry);
  return entry;
}

function inboxUpdate(entry, changes) {
  Object.assign(entry, changes);
  saveInbox();
  const el = inboxLines.get(entry.id);
  if (!el) return;
  if (changes.text !== undefined) el.textContent = entry.text;
  el.dataset.meta = metaOf(entry);
  el.classList.toggle("missed", entry.state === "missed");
}

function inboxRemove(entry) {
  inbox = inbox.filter((e) => e !== entry);
  saveInbox();
  inboxLines.get(entry.id)?.remove();
  inboxLines.delete(entry.id);
  markEmpty();
}

/** A question is settled one way or the other; one still waiting when it ends was not answered. */
const settleAsk = (entry, answer) => entry && entry.state === "open" && inboxUpdate(entry, answer === undefined ? { state: "missed" } : { state: "answered", answer: String(answer).slice(0, 200) });

/** Says so when the filter chosen, or the whole history, has nothing in it. */
function markEmpty() {
  const filter = $("log").dataset.filter;
  const any = [...$("log").children].some((el) => filter === "all" || el.dataset.cat === filter);
  $("history").classList.toggle("is-empty", !any);
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

/**
 * A page left open, or kept in memory by a phone, goes on running the scripts it was loaded with. Axis
 * restarts when it is updated, which drops and reopens the connection, so that is the moment to ask
 * whether this page is the current one, and to load the new one if nothing is going on.
 */
const MY_VERSION = new URL(import.meta.url).searchParams.get("v");
async function checkForNewPage() {
  if (!MY_VERSION) return;
  try {
    const { version } = await (await fetch("/v1/web-version", { cache: "no-store" })).json();
    if (!version || version === MY_VERSION) return;
    const reloadWhenQuiet = () => {
      if (capture || starting || player.turnId || ask || turnState !== "idle") return setTimeout(reloadWhenQuiet, 3000);
      location.reload();
    };
    reloadWhenQuiet();
  } catch {
    // Not reachable just now; the next connection asks again.
  }
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
  show("sound", false);
  show("bell", false);
  closePops();
  show("history-toggle", false);
  clearHistory();
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

// Forgetting takes two presses of the same button, in a place nobody presses by accident: the name at
// the bottom opens it, the first press asks, the second does it.
let forgetArmed;
function disarmForget() {
  clearTimeout(forgetArmed);
  forgetArmed = undefined;
  $("forget").textContent = "Forget this pairing";
  $("forget").classList.remove("sure");
}
$("forget").addEventListener("click", () => {
  if (forgetArmed) {
    disarmForget();
    return forget();
  }
  $("forget").textContent = "Press again to forget";
  $("forget").classList.add("sure");
  forgetArmed = setTimeout(disarmForget, 4000);
});

// --- connection ------------------------------------------------------------

// A press or a key is what the browser waits for before it allows sound. An iPhone only counts the END
// of a touch (and the click that follows), not its start, so those are the ones listened for.
for (const type of ["pointerup", "touchend", "click", "keydown"]) {
  document.addEventListener(type, () => identity && player.ensure(true), { passive: true, capture: true });
}
// Coming back to the front: an iPhone pauses a page's sound while it is away. Try to wake it, and say so if it will not.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !identity || !player.context) return;
  player.ensure();
  setTimeout(() => show("sound-note", !player.audible()), 500);
});

function start() {
  show("pair", false);
  show("talk", true);
  show("footer", true);
  show("sound", true);
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
/** The kept entry being filled in, when what is being said is an announcement. */
let replyEntry;
let replyText = "";

function onMessage(message) {
  switch (message.t) {
    case "welcome":
      online = true;
      reportScreen();
      checkForNewPage();
      break;
    case "settings":
      settings = { version: message.version, values: message.values };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      player.setVolume(settings.values.volume);
      renderSound();
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
      // Said while a question is open: that is its answer.
      settleAsk(ask?.entry, message.text);
      bubble("you", message.text);
      caption(message.text, "");
      break;
    case "reply.text": {
      // Something said with nobody having asked (an agent's own message, a timer going off) is an
      // announcement: it goes in the kept half of the history, marked and timed, not in the conversation.
      const unprompted = String(message.turnId).startsWith("say-");
      const put = (text) => {
        if (!unprompted) {
          replyBubble ??= bubble("axis", "");
          replyBubble.textContent = text;
        } else if (replyEntry) inboxUpdate(replyEntry, { text });
        else replyEntry = inboxAdd({ kind: "note", tag: "announcement", text, at: Date.now() });
        caption(undefined, text);
      };
      if (message.final) {
        // A reply the agent chose not to give leaves nothing behind.
        if (message.text) put(message.text);
        else replyBubble?.remove();
        replyBubble = undefined;
        replyEntry = undefined;
        replyText = "";
      } else {
        replyText += (replyText ? " " : "") + message.text;
        put(replyText);
      }
      $("log").scrollTop = $("log").scrollHeight;
      break;
    }
    case "speak.start":
      player.begin(message.turnId, message.format.sampleRate);
      break;
    case "speak.end":
      player.end(message.turnId);
      break;
    case "stop":
      if (player.stop()) send({ t: "playback", turnId: message.turnId ?? player.turnId, state: "stopped" });
      replyBubble = undefined;
      replyEntry = undefined;
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
  // The question was spoken a moment ago and went in as an announcement; it is listed once, as a question.
  const spoken = inbox.at(-1);
  if (spoken?.kind === "note" && spoken.text.trim() === message.question.trim() && Date.now() - spoken.at < 60_000) inboxRemove(spoken);
  const entry = inboxAdd({ kind: "ask", text: message.question, at: Date.now(), state: "open" });
  ask = { askId: message.askId, entry, timer: setTimeout(clearAsk, message.timeoutMs) };
  const box = $("choices");
  for (const choice of message.choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice;
    button.addEventListener("click", () => {
      send({ t: "answer", askId: message.askId, choice });
      settleAsk(entry, choice);
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
  // Still waiting when it ends (time ran out, or the connection went): it was not answered.
  settleAsk(ask?.entry);
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
  $("timer-label").textContent = nextTimer.label || "Timer";
  $("timer-text").textContent = `${clock}${nextTimer.count > 1 ? ` +${nextTimer.count - 1}` : ""}`;
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

  /**
   * Makes sure there is something to play sound with, and wakes it. `pressed` says this is being called
   * from a press or a key, the only moment a browser lets sound be switched on.
   *
   * An iPhone needs more than the rest: it pauses a page's sound when the page goes to the background,
   * the screen locks or the microphone is let go, into a state of its own ("interrupted"), and now and
   * then leaves it unable to wake at all, most of all in a page added to the Home Screen. So anything
   * that is not running is woken, and one that a press could not wake is thrown away and built again on
   * the next press.
   */
  ensure(pressed = false) {
    if (this.context?.state === "closed") this.context = undefined;
    if (pressed && this.stuck && this.context && this.context.state !== "running") {
      this.stop();
      this.context.close().catch(() => {});
      this.context = undefined;
    }
    if (!this.context) {
      const context = (this.context = new AudioContext());
      this.stuck = false;
      this.gain = context.createGain();
      this.gain.gain.value = this.volume;
      // The analyser measures the voice for the face BEFORE the volume, as the board does
      // (docs/face.md section 4), so a quiet setting does not shrink the speaking face.
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.samples = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.gain);
      this.gain.connect(context.destination);
      // The notice goes as soon as sound gets through, and comes back if the system takes it away again.
      context.addEventListener("statechange", () => this.context === context && identity && show("sound-note", !this.audible()));
    }
    if (this.context.state === "running") return;
    const context = this.context;
    context.resume().catch(() => {});
    if (!pressed) return;
    // A moment of silence played inside the press is what unlocks sound on an iPhone when waking alone does not.
    try {
      const blip = context.createBufferSource();
      blip.buffer = context.createBuffer(1, 1, 22050);
      blip.connect(context.destination);
      blip.start(0);
    } catch {
      // Nothing lost: the wake above may still do it.
    }
    clearTimeout(this.wakeCheck);
    this.wakeCheck = setTimeout(() => {
      if (this.context !== context) return;
      this.stuck = context.state !== "running";
      show("sound-note", Boolean(identity) && this.stuck);
    }, 500);
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
    // Muted: say so at once, so Axis neither sends the audio nor waits for it to be played. The words still show.
    if (muted) return send({ t: "playback", turnId, state: "blocked" });
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
  // A finger never stays quite still. Keeping hold of the touch means drifting off the face, or the
  // phone deciding the touch is a scroll, does not end the hold: only lifting the finger does.
  try {
    $("mic").setPointerCapture(event.pointerId);
  } catch {
    // Not a real pointer (a test's made-up one): nothing to hold on to.
  }
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
for (const type of ["pointerup", "pointercancel"]) $("mic").addEventListener(type, endHold);
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

$("sound-enable").addEventListener("click", () => player.ensure(true));

function toggleHistory(open) {
  show("history", open);
  $("history-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("log").scrollTop = $("log").scrollHeight;
}
$("history-toggle").addEventListener("click", () => toggleHistory($("history").classList.contains("hidden")));
for (const button of $("history-filter").querySelectorAll("button")) {
  button.addEventListener("click", () => {
    $("log").dataset.filter = button.dataset.filter;
    for (const other of $("history-filter").querySelectorAll("button")) other.classList.toggle("on", other === button);
    markEmpty();
    $("log").scrollTop = $("log").scrollHeight;
  });
}

/** Empties the history: the conversation on this page and what was kept in this browser. */
function clearHistory() {
  $("log").replaceChildren();
  inbox = [];
  inboxLines.clear();
  localStorage.removeItem(INBOX_KEY);
  replyBubble = undefined;
  replyEntry = undefined;
  if (ask) ask.entry = undefined;
  markEmpty();
}
$("history-clear").addEventListener("click", clearHistory);

// --- sound: this client's own volume, and a mute -----------------------------------------------
// The volume is this client's setting on Axis like any other device's, so the slider changes it there
// and it comes back with the settings. Mute is this browser's alone: while it is on, replies are shown
// and Axis is told nothing is being played, so no agent is led to think it was heard.

const MUTE_KEY = "axis-client-muted";
let muted = localStorage.getItem(MUTE_KEY) === "1";

function renderSound() {
  // The mark in the corner says how things stand without being opened: struck through when muted, one wave when quiet.
  $("sound").classList.toggle("muted", muted || player.volume === 0);
  $("sound").classList.toggle("low", player.volume < 0.5);
  $("sound").setAttribute("aria-label", muted ? "Sound: muted" : `Sound: ${Math.round(player.volume * 100)} %`);
  $("mute").textContent = muted ? "Unmute" : "Mute";
  $("mute").setAttribute("aria-pressed", String(muted));
  $("volume").disabled = muted;
  if (document.activeElement !== $("volume")) $("volume").value = String(Math.round(player.volume * 100));
}

// The small things in the corners (sound, notifications, the pairing) each open a little box when
// pressed. One is open at a time, and it closes when anything else is pressed, like a menu.
const POPS = [["sound", "sound-pop"], ["bell", "bell-pop"], ["who", "who-pop"]];
function openPop(buttonId, open) {
  for (const [button, box] of POPS) {
    const on = open && button === buttonId;
    show(box, on);
    $(button).setAttribute("aria-expanded", String(on));
  }
  disarmForget();
}
const closePops = () => openPop("", false);
for (const [button, box] of POPS) {
  $(button).addEventListener("click", () => openPop(button, $(box).classList.contains("hidden")));
}
document.addEventListener("pointerdown", (event) => event.target.closest(POPS.flat().map((id) => `#${id}`).join(", ")) || closePops());
document.addEventListener("keydown", (event) => event.key === "Escape" && closePops());
$("mute").addEventListener("click", () => {
  muted = !muted;
  localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  // Muting in the middle of a reply cuts it off there.
  const turnId = player.turnId;
  if (muted && player.stop()) send({ t: "playback", turnId, state: "stopped" });
  renderSound();
});
// Dragging changes what is heard straight away; letting go is what tells Axis.
$("volume").addEventListener("input", () => {
  player.setVolume(Number($("volume").value));
  renderSound();
});
$("volume").addEventListener("change", async () => {
  if (!identity) return;
  const volume = Number($("volume").value);
  await fetch("/v1/volume", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${identity.token}`, "x-axis-client": identity.clientId },
    body: JSON.stringify({ volume }),
  }).catch(() => undefined);
  $("volume").blur();
});
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
  // Typed while a question is open: that is its answer.
  settleAsk(ask?.entry, text);
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
  replyEntry = undefined;
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

/**
 * The bell in the corner: plain when notifications are on, struck through when they are off. Pressing it
 * opens the one button that changes that, with a line of explanation when something stands in the way.
 */
async function showNotifyControl() {
  const button = $("notify");
  const noteEl = $("notify-note");
  noteEl.textContent = "";
  show("notify", false);
  if (!identity) return show("bell", false);
  if (!pushSupported) {
    // The one case worth a bell that cannot be switched on: an iPhone can do it, but only from the Home Screen.
    const possible = isApplePhone && !installed;
    if (possible) noteEl.textContent = "To get notifications on an iPhone: Share, then Add to Home Screen, and open Vortex from there.";
    $("bell").className = "icon off";
    return show("bell", possible);
  }
  const subscription = await worker?.pushManager.getSubscription();
  $("bell").className = `icon ${subscription ? "on" : "off"}`;
  $("bell").setAttribute("aria-label", subscription ? "Notifications: on" : "Notifications: off");
  show("bell", true);
  show("notify", true);
  button.textContent = subscription ? "Turn notifications off" : "Turn notifications on";
  noteEl.textContent = subscription ? "This browser gets what Vortex says while this page is closed." : "";
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
  // Listed once, however many ways the page hears of it (the notification, the link, asking Axis).
  const entry =
    inbox.find((e) => e.kind === "ask" && e.askId === ask.id) ?? inboxAdd({ kind: "ask", askId: ask.id, text: ask.question, at: Date.now(), state: "open" });
  if (entry.state === "missed") inboxUpdate(entry, { state: "open" });
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
        if (entry.state !== "answered") inboxUpdate(entry, res?.ok ? { state: "answered", answer: choice } : { state: "missed" });
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
    const { asks, messages, received, missed } = await res.json();
    // What arrived as notifications while the page was closed: shown here, and kept in the history.
    // An older Axis sends only the words; a newer one says when as well.
    const arrived = received ?? (messages ?? []).map((text) => ({ text, at: Date.now() }));
    for (const { text, at } of arrived) inboxAdd({ kind: "note", tag: "notification", text, at });
    if (arrived.length) caption("", arrived[arrived.length - 1].text);
    // Questions that ran out of time while nobody was looking.
    for (const { question, at } of missed ?? []) {
      const known = inbox.find((e) => e.kind === "ask" && e.text === question && e.state === "open");
      if (known) inboxUpdate(known, { state: "missed" });
      else inboxAdd({ kind: "ask", text: question, at, state: "missed" });
    }
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

// What was kept from before this page was loaded. A question still marked as waiting then got no answer
// here; if it is in fact still open, asking Axis below brings it back.
for (const entry of inbox) {
  entry.id ??= `old-${++inboxCount}`;
  if (entry.kind === "ask" && entry.state === "open") entry.state = "missed";
  drawInbox(entry);
}
saveInbox();
markEmpty();
renderSound();

checkOpenAsks();

if (identity) start();
else show("pair", true);
