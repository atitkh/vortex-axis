// Admin page for VorteX Axis. Plain browser JavaScript, no build step.
// Everything it does goes through the same /admin endpoints any caller can use.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "axis-admin-token";
let token = sessionStorage.getItem(TOKEN_KEY) || "";
let timer;
// The device being edited, which layer of settings the editor is on, and the last data fetched.
let selectedId = "";
let layerTab = "device";
let lastClients = [];
let lastTypes = {};

/** Builds an element. Text always goes in as text, never as markup. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== false) el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) el.append(child instanceof Node ? child : String(child));
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

/** Runs an action from a button, showing failure next to it. */
async function act(button, noteId, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (error) {
    if (error.status === 401) return signOut("That token was not accepted.");
    note(noteId, error.message, "bad");
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
    renderSummary(status);
    renderGateway(gateway);
    renderClients(clients.clients);
    lastClients = clients.clients;
    lastTypes = clients.types || {};
    renderDevice();
    renderSettings(settings.values);
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

/** Shows one section, picked by the address: #clients, #clients/<id>, #pair, #settings, ... */
function route() {
  const [name, id] = location.hash.slice(1).split("/").map(decodeURIComponent);
  let view = ["clients", "pair", "settings", "openclaw", "agent", "speech"].includes(name) ? name : "clients";
  if (view === "clients" && id) {
    view = "device";
    if (id !== selectedId) {
      selectedId = id;
      layerTab = "device";
      $("device-note").textContent = "";
      $("device-note").className = "msg";
    }
  } else {
    selectedId = "";
  }
  for (const section of document.querySelectorAll(".view")) section.classList.toggle("on", section.id === view);
  const navFor = view === "device" ? "clients" : view;
  for (const a of document.querySelectorAll(".side a")) a.classList.toggle("on", a.dataset.view === navFor);
  if (view === "device") renderDevice();
}
window.addEventListener("hashchange", () => {
  route();
  window.scrollTo(0, 0);
});

// --- clients ---------------------------------------------------------------

const deviceHref = (c) => `#clients/${encodeURIComponent(c.id)}`;

function renderClients(clients) {
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
  const rows = shown.map((c) =>
    h(
      "tr",
      { class: `link-row${c.online ? "" : " off"}`, onclick: (event) => event.target.closest("a") || (location.hash = deviceHref(c)) },
      h("td", { class: "tight" }, stat(c.online ? "online" : "offline", c.online ? "good" : "")),
      h("td", {}, h("a", { href: deviceHref(c) }, c.name)),
      h("td", { class: "mono" }, c.type),
      h("td", {}, c.settings.room || h("span", { class: "sub" }, "none")),
      h("td", { class: "hide-narrow sub" }, c.capabilities.join(", ") || "nothing"),
      h("td", { class: "hide-narrow mono sub" }, c.version),
      h("td", { class: "hide-narrow sub tight" }, c.online ? "now" : ago(c.lastSeenAt)),
    ),
  );
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
          h("th", { class: "hide-narrow" }, "Can"),
          h("th", { class: "hide-narrow" }, "Version"),
          h("th", { class: "hide-narrow tight" }, "Last seen"),
        ),
      ),
      h("tbody", {}, rows),
    ),
  );
}

$("client-filter").addEventListener("input", () => renderClients(lastClients));

// --- one device: settings in three layers, actions and its own pages -----------

const SOURCE_NAMES = { device: "this device", type: "type", global: "all devices", default: "default" };

function showValue(def, value) {
  if (value === undefined || value === null || value === "") return "not set";
  if (def.kind === "toggle") return Number(value) ? "on" : "off";
  return `${value}${def.unit && def.kind === "number" ? ` ${def.unit}` : ""}`;
}

/** Which layer decides a setting for this device, and what it says. */
function effective(def, layers) {
  for (const name of ["device", "type", "global"]) {
    if (layers[name][def.key] !== undefined) return { source: name, value: layers[name][def.key] };
  }
  return { source: "default", value: def.default };
}

/** What the layers BELOW the one being edited would give. */
function inherited(def, layers, tab) {
  const below = { device: ["type", "global"], type: ["global"], global: [] }[tab];
  for (const name of below) if (layers[name][def.key] !== undefined) return { source: name, value: layers[name][def.key] };
  return { source: "default", value: def.default };
}

function layerPath(client, tab) {
  if (tab === "global") return "/admin/settings/global";
  if (tab === "type") return `/admin/settings/type/${encodeURIComponent(client.type)}`;
  return `/admin/settings/device/${encodeURIComponent(client.id)}`;
}

async function saveSetting(client, tab, key, value) {
  try {
    await api("PATCH", layerPath(client, tab), { values: { [key]: value } });
    note("device-note", `Saved ${key}. Connected devices have it now.`, "good");
  } catch (error) {
    if (error.status === 401) return signOut("That token was not accepted.");
    note("device-note", `${key}: ${error.message}`, "bad");
  }
  if (document.activeElement?.dataset?.edit) document.activeElement.blur();
  await refresh();
}

