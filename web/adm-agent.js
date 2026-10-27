// The Agent and voice area of the new admin page: Who answers, OpenClaw gateway, Tools and MCP, Speech and Voices
// (docs/admin-revamp/ia.md 2.4). Everything the classic pages #agent, #openclaw, #tools and #speech do is here. What is a
// setting is staged and saved with the save bar (one per page, entity "page:<name>"); what is an action runs at once.

import { html, useEffect, useRef, useState } from "/web/preact.js";
import { clock } from "/web/charts.js";
import { Button, ago, api, ask, authHeader, clearDraft, draftOf, plural, refresh, set, setDraft, store, toast } from "/web/adm-core.js";
import { SaveBar } from "/web/adm-settings.js";
import { PAGES, PageHead } from "/web/adm-shell.js";

// --- staged forms -------------------------------------------------------------------------------

const sameValue = (a, b) => String(a ?? "") === String(b ?? "");

/** A page's fields: what is saved, what is staged over it, and how to stage a value. */
export function useForm(entity, saved) {
  const staged = draftOf(entity).values;
  return {
    value: (key) => (Object.hasOwn(staged, key) ? staged[key] : saved?.[key]),
    dirty: (key) => Object.hasOwn(staged, key),
    put: (key, v) =>
      setDraft(entity, (d) => {
        if (sameValue(v, saved?.[key])) delete d.values[key];
        else d.values[key] = v;
        return d;
      }),
    staged,
  };
}

/**
 * Saves a page's staged fields: `apply(values, keys)` writes them (values: saved and staged together; keys: what changed).
 * Undo writes the values from before back, unless a key was among the changes (it cannot be read back). Returns the
 * error for the save bar, or "".
 */
export async function saveForm(entity, saved, apply, { secrets = [], words } = {}) {
  const staged = { ...draftOf(entity).values };
  const keys = new Set(Object.keys(staged));
  try {
    await apply({ ...saved, ...staged }, keys);
  } catch (error) {
    return error.message;
  }
  clearDraft(entity);
  const before = { ...saved };
  const undo = secrets.some((k) => staged[k])
    ? undefined
    : async () => {
        try {
          await apply(before, keys);
          toast("Put back as it was.");
        } catch (error) {
          toast(error.message, "bad");
        }
      };
  toast(words?.(staged) ?? `${plural(keys.size, "change")} saved. It applies to the next turn.`, "good", undo);
  return "";
}

/** One labelled line of a form; `dirty` marks it as not saved yet. */
export function F({ label, help, dirty, children, id, hidden }) {
  if (hidden) return null;
  return html`<div class=${`f${dirty ? " dirty" : ""}`}>
    <label class="f-l" for=${id}>${label}${dirty ? html`<span class="src-chip unsaved">unsaved</span>` : null}</label>
    <div class="f-c">${children}${help ? html`<p class="help">${help}</p>` : null}</div>
  </div>`;
}

export function Text({ form, k, id, placeholder, mono, type = "text", area, rows = 4, ...rest }) {
  const props = {
    id, "data-f": k, class: `field${mono ? " mono" : ""}`, value: form.value(k) ?? "", placeholder, spellcheck: "false",
    onInput: (e) => form.put(k, e.currentTarget.value),
  };
  return area
    ? html`<textarea ...${props} rows=${rows} ...${rest}></textarea>`
    : html`<input ...${props} type=${type} autocomplete=${type === "password" ? "off" : undefined} onKeyDown=${(e) => e.key === "Enter" && e.currentTarget.blur()} ...${rest} />`;
}

export function Seg({ form, k, options, label }) {
  const v = form.value(k);
  return html`<div class="seg" role="group" aria-label=${label} data-f=${k}>
    ${options.map(([value, text]) => html`<button type="button" key=${String(value)} class=${sameValue(v, value) ? "on" : ""} aria-pressed=${sameValue(v, value)} data-v=${String(value)} onClick=${() => form.put(k, value)}>${text}</button>`)}
  </div>`;
}

export function Switch({ form, k, label, disabled }) {
  const on = Boolean(form.value(k));
  return html`<label class="switch-l"><input type="checkbox" class="switch" data-f=${k} aria-label=${label} checked=${on} disabled=${disabled} onChange=${(e) => form.put(k, e.currentTarget.checked)} /><span>${label}</span></label>`;
}

export const Stat = ({ label, kind = "" }) => html`<span class=${`badge ${kind}`}>${label}</span>`;
export const Note = ({ m, id }) => (m?.text ? html`<p class=${`msg ${m.kind ?? ""}`} id=${id} role="status">${m.text}</p>` : html`<p class="msg" id=${id}></p>`);

/** The text in a box, or nothing when it is the built-in one, so a later change to the built-in one is picked up. */
const builtIn = (typed, given) => (String(typed ?? "").trim() === String(given ?? "").trim() ? "" : String(typed ?? "").trim());

// --- what is read for these pages ----------------------------------------------------------------

const cache = {};
/** Reads `path` on mount, and every `every` ms while shown (not while `pause.current`). */
export function useLoad(path, every = 0, pause) {
  const [data, setData] = useState(cache[path]);
  const [error, setError] = useState("");
  const load = async (method = "GET") => {
    try {
      const d = await api(method, path);
      cache[path] = d;
      setData(d);
      setError("");
      return d;
    } catch (e) {
      if (e.status !== 401) setError(e.message);
      return undefined;
    }
  };
  useEffect(() => {
    load();
    if (!every) return;
    const t = setInterval(() => !document.hidden && !pause?.current && load(), every);
    return () => clearInterval(t);
  }, [path]);
  return [data, load, error];
}

/** The agents the gateway lists, for the agent field and the guest agent. */
function useAgents() {
  const [list, setList] = useState();
  useEffect(() => {
    api("GET", "/admin/gateway/agents").then((l) => setList(l.agents.map((a) => a.id)), () => setList([]));
  }, []);
  return list;
}

/** The config, read fresh when a page that edits it opens. */
function useConfig() {
  useEffect(() => {
    api("GET", "/admin/config").then((config) => set({ config }), () => {});
  }, []);
  return store.config;
}

export const Loading = () => html`<div class="loading" aria-busy="true"><span class="spinner"></span> Loading…</div>`;
const Head = ({ page, children }) => html`<${PageHead} title=${PAGES[page].title} purpose=${PAGES[page].purpose}>${children}</${PageHead}>`;

export async function copy(text, field) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    field?.select();
    toast("Selected: copy it with Ctrl+C.", "warn");
  }
}

// --- Who answers (#agent) -------------------------------------------------------------------------

