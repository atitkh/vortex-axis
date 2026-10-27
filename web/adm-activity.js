// The Overview dashboard and the Activity area (docs/admin-revamp/ia.md 2.1): what needs attention, the day's numbers,
// the devices, what is running now, Say something; Live (the stream from GET /admin/live) and History (charts.js).

import { html, useEffect, useMemo, useRef, useState } from "/web/preact.js";
import { clock, columnChart, duration, hideTip, lineChart, ms, partsBar, percent, stateLegend, strip, stripAxis } from "/web/charts.js";
import { Button, api, ago, authHeader, deviceHref, enc, plural, refresh, set, signOut, store, toast } from "/web/adm-core.js";
import { DeviceCard } from "/web/adm-devices.js";
import { AttentionList, Icon, PageHead } from "/web/adm-shell.js";

// --- shared bits --------------------------------------------------------------------------------

/** Redraws every `every` ms while mounted (countdowns, running steps). */
function useTick(every, when = true) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!when) return;
    const t = setInterval(() => force((n) => n + 1), every);
    return () => clearInterval(t);
  }, [every, when]);
}

/** Axis's clock: the poll's `now.at` corrected for the browser's own. */
const hubNow = () => Date.now() + (store.nowSkew ?? 0);

function countdown(ms) {
  const left = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(left / 3600), minutes = Math.floor((left % 3600) / 60), seconds = String(left % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

const Stat = ({ label, kind = "" }) => html`<span class=${`badge ${kind}`}>${label}</span>`;
const DevLink = ({ id, name }) => html`<a href=${deviceHref(id)}>${name}</a>`;

/** A DOM element for charts.js's neighbours; text only ever as text. */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined) node.setAttribute(k, v);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

const activityCache = {};
/** GET /admin/activity for `hours`, kept 10 s, reloaded every 30 s while shown. The 24 h one also feeds the attention list. */
function useActivity(hours) {
  const [state, setState] = useState(() => ({ hours, data: activityCache[hours]?.data ?? (hours === 24 ? store.activity : undefined) }));
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const kept = activityCache[hours];
      if (kept && Date.now() - kept.at < 10_000) return setState({ hours, data: kept.data });
      setLoading(true);
      try {
        const data = await api("GET", `/admin/activity?hours=${hours}`);
        activityCache[hours] = { at: Date.now(), data };
        if (hours === 24) set({ activity: data });
        if (live) setState({ hours, data });
      } catch {
        // The last figures stay; the poll's error shows in the header.
      }
      if (live) setLoading(false);
    };
    load();
    const t = setInterval(() => document.hidden || load(), 30_000);
    return () => ((live = false), clearInterval(t));
  }, [hours]);
  return { data: state.data, stale: loading || state.hours !== hours };
}

const rangeWords = (hours) => (hours === 24 ? "24 hours" : hours === 72 ? "3 days" : "7 days");

/** The day's numbers: as the classic Overview's tiles. */
function Kpis({ data, hours }) {
  const s = store.status;
  const online = store.clients.filter((c) => c.online).length;
  const t = data?.turns;
  const span = rangeWords(hours);
  const kpi = (label, value, detail, kind = "", unit = "") => html`<div class=${`kpi ${kind}`}><div class="l">${label}</div><div class="v">${value}${unit ? html`<small> ${unit}</small>` : null}</div>${detail ? html`<div class="d">${detail}</div>` : null}</div>`;
  const [p50, p50unit] = t && t.firstAudioP50 !== null ? splitUnit(ms(t.firstAudioP50)) : ["–", ""];
  return html`<div class="kpis five" id="kpis">
    ${kpi("Axis running for", s?.uptimeMs !== undefined ? duration(s.uptimeMs) : "–", data ? `up ${percent(data.axis.availability)} of the last ${span}` : null)}
    ${kpi("Devices online", html`${online} <small>of ${store.clients.length}</small>`, store.clients.length - online ? `${store.clients.length - online} offline` : "all of them", online < store.clients.length ? "warn" : "")}
    ${kpi(`Turns, last ${span}`, t ? String(t.count) : "–", t?.count ? `${t.answered} answered · ${t.heard} heard to the end` : null)}
    ${kpi("Failed", t ? String(t.failed) : "–", t?.interrupted ? `${t.interrupted} interrupted` : null, t?.failed ? "bad" : "")}
    ${kpi("Time to first sound", p50, t && t.firstAudioP95 !== null ? `slowest 5 %: ${ms(t.firstAudioP95)}` : "no turns yet", "", p50unit)}
  </div>`;
}
const splitUnit = (text) => (/^(.*) (\S+)$/.exec(text) ?? [text, text, ""]).slice(1);

