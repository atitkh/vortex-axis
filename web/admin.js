// Admin page for VorteX Axis. Plain browser JavaScript, no build step.
// Everything it does goes through the same /admin endpoints any caller can use.
//
// Settings are managed fleet first: a type's page sets what all its devices share, and a
// device's page shows only where that one device differs. The three layers underneath
// (all devices, type, device) are the server's; this page only presents them.

import { clock, columnChart, duration, lineChart, ms, partsBar, percent, stateLegend, strip, stripAxis } from "/web/charts.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "axis-admin-token";
let token = sessionStorage.getItem(TOKEN_KEY) || "";
let timer;
// What is on screen, and the last data fetched.
let view = { name: "overview", id: "" };
let lastClients = [];
let lastTypes = {};
let lastGlobal = {};
let lastStatus;
let lastGateway;
let lastConfig;

/** Builds an element. Text always goes in as text, never as markup. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = Boolean(value);
    else if (value !== undefined && value !== false && value !== null) el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `request failed (${res.status})`);
  return data;
}

function note(id, text, kind = "") {
  const el = $(id);
  el.textContent = text;
  el.className = `msg ${kind}`.trim();
}

/** A short message at the bottom of the screen, for saves that happen where the person is looking. */
let toastTimer;
function toast(text, kind = "good") {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), kind === "bad" ? 8000 : 3500);
}

/** Runs an action from a button, showing failure next to it (or as a toast when there is no place). */
async function act(button, noteId, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (error) {
    if (error.status === 401) return signOut("That token was not accepted.");
    if (noteId) note(noteId, error.message, "bad");
    else toast(error.message, "bad");
  } finally {
    button.disabled = false;
  }
}

/** A status mark: a small coloured square and a word. */
const stat = (label, kind = "") => h("span", { class: `stat ${kind}`.trim() }, label);

/** "3 min ago" style age of a timestamp. */
function ago(at) {
  if (!at) return "never";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const typeHref = (type) => `#type/${encodeURIComponent(type)}`;
const deviceHref = (c) => `#clients/${encodeURIComponent(c.id)}`;

/** True while someone is typing or choosing inside `box`, so a poll does not redraw under them. */
const busy = (box) => box.contains(document.activeElement) && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);

const LINK_STATES = {
  connected: ["connected", "good"],
  connecting: ["connecting", "warn"],
  pairing_required: ["waiting for approval", "warn"],
  auth_failed: ["refused", "bad"],
  unreachable: ["unreachable", "bad"],
  unconfigured: ["not paired", ""],
};

// --- sign in ---------------------------------------------------------------

function signOut(message = "") {
  token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  clearInterval(timer);
  $("app").classList.add("hidden");
  $("signin-form").classList.remove("hidden");
  $("summary").replaceChildren();
  $("signin-error").textContent = message;
}

async function signIn() {
  try {
    await api("GET", "/admin/status");
  } catch (error) {
    const message =
      error.status === 503 ? "The admin API is off: set AXIS_ADMIN_TOKEN on the hub and restart it."
      : error.status === 401 ? "That token was not accepted."
      : error.message;
    return signOut(token ? message : "");
  }
  sessionStorage.setItem(TOKEN_KEY, token);
  $("signin-form").classList.add("hidden");
  $("app").classList.remove("hidden");
  route();
  await Promise.all([loadConfig(), refresh()]);
  clearInterval(timer);
  timer = setInterval(() => document.hidden || refresh(), 3000);
}

$("signin-form").addEventListener("submit", (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  $("token").value = "";
  signIn();
});
$("signout").addEventListener("click", () => signOut());

// --- live state ------------------------------------------------------------

async function refresh() {
  try {
    const [status, gateway, clients, settings] = await Promise.all([
      api("GET", "/admin/status"),
      api("GET", "/admin/gateway"),
      api("GET", "/admin/clients"),
      api("GET", "/admin/settings/global"),
    ]);
    lastClients = clients.clients;
    lastTypes = clients.types || {};
    lastGlobal = settings.values;
    lastStatus = status;
    renderSummary(status);
    renderGateway(gateway);
    renderNavTypes();
    renderClients();
    renderRooms();
    renderPairDone();
    renderView();
  } catch (error) {
    if (error.status === 401) signOut("That token was not accepted.");
  }
}

function renderSummary(status) {
  const up = (name, value) => stat(name, value === "up" ? "good" : value === "down" ? "bad" : "");
  $("summary").replaceChildren(
    up("agent", status.upstream.openclaw),
    up("recognition", status.upstream.stt),
    up("synthesis", status.upstream.tts),
    stat(`${status.clientsOnline} of ${status.clientsKnown} clients online`, status.clientsOnline ? "good" : ""),
  );
  $("nav-clients").textContent = `${status.clientsOnline}/${status.clientsKnown}`;
}

let gatewayUrlTouched = false;
let agentTouched = false;
let stepsOpened = false;

function renderGateway(gw) {
  lastGateway = gw;
  const link = (name, l) => {
    const [label, kind] = LINK_STATES[l.state] || [l.state, ""];
    return stat(`${name}: ${label}`, kind);
  };
  $("gw-pills").replaceChildren(
    link("turns", gw.operator),
    link("commands", gw.node),
    ...(gw.setupCodePending ? [stat("setup code waiting", "warn")] : []),
  );
  // The sidebar says when the gateway needs attention, so it is seen from any section.
  const both = gw.operator.state === "connected" && gw.node.state === "connected";
  const failed = [gw.operator.state, gw.node.state].some((s) => s === "auth_failed" || s === "unreachable");
  $("nav-openclaw").textContent = both ? "" : failed ? "down" : "setup";
  $("nav-openclaw").className = `count ${failed ? "bad" : both ? "" : "warn"}`.trim();
  // Open the pairing steps once for a hub that is not paired yet.
  if (!both && !stepsOpened) $("gw-steps").open = stepsOpened = true;
  const problem = gw.operator.error || gw.node.error;
  $("gw-note").textContent = problem ? problem : "";
  $("gw-note").className = problem ? "msg bad" : "msg";
  $("gw-device").textContent = gw.deviceId;
  $("gw-commands").textContent = (gw.commands || []).filter((c) => c.startsWith("vortex.axis.")).join(", ");
  if (!gatewayUrlTouched && document.activeElement !== $("gw-url")) $("gw-url").value = gw.url || "";
  if (!agentTouched && document.activeElement !== $("agent-id")) $("agent-id").value = gw.agentId || "";
}

$("gw-url").addEventListener("input", () => (gatewayUrlTouched = true));
$("agent-id").addEventListener("input", () => (agentTouched = true));

$("gw-url-save").addEventListener("click", (event) =>
  act(event.target, "gw-note", async () => {
    renderGateway(await api("PATCH", "/admin/gateway", { url: $("gw-url").value.trim() || null }));
    gatewayUrlTouched = false;
  }),
);