export function AgentPage() {
  const config = useConfig();
  const agents = useAgents();
  const [m, setM] = useState();
  const entity = "page:agent";
  const a = config?.agent;
  const saved = a && {
    backend: a.backend, agentId: store.gateway?.agentId || "", note: a.gatewayNote || a.defaultGatewayNote,
    url: a.url, model: a.model, token: "", prompt: a.systemPrompt || a.defaultSystemPrompt,
  };
  const form = useForm(entity, saved);
  if (!a) return html`<${Head} page="agent" /><${Loading} />`;
  const openai = form.value("backend") === "openai";
  const apply = async (v, keys) => {
    set({
      config: await api("PATCH", "/admin/config", {
        agent: {
          backend: v.backend, url: String(v.url).trim(), model: String(v.model).trim(),
          systemPrompt: builtIn(v.prompt, a.defaultSystemPrompt), gatewayNote: builtIn(v.note, a.defaultGatewayNote),
          ...(v.token ? { token: v.token } : {}),
        },
      }),
    });
    if (v.backend === "gateway" && (keys.has("agentId") || keys.has("backend"))) {
      set({ gateway: await api("PATCH", "/admin/gateway", { agentId: String(v.agentId).trim() || null }) });
    }
  };
  const save = () => saveForm(entity, saved, apply, { secrets: ["token"] });
  const test = async () => {
    setM({ text: "Asking the endpoint…" });
    try {
      const r = await api("POST", "/admin/config/test-agent", {
        url: String(form.value("url")).trim(), model: String(form.value("model")).trim(), token: form.value("token"),
        systemPrompt: builtIn(form.value("prompt"), a.defaultSystemPrompt),
      });
      setM(r.ok
        ? { kind: "good", text: `It works: first words after ${(r.firstTextMs / 1000).toFixed(1)} s, whole reply in ${(r.totalMs / 1000).toFixed(1)} s. It said: "${r.reply}". Not saved yet.` }
        : { kind: "bad", text: `It does not work: ${r.error}.` });
    } catch (e) {
      setM({ kind: "bad", text: e.message });
    }
  };
  return html`<${Head} page="agent" />
    <section class="card" id="agent-form">
      <div class="card-h"><h3>Answered by</h3></div>
      <div class="card-b fgrid">
        <${F} label="Who answers" dirty=${form.dirty("backend")} help="Who answers when someone talks to a device.">
          <${Seg} form=${form} k="backend" label="Answered by" options=${[["gateway", "OpenClaw gateway"], ["openai", "Another OpenAI-style chat endpoint"]]} />
        </${F}>
        <${F} hidden=${openai} label="OpenClaw agent" id="agent-id" dirty=${form.dirty("agentId")} help=${agents?.length ? `The gateway lists ${agents.join(", ")}.` : "Empty for the gateway's default agent."}>
          <${Text} form=${form} k="agentId" id="agent-id" placeholder="gateway default" list="agent-list" />
          <datalist id="agent-list">${(agents ?? []).map((id) => html`<option key=${id} value=${id} />`)}</datalist>
        </${F}>
        <${F} hidden=${openai} label="Note to the agent" id="agent-note" dirty=${form.dirty("note")}
          help=${html`Added to the agent's own system prompt on every turn from Axis: that it is speaking as a voice assistant, what the line describing the device means, and that the Axis tools reach the devices. Keep it free of anything that changes from turn to turn. Empty the box and save for the built-in one; a single <code>-</code> sends none.`}>
          <${Text} form=${form} k="note" id="agent-note" area rows=${8} />
        </${F}>
        <${F} hidden=${!openai} label="Chat endpoint" id="agent-url" dirty=${form.dirty("url")}>
          <${Text} form=${form} k="url" id="agent-url" mono placeholder="http://host:11434/v1/chat/completions" />
        </${F}>
        <${F} hidden=${!openai} label="Model" id="agent-model" dirty=${form.dirty("model")}><${Text} form=${form} k="model" id="agent-model" /></${F}>
        <${F} hidden=${!openai} label=${html`Token ${a.tokenSet ? html`<span class="badge">set</span>` : null}`} id="agent-token" dirty=${form.dirty("token")}>
          <${Text} form=${form} k="token" id="agent-token" type="password" placeholder="leave empty to keep" />
        </${F}>
        <${F} hidden=${!openai} label="System prompt" id="agent-prompt" dirty=${form.dirty("prompt")}
          help="Sent with every turn, ahead of the person's words. It tells the model it is a voice assistant and how to read the line that describes the device. Empty the box and save to go back to the built-in one. An OpenClaw agent has its own prompt and is not sent this.">
          <${Text} form=${form} k="prompt" id="agent-prompt" area rows=${12} />
        </${F}>
        ${openai
          ? html`<div class="f"><span class="f-l"></span><div class="f-c">
              <p class="btnrow"><${Button} class="btn" id="agent-test" run=${test}>Test this endpoint</${Button}><span class="dim sm">Sends one short message with what is typed above. Nothing is saved.</span></p>
              <${Note} m=${m} id="agent-test-note" />
            </div></div>`
          : null}
      </div>
    </section>
    <${SaveBar} entity=${entity} save=${save} floating />`;
}

// --- OpenClaw gateway (#openclaw) ----------------------------------------------------------------

export const LINK_STATES = {
  connected: ["connected", "good"],
  connecting: ["connecting", "warn"],
  pairing_required: ["waiting for approval", "warn"],
  auth_failed: ["refused", "bad"],
  unreachable: ["unreachable", "bad"],
  unconfigured: ["not paired", ""],
};
const CHECK_STATES = { ok: ["working", "good"], off: ["off", ""], problem: ["not working", "bad"], unknown: ["cannot tell", "warn"] };

/** The sidebar's mark for the gateway: "" when both links are up, else "down" or "setup". */
export function gatewayMark(gw) {
  if (!gw) return ["", ""];
  const both = gw.operator.state === "connected" && gw.node.state === "connected";
  const failed = [gw.operator.state, gw.node.state].some((s) => s === "auth_failed" || s === "unreachable");
  return both ? ["", ""] : failed ? ["down", "bad"] : ["setup", "warn"];
}

/** Has Axis ask the gateway afresh what it offers; the result goes into the store for the attention list too. */
export async function checkAgain() {
  const check = await api("POST", "/admin/selfcheck");
  set({ check });
  return check;
}

export async function reconnectGateway() {
  const gateway = await api("POST", "/admin/gateway/retry");
  set({ gateway });
  return gateway;
}

export function OpenClawPage() {
  const gw = store.gateway;
  const [mcp, loadMcp] = useLoad("/admin/mcp", 10_000);
  const [check, setCheck] = useState(store.check);
  // Read from the field itself when Pair is pressed, so a code pasted a moment before is never missed.
  const codeField = useRef();
  const [m, setM] = useState();
  const [stepsOpen] = useState(() => gatewayMark(gw)[0] !== "");
  useEffect(() => {
    api("GET", "/admin/selfcheck").then((c) => (setCheck(c), set({ check: c })), () => {});
  }, []);
  const entity = "page:openclaw";
  const saved = gw && mcp && { url: gw.url || "", mirrorCards: mcp.mirrorCards, mirrorQuestions: mcp.mirrorQuestions, mirrorApprovals: mcp.mirrorApprovals };
  const form = useForm(entity, saved);
  if (!gw) return html`<${Head} page="openclaw" /><${Loading} />`;
  const link = (name, l) => {
    const [label, kind] = LINK_STATES[l.state] || [l.state, ""];
    return html`<${Stat} label=${`${name}: ${label}`} kind=${kind} />`;
  };
  const problem = gw.operator.error || gw.node.error;
  const apply = async (v, keys) => {
    if (keys.has("url")) set({ gateway: await api("PATCH", "/admin/gateway", { url: String(v.url).trim() || null }) });
    const mirrors = Object.fromEntries(["mirrorCards", "mirrorQuestions", "mirrorApprovals"].filter((k) => keys.has(k)).map((k) => [k, Boolean(v[k])]));
    if (Object.keys(mirrors).length) await api("PATCH", "/admin/integrations", mirrors);
    await loadMcp();
  };
  const save = () => saveForm(entity, saved ?? {}, apply);
  const pair = async () => {
    const text = codeField.current.value.trim();
    if (!text) return setM({ kind: "bad", text: "Paste a setup code first." });
    setM();
    const url = String(form.value("url") ?? "").trim();
    try {
      set({ gateway: await api("POST", "/admin/gateway/setup-code", url ? { code: text, url } : { code: text }) });
      codeField.current.value = "";
      form.put("url", store.gateway.url || "");
      toast("Paired: approve Axis on the gateway, if it asks.");
    } catch (e) {
      setM({ kind: "bad", text: e.message });
    }
  };
  const commands = (gw.commands || []).filter((c) => c.startsWith("vortex.axis."));
  const w = mcp?.watch;
  return html`<${Head} page="openclaw">
      <${Button} class="btn" id="gw-retry" run=${async () => (await reconnectGateway(), toast("Reconnecting to the gateway."))}>Reconnect</${Button}>
    </${Head}>
    <section class="card" id="gw-links">
      <div class="card-h"><h3>The link</h3><span class="health-row" id="gw-pills">${link("turns", gw.operator)} ${link("commands", gw.node)} ${gw.setupCodePending ? html`<${Stat} label="setup code waiting" kind="warn" />` : null}</span></div>
      <div class="card-b">
        ${problem ? html`<p class="msg bad" id="gw-note">${problem}</p>` : html`<p class="help">Turns go to the agent over the turn link; the agent reaches the devices over the command link.</p>`}
      </div>
    </section>
    <section class="card" id="gw-check">
      <div class="card-h"><h3>What Axis relies on</h3>
        ${check?.asked ? html`<span class="dim sm">Last asked ${ago(check.at)}</span>` : null}
        <${Button} class="btn sm" id="check-again" run=${async () => setCheck(await checkAgain())}>Check again</${Button}></div>
      <div class="card-b">
        <p class="help">Much of what the devices show comes from this gateway: an agent's steps, its questions, the tools it picks up, the realtime voice. An update to OpenClaw could take one of those away without a word. Axis asks the gateway what it offers each time it connects, and tries what it can try without changing anything.</p>
        ${check?.asked
          ? html`<div class="tablebox"><table class="t" id="check-list"><tbody>${check.checks.map((c) => {
              const [label, kind] = CHECK_STATES[c.state] ?? [c.state, ""];
              return html`<tr key=${c.label}><td>${c.label}</td><td><${Stat} label=${label} kind=${kind} /></td><td class="dim">${c.detail}</td></tr>`;
            })}</tbody></table></div>`
          : html`<p class="empty" id="check-list">Nothing to ask: Axis is not connected to an OpenClaw gateway as its agent.</p>`}
      </div>
    </section>
    <section class="card" id="gw-pairing">
      <div class="card-h"><h3>Address and pairing</h3></div>
      <div class="card-b fgrid">
        <${F} label="Gateway address" id="gw-url" dirty=${form.dirty("url")} help="Saved with the save bar; Axis connects to it at once.">
          <${Text} form=${form} k="url" id="gw-url" mono placeholder="ws://host:18789" />
        </${F}>
        <${F} label="Setup code" id="gw-code">
          <textarea class="field mono" id="gw-code" rows="3" spellcheck="false" placeholder="Output of: openclaw qr --setup-code-only" ref=${codeField}></textarea>
          <p class="btnrow"><${Button} class="btn primary sm" id="gw-pair" run=${pair}>Pair</${Button}></p>
          <${Note} m=${m} id="gw-pair-note" />
        </${F}>
        <${F} label="Device id"><span class="mono" id="gw-device">${gw.deviceId}</span></${F}>
      </div>
      <div class="card-b">
        <details id="gw-steps" open=${stepsOpen}>
          <summary>Pairing steps</summary>
          <ol class="pair-steps">
            <li>On the gateway host run <code>openclaw qr --setup-code-only</code>, paste it above and press Pair.</li>
            <li>Approve the device: <code>openclaw devices list</code>, then <code>openclaw devices approve ${"<id>"}</code>. Two requests arrive one after the other: the device, then its node role. Axis retries every 10 seconds.</li>
            <li>Allow these under <code>gateway.nodes.commands.allow</code>: <code id="gw-commands">${commands.join(", ")}</code></li>
          </ol>
        </details>
      </div>
    </section>
    <section class="card" id="gw-mirrors">
      <div class="card-h"><h3>The agent's steps, questions and approvals on the devices</h3></div>
      ${saved
        ? html`<div class="card-b fgrid">
            <${F} label="Progress cards" dirty=${form.dirty("mirrorCards")}
              help="An agent on the linked OpenClaw gateway keeps a list of steps for long work. With this on, Axis shows it on the screens with no tool call: named after where you talk to the agent, waiting for you when the agent has stopped with steps left, and gone once it is done.">
              <${Switch} form=${form} k="mirrorCards" label="Show an OpenClaw agent's own step list as a task" />
            </${F}>
            <${F} label="Questions" dirty=${form.dirty("mirrorQuestions")}
              help="When an agent on the gateway asks you something, the device you last used shows it and says it, with the choices to tap or to say. While Home Assistant says you are away it goes to your phone as a notification. It can still be answered where it was asked.">
              <${Switch} form=${form} k="mirrorQuestions" label="Put an OpenClaw agent's questions to me on a device" />
            </${F}>
            <${F} label="Approvals" dirty=${form.dirty("mirrorApprovals")}
              help="When an agent needs your leave to run a command or use a tool, a device with a screen shows what it is, silently, with Allow once and Deny. Only a tap allows; a voice can only refuse. A standing permission is never given from here.">
              <${Switch} form=${form} k="mirrorApprovals" label="Offer approvals on a device" />
            </${F}>
            ${w
              ? html`<p class=${`help ${w.missing.length ? "msg warn" : ""}`} id="watch-state">${!w.missing.length
                  ? `The gateway lets Axis listen for these (${w.scopes.join(", ")}).`
                  : `Not working yet: the gateway has not granted Axis ${w.missing.join(" and ")}. It grants scopes when a pairing is approved, so pair again: make a setup code on the gateway (openclaw qr --setup-code-only --limited), paste it above, and approve the request there. Turns stop for the moment that takes.`}</p>`
              : null}
          </div>`
        : html`<div class="card-b"><${Loading} /></div>`}
    </section>
    <${SaveBar} entity=${entity} save=${save} floating />`;
}

// --- Tools and MCP (#tools) ----------------------------------------------------------------------

/** What each tool is for, in a line, for somebody deciding whether to leave it on. */
const TOOL_READS = {
  vortex_axis_say: "Speak or show a message on a device. The gateway's own notify command is this tool too.",
  vortex_axis_ask: "Ask the person a question and wait for the answer.",
  vortex_axis_timer: "Set, list and cancel timers.",
  vortex_axis_admin: "Run a device's actions, rename a device, make a pairing code.",
  vortex_axis_clients: "List the devices: names, locations, what each can do.",
  vortex_axis_config: "Read and change device settings such as volume.",
  vortex_axis_sense: "Read what a device reports about itself.",
  vortex_axis_progress: "Show, silently, how a long piece of the agent's work is going.",
  vortex_axis_session: "Point every device at another of the agent's conversations, and back.",
  vortex_axis_diag: "Check that Axis and its services are working.",
  vortex_axis_desktop: "Experimental, off until switched on: see, point at, click and type on a paired computer (the Windows desktop app). Clicking and typing can be switched off on that computer's page.",
};

export function ToolsPage() {
  const [d, load, error] = useLoad("/admin/mcp", 10_000);
  const [tryName, setTryName] = useState("");
  const [made, setMade] = useState("");
  const tokenName = useRef();
  const entity = "page:tools";
  const saved = d && {
    ...Object.fromEntries(d.tools.map((t) => [`tool:${t.name}`, t.enabled])),
    desktopBlocked: (d.desktopBlocked ?? []).join(", "),
    mcpPublic: d.public,
  };
  const form = useForm(entity, saved);
  if (!d) return html`<${Head} page="tools" />${error ? html`<p class="msg bad">${error}</p>` : html`<${Loading} />`}`;
  const apply = async (v, keys) => {
    const tools = Object.fromEntries([...keys].filter((k) => k.startsWith("tool:")).map((k) => [k.slice(5), Boolean(v[k])]));
    if (Object.keys(tools).length) await api("PATCH", "/admin/mcp/tools", tools);
    const rest = {};
    if (keys.has("desktopBlocked")) rest.desktopBlocked = v.desktopBlocked;
    if (keys.has("mcpPublic")) rest.mcpPublic = Boolean(v.mcpPublic);
    if (Object.keys(rest).length) await api("PATCH", "/admin/integrations", rest);
    await load();
  };
  const words = (staged) => {
    const keys = Object.keys(staged);
    if (keys.length === 1 && keys[0].startsWith("tool:")) return `${keys[0].slice(5)} is ${staged[keys[0]] ? "on" : "off"} for every agent.`;
    if (keys.length === 1 && keys[0] === "desktopBlocked") {
      const list = String(staged.desktopBlocked).split(",").map((s) => s.trim()).filter(Boolean);
      return list.length ? `Blocked: ${list.join(", ")}.` : "Nothing is blocked.";
    }
    return `${plural(keys.length, "change")} saved.`;
  };
  const save = () => saveForm(entity, saved, apply, { words });
  const url = `${location.origin}${d.path}`;
  const snippet = JSON.stringify({ mcpServers: { "vortex-axis": { type: "http", url, headers: { Authorization: "Bearer YOUR_TOKEN" } } } }, null, 2);
  const pick = (name) => {
    setTryName(name);
    requestAnimationFrame(() => document.querySelector("#try-tool")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  const makeToken = async () => {
    const r = await api("POST", "/admin/mcp/tokens", { name: tokenName.current.value });
    tokenName.current.value = "";
    setMade(r.token);
    await load();
  };
  const revoke = async (t) => {
    if (!(await ask({ title: `Revoke the token for ${t.name}?`, body: "Whatever uses it loses the tools at once.", confirm: "Revoke", danger: true }))) return;
    await api("DELETE", `/admin/mcp/tokens/${t.id}`);
    toast(`The token for ${t.name} is revoked.`);
    await load();
  };
  const publicHelp = d.publicHosts.length
    ? d.public
      ? `Agents can connect at https://${d.publicHosts[0]}${d.path} with a token. The admin page stays local.`
      : `Off: under ${d.publicHosts.join(", ")} the MCP address does not exist, like this admin page. Switch it on only for a harness that runs outside your network.`
    : "Axis has no public name, so it is reachable on the local network only.";
  return html`<${Head} page="tools" />
    <p class="help lead">What an agent can do through Axis. The same tools reach an agent two ways: the OpenClaw gateway gets them through the node link, and any other harness gets them by MCP, connecting to the address below with a token made here. Who answers turns is set under <a href="#agent">Who answers</a>.</p>
    <section class="card" id="tools-card">
      <div class="card-h"><h3>Tools</h3><span class="dim sm">A tool switched off is taken from every agent at once, by both ways in.</span></div>
      <div class="tablebox flat"><table class="t" id="tools-list"><tbody>
        ${d.tools.map((t) => {
          const on = Boolean(form.value(`tool:${t.name}`));
          return html`<tr key=${t.name} class=${`${on ? "" : "off"}${form.dirty(`tool:${t.name}`) ? " dirty" : ""}`}>
            <td class="tight"><input type="checkbox" class="switch" aria-label=${t.name} data-f=${`tool:${t.name}`} checked=${on} onChange=${(e) => form.put(`tool:${t.name}`, e.currentTarget.checked)} /></td>
            <td class="mono tight">${t.name}</td>
            <td class="dim">${TOOL_READS[t.name] ?? t.description}</td>
            <td class="acts"><button type="button" class="btn sm ghost" onClick=${() => pick(t.name)}>Try</button></td>
          </tr>`;
        })}
      </tbody></table></div>
    </section>
    <${TryTool} tools=${d.tools} name=${tryName || d.tools[0]?.name} onPick=${setTryName} />
    <section class="card" id="desktop-card">
      <div class="card-h"><h3>Apps the desktop tool may not use</h3></div>
      <div class="card-b fgrid">
        <${F} label="Blocked apps" id="desktop-blocked" dirty=${form.dirty("desktopBlocked")}
          help="Parts of app, window or process names, separated by commas, any case. A window whose name or title contains one is never read (a look says it is blocked, with nothing of what it shows) and nothing is clicked, dragged or typed there. The computer itself keeps a list too, on its page.">
          <${Text} form=${form} k="desktopBlocked" id="desktop-blocked" placeholder="bank, keepass, signal" />
        </${F}>
      </div>
    </section>
    <section class="card" id="mcp-card">
      <div class="card-h"><h3>Connect a harness by MCP</h3></div>
      <div class="card-b fgrid">
        <${F} label="Address" help=${'Give the harness this as a remote MCP server ("streamable HTTP") with a token below as its Bearer token. It is the address you are using this page at; a harness on another machine needs a name it can reach Axis by.'}>
          <div class="inline"><input class="field mono grow" id="mcp-url" readonly value=${url} /><button type="button" class="btn sm" onClick=${(e) => copy(url, e.currentTarget.previousElementSibling)}>Copy</button></div>
        </${F}>
        <${F} label="Outside the network" dirty=${form.dirty("mcpPublic")} help=${publicHelp}>
          <${Switch} form=${form} k="mcpPublic" label="Also answer under the public name" disabled=${!d.publicHosts.length} />
        </${F}>
        <${F} label="Settings to paste" help=${html`The shape most harnesses take. Put a token in place of <code>YOUR_TOKEN</code>.`}>
          <textarea class="field mono" id="mcp-snippet" rows="9" readonly spellcheck="false" value=${snippet}></textarea>
        </${F}>
      </div>
    </section>
    <section class="card" id="tokens-card">
      <div class="card-h"><h3>Tokens</h3><span class="dim sm">One for each harness, so one can be taken away without the others noticing.</span></div>
      <div class="card-b">
        <p class="help">A token lets its holder use every tool that is switched on.</p>
        ${d.tokens.length
          ? html`<div class="tablebox"><table class="t" id="mcp-tokens"><thead><tr><th>For</th><th>Made</th><th>Last used</th><th></th></tr></thead><tbody>
              ${d.tokens.map((t) => html`<tr key=${t.id}><td>${t.name}</td><td class="dim">${ago(t.createdAt)}</td><td class="dim">${t.lastUsedAt ? ago(t.lastUsedAt) : "never"}</td>
                <td class="acts"><${Button} class="btn sm danger" run=${() => revoke(t)}>Revoke</${Button}></td></tr>`)}
            </tbody></table></div>`
          : html`<p class="empty" id="mcp-tokens">No tokens yet, so nothing can connect by MCP.</p>`}
        <div class="inline add">
          <input class="field grow" id="mcp-token-name" placeholder="Name, such as the harness that will use it" maxlength="60" spellcheck="false" ref=${tokenName} />
          <${Button} class="btn primary" id="mcp-token-new" run=${makeToken}>Make a token</${Button}>
        </div>
        ${made
          ? html`<div class="newtoken" id="mcp-token-made">
              <p class="msg good">Copy it now. It is not shown again.</p>
              <div class="inline"><input class="field mono grow" id="mcp-token-value" readonly value=${made} /><button type="button" class="btn sm" onClick=${(e) => copy(made, e.currentTarget.previousElementSibling)}>Copy</button><button type="button" class="btn sm ghost" onClick=${() => setMade("")}>Done</button></div>
            </div>`
          : null}
      </div>
    </section>
    <${SaveBar} entity=${entity} save=${save} floating />`;
}