/** Uptime strips: Axis, the services (gateway links only when they matter), the devices. One time axis below. */
function uptimeRows(data, { devices = true, onlyTrouble = false } = {}) {
  const usesGateway = store.config?.agent?.backend !== "openai";
  const rows = [
    { label: "Axis", segments: data.axis.segments, availability: data.axis.availability },
    ...data.services
      .filter((s) => !["operator", "node"].includes(s.key) || usesGateway || s.segments.some((g) => g.state !== "unconfigured" && g.state !== "unknown" && g.state !== "axis_down"))
      .map((s) => ({ label: s.label, segments: s.segments, availability: s.availability, href: s.key === "stt" || s.key === "tts" ? "#speech" : usesGateway ? "#openclaw" : "#agent" })),
  ];
  if (devices)
    rows.push(
      ...data.clients
        .filter((c) => !onlyTrouble || (c.availability ?? 1) < 0.999)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({ label: c.name, segments: c.segments, availability: c.availability, href: deviceHref(c.id) })),
    );
  return rows;
}

function Strips({ data, devices, onlyTrouble }) {
  const node = useMemo(() => {
    if (!data) return undefined;
    hideTip();
    const rows = uptimeRows(data, { devices, onlyTrouble });
    return el("div", { class: "strips" },
      ...rows.map((r) =>
        el("div", { class: "strip-row" },
          el("div", { class: "strip-name" }, r.href ? el("a", { href: r.href }, r.label) : r.label),
          el("div", { class: "strip-cell" }, strip(r.segments, data.from, data.to)),
          el("div", { class: "strip-avail", title: "Share of the recorded time it was working" }, percent(r.availability)),
        )),
      el("div", { class: "strip-row" }, el("div", {}), stripAxis(data.from, data.to), el("div", {})),
      stateLegend(rows.flatMap((r) => r.segments.map((s) => s.state))),
    );
  }, [data, devices, onlyTrouble, store.config?.agent?.backend]);
  return html`<${DomNode} node=${node} id="strips" />`;
}

function DomNode({ node, id }) {
  const ref = useRef();
  useEffect(() => {
    ref.current.replaceChildren(...(node ? [node] : []));
  }, [node]);
  return html`<div id=${id} ref=${ref}></div>`;
}

/** A chart drawn by charts.js to the width it has, drawn again when that changes. */
function Chart({ id, build, data }) {
  const ref = useRef();
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(() => setWidth(Math.round(ref.current?.clientWidth ?? 0)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!width || !data) return;
    hideTip();
    ref.current.replaceChildren(build(width));
  }, [width, data]);
  return html`<div class="chart-holder" id=${id} ref=${ref}></div>`;
}

// --- Now: timers, questions, tasks, the attached conversation ---------------------------------

const DOING = { listening: "Listening", thinking: "Waiting for the agent", speaking: "Speaking", asked: "Waiting for an answer" };
const TASK_STATES = { running: ["under way", "good"], blocked: ["waiting for you", "warn"], done: ["done", ""] };

/** What is going on at this moment, from GET /admin/now (the 3 s poll), with the buttons that stop each thing. */
export function NowList() {
  useTick(1000);
  const now = store.now;
  const at = hubNow();
  const gone = async (path) => {
    await api("DELETE", path);
    await refresh();
  };
  const kept = store.clients.filter((c) => c.waiting);
  const notified = store.clients.filter((c) => c.notified);
  const items = [];
  const item = (key, title, sub, time, action, extra) => items.push(html`<li key=${key} class="now-it">
    <div class="now-t"><div class="now-title">${title}</div>${sub ? html`<div class="now-sub">${sub}</div>` : null}${extra}</div>
    ${time ? html`<span class="now-time">${time}</span>` : null}
    ${action ?? null}
  </li>`);
  if (now?.attached) {
    // Everything said goes to that conversation, so it is first.
    item("attached", html`Attached to <b>${now.attached.title}</b>`, "Every device: what is said goes to this conversation, not the usual voice one. It lets go after half an hour with nothing said.",
      `for ${countdown(at - now.attached.since)}`, html`<${Button} class="btn sm" run=${() => gone("/admin/attached")}>Detach</${Button}>`);
  }
  for (const c of now?.computers ?? [])
    item(`pc:${c.clientId}`, html`Computer in use: <${DevLink} id=${c.clientId} name=${c.computer} />`, `An agent is using it. Last: ${c.last}`, `for ${countdown(at - c.since)}`);
  for (const t of now?.tasks ?? []) {
    const [word, kind] = TASK_STATES[t.state] ?? [t.state, ""];
    item(`task:${t.id}`, t.title, html`Agent task${t.total ? ` · step ${t.done ?? 0} of ${t.total}` : ""}${t.note ? `: ${t.note}` : ""} <${Stat} label=${word} kind=${kind} />`, `for ${countdown(at - t.startedAt)}`,
      html`<${Button} class="btn sm ghost" run=${() => gone(`/admin/tasks/${enc(t.id)}`)}>Clear</${Button}>`,
      html`${t.total ? html`<progress class="task-progress" max=${t.total} value=${t.state === "done" ? t.total : t.done ?? 0}></progress>` : null}
        ${t.steps?.length ? html`<ol class="task-steps">${t.steps.map((s, i) => html`<li key=${i} data-state=${s.state}>${s.text}</li>`)}</ol>` : null}`);
  }
  for (const c of notified) item(`n:${c.id}`, html`Notification for <${DevLink} id=${c.id} name=${c.name} />`, `${plural(c.notified, "message")} sent to its closed page, not opened there yet`);
  for (const c of kept) item(`k:${c.id}`, html`Kept for <${DevLink} id=${c.id} name=${c.name} />`, `${plural(c.waiting, "message")} waiting for it to come back`);
  for (const c of now?.clients ?? [])
    item(`c:${c.clientId}`, html`<${DevLink} id=${c.clientId} name=${c.client} /> · ${DOING[c.state] ?? c.state}`, c.question ? `${c.question}${c.choices?.length ? ` (${c.choices.join(" / ")})` : ""}` : "", `for ${countdown(at - c.since)}`, html`<span class="dot accent" aria-hidden="true"></span>`);
  for (const t of now?.timers ?? []) {
    const left = t.dueAt > at ? countdown(t.dueAt - at) : t.task ? "due, the agent is on it" : "due, announcing";
    item(`t:${t.id}`, t.task ? `${t.label ? `${t.label}: ` : ""}${t.task}` : t.label || `${countdown(t.seconds * 1000)} timer`,
      html`${t.task ? "Task for later" : "Timer"} on <${DevLink} id=${t.clientId} name=${t.client} />${t.task ? html` <${Stat} label=${t.mayAct ? "may act on a computer" : "look only"} kind=${t.mayAct ? "warn" : ""} />` : null}`,
      html`<span class="mono">${left}</span>`, html`<${Button} class="btn sm ghost" run=${() => gone(`/admin/timers/${enc(t.id)}`)}>Cancel</${Button}>`);
  }
  if (!items.length) return html`<p class="dim now-empty" id="now">Nothing is running right now: no agent tasks, no timers, no questions, no conversations, no messages or notifications waiting.</p>`;
  return html`<ul class="now" id="now">${items}</ul>`;
}