$("gw-retry").addEventListener("click", (event) =>
  act(event.target, "gw-note", async () => renderGateway(await api("POST", "/admin/gateway/retry"))),
);

$("gw-pair").addEventListener("click", (event) =>
  act(event.target, "gw-note", async () => {
    const code = $("gw-code").value.trim();
    if (!code) throw new Error("Paste a setup code first.");
    const url = $("gw-url").value.trim();
    renderGateway(await api("POST", "/admin/gateway/setup-code", url ? { code, url } : { code }));
    $("gw-code").value = "";
    gatewayUrlTouched = false;
  }),
);

// --- settings that are edited, not polled ------------------------------------

function showBackend() {
  const openai = $("agent-backend").value === "openai";
  $("agent-openai").classList.toggle("hidden", !openai);
  $("agent-gateway").classList.toggle("hidden", openai);
}
$("agent-backend").addEventListener("change", showBackend);

function fillConfig(config) {
  lastConfig = config;
  $("stt-url").value = config.stt.url;
  $("stt-model").value = config.stt.model;
  $("stt-key-state").textContent = config.stt.apiKeySet ? "(set)" : "";
  $("tts-url").value = config.tts.url;
  $("tts-model").value = config.tts.model;
  $("tts-voice").value = config.tts.voice;
  $("tts-rate").value = config.tts.sampleRate;
  $("tts-key-state").textContent = config.tts.apiKeySet ? "(set)" : "";
  $("agent-backend").value = config.agent.backend;
  $("agent-url").value = config.agent.url;
  $("agent-model").value = config.agent.model;
  $("agent-token-state").textContent = config.agent.tokenSet ? "(set)" : "";
  for (const id of ["stt-key", "tts-key", "agent-token"]) $(id).value = "";
  showBackend();
}

async function loadConfig() {
  fillConfig(await api("GET", "/admin/config"));
  api("GET", "/admin/gateway/agents")
    .then((list) => $("agent-list").replaceChildren(...list.agents.map((a) => h("option", { value: a.id }))))
    .catch(() => {});
}

/** A secret field left empty is not sent, so the saved value stays. */
const secret = (id, key) => ($(id).value ? { [key]: $(id).value } : {});

$("speech-save").addEventListener("click", (event) =>
  act(event.target, "speech-note", async () => {
    fillConfig(
      await api("PATCH", "/admin/config", {
        stt: { url: $("stt-url").value.trim(), model: $("stt-model").value.trim(), ...secret("stt-key", "apiKey") },
        tts: {
          url: $("tts-url").value.trim(),
          model: $("tts-model").value.trim(),
          voice: $("tts-voice").value.trim(),
          sampleRate: Number($("tts-rate").value),
          ...secret("tts-key", "apiKey"),
        },
      }),
    );
    note("speech-note", "Saved. It applies to the next turn.", "good");
  }),
);

$("speech-test").addEventListener("click", (event) =>
  act(event.target, "speech-note", async () => {
    note("speech-note", "Synthesizing a sentence and transcribing it back…");
    const r = await api("POST", "/admin/config/test");
    const tts = r.tts.ok
      ? `Synthesis: first audio after ${r.tts.firstAudioMs} ms, ${r.tts.audioSeconds} s of audio.`
      : `Synthesis failed: ${r.tts.error}.`;
    const stt = r.stt.ok
      ? r.stt.heard !== undefined
        ? `Recognition: ${r.stt.ms} ms, heard "${r.stt.heard}" (said "${r.said}").`
        : "Recognition answers, but there was no audio to try it with."
      : `Recognition failed: ${r.stt.error}.`;
    note("speech-note", `${tts} ${stt}`, r.tts.ok && r.stt.ok ? "good" : "bad");
  }),
);

$("agent-save").addEventListener("click", (event) =>
  act(event.target, "agent-note", async () => {
    const backend = $("agent-backend").value;
    fillConfig(
      await api("PATCH", "/admin/config", {
        agent: {
          backend,
          url: $("agent-url").value.trim(),
          model: $("agent-model").value.trim(),
          ...secret("agent-token", "token"),
        },
      }),
    );
    if (backend === "gateway") {
      renderGateway(await api("PATCH", "/admin/gateway", { agentId: $("agent-id").value.trim() || null }));
      agentTouched = false;
    }
    note("agent-note", "Saved. It applies to the next turn.", "good");
  }),
);


// --- sections ----------------------------------------------------------------

const VIEWS = ["overview", "activity", "clients", "pair", "settings", "type", "openclaw", "agent", "speech"];

/** Shows one section, picked by the address: #clients, #clients/<id>, #type/<type>, #pair, ... */
function route() {
  const [first, ...rest] = location.hash.slice(1).split("/");
  const id = decodeURIComponent(rest.join("/"));
  let name = VIEWS.includes(first) ? first : "overview";
  if (name === "clients" && id) name = "device";
  if (name === "type" && !id) name = "settings";
  if (name !== view.name || id !== view.id) $("device-note").textContent = "";
  view = { name, id };
  for (const section of document.querySelectorAll(".view")) section.classList.toggle("on", section.id === name);
  const navKey = name === "device" ? "clients" : name === "type" ? `type:${id}` : name;
  for (const a of document.querySelectorAll(".side a")) a.classList.toggle("on", a.dataset.view === navKey);
  renderView();
}
window.addEventListener("hashchange", () => {
  route();
  window.scrollTo(0, 0);
});

function renderView() {
  if (["overview", "activity", "device"].includes(view.name)) loadActivity();
  if (view.name === "overview") renderOverview();
  if (view.name === "activity") renderActivity();
  if (view.name === "device") renderDevice();
  if (view.name === "type") renderType();
  if (view.name === "settings") renderAllDevices();
}

/** Every client type that has a device, with how many are online. */
function typesInUse() {
  const types = new Map();
  for (const c of lastClients) {
    const t = types.get(c.type) || { type: c.type, total: 0, online: 0 };
    t.total++;
    if (c.online) t.online++;
    types.set(c.type, t);
  }
  return [...types.values()].sort((a, b) => a.type.localeCompare(b.type));
}

function renderNavTypes() {
  $("nav-types").replaceChildren(
    ...typesInUse().map((t) =>
      h(
        "a",
        { href: typeHref(t.type), "data-view": `type:${t.type}`, class: view.name === "type" && view.id === t.type ? "on" : "", title: `Settings shared by every ${t.type} device` },
        h("span", { class: "typename" }, t.type),
        h("span", { class: "count" }, String(t.total)),
      ),
    ),
  );
}