/** What an empty "Send to" means for each tool, in the tool's own terms. */
const TRY_NO_TARGET = {
  vortex_axis_sense: "Every device",
  vortex_axis_admin: "Every device (for actions)",
  vortex_axis_config: "Choose a device",
  vortex_axis_desktop: "The computer (when there is one)",
};
const TRY_TARGETS = new Set(["client", "location", "everywhere"]);

/** The arguments the form would send. */
function tryArgs(tool, target, raw) {
  const props = tool?.parameters?.properties ?? {};
  const args = {};
  if (props.client || props.location) {
    const [kind, ...rest] = target.split(":");
    if (kind === "everywhere") args.everywhere = true;
    if (kind === "client") args.client = rest.join(":");
    if (kind === "location") {
      args.location = rest.join(":");
      if (props.everywhere) args.everywhere = true;
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    if (TRY_TARGETS.has(key)) continue;
    const v = raw[key];
    let out;
    if (spec.type === "boolean") out = v ? true : undefined;
    else if (v === undefined || v === "") out = undefined;
    else if (spec.enum) out = v;
    else if (spec.type === "number" || spec.type === "integer") out = Number(v);
    else if (spec.type === "array") {
      const list = String(v).split("\n").map((x) => x.trim()).filter(Boolean);
      out = list.length ? list : undefined;
    } else if (spec.type === undefined) {
      // Any value: true, false, null and numbers are taken as such, anything else as text.
      try {
        const j = JSON.parse(v);
        out = j === null || ["number", "boolean"].includes(typeof j) ? j : v;
      } catch {
        out = v;
      }
    } else out = String(v).trim() || undefined;
    if (out !== undefined) args[key] = out;
  }
  return args;
}

function TryTool({ tools, name, onPick }) {
  const tool = tools.find((t) => t.name === name);
  const [target, setTarget] = useState("");
  const [raw, setRaw] = useState({});
  const [result, setResult] = useState();
  const [m, setM] = useState();
  useEffect(() => {
    setTarget("");
    setRaw({});
    setResult();
    setM();
  }, [name]);
  const props = tool?.parameters?.properties ?? {};
  const required = tool?.parameters?.required ?? [];
  const args = tryArgs(tool, target, raw);
  const places = [...new Set(store.clients.map((c) => String(c.settings.location ?? "").trim()).filter(Boolean))].sort();
  const all = Boolean(props.everywhere);
  const put = (key, v) => setRaw((r) => ({ ...r, [key]: v }));
  const run = async () => {
    if (name === "vortex_axis_admin" && args.action === "run" && /reboot|reset/i.test(String(args.run ?? ""))) {
      if (!(await ask({ title: `Run ${args.run} on ${args.client ?? "the device"}?`, body: "It restarts.", confirm: `Run ${args.run}`, danger: true }))) return;
    }
    const missing = required.filter((key) => args[key] === undefined);
    if (missing.length) return setM({ kind: "bad", text: `Fill in ${missing.join(" and ")} first.` });
    setM({ text: name === "vortex_axis_ask" ? "Waiting for an answer on the device…" : "Running…" });
    setResult();
    try {
      const got = await api("POST", "/admin/mcp/tools/try", { name, arguments: args });
      setM(got.ok ? { kind: "good", text: `Done in ${got.ms} ms.` } : { kind: "bad", text: `Refused after ${got.ms} ms.` });
      setResult(got.ok ? JSON.stringify(got.result, null, 2) : got.error);
    } catch (e) {
      setM({ kind: "bad", text: e.message });
    }
  };
  const field = (key, spec) => {
    const v = raw[key] ?? "";
    if (spec.enum) return html`<select class="field" value=${v} onChange=${(e) => put(key, e.currentTarget.value)}><option value="">(default)</option>${spec.enum.map((x) => html`<option key=${x} value=${x}>${x}</option>`)}</select>`;
    if (spec.type === "boolean") return html`<label class="switch-l"><input type="checkbox" class="switch" checked=${Boolean(raw[key])} onChange=${(e) => put(key, e.currentTarget.checked)} /><span>yes</span></label>`;
    if (spec.type === "number" || spec.type === "integer") return html`<input class="field num" type="number" step=${spec.type === "integer" ? "1" : "any"} value=${v} onInput=${(e) => put(key, e.currentTarget.value)} />`;
    if (spec.type === "array") return html`<textarea class="field" rows="3" spellcheck="false" placeholder="One to a line" value=${v} onInput=${(e) => put(key, e.currentTarget.value)}></textarea>`;
    if (spec.type === undefined) return html`<input class="field mono" spellcheck="false" placeholder="text, a number, true, false or null" value=${v} onInput=${(e) => put(key, e.currentTarget.value)} />`;
    return key === "text" || key === "question" || key === "note"
      ? html`<textarea class="field" rows="2" value=${v} onInput=${(e) => put(key, e.currentTarget.value)}></textarea>`
      : html`<input class="field" spellcheck="false" value=${v} onInput=${(e) => put(key, e.currentTarget.value)} />`;
  };
  const fields = Object.entries(props).filter(([key]) => !TRY_TARGETS.has(key));
  return html`<section class="card" id="try-card">
    <div class="card-h"><h3>Try a tool</h3></div>
    <div class="card-b">
      <p class="help">Calls a tool just as an agent would, through the same switch above, and shows what the agent would get back. It does it for real: a message is said, a timer is set, a reboot restarts the device. Where a tool can reach more than one device, pick one first.</p>
    </div>
    <div class="card-b fgrid" id="try-fields">
      <${F} label="Tool" id="try-tool" help=${tool ? (tool.enabled ? tool.description : `Switched off, so it will be refused, as it would be for an agent. ${tool.description}`) : ""}>
        <select class="field" id="try-tool" value=${name} onChange=${(e) => onPick(e.currentTarget.value)}>${tools.map((t) => html`<option key=${t.name} value=${t.name}>${t.name}</option>`)}</select>
      </${F}>
      ${props.client || props.location
        ? html`<${F} label="Send to">
            <select class="field" data-try="target" value=${target} onChange=${(e) => setTarget(e.currentTarget.value)}>
              <option value="">${TRY_NO_TARGET[name] ?? "The device last spoken to"}</option>
              ${all ? html`<option value="everywhere">Every device</option>` : null}
              ${props.location ? places.map((p) => html`<option key=${p} value=${`location:${p}`}>${all ? `Every device in ${p}` : `A device in ${p}`}</option>`) : null}
              ${store.clients.map((c) => html`<option key=${c.id} value=${`client:${c.name}`}>${c.name}${c.online ? "" : " (offline)"}</option>`)}
            </select>
          </${F}>`
        : null}
      ${fields.map(([key, spec]) => html`<${F} key=${`${name}:${key}`} label=${`${key}${required.includes(key) ? " *" : ""}`} help=${spec.description}><div data-try=${key}>${field(key, spec)}</div></${F}>`)}
      ${!fields.length && !(props.client || props.location) ? html`<p class="help">This tool takes nothing.</p>` : null}
      <${F} label="Sends"><code class="mono" id="try-args">${JSON.stringify(args)}</code></${F}>
      <div class="f"><span class="f-l"></span><div class="f-c">
        <p class="btnrow"><${Button} class="btn primary" id="try-run" run=${run}>Try it</${Button}></p>
        <${Note} m=${m} id="try-note" />
      </div></div>
    </div>
    ${result !== undefined ? html`<div class="card-b" id="try-result"><pre class="mono tryout">${result}</pre></div>` : null}
  </section>`;
}

// --- Speech (#speech) ----------------------------------------------------------------------------

export function SpeechPage() {
  const config = useConfig();
  const [talk, loadTalk] = useLoad("/admin/talk");
  const [m, setM] = useState();
  const [tm, setTm] = useState();
  const entity = "page:speech";
  const saved = config && {
    sttUrl: config.stt.url, sttModel: config.stt.model, sttKey: "",
    ttsUrl: config.tts.url, ttsModel: config.tts.model, ttsKey: "", ttsVoice: config.tts.voice, ttsRate: config.tts.sampleRate,
    ...(talk?.available ? { voiceMode: talk.mode === "realtime" ? "realtime" : "local", voiceProvider: talk.provider ?? "" } : {}),
  };
  const form = useForm(entity, saved);
  if (!config) return html`<${Head} page="speech" /><${Loading} />`;
  const apply = async (v, keys) => {
    if ([...keys].some((k) => k.startsWith("stt") || k.startsWith("tts"))) {
      const rate = Number(v.ttsRate);
      if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) throw new Error("The PCM sample rate is a whole number from 8000 to 48000.");
      set({
        config: await api("PATCH", "/admin/config", {
          stt: { url: String(v.sttUrl).trim(), model: String(v.sttModel).trim(), ...(v.sttKey ? { apiKey: v.sttKey } : {}) },
          tts: { url: String(v.ttsUrl).trim(), model: String(v.ttsModel).trim(), voice: String(v.ttsVoice).trim(), sampleRate: rate, ...(v.ttsKey ? { apiKey: v.ttsKey } : {}) },
        }),
      });
    }
    const values = {};
    if (keys.has("voiceMode")) values.voiceMode = v.voiceMode === "realtime" ? "realtime" : null;
    if (keys.has("voiceProvider")) values.voiceProvider = v.voiceProvider || null;
    if (Object.keys(values).length) {
      await api("PATCH", "/admin/settings/global", { values });
      await loadTalk();
      refresh();
    }
  };
  const save = () => saveForm(entity, saved, apply, { secrets: ["sttKey", "ttsKey"] });
  const unsavedService = Object.keys(form.staged).some((k) => k.startsWith("stt") || k.startsWith("tts"));
  const test = async () => {
    setM({ text: "Synthesizing a sentence and transcribing it back…" });
    try {
      const r = await api("POST", "/admin/config/test");
      const tts = r.tts.ok ? `Synthesis: first audio after ${r.tts.firstAudioMs} ms, ${r.tts.audioSeconds} s of audio.` : `Synthesis failed: ${r.tts.error}.`;
      const stt = r.stt.ok
        ? r.stt.heard !== undefined ? `Recognition: ${r.stt.ms} ms, heard "${r.stt.heard}" (said "${r.said}").` : "Recognition answers, but there was no audio to try it with."
        : `Recognition failed: ${r.stt.error}.`;
      setM({ kind: r.tts.ok && r.stt.ok ? "good" : "bad", text: `${tts} ${stt}` });
    } catch (e) {
      setM({ kind: "bad", text: e.message });
    }
  };
  const tryVoice = async () => {
    setTm({ text: "Opening a session with the voice…" });
    try {
      const r = await api("POST", "/admin/talk/test", { provider: form.value("voiceProvider") ?? "" });
      setTm(r.ok ? { kind: "good", text: `It works: the voice answered in ${r.ms} ms.` } : { kind: "bad", text: `It does not work: ${r.message}.` });
    } catch (e) {
      setTm({ kind: "bad", text: e.message });
    }
  };
  const talkState = !talk ? null : talk.available ? html`<${Stat} label=${talk.mode === "realtime" ? "in use" : "ready"} kind=${talk.mode === "realtime" ? "good" : ""} />` : html`<${Stat} label="needs OpenClaw" />`;
  const own = (talk?.overrides ?? []).map((o) => `${o.name} (${o.mode})`).join(", ");
  const realtime = form.value("voiceMode") === "realtime";
  const providers = talk?.available
    ? [["", "the gateway's choice"], ...talk.providers.map((p) => [p.id, p.label === p.id ? p.id : `${p.label} (${p.id})`]),
       // A provider typed in by hand, or with a model named after it, is still shown as what is set.
       ...(talk.provider && !talk.providers.some((p) => p.id === talk.provider) ? [[talk.provider, talk.provider]] : [])]
    : [];
  return html`<${Head} page="speech" />
    <p class="help lead">Custom STT/TTS: OpenAI-style endpoints, such as the local ones that run beside Axis (<code>http://vortex-axis-stt:8000/v1/audio/transcriptions</code> and <code>http://vortex-axis-tts:8000/v1/audio/speech</code>). Keys are kept on the hub and never shown again.</p>
    <div class="two">
      <section class="card" id="stt-card">
        <div class="card-h"><h3>Speech to text</h3>${store.status ? html`<${Stat} label=${store.status.upstream.stt === "up" ? "answering" : store.status.upstream.stt === "down" ? "down" : "not tried"} kind=${store.status.upstream.stt === "up" ? "good" : store.status.upstream.stt === "down" ? "bad" : ""} />` : null}</div>
        <div class="card-b fgrid">
          <${F} label="Address" id="stt-url" dirty=${form.dirty("sttUrl")}><${Text} form=${form} k="sttUrl" id="stt-url" mono placeholder="http://host:8090/v1/audio/transcriptions" /></${F}>
          <${F} label="Model" id="stt-model" dirty=${form.dirty("sttModel")}><${Text} form=${form} k="sttModel" id="stt-model" /></${F}>
          <${F} label=${html`Key ${config.stt.apiKeySet ? html`<span class="badge">set</span>` : null}`} id="stt-key" dirty=${form.dirty("sttKey")}><${Text} form=${form} k="sttKey" id="stt-key" type="password" placeholder="leave empty to keep" /></${F}>
        </div>
      </section>
      <section class="card" id="tts-card">
        <div class="card-h"><h3>Text to speech</h3>${store.status ? html`<${Stat} label=${store.status.upstream.tts === "up" ? "answering" : store.status.upstream.tts === "down" ? "down" : "not tried"} kind=${store.status.upstream.tts === "up" ? "good" : store.status.upstream.tts === "down" ? "bad" : ""} />` : null}</div>
        <div class="card-b fgrid">
          <${F} label="Address" id="tts-url" dirty=${form.dirty("ttsUrl")}><${Text} form=${form} k="ttsUrl" id="tts-url" mono placeholder="http://host:8092/v1/audio/speech" /></${F}>
          <${F} label="Model" id="tts-model" dirty=${form.dirty("ttsModel")}><${Text} form=${form} k="ttsModel" id="tts-model" /></${F}>
          <${F} label=${html`Key ${config.tts.apiKeySet ? html`<span class="badge">set</span>` : null}`} id="tts-key" dirty=${form.dirty("ttsKey")}><${Text} form=${form} k="ttsKey" id="tts-key" type="password" placeholder="leave empty to keep" /></${F}>
          <${F} label="Default voice" id="tts-voice" dirty=${form.dirty("ttsVoice")}><${Text} form=${form} k="ttsVoice" id="tts-voice" placeholder="service default" /></${F}>
          <${F} label="PCM sample rate" id="tts-rate" dirty=${form.dirty("ttsRate")}><span class="unit"><${Text} form=${form} k="ttsRate" id="tts-rate" type="number" min="8000" max="48000" step="1" class="field num" /><span>Hz</span></span></${F}>
        </div>
      </section>
    </div>
    <section class="card" id="speech-test-card">
      <div class="card-h"><h3>Test both</h3><${Button} class="btn sm" id="speech-test" run=${test}>Test both</${Button}></div>
      <div class="card-b">
        <p class="help">Synthesizes a sentence with what is saved, then transcribes it back.${unsavedService ? " Save first to try the changes above." : ""}</p>
        <${Note} m=${m} id="speech-note" />
      </div>
    </section>
    <section class="card" id="talk-card">
      <div class="card-h"><h3>Realtime voice</h3><span id="talk-state">${talkState}</span></div>
      <div class="card-b">
        <p class="help">A second way to answer what is said, in place of the custom STT/TTS above. What a device hears goes through the OpenClaw gateway to a realtime voice model, which answers in its own voice and hands real work to the agent.</p>
        ${talk && !talk.available
          ? html`<p class="msg" id="talk-note">This needs an OpenClaw gateway as the agent, connected. With another agent, or none, devices use the custom STT/TTS above.</p>`
          : null}
      </div>
      ${talk?.available
        ? html`<div class="card-b fgrid" id="talk-body">
            <${F} label="Devices use" dirty=${form.dirty("voiceMode")}
              help=${(realtime ? "Every device is answered by the realtime voice" : "Every device is answered the usual way") + (own ? `, except those set otherwise on their own page: ${own}.` : ". One device can be set differently on its own page, under Who hears and speaks.")}>
              <${Seg} form=${form} k="voiceMode" label="Who hears and speaks" options=${[["local", "Custom STT/TTS"], ["realtime", "Realtime voice"]]} />
            </${F}>
            <${F} label="Voice from" id="talk-provider" dirty=${form.dirty("voiceProvider")}
              help="The realtime voices the gateway offers. Try it opens a session and closes it again: the gateway lists a voice before its credentials have been tried, so this is how to know one works.">
              <div class="inline">
                <select class="field" id="talk-provider" data-f="voiceProvider" value=${form.value("voiceProvider") ?? ""} onChange=${(e) => form.put("voiceProvider", e.currentTarget.value)}>
                  ${providers.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
                </select>
                <${Button} class="btn sm" id="talk-test" run=${tryVoice}>Try it</${Button}>
              </div>
              ${talk.error ? html`<p class="msg warn">The gateway would not list its voices: ${talk.error}</p>` : null}
              <${Note} m=${tm} id="talk-note" />
            </${F}>
          </div>`
        : null}
    </section>
    <p class="help">Telling voices apart is under <a href="#voices">Voices</a>.</p>
    <${SaveBar} entity=${entity} save=${save} floating />`;
}

// --- Voices (#voices) ----------------------------------------------------------------------------

const VERDICTS = { known: "good", guest: "bad", unsure: "warn" };
const verdictText = (who) =>
  !who ? "" : who.untaught ? "nothing taught yet" : `${who.verdict === "known" ? who.name : who.verdict}${who.score !== undefined ? ` ${who.score.toFixed(2)}` : ""}${who.verdict === "unsure" && who.as === "guest" ? " (taken for a guest)" : ""}`;

/** Records `seconds` of the microphone as 16-bit PCM. Resolves with the bytes and their sample rate. */
async function recordMic(seconds) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This page cannot use the microphone here: open it on https or localhost.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    await context.audioWorklet.addModule("/web/pcm-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "pcm-capture");
    const parts = [];
    node.port.onmessage = (event) => parts.push(event.data);
    source.connect(node);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    source.disconnect();
    const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) for (const x of part) pcm[at++] = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    return { pcm, rate: context.sampleRate };
  } finally {
    for (const track of stream.getTracks()) track.stop();
    context.close();
  }
}