// --- Say something --------------------------------------------------------------------------------

export const focusSay = () => {
  const box = document.getElementById("say-text");
  if (!box) return void (location.hash = "#overview", setTimeout(focusSay, 80));
  box.scrollIntoView({ block: "center", behavior: "smooth" });
  box.focus();
};

const SAID = (c) => (c.heard ? ["heard", "good"] : c.held ? ["kept for later", "warn"] : c.shown ? ["shown", ""] : ["not delivered", "bad"]);

function SaySomething() {
  const [text, setText] = useState("");
  const [target, setTarget] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [result, setResult] = useState();
  const [error, setError] = useState("");
  const places = [...new Set(store.clients.map((c) => String(c.settings.location ?? "").trim()).filter(Boolean))].sort();
  const able = store.clients.filter((c) => c.capabilities.includes("speaker") || c.capabilities.includes("screen"));
  const go = async () => {
    const words = text.trim();
    setResult(undefined);
    if (!words) return setError("Type what to say first.");
    setError("");
    const [kind, ...rest] = target.split(":");
    try {
      const said = await api("POST", "/admin/announce", {
        text: words, urgent, ...(kind === "client" ? { client: rest.join(":") } : kind === "location" ? { location: rest.join(":") } : {}),
      });
      setText("");
      setResult(said.clients);
    } catch (e) {
      if (e.status !== 401) setError(e.message);
    }
  };
  return html`<div class="say">
    <textarea class="field" id="say-text" rows="3" maxlength="1000" placeholder="Dinner is ready." aria-label="What to say" value=${text}
      onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && go()}></textarea>
    <div class="say-row">
      <select class="field" id="say-target" aria-label="Where to say it" value=${target} onChange=${(e) => setTarget(e.currentTarget.value)}>
        <option value="">Every device</option>
        ${places.map((p) => html`<option key=${p} value=${`location:${p}`}>Every device in ${p}</option>`)}
        ${able.map((c) => html`<option key=${c.id} value=${`client:${c.id}`}>${c.name}${c.online ? "" : c.notifications ? " (page closed)" : " (offline)"}</option>`)}
      </select>
      <label class="switch-l"><input type="checkbox" class="switch" id="say-urgent" checked=${urgent} onChange=${(e) => setUrgent(e.currentTarget.checked)} /> Urgent</label>
      <${Button} class="btn primary sm" id="say-go" run=${go}>Say it</${Button}>
    </div>
    ${error ? html`<p class="msg bad" role="alert">${error}</p>` : null}
    ${result
      ? html`<table class="t said" id="say-result"><tbody>${result.map((c, i) => {
          const [word, kind] = SAID(c);
          return html`<tr key=${i}><td>${c.client}</td><td><${Stat} label=${word} kind=${kind} /></td><td class="dim">${c.note ?? "Played to the end."}</td></tr>`;
        })}</tbody></table>`
      : html`<p class="help">Spoken on every device that can speak, or the one you pick. A closed browser page gets a notification; a device that is away gets it if it is back within a few minutes. In quiet hours it is shown without sound unless urgent.</p>`}
  </div>`;
}