/** Rooms already in use, offered when typing a room so one room is not spelled two ways. */
function renderRooms() {
  const rooms = [...new Set(lastClients.map((c) => c.settings.room).filter(Boolean))].sort();
  $("room-list").replaceChildren(...rooms.map((r) => h("option", { value: r })));
}

// --- settings: one editor for every layer ---------------------------------------

/** Keys whose place is the device's own header, not a settings table. */
const DEVICE_ONLY = new Set(["room"]);
const OWN_LABEL = { device: "this device", type: "this type", global: "all devices" };
const FROM_LABEL = { type: "type", global: "all devices", default: "default" };

function showValue(def, value) {
  if (value === undefined || value === null || value === "") return "not set";
  if (def.kind === "toggle") return Number(value) ? "on" : "off";
  if (def.kind === "client") return clientName(value) ?? String(value);
  return `${value}${def.unit && def.kind === "number" ? ` ${def.unit}` : ""}`;
}

/** What the layers below `tab` give a setting, and which one gives it. */
function inherited(def, layers, tab) {
  const below = { device: ["type", "global"], type: ["global"], global: [] }[tab];
  for (const name of below) if (layers[name][def.key] !== undefined) return { source: name, value: layers[name][def.key] };
  return { source: "default", value: def.default };
}

/** Which layer decides a setting, and what it says. */
const effective = (def, layers) => (layers.device[def.key] !== undefined ? { source: "device", value: layers.device[def.key] } : inherited(def, layers, "device"));

/** Clients that set their own value for `key`. */
const differing = (clients, key) => clients.filter((c) => c.layers.device[key] !== undefined);

/**
 * Saves one value on one layer. A value equal to what the layers below already give is
 * removed instead of stored, so the setting keeps following the shared value.
 */
async function saveSetting({ path, def, value, below, what }) {
  const same = value !== null && below.value !== undefined && String(value) === String(below.value);
  const sent = same ? null : value;
  document.activeElement?.blur?.();
  try {
    await api("PATCH", path, { values: { [def.key]: sent } });
    toast(
      sent === null
        ? `${def.label} on ${what} now follows ${below.source === "default" ? "the default" : FROM_LABEL[below.source]} (${showValue(def, below.value)}).`
        : `${def.label} set to ${showValue(def, sent)} on ${what}.`,
    );
  } catch (error) {
    if (error.status === 401) return signOut("That token was not accepted.");
    toast(`${def.label}: ${error.message}`, "bad");
  }
  await refresh();
}

/** An input for one setting, showing `value` and calling `commit` with the new value (null for empty). */
function editorFor(def, value, commit) {
  if (def.kind === "toggle") {
    const box = h("input", { type: "checkbox", "data-edit": def.key, checked: Number(value) === 1 });
    box.addEventListener("change", () => commit(box.checked ? 1 : 0));
    return h("label", { class: "switch" }, box, h("span", {}, Number(value) === 1 ? "on" : "off"));
  }
  if (def.kind === "choice" || def.kind === "client") {
    const options =
      def.kind === "client"
        ? lastClients.map((c) => [c.id, c.name])
        : (def.options || []).map((o) => [o, String(o)]);
    const current = def.kind === "client" ? clientId(value) : value;
    const select = h(
      "select",
      { "data-edit": def.key },
      def.kind === "client" || value === undefined || value === null ? h("option", { value: "" }, def.kind === "client" ? "not set" : "choose") : null,
      options.map(([v, label]) => h("option", { value: String(v), ...(current !== undefined && current !== null && String(current) === String(v) ? { selected: true } : {}) }, label)),
    );
    select.addEventListener("change", () => {
      // Numeric choices are stored as numbers, the way the firmware reads them.
      const numeric = def.kind === "choice" && (def.options || []).every((o) => typeof o === "number");
      commit(select.value === "" ? null : numeric ? Number(select.value) : select.value);
    });
    return select;
  }
  const input = h("input", {
    type: def.kind === "number" ? "number" : "text",
    value: value ?? "",
    placeholder: def.placeholder ?? "not set",
    "data-edit": def.key,
    spellcheck: "false",
    ...(def.kind === "number" && def.min !== undefined ? { min: def.min } : {}),
    ...(def.kind === "number" && def.max !== undefined ? { max: def.max } : {}),
  });
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    commit(raw === "" ? null : def.kind === "number" ? Number(raw) : raw);
  });
  input.addEventListener("keydown", (event) => event.key === "Enter" && input.blur());
  if (def.kind === "number" && def.unit) return h("span", { class: "unit" }, input, h("span", {}, def.unit));
  return input;
}

/**
 * A table of settings edited on one layer. Each row shows the value that applies at that
 * layer, where it comes from, and a way back to the shared value when it is set here.
 */
function settingsTable({ defs, layers, tab, path, what, extra }) {
  const groups = new Map();
  for (const def of defs) {
    const name = def.group || "Other";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(def);
  }
  return [...groups].map(([name, list]) =>
    h(
      "div",
      { class: "setgroup" },
      groups.size > 1 ? h("p", { class: "group" }, name) : null,
      h(
        "table",
        { class: "settings" },
        h(
          "tbody",
          {},
          list.map((def) => {
            const own = layers[tab][def.key];
            const below = inherited(def, layers, tab);
            const mine = own !== undefined;
            const commit = (value) => saveSetting({ path, def, value, below, what });
            return h(
              "tr",
              { class: mine ? "mine" : "follows", "data-key": def.key },
              h(
                "td",
                {},
                h("div", {}, def.label, " ", h("span", { class: "mono sub" }, def.key)),
                def.help ? h("div", { class: "sub" }, def.help) : null,
              ),
              h("td", {}, editorFor(def, mine ? own : below.value, commit)),
              h(
                "td",
                { class: "src" },
                mine ? h("span", { class: "tag" }, OWN_LABEL[tab]) : h("span", {}, below.value === undefined ? "not set" : FROM_LABEL[below.source]),
              ),
              h(
                "td",
                { class: "tight right" },
                extra?.(def, own),
                mine
                  ? h(
                      "button",
                      { class: "small", title: `Remove this value. It goes back to ${showValue(def, below.value)} (${FROM_LABEL[below.source]}).`, onclick: () => commit(null) },
                      tab === "global" ? "Clear" : below.source === "default" ? "Use default" : "Use shared",
                    )
                  : null,
              ),
            );
          }),
        ),
      ),
    ),
  );
}

// --- clients ---------------------------------------------------------------

const clientName = (idOrName) => {
  const c = lastClients.find((c) => c.id === idOrName || c.name.toLowerCase() === String(idOrName).toLowerCase());
  return c?.name;
};
const clientId = (idOrName) => {
  if (idOrName === undefined || idOrName === null) return idOrName;
  const c = lastClients.find((c) => c.id === idOrName || c.name.toLowerCase() === String(idOrName).toLowerCase());
  return c?.id ?? idOrName;
};