/** Sends a recording to an admin address that takes raw PCM. */
async function sendRecording(path, { pcm, rate }) {
  const res = await fetch(`${path}?rate=${rate}`, { method: "POST", headers: { ...authHeader(), "content-type": "application/octet-stream" }, body: pcm.buffer });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// While the microphone records, the lists are not read again under the button counting down.
const recording = { current: false };

/** A button that records `seconds` with a countdown on it, sends it to `path`, and hands the answer to `done`. */
function RecordButton({ seconds, path, label, done, onError, id }) {
  const [left, setLeft] = useState(0);
  const go = async () => {
    recording.current = true;
    setLeft(seconds);
    const tick = setInterval(() => setLeft((n) => Math.max(1, n - 1)), 1000);
    try {
      await done(await sendRecording(path, await recordMic(seconds)));
    } catch (e) {
      onError(e.message);
    } finally {
      clearInterval(tick);
      recording.current = false;
      setLeft(0);
    }
  };
  return html`<button type="button" class="btn sm" id=${id} disabled=${left > 0} onClick=${go}>${left ? `Speak… ${left}` : label}</button>`;
}

export function VoicesPage() {
  const [d, load, error] = useLoad("/admin/voices", 3000, recording);
  const agents = useAgents();
  const nameField = useRef();
  const [m, setM] = useState();
  const entity = "page:voices";
  const s = d?.settings;
  const saved = s && {
    enabled: s.enabled, url: d.service.url, knownAt: s.knownAt, guestBelow: s.guestBelow, unsure: s.unsure, guests: s.guests,
    guestAgent: s.guestAgent, guestNote: s.guestNote || d.defaultGuestNote, declineText: s.declineText,
  };
  const form = useForm(entity, saved);
  if (!d) return html`<${Head} page="voices" />${error ? html`<p class="msg bad">${error}</p>` : html`<${Loading} />`}`;
  const apply = async (v, keys) => {
    for (const k of ["knownAt", "guestBelow"]) {
      const n = Number(v[k]);
      if (v[k] === "" || !(n >= 0 && n <= 1)) throw new Error(`${k === "knownAt" ? "Known from" : "Guest below"} is a score from 0 to 1.`);
    }
    if (keys.has("url")) set({ config: await api("PATCH", "/admin/config", { voiceprint: { url: String(v.url).trim() } }) });
    if ([...keys].some((k) => k !== "url")) {
      await api("PATCH", "/admin/voices", {
        enabled: Boolean(v.enabled), unsure: v.unsure, knownAt: Number(v.knownAt), guestBelow: Number(v.guestBelow), guests: v.guests,
        guestAgent: v.guestAgent || "", guestNote: builtIn(v.guestNote, d.defaultGuestNote), declineText: v.declineText,
      });
    }
    await load();
  };
  const save = () => saveForm(entity, saved, apply);
  const say = (text, kind = "good") => setM({ text, kind });
  const guests = form.value("guests");
  const state = !s.enabled ? html`<${Stat} label="off" />` : d.service.up ? html`<${Stat} label=${d.voices.some((v) => v.samples) ? "on" : "on, nothing taught"} kind="good" />` : html`<${Stat} label="service down" kind="bad" />`;
  const agentOptions = agents?.length ? agents : [s.guestAgent].filter(Boolean);
  const forgetSample = async (v, x) => {
    if (!(await ask({ title: `Forget this recording of ${v.name}?`, body: `${x.source === "turn" ? "From a device" : "Recorded here"}, ${x.seconds} s, ${ago(x.at)}.`, confirm: "Forget it", danger: true }))) return;
    await api("DELETE", `/admin/voices/samples/${x.id}`);
    await load();
  };
  const forget = async (v) => {
    if (!(await ask({ title: `Forget ${v.name}'s voice?`, body: "Every recording of it goes too.", confirm: "Forget", danger: true }))) return;
    await api("DELETE", `/admin/voices/${v.id}`);
    toast(`${v.name}'s voice is forgotten.`);
    await load();
  };
  const add = async () => {
    await api("POST", "/admin/voices", { name: nameField.current.value });
    nameField.current.value = "";
    await load();
  };
  const teach = async (v, r) => {
    await api("POST", `/admin/voices/${v.id}/samples`, { turnId: r.turnId });
    say(`That turn now helps tell ${v.name}'s voice.`);
    await load();
  };
  return html`<${Head} page="voices" />
    <section class="card" id="vp-card">
      <div class="card-h"><h3>Voice recognition</h3><span id="vp-state">${state}</span></div>
      <div class="card-b"><p class="help">Tells the voices it was taught from everybody else's, roughly, from a voiceprint of what a device heard. The agent is told whose voice it was on the line that describes the device, and a guest's turn can go somewhere else.</p></div>
      <div class="card-b fgrid">
        <${F} label="Tell voices apart" dirty=${form.dirty("enabled")}><${Seg} form=${form} k="enabled" label="Tell voices apart" options=${[[false, "Off"], [true, "On"]]} /></${F}>
        <${F} label="Voiceprint service" id="vp-url" dirty=${form.dirty("url")} help=${d.service.url ? (d.service.up ? "Answering." : "Not answering.") : "Not set: nothing is told apart."}>
          <${Text} form=${form} k="url" id="vp-url" mono placeholder="http://vortex-axis-voiceprint:8000/v1/speaker/embed" />
        </${F}>
        <${F} label="Known from" id="vp-known" dirty=${form.dirty("knownAt")} help="A score from this up is the voice it matched. Scores run from 0 (nothing alike) to 1 (the same recording).">
          <${Text} form=${form} k="knownAt" id="vp-known" type="number" min="0" max="1" step="0.05" class="field num" />
        </${F}>
        <${F} label="Guest below" id="vp-guest" dirty=${form.dirty("guestBelow")} help="A score under this is a guest. Between the two it is unsure.">
          <${Text} form=${form} k="guestBelow" id="vp-guest" type="number" min="0" max="1" step="0.05" class="field num" />
        </${F}>
        <${F} label="When unsure" dirty=${form.dirty("unsure")}><${Seg} form=${form} k="unsure" label="When unsure" options=${[["known", "Take it for a known voice"], ["guest", "Take it for a guest"]]} /></${F}>
        <${F} label="A guest's turn" id="vp-guests" dirty=${form.dirty("guests")} help=${'Start with "only labelled" and watch Heard lately for a few days before letting it change anything. A guest is always answered with the custom STT/TTS, never the realtime voice.'}>
          <select class="field" id="vp-guests" data-f="guests" value=${guests} onChange=${(e) => form.put("guests", e.currentTarget.value)}>
            <option value="label">goes as usual, only labelled</option>
            <option value="guest">goes to the same agent, in a guest conversation</option>
            <option value="agent">goes to another agent, in a guest conversation</option>
            <option value="decline">is turned away</option>
          </select>
        </${F}>
        <${F} hidden=${guests !== "agent"} label="Guest agent" id="vp-agent" dirty=${form.dirty("guestAgent")}>
          <select class="field" id="vp-agent" data-f="guestAgent" value=${form.value("guestAgent") ?? ""} onChange=${(e) => form.put("guestAgent", e.currentTarget.value)}>
            ${agentOptions.length ? agentOptions.map((id) => html`<option key=${id} value=${id}>${id}</option>`) : html`<option value="">no agents listed</option>`}
          </select>
        </${F}>
        <${F} hidden=${guests !== "guest" && guests !== "agent"} label="What a guest's agent is told" id="vp-note" dirty=${form.dirty("guestNote")}>
          <${Text} form=${form} k="guestNote" id="vp-note" area rows=${4} />
        </${F}>
        <${F} hidden=${guests !== "decline"} label="Said to a guest" id="vp-decline" dirty=${form.dirty("declineText")}>
          <${Text} form=${form} k="declineText" id="vp-decline" maxlength="300" />
        </${F}>
      </div>
    </section>
    <section class="card" id="vp-voices-card">
      <div class="card-h"><h3>Voices</h3><span class="dim sm">${plural(d.voices.length, "voice")} taught</span></div>
      <div class="card-b">
        <p class="help">Teach a voice with a few recordings: five or more, said the way it is used, ideally some from a device across the room (pick them under Heard lately). Recording here needs the page on https or localhost. ◆ came from a device, ● was recorded here; click one to forget it.</p>
        ${d.voices.length
          ? html`<div class="tablebox"><table class="t" id="vp-voices"><tbody>${d.voices.map((v) => html`<tr key=${v.id}>
              <td><b class="vname">${v.name}</b></td>
              <td>${plural(v.samples, "recording")}, ${v.seconds} s
                ${v.list.length ? html`<span class="samples">${v.list.map((x) => html`<button type="button" key=${x.id} class="sample" title=${`${x.source === "turn" ? "From a device" : "Recorded here"}, ${x.seconds} s, ${ago(x.at)}. Click to forget it.`} aria-label=${`Forget a recording of ${v.name}`} onClick=${() => forgetSample(v, x).catch((e) => say(e.message, "bad"))}>${x.source === "turn" ? "◆" : "●"}</button>`)}</span>` : null}</td>
              <td class="acts">
                <${RecordButton} seconds=${5} path=${`/admin/voices/${v.id}/samples`} label="Record 5 s" onError=${(t) => say(t, "bad")} done=${async (r) => (say(`Learnt ${r.seconds} s of ${v.name}'s voice.`), await load())} />
                <${Button} class="btn sm danger" run=${() => forget(v)}>Forget</${Button}>
              </td></tr>`)}</tbody></table></div>`
          : html`<p class="empty" id="vp-voices">No voice taught yet. Add one, then record it or pick its turns under Heard lately.</p>`}
        <div class="inline add">
          <input class="field grow" id="vp-name" placeholder="Name, such as the person's" maxlength="40" spellcheck="false" ref=${nameField} />
          <${Button} class="btn" id="vp-add" run=${add}>Add a voice</${Button}>
          <${RecordButton} id="vp-check" seconds=${4} path="/admin/voices/check" label="Check my voice (4 s)" onError=${(t) => say(t, "bad")}
            done=${async (r) => {
              const scores = r.scores.map((x) => `${x.name} ${x.score.toFixed(2)}`).join(", ");
              say(`Taken for: ${verdictText(r.identity)}.${scores ? ` Scores: ${scores}.` : ""}`, VERDICTS[r.identity.verdict] ?? "");
            }} />
        </div>
        <${Note} m=${m} id="vp-voices-msg" />
      </div>
    </section>
    <section class="card" id="vp-recent-card">
      <div class="card-h"><h3>Heard lately</h3><span class="dim sm">the last ten minutes</span></div>
      <div class="card-b">
        <p class="help">Spoken turns from the last ten minutes, with whose voice each was taken for. A turn can teach a voice from here; after ten minutes it is gone.</p>
        ${d.recent.length
          ? html`<div class="tablebox"><table class="t" id="vp-recent"><tbody>${d.recent.map((r) => html`<tr key=${r.turnId}>
              <td class="dim">${clock(r.at)}</td><td>${r.client}</td><td class="dim">${r.seconds} s</td>
              <td><${Stat} label=${verdictText(r.identity)} kind=${r.identity.untaught ? "" : VERDICTS[r.identity.verdict]} /></td>
              <td class="acts">${d.voices.map((v) => html`<${Button} key=${v.id} class="btn sm ghost" run=${() => teach(v, r)}>That was ${v.name}</${Button}>`)}</td></tr>`)}</tbody></table></div>`
          : html`<p class="empty" id="vp-recent">${s.enabled ? "Nothing said in the last ten minutes." : "Switch it on to see whose voice each turn is in."}</p>`}
      </div>
    </section>
    <${SaveBar} entity=${entity} save=${save} floating />`;
}
