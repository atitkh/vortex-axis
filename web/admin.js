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
  el.className = `note ${kind}`.trim();
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

const pill = (label, kind) => h("span", { class: `pill ${kind}` }, label);

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
  $("signin").classList.remove("hidden");
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
  $("signin").classList.add("hidden");
  $("app").classList.remove("hidden");
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
  const up = (name, value) => pill(name, value === "up" ? "good" : value === "down" ? "bad" : "");
  $("summary").replaceChildren(
    up("agent", status.upstream.openclaw),
    up("recognition", status.upstream.stt),
    up("synthesis", status.upstream.tts),
    pill(`${status.clientsOnline}/${status.clientsKnown} clients online`, status.clientsOnline ? "good" : ""),
  );
}

let gatewayUrlTouched = false;
let agentTouched = false;

function renderGateway(gw) {
  const link = (name, l) => {
    const [label, kind] = LINK_STATES[l.state] || [l.state, ""];
    return pill(`${name}: ${label}`, kind);
  };
  $("gw-pills").replaceChildren(
    link("turns", gw.operator),
    link("commands", gw.node),
    gw.setupCodePending ? pill("setup code waiting", "warn") : null,
  );
  const problem = gw.operator.error || gw.node.error;
  $("gw-note").textContent = problem ? problem : "";
  $("gw-device").textContent = `Device id: ${gw.deviceId}`;
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

// --- clients ---------------------------------------------------------------

function renderClients(clients) {
  // Leave the table alone while someone is typing in it.
  if ($("client-table").contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  if (!clients.length) {
    $("client-table").replaceChildren(h("p", { class: "empty" }, "No clients yet. Create a pairing code below."));
    return;
  }
  const rows = clients.map((c) =>
    h(
      "tr",
      {},
      h("td", {}, h("div", {}, c.name), h("div", { class: "note mono", style: "margin:0" }, `${c.type} · ${c.version}`)),
      h("td", { class: "tight" }, pill(c.online ? "online" : "offline", c.online ? "good" : "")),
      h("td", {}, c.capabilities.join(", ") || "nothing"),
      h("td", {}, c.settings.room || ""),
      h(
        "td",
        { class: "tight" },
        h(
          "button",
          {
            class: `small${c.id === selectedId ? " primary" : ""}`,
            onclick: () => {
              selectedId = c.id;
              layerTab = "device";
              $("device-note").textContent = "";
              renderDevice();
              $("device").scrollIntoView({ behavior: "smooth", block: "nearest" });
            },
          },
          "Open",
        ),
        " ",
        h(
          "button",
          {
            class: "small danger",
            onclick: async (event) => {
              if (!confirm(`Remove ${c.name}? Its token stops working and it must pair again.`)) return;
              await act(event.target, "code-note", () => api("DELETE", `/admin/clients/${encodeURIComponent(c.id)}`));
              refresh();
            },
          },
          "Remove",
        ),
      ),
    ),
  );
  $("client-table").replaceChildren(
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, ...["Client", "", "Can", "Room", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows),
    ),
  );
}

// --- one device: settings in three layers, actions and its own pages -----------

const LAYER_LABELS = { device: "This device", type: "All devices of this type", global: "Everything" };
const SOURCE_NAMES = { device: "this device", type: "its type", global: "everything", default: "the device's default" };

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
    note("device-note", "Saved. The device has it now.", "good");
  } catch (error) {
    if (error.status === 401) return signOut("That token was not accepted.");
    note("device-note", error.message, "bad");
  }
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
    placeholder,
    "data-edit": def.key,
    spellcheck: "false",
    ...(def.kind === "number" && def.min !== undefined ? { min: def.min } : {}),
    ...(def.kind === "number" && def.max !== undefined ? { max: def.max } : {}),
  });
  input.addEventListener("change", () => saveSetting(client, tab, def.key, choose(input.value.trim())));
  return input;
}