function settingEditor(client, def, layers, tab) {
  const own = layers[tab][def.key];
  const below = inherited(def, layers, tab);
  const placeholder = showValue(def, below.value);
  const choose = (raw) => (raw === "" ? null : def.kind === "number" ? Number(raw) : raw);
  if (def.kind === "toggle" || def.kind === "choice") {
    const options = def.kind === "toggle" ? [[1, "on"], [0, "off"]] : (def.options || []).map((o) => [o, String(o)]);
    const select = h(
      "select",
      { "data-edit": def.key },
      h("option", { value: "" }, `inherit (${placeholder})`),
      options.map(([value, label]) => h("option", { value: String(value), ...(own !== undefined && String(own) === String(value) ? { selected: true } : {}) }, label)),
    );
    select.addEventListener("change", () => {
      const raw = select.value;
      // Toggles and numeric choices are stored as numbers, the way the firmware reads them.
      const numeric = def.kind === "toggle" || (def.options || []).every((o) => typeof o === "number");
      saveSetting(client, tab, def.key, raw === "" ? null : numeric ? Number(raw) : raw);
    });
    return select;
  }
  const input = h("input", {
    type: def.kind === "number" ? "number" : "text",
    value: own ?? "",
    placeholder: `inherit (${placeholder})`,
    "data-edit": def.key,
    spellcheck: "false",
    ...(def.kind === "number" && def.min !== undefined ? { min: def.min } : {}),
    ...(def.kind === "number" && def.max !== undefined ? { max: def.max } : {}),
  });
  input.addEventListener("change", () => saveSetting(client, tab, def.key, choose(input.value.trim())));
  return input;
}

function renderDevice() {
  if (!selectedId || !$("device").classList.contains("on")) return;
  const client = lastClients.find((c) => c.id === selectedId);
  if (!client) {
    $("device-title").textContent = lastClients.length ? "No such client" : "Loading";
    for (const id of ["device-state", "device-head", "device-actions", "device-tabs", "device-settings", "device-readings"]) $(id).replaceChildren();
    $("device-remove").disabled = true;
    return;
  }
  // Leave the page alone while someone is typing in it.
  const active = document.activeElement;
  if ($("device").contains(active) && ["INPUT", "SELECT"].includes(active.tagName)) return;

  const schema = lastTypes[client.type] || { settings: [], actions: [], links: [] };
  $("device-title").textContent = client.name;
  $("device-state").replaceChildren(stat(client.online ? "online" : `offline, last seen ${ago(client.lastSeenAt)}`, client.online ? "good" : ""));
  $("device-remove").disabled = false;

  const base = client.address ? `http://${client.address}` : "";
  const fact = (term, ...value) => [h("dt", {}, term), h("dd", {}, ...value)];
  $("device-head").replaceChildren(
    ...fact("Type", h("span", { class: "mono" }, client.type), `, version ${client.version}`),
    ...fact("Room", client.settings.room || "none"),
    ...fact("Can", client.capabilities.join(", ") || "nothing"),
    ...(client.address ? fact("Address", h("span", { class: "mono" }, client.address)) : []),
    ...(client.online && base && schema.links.length
      ? fact("Pages", ...schema.links.flatMap((l, i) => [i ? " · " : "", h("a", { href: base + l.path, target: "_blank", rel: "noopener" }, l.label)]))
      : []),
    ...fact("Id", h("span", { class: "mono" }, client.id)),
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
                    const result = await api("POST", `/admin/clients/${encodeURIComponent(client.id)}/commands/${encodeURIComponent(a.name)}`);
                    const detail = Object.entries(result.payload || {}).map(([k, v]) => `${k}: ${v}`).join(" · ");
                    note("device-note", result.ok ? `${a.label}: done${detail ? ` · ${detail}` : ""}` : `${a.label}: ${result.error || "failed"}`, result.ok ? "good" : "bad");
                  });
                },
              },
              a.label,
            ),
          ),
        )
      : h("p", { class: "help" }, "This device offers no actions."),
    canSay
      ? h("div", { class: "inline", style: "margin-top:8px" }, announceInput, h("button", { disabled: !client.online, onclick: announce }, "Announce"))
      : null,
  );

  const LAYER_HELP = {
    device: "Values set here apply to this device only. Empty fields inherit.",
    type: `Values set here apply to every ${client.type} device that has no value of its own.`,
    global: "Values set here apply to every device of every type, unless a more specific layer sets one.",
  };
  $("device-tabs").replaceChildren(
    ...["device", "type", "global"].map((name) =>
      h(
        "button",
        {
          class: name === layerTab ? "on" : "",
          onclick: () => {
            layerTab = name;
            renderDevice();
          },
        },
        name === "device" ? "This device" : name === "type" ? `All ${client.type} devices` : "All devices",
      ),
    ),
  );
  $("device-layer-help").textContent = LAYER_HELP[layerTab];

  renderReadings(client);

  const groups = new Map();
  for (const def of schema.settings) {
    const name = def.group || "Other";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(def);
  }
  if (!groups.size) {
    $("device-settings").replaceChildren(h("p", { class: "empty" }, "This device has not described its settings yet. It does so each time it connects."));
    return;
  }
  const layers = client.layers;
  $("device-settings").replaceChildren(
    ...[...groups].map(([name, defs]) =>
      h(
        "div",
        {},
        groups.size > 1 ? h("p", { class: "group" }, name) : null,
        h(
          "table",
          { class: "settings" },
          h(
            "tbody",
            {},
            defs.map((def) => {
              const now = effective(def, layers);
              const own = layers[layerTab][def.key];
              return h(
                "tr",
                { class: own === undefined ? "" : "mine" },
                h(
                  "td",
                  {},
                  h("div", {}, def.label, " ", h("span", { class: "mono sub" }, def.key)),
                  def.help ? h("div", { class: "sub" }, def.help) : null,
                ),
                h("td", {}, settingEditor(client, def, layers, layerTab)),
                h("td", { class: "eff" }, showValue(def, now.value), " ", h("span", { class: "from" }, `(${SOURCE_NAMES[now.source]})`)),
                h(
                  "td",
                  { class: "tight" },
                  own === undefined
                    ? null
                    : h("button", { class: "small", title: "Remove this value so the next layer applies", onclick: () => saveSetting(client, layerTab, def.key, null) }, "Reset"),
                ),
              );
            }),
          ),
        ),
      ),
    ),
  );
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
  const client = lastClients.find((c) => c.id === selectedId);
  if (!client || !confirm(`Remove ${client.name}? Its token stops working and it must pair again.`)) return;
  act(event.target, "device-note", async () => {
    await api("DELETE", `/admin/clients/${encodeURIComponent(client.id)}`);
    location.hash = "#clients";
    await refresh();
  });
});