/** Settings a device sets for itself, room excepted (it is shown on its own). */
const ownKeys = (c) => Object.keys(c.layers.device).filter((k) => !DEVICE_ONLY.has(k));

function renderClients() {
  const clients = lastClients;
  if (!clients.length) {
    $("client-table").replaceChildren(
      h("p", { class: "empty" }, "No clients yet. ", h("a", { href: "#pair" }, "Add a device"), " to get started."),
    );
    return;
  }
  const filter = $("client-filter").value.trim().toLowerCase();
  const shown = clients
    .filter((c) => !filter || [c.name, c.type, c.settings.room].some((v) => String(v ?? "").toLowerCase().includes(filter)))
    // Online first, then by name.
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  if (!shown.length) {
    $("client-table").replaceChildren(h("p", { class: "empty" }, "No client matches that filter."));
    return;
  }
  const rows = shown.map((c) => {
    const own = ownKeys(c);
    return h(
      "tr",
      { class: `link-row${c.online ? "" : " off"}`, onclick: (event) => event.target.closest("a") || (location.hash = deviceHref(c)) },
      h("td", { class: "tight" }, stat(c.online ? "online" : "offline", c.online ? "good" : "")),
      h("td", {}, h("a", { href: deviceHref(c) }, c.name)),
      h("td", {}, h("a", { href: typeHref(c.type), class: "mono plainlink" }, c.type)),
      h("td", {}, c.settings.room || h("span", { class: "sub" }, "none")),
      h("td", { class: "hide-narrow sub", title: own.join(", ") }, own.length ? plural(own.length, "own value") : "shared"),
      h("td", { class: "hide-narrow mono sub" }, c.version),
      h("td", { class: "hide-narrow sub tight" }, c.online ? "now" : ago(c.lastSeenAt)),
    );
  });
  $("client-table").replaceChildren(
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { class: "tight" }, "State"),
          h("th", {}, "Name"),
          h("th", {}, "Type"),
          h("th", {}, "Room"),
          h("th", { class: "hide-narrow" }, "Settings"),
          h("th", { class: "hide-narrow" }, "Version"),
          h("th", { class: "hide-narrow tight" }, "Last seen"),
        ),
      ),
      h("tbody", {}, rows),
    ),
  );
}

$("client-filter").addEventListener("input", renderClients);

// --- one device ----------------------------------------------------------------

function renderDevice() {
  const client = lastClients.find((c) => c.id === view.id);
  if (!client) {
    $("device-title").textContent = lastClients.length ? "No such client" : "Loading";
    for (const id of ["device-state", "device-head", "device-actions", "device-settings", "device-readings", "device-settings-help"]) $(id).replaceChildren();
    $("device-remove").disabled = true;
    return;
  }
  if (busy($("device"))) return;

  const schema = lastTypes[client.type] || { settings: [], actions: [], links: [] };
  const devicePath = `/admin/settings/device/${encodeURIComponent(client.id)}`;
  $("device-title").textContent = client.name;
  $("device-state").replaceChildren(stat(client.online ? "online" : `offline, last seen ${ago(client.lastSeenAt)}`, client.online ? "good" : ""));
  $("device-remove").disabled = false;

  // Name and room are this device's alone, so they sit at the top and save as they change.
  const nameInput = h("input", { value: client.name, spellcheck: "false", maxlength: 60, "data-edit": "name" });
  nameInput.addEventListener("change", async () => {
    const name = nameInput.value.trim();
    nameInput.blur();
    if (!name || name === client.name) return renderDevice();
    try {
      await api("PATCH", `/admin/clients/${encodeURIComponent(client.id)}`, { name });
      toast(`Renamed to ${name}. Agents address it by this name now.`);
    } catch (error) {
      toast(error.message, "bad");
    }
    refresh();
  });
  nameInput.addEventListener("keydown", (event) => event.key === "Enter" && nameInput.blur());
  const roomDef = { key: "room", label: "Room", kind: "text" };
  const roomInput = h("input", { value: client.layers.device.room ?? "", placeholder: "none", list: "room-list", spellcheck: "false", "data-edit": "room" });
  roomInput.addEventListener("change", () =>
    saveSetting({ path: devicePath, def: roomDef, value: roomInput.value.trim() || null, below: { source: "default", value: undefined }, what: client.name }),
  );
  roomInput.addEventListener("keydown", (event) => event.key === "Enter" && roomInput.blur());

  const base = client.address ? `http://${client.address}` : "";
  const row = (label, ...value) => [h("label", {}, label), h("div", { class: "value" }, ...value)];
  $("device-head").replaceChildren(
    ...row("Name", nameInput),
    ...row("Room", roomInput),
    ...row("Type", h("a", { href: typeHref(client.type), class: "mono" }, client.type), h("span", { class: "sub" }, ` · version ${client.version}`)),
    ...row("Can", client.capabilities.join(", ") || "nothing"),
    ...(client.address ? row("Address", h("span", { class: "mono" }, client.address)) : []),
    ...(client.online && base && schema.links.length
      ? row("Pages", ...schema.links.flatMap((l, i) => [i ? " · " : "", h("a", { href: base + l.path, target: "_blank", rel: "noopener" }, l.label)]))
      : []),
    ...row("Id", h("span", { class: "mono sub" }, client.id)),
  );

  // Actions: the device's own, plus announce for anything that can speak or show text.
  const canSay = client.capabilities.includes("speaker") || client.capabilities.includes("screen");
  const announceInput = h("input", { placeholder: client.online ? "Text to speak or show on this device" : "Offline", spellcheck: "false", disabled: !client.online });
  const announce = (event) =>
    act(event.target, "device-note", async () => {
      const text = announceInput.value.trim();
      if (!text) return;
      note("device-note", "Announcing…");
      const result = await api("POST", `/admin/clients/${encodeURIComponent(client.id)}/announce`, { text });
      announceInput.value = "";
      note("device-note", result.heard ? "Announced. The device played it to the end." : "Sent, but the device did not report playing it.", result.heard ? "good" : "warn");
    });
  announceInput.addEventListener("keydown", (event) => event.key === "Enter" && announce({ target: announceInput }));
  $("device-actions").replaceChildren(
    schema.actions.length
      ? h(
          "div",
          { class: "inline" },
          ...schema.actions.map((a) =>
            h(
              "button",
              {
                title: a.help || "",
                disabled: !client.online,
                onclick: async (event) => {
                  if (a.confirm && !confirm(`${a.label} on ${client.name}?`)) return;
                  await act(event.target, "device-note", async () => {
                    const result = await runCommand(client, a);
                    note("device-note", result.text, result.ok ? "good" : "bad");
                  });
                },
              },
              a.label,
            ),
          ),
        )
      : h("p", { class: "help" }, client.online ? "This device offers no actions." : "Actions appear once the device has connected."),
    canSay
      ? h("div", { class: "inline", style: "margin-top:8px" }, announceInput, h("button", { disabled: !client.online, onclick: announce }, "Announce"))
      : null,
  );

  renderReadings(client);
  renderDeviceHistory();

  const defs = schema.settings.filter((d) => !DEVICE_ONLY.has(d.key));
  const own = defs.filter((d) => client.layers.device[d.key] !== undefined);
  $("device-settings-help").replaceChildren(
    own.length
      ? `${client.name} has ${plural(own.length, "value")} of its own (${own.map((d) => d.label).join(", ")}). `
      : `${client.name} uses the shared settings. `,
    "Changing a value here changes it for this device only. To change it for every ",
    h("span", { class: "mono" }, client.type),
    " device, use ",
    h("a", { href: typeHref(client.type) }, "its type's settings"),
    ".",
  );
  if (!defs.length) {
    $("device-settings").replaceChildren(h("p", { class: "empty" }, "This device has not described its settings yet. It does so each time it connects."));
    return;
  }
  $("device-settings").replaceChildren(
    ...settingsTable({
      defs,
      layers: client.layers,
      tab: "device",
      path: devicePath,
      what: client.name,
      extra: (def, value) =>
        value === undefined
          ? null
          : h(
              "button",
              {
                class: "small",
                title: `Make ${showValue(def, value)} the shared value for every ${client.type} device`,
                onclick: (event) =>
                  act(event.target, null, async () => {
                    await api("PATCH", `/admin/settings/type/${encodeURIComponent(client.type)}`, { values: { [def.key]: value } });
                    await api("PATCH", devicePath, { values: { [def.key]: null } });
                    toast(`${def.label} ${showValue(def, value)} is now shared by every ${client.type} device.`);
                    await refresh();
                  }),
              },
              "Share with type",
            ),
    }),
  );
}

