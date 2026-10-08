// Admin page for VorteX Axis. Plain browser JavaScript, no build step.
// Everything it does goes through the same /admin endpoints any caller can use.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "axis-admin-token";
let token = sessionStorage.getItem(TOKEN_KEY) || "";
let timer;

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
  $("gw-commands").textContent = (gw.commands || []).filter((c) => c.startsWith("axis.")).join(", ");
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

function settingInput(client, key, type) {
  const value = client.settings[key];
  const input = h("input", { type, value: value ?? "", "data-edit": `${client.id}:${key}`, style: "min-width:84px" });
  input.addEventListener("change", async () => {
    const raw = input.value.trim();
    const next = raw === "" ? null : type === "number" ? Number(raw) : raw;
    try {
      await api("PATCH", `/admin/settings/device/${encodeURIComponent(client.id)}`, { values: { [key]: next } });
    } catch (error) {
      note("code-note", error.message, "bad");
    }
    input.blur();
    refresh();
  });
  return input;
}

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
      h("td", {}, settingInput(c, "room", "text")),
      h("td", {}, settingInput(c, "volume", "number")),
      h(
        "td",
        { class: "tight" },
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
      h("thead", {}, h("tr", {}, ...["Client", "", "Can", "Room", "Volume", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows),
    ),
  );
}

$("code-new").addEventListener("click", (event) =>
  act(event.target, "code-note", async () => {
    const { code, expiresAt } = await api("POST", "/admin/pairing-codes");
    $("code-value").textContent = code;
    const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
    note("code-note", `Works once, for ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }),
);

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