// --- Getting started --------------------------------------------------------------------------------

const STARTED_KEY = "axis-admin-started";

/** A new hub's first steps, as the classic page: put away for good once done on a hub in use, or by Hide. */
function GettingStarted({ data }) {
  const [, redraw] = useState(0);
  const s = store.status, config = store.config;
  if (!s || !config || localStorage.getItem(STARTED_KEY)) return null;
  const up = s.upstream ?? {};
  const usesGateway = config.agent.backend !== "openai";
  const devices = store.clients.length;
  const turns = data?.turns?.count ?? (data ? 0 : undefined);
  const speech = up.stt === "up" && up.tts === "up";
  const steps = [
    { done: speech, title: "Speech is working", help: speech ? "Recognition and synthesis both answer." : "Check the speech services and press Test. The ones that come with Axis fetch their models on first start, which takes a few minutes.", href: "#speech", action: "Speech" },
    {
      done: up.openclaw === "up", title: "An agent answers",
      help: up.openclaw === "up" ? (usesGateway ? "Connected to the OpenClaw gateway." : "The chat endpoint answers.") : "Pair with an OpenClaw gateway, or point Axis at any OpenAI-style chat endpoint (a local model works).",
      href: usesGateway ? "#openclaw" : "#agent", action: usesGateway ? "OpenClaw" : "Agent",
      other: usesGateway ? { href: "#agent", action: "Use a chat endpoint instead" } : { href: "#openclaw", action: "Use OpenClaw instead" },
    },
    { done: devices > 0, title: "A first device", help: devices ? `${devices} paired.` : "Make a pairing code, then open this hub's address without /admin in a browser and enter it: that browser is your first device. Boards and computers pair the same way.", href: "#pair", action: "Add a device" },
    { done: turns !== undefined && turns > 0, title: "Say something", help: turns ? "It has answered." : "Type or speak on the device you paired. Live shows each step of the turn as it happens.", href: "#live", action: "Live" },
  ];
  const left = steps.filter((x) => !x.done).length;
  const putAway = () => {
    localStorage.setItem(STARTED_KEY, "1");
    redraw((n) => n + 1);
  };
  if (!left && (turns ?? 0) > 3) {
    localStorage.setItem(STARTED_KEY, "1");
    return null;
  }
  return html`<section class="card started-card" id="getting-started">
    <div class="card-h"><h3>${left ? "Getting started" : "All set"}</h3><span class="dim sm">${left ? `${steps.length - left} of ${steps.length} done` : "Axis is ready to use."}</span>
      <button type="button" class="btn ghost sm" onClick=${putAway}>${left ? "Hide" : "Close"}</button></div>
    <ol class="started card-b">${steps.map((x) => html`<li key=${x.title} class=${x.done ? "done" : ""}>
      <${Stat} label=${x.done ? "done" : "to do"} kind=${x.done ? "good" : ""} />
      <div><b>${x.title}</b><p class="help">${x.help}</p>
        ${x.done ? null : html`<p class="btnrow"><a class="btn sm" href=${x.href}>${x.action}</a>${x.other ? html`<a href=${x.other.href}>${x.other.action}</a>` : null}</p>`}</div>
    </li>`)}</ol>
  </section>`;
}

// --- the Overview -----------------------------------------------------------------------------------

export function Overview({ attention }) {
  const { data } = useActivity(24);
  const clients = [...store.clients].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const today = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const up = store.status?.uptimeMs !== undefined ? ` · up ${duration(store.status.uptimeMs)}` : "";
  const shown = clients.slice(0, 8);
  return html`<${PageHead} title="Overview" purpose=${today + up}>
      <a class="btn" href="#pair">Add a device</a>
      <button type="button" class="btn primary" onClick=${focusSay}>Say something</button>
    </${PageHead}>
    <div id="attention"><${AttentionList} items=${attention} /></div>
    <${GettingStarted} data=${data} />
    <h2 class="sec visually-hidden">The last 24 hours in numbers</h2>
    <${Kpis} data=${data} hours=${24} />
    <div class="ov-grid">
      <div class="ov-main">
        <h2 class="sec">Devices <a href="#clients">All devices <${Icon} name="arrow" /></a></h2>
        ${clients.length
          ? html`<div class="devgrid ov-devs">${shown.map((c) => html`<${DeviceCard} key=${c.id} client=${c} />`)}
              ${clients.length > shown.length
                ? html`<a class="card dev add" href="#clients"><span class="add-ico">+${clients.length - shown.length}</span><div class="dev-t"><div class="nm">More devices</div><div class="mt dim">All devices</div></div></a>`
                : html`<a class="card dev add" href="#pair"><span class="add-ico">+</span><div class="dev-t"><div class="nm">Add a device</div><div class="mt dim">Board, browser or computer</div></div></a>`}</div>`
          : html`<div class="card empty-card"><p>No devices yet.</p><a class="btn primary" href="#pair">Add a device</a></div>`}
        <h2 class="sec">Last 24 hours <a href="#activity">History <${Icon} name="arrow" /></a></h2>
        <div class="card card-b">
          ${data ? html`<${Strips} data=${data} devices=${true} onlyTrouble=${true} />` : html`<p class="dim" aria-busy="true">Loading…</p>`}
          <p class="help">Axis and its services; a device shows here when it was away. Every device, the charts and the events are in History.</p>
        </div>
      </div>
      <aside class="ov-rail">
        <h2 class="sec">Now <a href="#live">Live <${Icon} name="arrow" /></a></h2>
        <div class="card"><${NowList} /></div>
        <h2 class="sec">Say something</h2>
        <div class="card card-b"><${SaySomething} /></div>
      </aside>
    </div>`;
}