/** Runs one of a device's actions and words the answer. */
async function runCommand(client, action) {
  const result = await api("POST", `/admin/clients/${encodeURIComponent(client.id)}/commands/${encodeURIComponent(action.name)}`);
  const detail = Object.entries(result.payload || {}).map(([k, v]) => `${k}: ${v}`).join(" · ");
  return {
    ok: result.ok,
    text: result.ok ? `${action.label}: done${detail ? ` · ${detail}` : ""}` : `${action.label}: ${result.error || "failed"}`,
  };
}

/** Sensor readings the device reported, if any. */
function renderReadings(client) {
  const entries = Object.entries(client.readings || {});
  $("device-readings").replaceChildren(
    ...(entries.length
      ? [
          h("h3", {}, "Readings"),
          h("table", {}, h("tbody", {}, entries.map(([k, v]) => h("tr", {}, h("td", { class: "mono tight" }, k), h("td", {}, String(v)))))),
        ]
      : []),
  );
}

$("device-remove").addEventListener("click", (event) => {
  const client = lastClients.find((c) => c.id === view.id);
  if (!client || !confirm(`Remove ${client.name}? Its token stops working and it must pair again.`)) return;
  act(event.target, "device-note", async () => {
    await api("DELETE", `/admin/clients/${encodeURIComponent(client.id)}`);
    toast(`${client.name} removed.`);
    location.hash = "#clients";
    await refresh();
  });
});

// --- one type: what its devices share --------------------------------------------

function renderType() {
  const type = view.id;
  const members = lastClients.filter((c) => c.type === type).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  $("type-title").textContent = type;
  if (!members.length) {
    $("type-help").textContent = lastClients.length ? "No device of this type is paired." : "Loading";
    for (const id of ["type-devices", "type-actions", "type-settings"]) $(id).replaceChildren();
    return;
  }
  if (busy($("type"))) return;
  const schema = lastTypes[type] || { settings: [], actions: [], links: [] };
  const online = members.filter((c) => c.online);
  $("type-help").textContent = `${plural(members.length, "device")}, ${online.length} online. Settings here apply to all of them, except where a device has its own value.`;

  $("type-devices").replaceChildren(
    h(
      "table",
      {},
      h(
        "tbody",
        {},
        members.map((c) => {
          const own = ownKeys(c);
          return h(
            "tr",
            { class: `link-row${c.online ? "" : " off"}`, onclick: (event) => event.target.closest("a") || (location.hash = deviceHref(c)) },
            h("td", { class: "tight" }, stat(c.online ? "online" : "offline", c.online ? "good" : "")),
            h("td", {}, h("a", { href: deviceHref(c) }, c.name)),
            h("td", { class: "sub" }, c.settings.room || "no room"),
            h("td", { class: "sub" }, own.length ? `own: ${own.map((k) => labelFor(schema, k)).join(", ")}` : "all shared"),
          );
        }),
      ),
    ),
  );

  // An action runs on every online device of the type, one after the other.
  $("type-actions-box").classList.toggle("hidden", !schema.actions.length);
  $("type-actions").replaceChildren(
    h(
      "div",
      { class: "inline" },
      schema.actions.map((a) =>
        h(
          "button",
          {
            title: a.help || "",
            disabled: !online.length,
            onclick: (event) => {
              if (!confirm(`${a.label} on ${plural(online.length, "online device")}?`)) return;
              act(event.target, null, async () => {
                const results = [];
                for (const c of online) {
                  const r = await runCommand(c, a).catch((error) => ({ ok: false, text: error.message }));
                  results.push({ name: c.name, ...r });
                }
                const failed = results.filter((r) => !r.ok);
                toast(
                  failed.length
                    ? `${a.label}: ${results.length - failed.length} of ${results.length} done. ${failed.map((r) => `${r.name}: ${r.text}`).join("; ")}`
                    : `${a.label}: done on ${plural(results.length, "device")}.`,
                  failed.length ? "bad" : "good",
                );
              });
            },
          },
          a.label,
        ),
      ),
    ),
  );

  const defs = schema.settings.filter((d) => !DEVICE_ONLY.has(d.key));
  if (!defs.length) {
    $("type-settings").replaceChildren(h("p", { class: "empty" }, "No device of this type has described its settings yet. They do so each time they connect."));
    return;
  }
  // The type and global layers are the same for every member; the device layer is empty here.
  const layers = { global: members[0].layers.global, type: members[0].layers.type, device: {} };
  $("type-settings").replaceChildren(
    ...settingsTable({
      defs,
      layers,
      tab: "type",
      path: `/admin/settings/type/${encodeURIComponent(type)}`,
      what: `every ${type} device`,
      extra: (def) => {
        const odd = differing(members, def.key);
        if (!odd.length) return null;
        return h(
          "span",
          { class: "differ", title: "These devices have their own value, so a change here does not reach them" },
          `${odd.length === 1 ? "differs on" : `${odd.length} differ:`} `,
          odd.flatMap((c, i) => [i ? ", " : "", h("a", { href: deviceHref(c) }, `${c.name} (${showValue(def, c.layers.device[def.key])})`)]),
        );
      },
    }),
  );
}