// --- pairing -----------------------------------------------------------------

$("code-new").addEventListener("click", (event) =>
  act(event.target, "code-note", async () => {
    const { code, expiresAt } = await api("POST", "/admin/pairing-codes");
    $("code-value").textContent = code;
    renderSetupString();
    const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
    const until = new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    note("code-note", `Works once, for ${minutes} minute${minutes === 1 ? "" : "s"} (until ${until}).`);
  }),
);

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

// --- shared settings -------------------------------------------------------

/** Settings Axis itself reads, with what happens when each is left empty. */
const KNOWN_SETTINGS = [
  { key: "voice", label: "Voice", fallback: "the default voice in the Speech section, or the speech service's own default" },
  { key: "defaultClient", label: "Default client", fallback: "the client last spoken to, then any client that can speak or show text" },
  { key: "wakeWord", label: "Wake word", fallback: "each device's built-in wake word (the web client has none)" },
];

function renderKnownSettings(values) {
  const box = $("settings-known");
  // Leave the fields alone while someone is typing in one.
  if (box.contains(document.activeElement)) return;
  box.replaceChildren(
    h(
      "table",
      { class: "settings" },
      h(
        "tbody",
        {},
        KNOWN_SETTINGS.map(({ key, label, fallback }) => {
          const input = h("input", { value: values[key] ?? "", placeholder: "not set", spellcheck: "false" });
          input.addEventListener("change", async () => {
            const raw = input.value.trim();
            await api("PATCH", "/admin/settings/global", { values: { [key]: raw === "" ? null : raw } }).catch(() => {});
            input.blur();
            refresh();
          });
          return h(
            "tr",
            {},
            h("td", {}, h("div", {}, label, " ", h("span", { class: "mono sub" }, key)), h("div", { class: "sub" }, `When empty: ${fallback}.`)),
            h("td", {}, input),
          );
        }),
      ),
    ),
  );
}

function renderSettings(all) {
  renderKnownSettings(all);
  const known = new Set(KNOWN_SETTINGS.map((s) => s.key));
  const values = Object.fromEntries(Object.entries(all).filter(([key]) => !known.has(key)));
  const keys = Object.keys(values);
  if (!keys.length) {
    $("settings-table").replaceChildren(h("p", { class: "empty" }, "No other keys set."));
    return;
  }
  $("settings-table").replaceChildren(
    h(
      "table",
      {},
      h(
        "tbody",
        {},
        keys.map((key) =>
          h(
            "tr",
            {},
            h("td", { class: "mono" }, key),
            h("td", {}, String(values[key])),
            h(
              "td",
              { class: "tight" },
              h(
                "button",
                {
                  class: "small",
                  onclick: async () => {
                    await api("PATCH", "/admin/settings/global", { values: { [key]: null } }).catch(() => {});
                    refresh();
                  },
                },
                "Clear",
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

$("set-add").addEventListener("click", async () => {
  const key = $("set-key").value.trim();
  const raw = $("set-value").value.trim();
  if (!key) return;
  // Numbers and true/false are stored as such, everything else as text.
  const value = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  await api("PATCH", "/admin/settings/global", { values: { [key]: value } }).catch(() => {});
  $("set-key").value = "";
  $("set-value").value = "";
  refresh();
});

if (token) signIn();