// --- Live: the stream ---------------------------------------------------------------------------------

/** The one stream, open while Live is on screen. Turns and calls come from Axis's snapshot; wake words since opened. */
const live = { up: false, turns: [], calls: [], wakes: [], stop: undefined, open: 0 };
const liveListeners = new Set();
const liveChanged = () => liveListeners.forEach((fn) => fn());

async function openLive() {
  if (live.stop) return;
  const stop = (live.stop = new AbortController());
  try {
    const res = await fetch("/admin/live", { headers: authHeader(), signal: stop.signal });
    if (res.status === 401) return signOut("That token was not accepted.");
    if (!res.ok || !res.body) throw new Error(`live stream refused (${res.status})`);
    live.up = true;
    liveChanged();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      for (let cut = pending.indexOf("\n\n"); cut >= 0; cut = pending.indexOf("\n\n")) {
        const block = pending.slice(0, cut);
        pending = pending.slice(cut + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (name && data) liveEvent(name, JSON.parse(data));
      }
    }
  } catch {
    // Dropped, or closed on purpose: the lines below decide.
  }
  if (live.stop !== stop) return;
  live.stop = undefined;
  live.up = false;
  liveChanged();
  setTimeout(() => live.open && store.signedIn && openLive(), 2000);
}

function closeLive() {
  live.stop?.abort();
  live.stop = undefined;
  live.up = false;
}

function liveEvent(name, data) {
  const upsert = (list, item, max) => {
    const at = list.findIndex((x) => x.key === item.key);
    if (at >= 0) list[at] = item;
    else list.unshift(item);
    return list.slice(0, max);
  };
  if (name === "snapshot") {
    live.turns = data.turns;
    live.calls = data.calls ?? [];
  } else if (name === "tool") live.calls = upsert(live.calls, data, 40);
  else if (name === "turn") live.turns = upsert(live.turns, data, 30);
  else if (name === "wake") live.wakes = [data, ...live.wakes].slice(0, 20);
  liveChanged();
}

/** Deletes the words of recent turns from Axis's memory and the device sketches. */
export async function clearLive() {
  await api("POST", "/admin/live/clear");
  live.wakes = [];
  liveChanged();
  toast("Cleared: the words of recent turns are deleted from Axis's memory.");
}

function useLive() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    liveListeners.add(fn);
    live.open++;
    openLive();
    return () => {
      liveListeners.delete(fn);
      if (!--live.open) closeLive();
    };
  }, []);
  // A running step counts up between the messages that move it along.
  useTick(200, live.turns.some((t) => !t.outcome) || live.calls.some((c) => !c.outcome));
  return live;
}

const STAGES = { listening: "Listening", transcribing: "Recognising", thinking: "Agent", speaking: "Speaking" };
const OUTCOMES = { answered: ["answered", "good"], silent: ["no reply", ""], no_speech: ["nothing heard", ""], interrupted: ["interrupted", "warn"], failed: ["failed", "bad"], cancelled: ["dropped", ""] };
const KINDS = { voice: "spoken", text: "typed", say: "agent spoke" };
const STARTED_BY = { wake: "wake word", tap: "tap", hold: "held", follow_up: "follow-up", question: "answering a question" };
const turnKind = (turn) => `${KINDS[turn.kind] ?? turn.kind}${turn.kind === "voice" && STARTED_BY[turn.startedBy] ? `, ${STARTED_BY[turn.startedBy]}` : ""}`;
const second = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const verdictText = (who) =>
  !who ? "" : who.untaught ? "nothing taught yet" : `${who.verdict === "known" ? who.name : who.verdict}${who.score !== undefined ? ` ${who.score.toFixed(2)}` : ""}${who.verdict === "unsure" && who.as === "guest" ? " (taken for a guest)" : ""}`;
const WAKE_OUTCOMES = { answered: ["answered", "good"], stood_down: ["another device answered", ""], ignored: ["ignored: a device nearby was speaking", "warn"] };
const TASK_ENDINGS = { done: ["done", "good"], cleared: ["cleared", ""], abandoned: ["no word for half an hour", "warn"] };