const labelFor = (schema, key) => schema.settings.find((d) => d.key === key)?.label ?? key;

// --- pairing -----------------------------------------------------------------

// Clients that existed when the last code was made, to notice the one that pairs with it.
let pairBaseline;

$("code-new").addEventListener("click", (event) =>
  act(event.target, "code-note", async () => {
    const { code, expiresAt } = await api("POST", "/admin/pairing-codes");
    pairBaseline = new Set(lastClients.map((c) => c.id));
    $("pair-done").replaceChildren();
    $("code-value").textContent = code;
    renderSetupString();
    const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
    const until = new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    note("code-note", `Works once, for ${minutes} minute${minutes === 1 ? "" : "s"} (until ${until}). This page notices when a device uses it.`);
  }),
);

function renderPairDone() {
  if (!pairBaseline) return;
  const fresh = lastClients.find((c) => !pairBaseline.has(c.id));
  if (!fresh) return;
  pairBaseline = undefined;
  $("code-value").textContent = "";
  $("setup-string").value = "";
  note("code-note", "That code has been used.");
  $("pair-done").replaceChildren(`${fresh.name} (${fresh.type}) paired. `, h("a", { href: deviceHref(fresh) }, "Open it"), " to name it and set its room.");
  toast(`${fresh.name} paired.`);
}

$("setup-copy").addEventListener("click", async (event) => {
  const value = $("setup-string").value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // The clipboard needs https or localhost; selecting the text is the fallback.
    $("setup-string").select();
    document.execCommand("copy");
  }
  event.target.textContent = "Copied";
  setTimeout(() => (event.target.textContent = "Copy"), 1500);
});

// A device cannot follow a link, so it gets the address and the code as one string.
// The address is kept in this browser: it is a fact about the network, not about Axis.
const LOCAL_NAMES = ["localhost", "127.0.0.1", "[::1]"];
$("device-address").value =
  localStorage.getItem("axis.deviceAddress") ??
  (location.protocol === "http:" && !LOCAL_NAMES.includes(location.hostname) ? location.host : "");

function renderSetupString() {
  const address = $("device-address").value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const code = $("code-value").textContent;
  $("setup-string").value = address && code ? `axis://${address}/${code}` : "";
}

$("device-address").addEventListener("input", () => {
  localStorage.setItem("axis.deviceAddress", $("device-address").value.trim());
  renderSetupString();
});
$("setup-string").addEventListener("focus", (event) => event.target.select());

// --- all devices -------------------------------------------------------------

/** Settings Axis itself reads from the base layer. */
const AXIS_SETTINGS = [
  {
    key: "voice",
    label: "Voice",
    kind: "text",
    group: "Axis",
    placeholder: "the Speech section's default voice",
    help: "Voice for every device's speech. A type or a device can pick its own.",
  },
  {
    key: "defaultClient",
    label: "Default client",
    kind: "client",
    group: "Axis",
    help: "Where an agent's unprompted speech goes when nobody has spoken lately. Not set: any client that can speak or show text.",
  },
];

/** Device settings declared alike by more than one type: the only ones worth setting for everything. */
function sharedDeviceSettings() {
  const byKey = new Map();
  for (const [type, schema] of Object.entries(lastTypes)) {
    for (const def of schema.settings) {
      if (DEVICE_ONLY.has(def.key) || AXIS_SETTINGS.some((s) => s.key === def.key)) continue;
      const entry = byKey.get(def.key) || { def, types: [] };
      entry.types.push(type);
      byKey.set(def.key, entry);
    }
  }
  return [...byKey.values()].filter((e) => e.types.length > 1);
}

function renderAllDevices() {
  if (busy($("settings"))) return;
  const layers = { global: lastGlobal, type: {}, device: {} };
  const path = "/admin/settings/global";
  $("settings-known").replaceChildren(...settingsTable({ defs: AXIS_SETTINGS, layers, tab: "global", path, what: "all devices" }));

  const shared = sharedDeviceSettings();
  $("settings-shared").replaceChildren(
    ...(shared.length
      ? [
          h("h3", {}, "Settings several device types share"),
          h("p", { class: "help" }, "A value here applies to every type that has the setting, unless the type sets its own."),
          ...settingsTable({ defs: shared.map((e) => ({ ...e.def, group: undefined, help: `Used by ${e.types.join(", ")}.` })), layers, tab: "global", path, what: "all devices" }),
        ]
      : []),
  );

  // Anything else on this layer: keys no type describes, or left over from before.
  const shown = new Set([...AXIS_SETTINGS.map((s) => s.key), ...shared.map((e) => e.def.key)]);
  const others = Object.keys(lastGlobal).filter((k) => !shown.has(k));
  $("settings-other-count").textContent = others.length ? String(others.length) : "";
  if (others.length && !$("settings-advanced").dataset.seen) $("settings-advanced").open = $("settings-advanced").dataset.seen = "1";
  const describedBy = (key) => Object.entries(lastTypes).filter(([, s]) => s.settings.some((d) => d.key === key)).map(([t]) => t);
  $("settings-table").replaceChildren(
    others.length
      ? h(
          "table",
          {},
          h(
            "tbody",
            {},
            others.map((key) => {
              const types = describedBy(key);
              return h(
                "tr",
                {},
                h("td", { class: "mono" }, key),
                h("td", {}, String(lastGlobal[key])),
                h("td", { class: "sub" }, types.length ? `also on ${types.join(", ")}'s page` : ""),
                h(
                  "td",
                  { class: "tight" },
                  h(
                    "button",
                    {
                      class: "small",
                      onclick: (event) =>
                        act(event.target, null, async () => {
                          await api("PATCH", path, { values: { [key]: null } });
                          toast(`${key} cleared.`);
                          await refresh();
                        }),
                    },
                    "Clear",
                  ),
                ),
              );
            }),
          ),
        )
      : h("p", { class: "empty" }, "No other keys set."),
  );
}

$("set-add").addEventListener("click", (event) =>
  act(event.target, null, async () => {
    const key = $("set-key").value.trim();
    const raw = $("set-value").value.trim();
    if (!key) return;
    // Numbers and true/false are stored as such, everything else as text.
    const value = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
    await api("PATCH", "/admin/settings/global", { values: { [key]: value } });
    $("set-key").value = "";
    $("set-value").value = "";
    toast(`${key} set for all devices.`);
    await refresh();
  }),
);

// --- activity: overview, activity page, a device's history ---------------------------