function renderDevice() {
  const client = lastClients.find((c) => c.id === selectedId);
  $("device").classList.toggle("hidden", !client);
  if (!client) return;
  // Leave the editor alone while someone is typing in it.
  const active = document.activeElement;
  if ($("device").contains(active) && ["INPUT", "SELECT"].includes(active.tagName)) return;

  const schema = lastTypes[client.type] || { settings: [], actions: [], links: [] };
  $("device-title").textContent = client.name;
  const base = client.address ? `http://${client.address}` : "";
  $("device-head").replaceChildren(
    h(
      "div",
      { class: "row center", style: "margin-top:6px" },
      pill(client.online ? "online" : "offline", client.online ? "good" : ""),
      h("span", { class: "note mono", style: "margin:0" }, `${client.type} · ${client.version}${client.address ? ` · ${client.address}` : ""}`),
      ...(client.online && base
        ? schema.links.map((l) => h("a", { href: base + l.path, target: "_blank", rel: "noopener" }, l.label))
        : []),
    ),
  );

  // Actions: the device's own, plus announce for anything that can speak or show text.
  const canSay = client.capabilities.includes("speaker") || client.capabilities.includes("screen");
  const announceInput = h("input", { placeholder: "Say something on this device", style: "min-width:220px", spellcheck: "false" });
  $("device-actions").replaceChildren(
    h(
      "div",
      { class: "row center" },
      ...schema.actions.map((a) =>
        h(
          "button",
          {
            class: "small",
            title: a.help || "",
            disabled: !client.online,
            onclick: async (event) => {
              if (a.confirm && !confirm(`${a.label} on ${client.name}?`)) return;
              await act(event.target, "device-note", async () => {
                const result = await api("POST", `/admin/clients/${encodeURIComponent(client.id)}/commands/${encodeURIComponent(a.name)}`);
                const detail = Object.entries(result.payload || {}).map(([k, v]) => `${k}: ${v}`).join(" · ");
                note("device-note", result.ok ? `${a.label}: ok${detail ? ` · ${detail}` : ""}` : `${a.label}: ${result.error || "failed"}`, result.ok ? "good" : "bad");
              });
            },
          },
          a.label,
        ),
      ),
    ),
    canSay
      ? h(
          "div",
          { class: "row center" },
          announceInput,
          h(
            "button",
            {
              class: "small",
              disabled: !client.online,
              onclick: (event) =>
                act(event.target, "device-note", async () => {
                  const text = announceInput.value.trim();
                  if (!text) return;
                  note("device-note", "Announcing...");
                  const result = await api("POST", `/admin/clients/${encodeURIComponent(client.id)}/announce`, { text });
                  announceInput.value = "";
                  note("device-note", result.heard ? "Announced; the device played it to the end." : "Sent, but the device did not report playing it.", result.heard ? "good" : "warn");
                }),
            },
            "Announce",
          ),
        )
      : null,
  );

  const tabs = ["device", "type", "global"].map((name) =>
    h(
      "button",
      {
        class: `small${name === layerTab ? " primary" : ""}`,
        onclick: () => {
          layerTab = name;
          renderDevice();
        },
      },
      name === "type" ? `All ${client.type} devices` : LAYER_LABELS[name],
    ),
  );
  $("device-tabs").replaceChildren(
    ...tabs,
    h(
      "span",
      { class: "note", style: "margin:0" },
      layerTab === "device"
        ? "Only this device. Empty inherits."
        : layerTab === "type"
          ? `Every ${client.type} device without its own value.`
          : "Every device of every type without a more specific value.",
    ),
  );

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
        h("h2", { style: "margin-top:14px" }, name),
        h(
          "table",
          {},
          h(
            "tbody",
            {},
            defs.map((def) => {
              const now = effective(def, layers);
              const own = layers[layerTab][def.key];
              return h(
                "tr",
                {},
                h("td", { style: "width:34%" }, h("div", {}, def.label), def.help ? h("div", { class: "note", style: "margin:2px 0 0" }, def.help) : null, h("div", { class: "note mono", style: "margin:0" }, def.key)),
                h("td", { style: "width:30%" }, settingEditor(client, def, layers, layerTab)),
                h("td", { class: "note", style: "margin:0" }, `On this device: ${showValue(def, now.value)} (from ${SOURCE_NAMES[now.source]})`),
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

$("code-new").addEventListener("click", (event) =>
  act(event.target, "code-note", async () => {
    const { code, expiresAt } = await api("POST", "/admin/pairing-codes");
    $("code-value").textContent = code;
    renderSetupString();
    const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
    note("code-note", `Works once, for ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }),
);

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
      {},
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
            h("td", { class: "tight" }, h("div", {}, label), h("div", { class: "note mono", style: "margin:0" }, key)),
            h("td", { style: "width:34%" }, input),
            h("td", { class: "note", style: "margin:0" }, `When empty: ${fallback}.`),
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
    $("settings-table").replaceChildren(h("p", { class: "empty" }, "None."));
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