function TurnCard({ turn }) {
  const end = turn.endedAt ?? Date.now();
  const running = !turn.outcome;
  const [label, kind] = running ? [STAGES[turn.stages.at(-1)?.name] ?? "Starting", "accent"] : OUTCOMES[turn.outcome] ?? [turn.outcome, ""];
  const facts = [
    turn.speechMs !== undefined && `spoke for ${ms(turn.speechMs)}`,
    turn.sttMs !== undefined && `recognition ${ms(turn.sttMs)}`,
    turn.agentMs !== undefined && `agent's first words ${ms(turn.agentMs)}`,
    turn.firstAudioMs !== undefined && `first sound ${ms(turn.firstAudioMs)}`,
    turn.totalMs !== undefined && `whole turn ${ms(turn.totalMs)}`,
    turn.outcome === "answered" && turn.kind !== "text" && (turn.played ? "played to the end" : "not confirmed as played"),
    turn.voice && !turn.voice.untaught && `voice: ${verdictText(turn.voice)} (${ms(turn.voice.ms)})`,
  ].filter(Boolean);
  return html`<div class=${`card turn-card${running ? " running" : ""}`}>
    <div class="turn-head"><${DevLink} id=${turn.clientId} name=${turn.client} /><span class="dim sm grow">${turnKind(turn)} · ${second(turn.startedAt)}</span><${Stat} label=${label} kind=${kind} /></div>
    <div class="steps">${turn.stages.map((stage, i) => {
      const until = turn.stages[i + 1]?.at ?? end;
      const now = running && i === turn.stages.length - 1;
      return html`<div key=${i} class=${`step ${stage.name}${now ? " now" : ""}`} style=${`flex-grow:${Math.max(1, until - stage.at)}`}><span class="step-name">${STAGES[stage.name] ?? stage.name}</span><span class="step-time">${ms(until - stage.at)}</span></div>`;
    })}</div>
    ${turn.heard ? html`<p class="turn-words heard"><b>${turn.kind === "text" ? "Typed" : "Heard"}</b> ${turn.heard}</p>` : null}
    ${turn.said ? html`<p class="turn-words"><b>Said</b> ${turn.said}</p>` : null}
    ${turn.error ? html`<p class="msg bad">${turn.error}</p>` : null}
    ${facts.length ? html`<p class="turn-facts">${facts.join(" · ")}</p>` : null}
  </div>`;
}

function ToolCalls({ calls }) {
  if (!calls.length) return html`<p class="empty">No tool calls since Axis started. When an agent uses an Axis tool, it shows up here.</p>`;
  return html`<div class="tablebox"><table class="t" id="live-calls">
    <thead><tr><th>When</th><th>Tool</th><th>By</th><th class="num">Took</th><th>Outcome</th></tr></thead>
    <tbody>${calls.map((c) => {
      const detail = [c.args && ["Given", c.args], c.result && ["Gave back", c.result], c.error && ["Refused", c.error]].filter(Boolean);
      return html`<tr key=${c.key}>
        <td class="mono sm">${second(c.startedAt)}</td>
        <td>${detail.length
          ? html`<details class="call"><summary class="mono">${c.tool}</summary>${detail.map(([l, text]) => html`<p class="call-detail"><b>${l}</b> <code>${text}</code></p>`)}</details>`
          : html`<span class="mono">${c.tool}</span>`}</td>
        <td class="dim">${c.via}</td>
        <td class="num">${ms(c.ms ?? Date.now() - c.startedAt)}</td>
        <td>${!c.outcome ? html`<${Stat} label="running" kind="accent" />` : c.outcome === "ok" ? html`<${Stat} label="done" kind="good" />` : html`<${Stat} label=${c.error ?? "refused"} kind="bad" />`}</td>
      </tr>`;
    })}</tbody>
  </table></div>`;
}

function Wakes({ wakes }) {
  return html`${wakes.length
    ? html`<div class="tablebox"><table class="t" id="live-wakes">
        <thead><tr><th>When</th><th>Device</th><th class="num">Score</th><th class="num">Loudness</th><th>Outcome</th></tr></thead>
        <tbody>${wakes.map((w, i) => {
          const [word, kind] = WAKE_OUTCOMES[w.outcome] ?? [w.outcome, ""];
          return html`<tr key=${i}><td class="mono sm">${second(w.at)}</td><td>${w.client}</td><td class="num">${Math.round(w.score * 100)} %</td><td class="num">${Math.round(w.level * 100)} %</td><td><${Stat} label=${word} kind=${kind} /></td></tr>`;
        })}</tbody></table></div>`
    : html`<p class="empty">No wake word since this page was opened.</p>`}
    <p class="help"><a href="/admin#wakewords">Scores by device</a> are on the classic Wake words page until it moves here.</p>`;
}