// The summary is fetched for what is on screen and kept a few seconds; it changes slowly.
let activityRange = 24;
let activityData = { key: "", at: 0, data: undefined, loading: false };
const ACTIVITY_FRESH_MS = 10_000;

function activityKey() {
  if (view.name === "device") return `24:${view.id}`;
  if (view.name === "activity") return `${activityRange}:`;
  return "24:";
}

async function loadActivity(force = false) {
  const key = activityKey();
  const fresh = activityData.key === key && Date.now() - activityData.at < ACTIVITY_FRESH_MS;
  if ((fresh && !force) || activityData.loading) return;
  activityData.loading = true;
  const [hours, client] = key.split(":");
  try {
    const data = await api("GET", `/admin/activity?hours=${hours}${client ? `&client=${encodeURIComponent(client)}` : ""}`);
    activityData = { key, at: Date.now(), data, loading: false };
    if (activityKey() === key) {
      if (view.name === "overview") renderOverview();
      if (view.name === "activity") renderActivity();
      if (view.name === "device") renderDeviceHistory();
    }
  } catch (error) {
    activityData.loading = false;
    if (error.status === 401) signOut("That token was not accepted.");
  }
}

/** The summary for what is on screen, or undefined while it loads. */
const currentActivity = () => (activityData.key === activityKey() ? activityData.data : undefined);

const tile = (label, value, detail, kind = "") =>
  h("div", { class: `tile ${kind}`.trim() }, h("div", { class: "tile-label" }, label), h("div", { class: "tile-value" }, value), detail ? h("div", { class: "tile-detail" }, detail) : null);

/** Rows of uptime strips with a name and availability on the left and one time axis below. */
function strips(rows, from, to) {
  return h(
    "div",
    { class: "strips" },
    rows.map((r) =>
      h(
        "div",
        { class: "strip-row" },
        h("div", { class: "strip-name" }, r.href ? h("a", { href: r.href }, r.label) : r.label),
        h("div", { class: "strip-cell" }, strip(r.segments, from, to)),
        h("div", { class: "strip-avail", title: "Share of the recorded time it was working" }, percent(r.availability)),
      ),
    ),
    h("div", { class: "strip-row" }, h("div", {}), stripAxis(from, to), h("div", {})),
    stateLegend(rows.flatMap((r) => r.segments.map((s) => s.state))),
  );
}

function uptimeRows(data) {
  return [
    { label: "Axis", segments: data.axis.segments, availability: data.axis.availability },
    ...data.services
      // The gateway links only matter when the gateway answers turns or has been paired.
      .filter((s) => !["operator", "node"].includes(s.key) || lastConfig?.agent.backend !== "openai" || s.segments.some((g) => g.state !== "unconfigured" && g.state !== "unknown" && g.state !== "axis_down"))
      .map((s) => ({ label: s.label, segments: s.segments, availability: s.availability, href: s.key === "stt" || s.key === "tts" ? "#speech" : "#openclaw" })),
  ];
}

const clientRows = (data) =>
  data.clients
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ label: c.name, segments: c.segments, availability: c.availability, href: `#clients/${encodeURIComponent(c.id)}` }));

const LEVEL_MARK = { bad: "bad", warn: "warn", info: "" };

function eventList(events, limit) {
  if (!events.length) return h("p", { class: "empty" }, "Nothing recorded yet.");
  return h(
    "table",
    { class: "events" },
    h(
      "tbody",
      {},
      events.slice(0, limit).map((e) =>
        h(
          "tr",
          { class: e.level === "info" ? "" : e.level },
          h("td", { class: "tight sub", title: new Date(e.at).toLocaleString() }, clock(e.at, Date.now() - e.at > 20 * 3_600_000)),
          h("td", { class: "tight" }, h("span", { class: `stat ${LEVEL_MARK[e.level]}`.trim() }, e.kind)),
          h("td", {}, e.text),
        ),
      ),
    ),
  );
}

/** Things to look at now, worst first. Each links to where it is fixed. */
function attentionItems(data) {
  const items = [];
  const add = (level, text, href) => items.push({ level, text, href });
  const up = lastStatus?.upstream ?? {};
  const usesGateway = lastConfig?.agent.backend !== "openai";
  if (up.openclaw === "down") add("bad", usesGateway ? "The agent cannot be reached: OpenClaw is not connected." : "The agent endpoint is not answering.", usesGateway ? "#openclaw" : "#agent");
  if (up.stt === "down") add("bad", "Speech recognition is down or not set up. Spoken turns fail.", "#speech");
  if (up.tts === "down") add("bad", "Speech synthesis is down or not set up. Replies are shown but not spoken.", "#speech");
  if (lastGateway) {
    if (lastGateway.setupCodePending) add("warn", "A gateway approval is waiting: approve Axis on the gateway.", "#openclaw");
    else if (usesGateway && lastGateway.node.state !== "connected" && lastGateway.operator.state === "connected")
      add("warn", "The gateway command link is not connected, so agents cannot speak through Axis.", "#openclaw");
  }
  for (const c of lastClients) {
    if (c.online) continue;
    if (!c.lastSeenAt) add("warn", `${c.name} has never connected.`, `#clients/${encodeURIComponent(c.id)}`);
    else if (Date.now() - c.lastSeenAt > 10 * 60_000) add("warn", `${c.name} has been offline for ${duration(Date.now() - c.lastSeenAt)}.`, `#clients/${encodeURIComponent(c.id)}`);
  }
  if (data) {
    const lastHour = data.turns.buckets.at(-1);
    if (lastHour?.failed) add("bad", `${lastHour.failed} ${lastHour.failed === 1 ? "turn" : "turns"} failed in the last hour.`, "#activity");
    const crashes = data.events.filter((e) => /without shutting down/.test(e.text)).length;
    if (crashes) add("warn", `Axis stopped without shutting down ${crashes === 1 ? "once" : `${crashes} times`} in the last 24 hours.`, "#activity");
    const drops = data.events.filter((e) => e.kind === "client" && /stopped answering/.test(e.text)).length;
    if (drops >= 3) add("warn", `Devices dropped off without saying so ${drops} times today. Check Wi-Fi and power.`, "#activity");
  }
  return items.sort((a, b) => (a.level === b.level ? 0 : a.level === "bad" ? -1 : 1));
}