function TasksEnded() {
  const ended = store.now?.tasksEnded ?? [];
  return html`${store.now?.away ? html`<p class="msg">Home Assistant says you are away, so a finished task also goes to your phone.</p>` : null}
    ${ended.length
      ? html`<div class="tablebox"><table class="t" id="live-tasks">
          <thead><tr><th>Task</th><th>How it ended</th><th>Last word</th><th class="num">Took</th><th class="num">Ended</th></tr></thead>
          <tbody>${ended.map((t, i) => {
            const [word, kind] = TASK_ENDINGS[t.ending] ?? [t.ending, ""];
            return html`<tr key=${i}><td>${t.title}</td><td><${Stat} label=${word} kind=${kind} />${t.total ? ` step ${t.done ?? 0} of ${t.total}` : ""}</td><td>${t.note}</td><td class="num">${countdown(t.at - t.startedAt)}</td><td class="num">${ago(t.at)}</td></tr>`;
          })}</tbody></table></div>`
      : html`<p class="empty">No agent task has finished yet.</p>`}
    <p class="help">Long work an agent reported on, once it is over: how far it got and how long it took. Kept as long as the rest of the activity.</p>`;
}

const LIVE_TABS = ["turns", "now", "calls", "wakes", "tasks"];
const LIVE_LABELS = { turns: "Turns", now: "Now", calls: "Tool calls", wakes: "Wake words", tasks: "Tasks finished" };

export function Live({ tab }) {
  const l = useLive();
  const current = LIVE_TABS.includes(tab) ? tab : "turns";
  const running = l.turns.filter((t) => !t.outcome).length;
  const nowCount = (store.now?.timers.length ?? 0) + (store.now?.clients.length ?? 0) + (store.now?.tasks?.length ?? 0) + (store.now?.attached ? 1 : 0) + (store.now?.computers?.length ?? 0);
  const counts = { turns: running ? `${running} running` : l.turns.length, now: nowCount, calls: l.calls.length, wakes: l.wakes.length, tasks: store.now?.tasksEnded?.length ?? 0 };
  return html`<${PageHead} title="Live" purpose="Turns, tool calls and wake words as they happen, and what is running now." crumb=${html`<span>Activity</span>`}>
      <span class=${`dot ${l.up ? "good" : "warn"}`} id="live-state">${l.up ? "watching" : "connecting"}</span>
      <${Button} class="btn" id="live-clear" run=${clearLive} title="Delete the words of recent turns from Axis's memory and from the device sketches">Clear now</${Button}>
    </${PageHead}>
    <nav class="tabs" aria-label="Live">${LIVE_TABS.map((t) => html`<a key=${t} href=${t === "turns" ? "#live" : `#live/${t}`} class=${t === current ? "on" : ""} aria-current=${t === current ? "page" : undefined}>${LIVE_LABELS[t]}${counts[t] ? html` <span class=${`badge ${t === "turns" && running ? "accent" : ""}`}>${counts[t]}</span>` : null}</a>`)}</nav>
    <div class="live-b" id="live-tab">
      ${current === "turns"
        ? html`<p class="help">Each turn as it moves from listening to recognition, the agent and speech. The words are never written to disk: Axis holds them in memory for ten minutes after a turn ends, and <b>Clear now</b> deletes them at once, here and from the device sketches.</p>
          <div id="live-turns">${l.turns.length ? l.turns.map((t) => html`<${TurnCard} key=${t.key} turn=${t} />`) : html`<p class="empty">Nothing to show yet. Say the wake word, tap a device or type in the web client, and the turn shows up here as it happens.</p>`}</div>`
        : current === "now"
          ? html`<div class="card"><${NowList} /></div>`
          : current === "calls"
            ? html`<p class="help">Every call of an Axis tool, by the OpenClaw agent, a harness over MCP or an admin page: what it was given, what it gave back, how long it took. What was given and given back is deleted with the words of turns.</p><${ToolCalls} calls=${l.calls} />`
            : current === "wakes"
              ? html`<${Wakes} wakes=${l.wakes} />`
              : html`<${TasksEnded} />`}
    </div>`;
}

// --- History: uptime, charts, recent turns, events ----------------------------------------------------

const EVENT_FILTERS = {
  problems: (e) => e.level !== "info",
  client: (e) => e.kind === "client",
  service: (e) => e.kind === "service" || e.kind === "axis",
  changes: (e) => e.kind === "settings" || e.kind === "admin",
};
let historyHours = 24;
let historyFilter = "";