function renderOverview() {
  const data = currentActivity();
  const items = attentionItems(data);
  $("nav-overview").textContent = items.length ? String(items.length) : "";
  $("nav-overview").className = `count ${items.some((i) => i.level === "bad") ? "bad" : items.length ? "warn" : ""}`.trim();
  $("attention").replaceChildren(
    ...(items.length
      ? items.map((i) => h("li", { class: i.level }, h("span", { class: `stat ${i.level}` }, i.level === "bad" ? "problem" : "check"), " ", h("a", { href: i.href }, i.text)))
      : [h("li", { class: "ok" }, h("span", { class: "stat good" }, "all good"), " Nothing needs attention.")]),
  );

  const online = lastClients.filter((c) => c.online).length;
  const t = data?.turns;
  $("overview-tiles").replaceChildren(
    tile("Axis running for", lastStatus?.uptimeMs !== undefined ? duration(lastStatus.uptimeMs) : "–", data ? `${percent(data.axis.availability)} of the last 24 h` : null),
    tile("Devices online", `${online} of ${lastClients.length}`, lastClients.length - online ? `${lastClients.length - online} offline` : "all of them", online < lastClients.length ? "warn" : ""),
    tile("Turns, last 24 h", t ? String(t.count) : "–", t ? (t.failed ? `${t.failed} failed` : "none failed") : null, t?.failed ? "bad" : ""),
    tile("Time to first sound", t ? ms(t.firstAudioP50) : "–", t?.firstAudioP95 !== null && t ? `worst 5 %: ${ms(t.firstAudioP95)}` : "no turns yet"),
  );
  if (!data) return;
  $("overview-strips").replaceChildren(strips([...uptimeRows(data), ...clientRows(data)], data.from, data.to));
  $("overview-events").replaceChildren(eventList(data.events, 8));
}

for (const b of $("activity-range").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    activityRange = Number(b.dataset.hours);
    renderActivity();
    loadActivity(true);
  });
}
$("event-filter").addEventListener("change", () => renderActivity());

const EVENT_FILTERS = {
  problems: (e) => e.level !== "info",
  client: (e) => e.kind === "client",
  service: (e) => e.kind === "service" || e.kind === "axis",
  changes: (e) => e.kind === "settings" || e.kind === "admin",
};

const OUTCOMES = {
  answered: ["answered", "good"],
  silent: ["no reply", ""],
  no_speech: ["nothing heard", ""],
  interrupted: ["interrupted", "warn"],
  failed: ["failed", "bad"],
};
const KINDS = { voice: "spoken", text: "typed", say: "agent spoke" };

function renderActivity() {
  for (const b of $("activity-range").querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.hours) === activityRange);
  const data = currentActivity();
  $("activity").classList.toggle("stale", !data);
  if (!data) return;
  const t = data.turns;
  const span = activityRange === 24 ? "24 hours" : activityRange === 72 ? "3 days" : "7 days";
  $("activity-tiles").replaceChildren(
    tile(`Turns, last ${span}`, String(t.count), t.count ? `${t.answered} answered · ${t.heard} heard to the end` : null),
    tile("Failed", String(t.failed), t.interrupted ? `${t.interrupted} interrupted` : null, t.failed ? "bad" : ""),
    tile("Typical first sound", ms(t.firstAudioP50), "half of turns were faster"),
    tile("Slowest 5 %", ms(t.firstAudioP95), "took at least this long"),
  );

  const width = $("chart-latency").clientWidth || 600;
  $("chart-latency").replaceChildren(
    t.firstAudioP50 === null
      ? h("p", { class: "empty" }, "No spoken replies in this period yet.")
      : lineChart(t.buckets, data.bucketMs, [
          { key: "firstAudioP50", label: "typical", color: "--s1" },
          { key: "firstAudioP95", label: "slowest 5 %", color: "--s2" },
        ], width),
  );
  const turnBuckets = t.buckets.map((b) => ({ ...b, ok: b.count - b.failed }));
  $("chart-turns").replaceChildren(
    t.count
      ? columnChart(turnBuckets, data.bucketMs, [
          { key: "ok", label: "went through", color: "--s1" },
          { key: "failed", label: "failed", color: "--st-bad" },
        ], $("chart-turns").clientWidth || 600)
      : h("p", { class: "empty" }, "No turns in this period yet."),
  );
  $("chart-parts").replaceChildren(
    partsBar([
      { label: "Speech recognition", value: t.sttP50, color: "--s1" },
      { label: "Agent's first words", value: t.agentP50, color: "--s2" },
      { label: "Synthesis to first audio", value: t.synthesisP50, color: "--s3" },
    ]),
  );

  $("activity-strips").replaceChildren(strips([...uptimeRows(data), ...clientRows(data)], data.from, data.to));

  $("activity-turns").replaceChildren(
    data.recentTurns.length
      ? h(
          "table",
          { class: "numbers" },
          h(
            "thead",
            {},
            h("tr", {}, ...["When", "Device", "Kind", "Outcome", "Spoke", "Recognition", "Agent", "First sound", "Total"].map((c, i) => h("th", { class: i >= 4 ? "num" : "" }, c))),
          ),
          h(
            "tbody",
            {},
            data.recentTurns.slice(0, 40).map((r) => {
              const [label, kind] = OUTCOMES[r.outcome] ?? [r.outcome, ""];
              return h(
                "tr",
                {},
                h("td", { class: "tight sub", title: new Date(r.at).toLocaleString() }, clock(r.at, activityRange > 24)),
                h("td", {}, h("a", { href: `#clients/${encodeURIComponent(r.clientId)}` }, r.clientName)),
                h("td", { class: "sub" }, KINDS[r.kind] ?? r.kind),
                h("td", { title: r.error ?? "" }, h("span", { class: `stat ${kind}`.trim() }, label), r.outcome === "answered" && !r.heard && r.kind !== "text" ? h("span", { class: "sub" }, " · not confirmed heard") : null),
                ...[r.speechMs, r.sttMs, r.agentMs, r.firstAudioMs, r.totalMs].map((v) => h("td", { class: "num" }, ms(v))),
              );
            }),
          ),
        )
      : h("p", { class: "empty" }, "No turns in this period yet."),
  );

  const filter = EVENT_FILTERS[$("event-filter").value];
  $("activity-events").replaceChildren(eventList(filter ? data.events.filter(filter) : data.events, 150));
}

function renderDeviceHistory() {
  const data = currentActivity();
  const line = data?.clients[0];
  if (!line || line.id !== view.id) return void $("device-history").replaceChildren(h("p", { class: "help" }, "Loading…"));
  $("device-history").replaceChildren(
    h(
      "div",
      { class: "tiles small" },
      tile("Online", percent(line.availability), `${line.connects} ${line.connects === 1 ? "connection" : "connections"}`),
      tile("Turns", String(line.turns), null),
      tile("Typical first sound", ms(line.firstAudioP50), null),
    ),
    strips([{ label: "Online", segments: line.segments, availability: line.availability }], data.from, data.to),
    h("p", { class: "group" }, "Events"),
    eventList(data.events, 12),
  );
}

// Charts are drawn to the width they have, so a resize redraws them.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => view.name === "activity" && renderActivity(), 150);
});

if (token) signIn();
else route();