export function History() {
  const [hours, setHours] = useState(historyHours);
  const [filter, setFilter] = useState(historyFilter);
  const { data, stale } = useActivity(hours);
  const pick = (h) => setHours((historyHours = h));
  const t = data?.turns;
  const events = data ? (EVENT_FILTERS[filter] ? data.events.filter(EVENT_FILTERS[filter]) : data.events) : [];
  return html`<${PageHead} title="History" purpose="Uptime, turn timings and events over the last day or week." crumb=${html`<span>Activity</span>`}>
      <div class="seg" role="group" aria-label="Range" id="range">${[24, 72, 168].map((h) => html`<button key=${h} type="button" class=${h === hours ? "on" : ""} aria-pressed=${h === hours} onClick=${() => pick(h)}>${h === 24 ? "24 hours" : h === 72 ? "3 days" : "7 days"}</button>`)}</div>
    </${PageHead}>
    <div class=${stale ? "stale" : ""} id="history" aria-busy=${stale ? "true" : undefined}>
      <${Kpis} data=${data} hours=${hours} />
      ${!data
        ? html`<p class="dim" aria-busy="true">Loading…</p>`
        : html`
          <h2 class="sec">Uptime</h2>
          <div class="card card-b"><${Strips} data=${data} devices=${true} /></div>
          <h2 class="sec">Response times and turns</h2>
          <div class="charts">
            <section class="card"><div class="card-h"><h3>Time to first sound</h3></div><div class="card-b">
              <p class="help">From Axis having the request to the first audio going out. A spoken turn also includes recognition.</p>
              <${Chart} id="chart-latency" data=${data} build=${(w) => t.firstAudioP50 === null
                ? el("p", { class: "empty" }, "No spoken replies in this period yet.")
                : lineChart(t.buckets, data.bucketMs, [{ key: "firstAudioP50", label: "typical", color: "--s1" }, { key: "firstAudioP95", label: "slowest 5 %", color: "--s2" }], w)} />
            </div></section>
            <section class="card"><div class="card-h"><h3>Turns</h3></div><div class="card-b">
              <${Chart} id="chart-turns" data=${data} build=${(w) => t.count
                ? columnChart(t.buckets.map((b) => ({ ...b, ok: b.count - b.failed })), data.bucketMs, [{ key: "ok", label: "went through", color: "--s1" }, { key: "failed", label: "failed", color: "--st-bad" }], w)
                : el("p", { class: "empty" }, "No turns in this period yet.")} />
            </div></section>
          </div>
          <section class="card"><div class="card-h"><h3>Where the wait goes, typical turn</h3></div><div class="card-b">
            <${Chart} id="chart-parts" data=${data} build=${() => partsBar([
              { label: "Speech recognition", value: t.sttP50, color: "--s1" },
              { label: "Agent's first words", value: t.agentP50, color: "--s2" },
              { label: "Synthesis to first audio", value: t.synthesisP50, color: "--s3" },
            ])} />
          </div></section>
          <h2 class="sec">Recent turns <a href="#live">Watch live <${Icon} name="arrow" /></a></h2>
          <p class="help">Timings and outcomes only. What was said is never stored.</p>
          ${data.recentTurns.length
            ? html`<div class="tablebox scrollbox"><table class="t" id="recent-turns">
                <thead><tr>${["When", "Device", "Kind", "Outcome", "Spoke", "Recognition", "Agent", "First sound", "Total"].map((c, i) => html`<th key=${c} class=${i >= 4 ? "num" : ""}>${c}</th>`)}</tr></thead>
                <tbody>${data.recentTurns.map((r, i) => {
                  const [word, kind] = OUTCOMES[r.outcome] ?? [r.outcome, ""];
                  return html`<tr key=${i}>
                    <td class="mono sm" title=${new Date(r.at).toLocaleString()}>${clock(r.at, hours > 24)}</td>
                    <td><${DevLink} id=${r.clientId} name=${r.clientName} /></td>
                    <td class="dim">${turnKind(r)}${r.speaker ? ` · ${r.speaker}` : ""}</td>
                    <td title=${r.error ?? ""}><${Stat} label=${word} kind=${kind} />${r.outcome === "answered" && !r.heard && r.kind !== "text" ? html`<span class="dim sm"> · not confirmed heard</span>` : null}</td>
                    ${[r.speechMs, r.sttMs, r.agentMs, r.firstAudioMs, r.totalMs].map((v, j) => html`<td key=${j} class="num">${ms(v)}</td>`)}
                  </tr>`;
                })}</tbody></table></div>`
            : html`<p class="empty">No turns in this period yet.</p>`}
          <h2 class="sec">Events
            <select class="field sm-field" id="event-filter" aria-label="Which events" value=${filter} onChange=${(e) => setFilter((historyFilter = e.currentTarget.value))}>
              <option value="">Everything</option><option value="problems">Problems only</option><option value="client">Connections</option><option value="service">Services</option><option value="changes">Changes by an admin</option>
            </select></h2>
          ${events.length
            ? html`<div class="tablebox scrollbox"><table class="t events-t" id="events"><tbody>${events.slice(0, 150).map((e, i) => html`<tr key=${i} class=${e.level === "info" ? "" : e.level}>
                <td class="mono sm" title=${new Date(e.at).toLocaleString()}>${clock(e.at, Date.now() - e.at > 20 * 3_600_000)}</td>
                <td><span class=${`dot ${e.level === "info" ? "" : e.level}`}>${e.kind}</span></td>
                <td>${e.text}</td></tr>`)}</tbody></table></div>`
            : html`<p class="empty">Nothing recorded yet.</p>`}`}
    </div>`;
}
