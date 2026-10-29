// The Devices area of the admin page: All devices, one device (Overview · Settings · Tools · Danger zone),
// a type (Devices · Settings · Firmware), Defaults for everything, and Add a device with a QR code of the setup string.

import { html, useEffect, useMemo, useRef, useState } from "/web/preact.js";
import qrcode from "/web/qr.js";
import { strip, stripAxis, percent, ms as fmtMs, clock } from "/web/charts.js";
import {
  ago, api, ask, behind, clientById, deviceHref, download, draftOf, enc, heldBuild, kept, kindOf, offlineAfter,
  plural, PROFILE_WORDS, profileLine, refresh, RolloutCard, rolloutRunning, runCommand, startRollout, setDraft, span, store, toast, typeHref, typeName, typesInUse, updateDevice, useStore, Dom,
} from "/web/adm-core.js";
import { BatteryPreview, DeviceSketch, GlowPreview, MicPanel, batteryDef, doingOf, glowDef } from "/web/adm-tools.js";
import { DeviceTwin } from "/web/adm-twin.js";
import {
  DEVICE_ONLY, LayerBanner, SaveBar, SettingsEditor, capabilityGroup, differsOn, inherited, saveDraft, shareWithType, showValue, stage,
} from "/web/adm-settings.js";

export const findAction = (client) => (store.types[client.type]?.actions ?? []).find((a) => a.name === "find");

const KIND_WORDS = { board: "board", round: "round board", browser: "browser", computer: "computer", headset: "headset" };
const autoWords = (client) => {
  const t = client.offlineAfterAutoMs;
  return typeof t === "number" ? `after ${span(t)}` : "never";
};

function FindButton({ client, cls = "btn sm" }) {
  const action = findAction(client);
  if (!action || !client.online) return null;
  const go = async (event) => {
    event.stopPropagation();
    event.preventDefault();
    try {
      const r = await runCommand(client, action);
      toast(r.ok ? `${client.name} is chiming and flashing now.` : r.text, r.ok ? "good" : "bad");
    } catch (error) {
      toast(error.message, "bad");
    }
  };
  return html`<button type="button" class=${cls} title=${action.help || "Chime and flash, to tell which one it is"} onClick=${go}>Find</button>`;
}

function UpdateNow({ client, cls = "btn sm" }) {
  const held = heldBuild(client);
  if (!held || !behind(client)) return null;
  const go = async (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (!(await ask({ title: `Update ${client.name}?`, body: `From ${client.version} to ${held.version}. It restarts and is away for about half a minute.${client.type === "meta-quest" ? "" : " This board updates on its own, without the one-board-first check of Update all; if the new build cannot reach Axis it goes back to the old one by itself."}`, confirm: "Update" }))) return;
    try {
      toast(await updateDevice(client));
    } catch (error) {
      toast(error.message, "bad");
    }
  };
  return html`<button type="button" class=${cls} data-update=${client.id} disabled=${!client.online} title=${client.online ? `Update to ${held.version}` : "It can update once it is online"} onClick=${go}>Update to ${held.version}</button>`;
}

/** A device's state as a dot and a word: online and what it is doing, or how long it has been away. */
export function StateDot({ client }) {
  if (client.online) {
    const doing = doingOf(client);
    return html`<span class=${`dot ${doing === "Idle" ? "good" : "accent"}`}>${doing === "Idle" ? "Online" : doing}</span>`;
  }
  const late = offlineAfter(client) !== Infinity && client.lastSeenAt && Date.now() - client.lastSeenAt > offlineAfter(client);
  return html`<span class=${`dot ${late ? "warn" : ""}`} title=${client.lastSeenAt ? new Date(client.lastSeenAt).toLocaleString() : "never connected"}>${client.lastSeenAt ? `Last seen ${ago(client.lastSeenAt)}` : "Never connected"}</span>`;
}

function VersionBadge({ client }) {
  if (!client.version) return null;
  const held = heldBuild(client);
  if (behind(client)) return html`<span class="badge warn" title=${`${held.version} is on the shelf`}>${client.version} · update</span>`;
  return html`<span class="badge" title=${held ? "The build Axis holds for it" : ""}>${client.version}${held ? " · current" : ""}</span>`;
}

/** A chip for a device on a profile other than normal, with why in its title. */
export function ProfileBadge({ client }) {
  if (!client.profile || client.profile === "normal") return null;
  return html` <span class="badge" data-profile-chip=${client.profile} title=${profileLine(client.profile, client.profileReason, client.readings?.battery, client.effective?.chargeLimit)}>${PROFILE_WORDS[client.profile]?.toLowerCase() ?? client.profile}</span>`;
}

/** One device as a card: picture, name, state, type and version, what it can do now. */
export function DeviceCard({ client }) {
  return html`<a class=${`card dev${client.online ? "" : " off"}`} href=${deviceHref(client)} data-device=${client.id}>
    <div class="mini-wrap"><${DeviceSketch} client=${client} size="mini" /></div>
    <div class="dev-t">
      <div class="nm"><span>${client.name}</span><${ProfileBadge} client=${client} />${behind(client) ? html`<span class="badge warn">update</span>` : null}</div>
      <div class="mt"><${StateDot} client=${client} /></div>
      <div class="mt dim">${typeName(client.type)}${client.version ? ` · ${client.version}` : ""}${client.settings.location ? ` · ${client.settings.location}` : ""}</div>
    </div>
    <div class="dev-acts"><${FindButton} client=${client} /><${UpdateNow} client=${client} /></div>
  </a>`;
}

const ownKeys = (c) => Object.keys(c.layers.device).filter((k) => !DEVICE_ONLY.has(k));

// --- All devices ----------------------------------------------------------------------------------

export function AllDevices() {
  useStore();
  const saved = kept.get("axis.devices", {});
  const [view, setView] = useState(saved.view ?? "grid");
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [place, setPlace] = useState("");
  const [state, setState] = useState(location.hash.includes("?behind") ? "behind" : "");
  const choose = (v) => (setView(v), kept.set("axis.devices", { ...saved, view: v }));
  const places = [...new Set(store.clients.map((c) => String(c.settings.location ?? "").trim()).filter(Boolean))].sort();
  const words = q.trim().toLowerCase();
  const shown = store.clients
    .filter((c) => !words || [c.name, c.type, typeName(c.type), c.settings.location, c.id].some((v) => String(v ?? "").toLowerCase().includes(words)))
    .filter((c) => !type || c.type === type)
    .filter((c) => !place || c.settings.location === place)
    .filter((c) => !state || (state === "online" ? c.online : state === "offline" ? !c.online : behind(c)))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const s = store.status;
  return html`<header class="ph">
      <div class="grow"><h1>All devices</h1><p class="s">${s ? `${s.clientsOnline} of ${s.clientsKnown} online` : ""}${store.clients.filter(behind).length ? ` · ${plural(store.clients.filter(behind).length, "update")} waiting` : ""}</p></div>
      <div class="ph-acts"><a class="btn primary" href="#pair">Add a device</a></div>
    </header>
    ${store.clients.length
      ? html`<div class="filters" role="search">
          <input class="field grow" type="search" id="device-filter" placeholder="Filter by name, type, location" aria-label="Filter devices" value=${q} onInput=${(e) => setQ(e.target.value)} />
          <select class="field" aria-label="Type" value=${type} onChange=${(e) => setType(e.target.value)}><option value="">Every type</option>${typesInUse().map((t) => html`<option value=${t.type}>${typeName(t.type)}</option>`)}</select>
          ${places.length ? html`<select class="field" aria-label="Location" value=${place} onChange=${(e) => setPlace(e.target.value)}><option value="">Every location</option>${places.map((p) => html`<option value=${p}>${p}</option>`)}</select>` : null}
          <select class="field" aria-label="State" value=${state} onChange=${(e) => setState(e.target.value)}><option value="">Any state</option><option value="online">Online</option><option value="offline">Offline</option><option value="behind">Needs an update</option></select>
          <div class="seg" role="group" aria-label="Show as">${[["grid", "Grid"], ["list", "List"]].map(([v, l]) => html`<button type="button" aria-pressed=${view === v} class=${view === v ? "on" : ""} onClick=${() => choose(v)}>${l}</button>`)}</div>
        </div>`
      : null}
    ${!store.clients.length
      ? html`<div class="card empty-card"><h2>No devices yet</h2><p class="dim">A board, a browser, a computer or a headset pairs with a code from Add a device.</p><a class="btn primary" href="#pair">Add a device</a></div>`
      : !shown.length
        ? html`<p class="empty">No device matches. <button type="button" class="linkish" onClick=${() => (setQ(""), setType(""), setPlace(""), setState(""))}>Clear the filters</button></p>`
        : view === "grid"
          ? html`<div class="devgrid" id="device-list">${shown.map((c) => html`<${DeviceCard} key=${c.id} client=${c} />`)}</div>`
          : html`<div class="tablebox"><table class="t" id="device-list">
              <thead><tr><th>Name</th><th>State</th><th>Type</th><th class="hide-narrow">Location</th><th class="hide-narrow">Settings</th><th class="hide-narrow">Version</th><th></th></tr></thead>
              <tbody>${shown.map((c) => {
                const own = ownKeys(c);
                return html`<tr key=${c.id} class=${c.online ? "" : "off"} onClick=${(e) => !e.target.closest("a, button") && (location.hash = deviceHref(c))}>
                  <td><a href=${deviceHref(c)}>${c.name}</a><${ProfileBadge} client=${c} /></td>
                  <td><${StateDot} client=${c} /></td>
                  <td><a class="plain" href=${typeHref(c.type)} title=${c.type}>${typeName(c.type)}</a></td>
                  <td class="hide-narrow">${c.settings.location || html`<span class="dim">none</span>`}</td>
                  <td class="hide-narrow dim" title=${own.join(", ")}>${own.length ? plural(own.length, "own value") : "shared"}</td>
                  <td class="hide-narrow"><${VersionBadge} client=${c} /></td>
                  <td class="acts"><${FindButton} client=${c} /><${UpdateNow} client=${c} /></td>
                </tr>`;
              })}</tbody>
            </table></div>`}`;
}

// --- one device -------------------------------------------------------------------------------------

const TAB_LABELS = { overview: "Overview", settings: "Settings", tools: "Tools", danger: "Danger zone" };

export function DevicePage({ id, tab, focusKey }) {
  useStore();
  const client = clientById(id);
  if (!client) {
    return html`<header class="ph"><div class="grow"><div class="crumb"><a href="#clients">Devices</a></div><h1>No such device</h1><p class="s">It may have been removed, or the address is wrong.</p></div></header>
      <a class="btn" href="#clients">All devices</a>`;
  }
  const entity = `device:${client.id}`;
  const schema = store.types[client.type] ?? { settings: [], actions: [], links: [] };
  const hasTools = Boolean(glowDef(client)) || Boolean(batteryDef(client)) || schema.actions.some((a) => a.name === "mic");
  const tabs = ["overview", "settings", ...(hasTools ? ["tools"] : []), "danger"];
  const current = tabs.includes(tab) ? tab : "overview";
  const own = ownKeys(client).length;
  const n = Object.keys(draftOf(entity).values).length + (draftOf(entity).caps !== undefined ? 1 : 0) + (draftOf(entity).name !== undefined ? 1 : 0);
  return html`<div class="device" data-id=${client.id}>
    <header class="dband">
      <div class="dband-pic"><${DeviceSketch} client=${client} size="mini" /></div>
      <div class="dband-t">
        <div class="crumb"><a href="#clients">Devices</a><span>/</span><a href=${typeHref(client.type)}>${typeName(client.type)}</a>${client.settings.location ? html`<span>/</span>${client.settings.location}` : null}</div>
        <h1 id="device-title">${client.name}</h1>
        <div class="meta"><${StateDot} client=${client} /><a class="badge" href=${typeHref(client.type)}>${typeName(client.type)}</a><${VersionBadge} client=${client} />${client.settings.location ? html`<span class="dim">Location: ${client.settings.location}</span>` : null}</div>
      </div>
      <div class="dband-acts"><a class="btn" href=${`#map?device=${enc(client.id)}`} id="device-map" title="The system map, with this device picked out">On the map</a><${FindButton} client=${client} cls="btn" /><${UpdateNow} client=${client} cls="btn" />${canSay(client) ? html`<button type="button" class="btn" disabled=${!client.online} onClick=${() => announce(client)}>Announce…</button>` : null}</div>
    </header>
    <nav class="tabs" aria-label="Device">
      ${tabs.map((t) => html`<a key=${t} href=${deviceHref(client, t === "overview" ? "" : t)} class=${`${t === current ? "on" : ""}${t === "danger" ? " danger" : ""}`} aria-current=${t === current ? "page" : undefined}>${TAB_LABELS[t]}${t === "settings" && (own || n) ? html`<span class=${`badge ${n ? "warn" : "accent"}`}>${n ? `${n} unsaved` : `${own} set here`}</span>` : null}</a>`)}
    </nav>
    ${current === "overview" ? html`<${DeviceOverview} client=${client} schema=${schema} />` : null}
    ${current === "settings" ? html`<${DeviceSettings} client=${client} schema=${schema} focusKey=${focusKey} />` : null}
    ${current === "tools" ? html`<${DeviceTools} client=${client} schema=${schema} />` : null}
    ${current === "danger" ? html`<${DangerZone} client=${client} />` : null}
    ${current !== "settings" ? html`<${SaveBar} entity=${entity} floating=${true} save=${() => saveDevice(client)} />` : null}
  </div>`;
}

const canSay = (c) => c.capabilities.includes("speaker") || c.capabilities.includes("screen");

async function announce(client) {
  const text = await ask({ title: `Announce on ${client.name}`, body: "Spoken or shown on this device now.", confirm: "Announce", input: { label: "What to say", placeholder: "Dinner is ready." } });
  if (!text?.trim()) return;
  try {
    const result = await api("POST", `/admin/clients/${enc(client.id)}/announce`, { text: text.trim() });
    toast(result.heard ? `Announced. ${client.name} played it to the end.` : "Sent, but the device did not report playing it.", result.heard ? "good" : "warn");
  } catch (error) {
    toast(error.message, "bad");
  }
}

/** Every key a device page may stage: its settings, plus location (and glowCorner, which may not be declared on a round board). */
function deviceDefs(client, schema) {
  const defs = schema.settings.filter((d) => d.key !== "capabilitiesOff");
  const loc = store.builtIns.find((d) => d.key === "location") ?? { key: "location", label: "Location", kind: "text" };
  return defs.some((d) => d.key === "location") ? defs : [loc, ...defs];
}

function saveDevice(client) {
  const schema = store.types[client.type] ?? { settings: [] };
  return saveDraft({ entity: `device:${client.id}`, defs: [...deviceDefs(client, schema), ...(glowDef(client) ? [glowDef(client).def] : [])], layers: client.layers, tab: "device", path: `/admin/settings/device/${enc(client.id)}`, what: client.name, clientId: client.id });
}

/** Labelled facts from what a device reports; the raw readings stay available, folded. */
const READING_LABELS = { battery: ["Battery", "%"], rssi: ["Wi-Fi signal", "dBm"], heap: ["Free memory", "bytes"], uptime: ["Up for", "s"], rotation: ["Way up", "°"], temperature: ["Temperature", "°C"] };
function readingFacts(readings) {
  const out = [];
  const w = readings.screenW, h = readings.screenH;
  if (w && h) out.push(["Screen", `${w} × ${h}${Number(readings.screenRound) === 1 ? ", round" : ""}`]);
  for (const [key, value] of Object.entries(readings)) {
    if (["screenW", "screenH", "screenRound", "axis"].includes(key)) continue;
    const known = READING_LABELS[key];
    out.push([known?.[0] ?? key, `${value}${known?.[1] ? ` ${known[1]}` : ""}`]);
  }
  return out;
}

function DeviceOverview({ client, schema }) {
  const [history, setHistory] = useState();
  const [note, setNote] = useState(["", ""]);
  useEffect(() => {
    let live = true;
    const load = () => api("GET", `/admin/activity?hours=24&client=${enc(client.id)}`).then((d) => live && setHistory(d)).catch(() => live && setHistory(null));
    load();
    const t = setInterval(() => document.hidden || load(), 30_000);
    return () => ((live = false), clearInterval(t));
  }, [client.id]);
  const base = client.address ? `http://${client.address}` : "";
  const changeAddress = async () => {
    const address = await ask({
      title: `Where ${client.name} reaches Axis`,
      body: "For example https://axis.example.org or 192.168.1.20:8440. It keeps its pairing and settings, tries the new address, and goes back to this one by itself if it cannot connect within a minute and a half.",
      confirm: "Tell it", input: { label: "Address", value: client.readings.axis },
    });
    if (!address?.trim() || address.trim() === client.readings.axis) return;
    try {
      const told = await api("POST", `/admin/clients/${enc(client.id)}/address`, { address: address.trim() });
      setNote([`${told.client} is trying ${told.address}. It drops off for a few seconds; if it does not come back on that address it returns to the old one.`, "good"]);
    } catch (error) {
      setNote([error.message, "bad"]);
    }
  };
  const testNotify = async () => {
    try {
      const told = await api("POST", `/admin/clients/${enc(client.id)}/notify-test`);
      setNote([`Test notification sent to ${told.sent}. It should appear there within a few seconds, open or closed.`, "good"]);
    } catch (error) {
      setNote([error.message, "bad"]);
    }
  };
  const facts = readingFacts(client.readings ?? {});
  const line = history?.clients?.[0]?.id === client.id ? history.clients[0] : undefined;
  const fact = (label, ...value) => html`<div class="fact"><dt>${label}</dt><dd>${value}</dd></div>`;
  const actions = schema.actions.filter((a) => a.name !== "reset");
  return html`<${DeviceTwin} client=${client} head=${html`<a class="btn ghost sm" href=${deviceHref(client, "settings")}>Name and location</a>`}>
      <dl class="facts twin-facts" id="device-facts">
        ${fact("Type", html`<a href=${typeHref(client.type)}>${typeName(client.type)}</a>`, typeName(client.type) !== client.type ? html` <span class="mono dim">${client.type}</span>` : null)}
        ${fact("Version", client.version || "not reported", " ", behind(client) ? html`<span class="badge warn">${heldBuild(client).version} on the shelf</span>` : null, " ", html`<${UpdateNow} client=${client} />`)}
        ${fact("Can", (client.reported ?? client.capabilities).length ? (client.reported ?? client.capabilities).map((c) => html`<span class=${`chip${client.off?.includes(c) ? " no" : ""}`} title=${client.off?.includes(c) ? "Switched off" : ""}>${c}</span> `) : "nothing reported", " ", html`<a class="sm" href=${deviceHref(client, "settings?key=capabilities")}>Switch off…</a>`)}
        ${client.address ? fact("Address", html`<span class="mono">${client.address}</span>`) : null}
        ${client.online && base && schema.links.length ? fact("Pages", schema.links.map((l, i) => html`${i ? " · " : ""}<a href=${base + l.path} target="_blank" rel="noopener">${l.label} ↗</a>`)) : null}
        ${client.readings?.axis ? fact("Reaches Axis at", html`<span class="mono">${client.readings.axis}</span>`, " ", html`<button type="button" class="btn sm" disabled=${!client.online} onClick=${changeAddress}>Change…</button>`) : null}
        ${client.type === "web" ? fact("When its page is closed", client.notifications ? "gets a notification " : html`<span class="dim">not reachable (notifications are off in that browser) </span>`, client.notifications ? html`<button type="button" class="btn sm" onClick=${testNotify}>Send a test</button>` : null) : null}
        ${client.waiting ? fact("Waiting for it", `${plural(client.waiting, "message")}, said when it is back`) : null}
        ${fact("Offline alert", `${client.settings.offlineAlert ?? "auto"}${(client.settings.offlineAlert ?? "auto") === "auto" ? ` (a ${KIND_WORDS[kindOf(client)]}: ${autoWords(client)})` : ""}`)}
        ${fact("Id", html`<span class="mono dim">${client.id}</span>`)}
      </dl>
      ${note[0] ? html`<p class=${`msg ${note[1]}`} role="status">${note[0]}</p>` : null}
    <//>
    <div class="dmain">
      <section class="card">
        <div class="card-h"><h3>Actions</h3>${client.online ? null : html`<span class="dim sm">Offline: actions wait until it is back</span>`}</div>
        <div class="card-b"><${Actions} client=${client} actions=${actions} /></div>
      </section>
      <section class="card">
        <div class="card-h"><h3>Last 24 hours</h3></div>
        <div class="card-b" id="device-history">
          ${history === undefined ? html`<p class="dim" aria-busy="true">Loading…</p>` : !line ? html`<p class="dim">Nothing recorded yet.</p>` : html`
            <div class="kpis small">
              <div class="kpi"><div class="l">Online</div><div class="v">${percent(line.availability)}</div><div class="d">${plural(line.connects, "connection")}</div></div>
              <div class="kpi"><div class="l">Turns</div><div class="v">${line.turns}</div></div>
              <div class="kpi"><div class="l">Typical first sound</div><div class="v">${fmtMs(line.firstAudioP50)}</div></div>
            </div>
            <${Strip} line=${line} from=${history.from} to=${history.to} />
            <details class="events"><summary>Events (${history.events.length})</summary>
              ${history.events.length ? html`<ul>${history.events.slice(0, 100).map((e) => html`<li key=${e.at + e.text} class=${e.level}><span class="when" title=${new Date(e.at).toLocaleString()}>${clock(e.at)}</span> <span class=${`dot ${e.level === "info" ? "" : e.level}`}>${e.kind}</span> ${e.text}</li>`)}</ul>` : html`<p class="dim">None.</p>`}
            </details>`}
        </div>
      </section>
      ${facts.length
        ? html`<section class="card"><div class="card-h"><h3>Readings</h3></div>
            <dl class="facts card-b">${facts.map(([k, v]) => fact(k, v))}</dl>
            <details class="raw card-b"><summary>As reported</summary><table class="t"><tbody>${Object.entries(client.readings).map(([k, v]) => html`<tr><td class="mono">${k}</td><td>${String(v)}</td></tr>`)}</tbody></table></details>
          </section>`
        : null}
    </div>`;
}

function Strip({ line, from, to }) {
  const node = useMemo(() => {
    const box = document.createElement("div");
    box.className = "strip-box";
    box.append(strip(line.segments, from, to), stripAxis(from, to));
    return box;
  }, [line, from, to]);
  return html`<${Dom} node=${node} />`;
}

function Actions({ client, actions }) {
  const [out, setOut] = useState(["", ""]);
  const [busy, setBusy] = useState("");
  if (!actions.length) return html`<p class="dim">${client.online ? "This device offers no actions." : "Actions appear once the device has connected."}</p>`;
  const run = async (a) => {
    if (a.confirm && !(await ask({ title: `${a.label} on ${client.name}?`, body: a.help, confirm: a.label }))) return;
    setBusy(a.name);
    try {
      const r = await runCommand(client, a);
      setOut([r.text, r.ok ? "good" : "bad"]);
    } catch (error) {
      setOut([error.message, "bad"]);
    }
    setBusy("");
  };
  return html`<div class="btnrow">${actions.map((a) => html`<button type="button" key=${a.name} class="btn sm" title=${a.help || ""} disabled=${!client.online || busy === a.name} onClick=${() => run(a)}>${a.label}</button>`)}
    ${canSay(client) ? html`<button type="button" class="btn sm" disabled=${!client.online} onClick=${() => announce(client)}>Announce…</button>` : null}</div>
    ${out[0] ? html`<p class=${`msg ${out[1]}`} id="action-note" role="status">${out[0]}</p>` : null}`;
}

function DeviceSettings({ client, schema, focusKey }) {
  const entity = `device:${client.id}`;
  const defs = batteryGroup(client, schema.settings.filter((d) => !DEVICE_ONLY.has(d.key)));
  const d = draftOf(entity);
  const locations = [...new Set(store.clients.map((c) => c.settings.location).filter(Boolean))].sort();
  const locDef = store.builtIns.find((x) => x.key === "location") ?? { key: "location", label: "Location", kind: "text" };
  const loc = Object.hasOwn(d.values, "location") ? d.values.location : client.layers.device.location ?? "";
  const identity = {
    name: "This device",
    count: "Name and location",
    dirty: d.name !== undefined || Object.hasOwn(d.values, "location"),
    body: html`<div class="row" data-key="name"><div class="lbl-col"><div class="lbl">Name</div><div class="hlp">Agents and people address it by this name.</div></div>
        <div class="ctl"><input class="field" data-edit="name" aria-label="Name" maxlength="60" spellcheck="false" value=${d.name ?? client.name} onInput=${(e) => setDraft(entity, (x) => ((x.name = e.target.value === client.name ? undefined : e.target.value), x))} /></div>
        <div class="src">${d.name !== undefined ? html`<span class="src-chip unsaved">unsaved</span>` : null}</div><div class="rst"></div></div>
      <div class=${`row${Object.hasOwn(d.values, "location") ? " dirty" : client.layers.device.location ? " mine" : ""}`} data-key="location"><div class="lbl-col"><div class="lbl">Location</div><div class="hlp">${locDef.help}</div></div>
        <div class="ctl"><input class="field" data-edit="location" aria-label="Location" list="locations" placeholder="none" spellcheck="false" value=${loc} onInput=${(e) => stage(entity, locDef, e.target.value, client.layers.device.location, { value: undefined })} />
          <datalist id="locations">${locations.map((l) => html`<option value=${l} />`)}</datalist></div>
        <div class="src">${Object.hasOwn(d.values, "location") ? html`<span class="src-chip unsaved">unsaved</span>` : null}</div><div class="rst"></div></div>`,
  };
  const save = () => saveDevice(client);
  const kind = kindOf(client);
  const rail = html`<div class="card"><${DeviceSketch} client=${client} /></div>`;
  const tools = html`<a href=${deviceHref(client, "tools")}>Preview and test on the Tools tab.</a>`;
  const banner = html`<${LayerBanner} tab="device" who="this device" entity=${entity} save=${save}
    detail=${`${client.name}: its values win over ${typeName(client.type)} and everything.`}
    layers=${[{ label: "This device", href: deviceHref(client, "settings"), on: true }, { label: `Every ${typeName(client.type)}`, href: typeHref(client.type, "settings") }, { label: "Everything", href: "#settings" }]} />`;
  return html`${banner}
    ${defs.length
      ? html`<${SettingsEditor} defs=${defs} layers=${client.layers} tab="device" entity=${entity} focusKey=${focusKey}
          head=${[identity, capabilityGroup(client, entity)]} extra=${shareWithType(client)} rail=${rail}
          hints=${{ offlineAlert: `Auto for this ${KIND_WORDS[kind]}: ${autoWords(client)}.`, glowCorner: tools, lowBatteryBelow: tools, batteryGlyph: tools, chargeLimit: chargeHint(client) }} />`
      : html`<div class="edit-grid with-rail"><div class="edit-main"><p class="empty">This device has not described its settings yet. It does so each time it connects.</p></div><aside class="rail">${rail}</aside></div>`}
    <${SaveBar} entity=${entity} save=${save} floating=${true} />`;
}

/** Under the charge limit on a device on Dock: the profile's limit wins while it is on. */
function chargeHint(client) {
  return client.profile === "dock" ? `On Dock now: held at ${client.effective?.chargeLimit ?? 80}% from the System page.` : undefined;
}

/** Settings about the battery, in one Battery group on a device's page: Axis's charge limit beside the board's own. */
const BATTERY_KEYS = new Set(["chargeLimit", "lowBatteryBelow", "batteryGlyph"]);

/** The device's settings with the battery ones grouped together, and the charge limit left out for a device with no battery. */
function batteryGroup(client, defs) {
  const battery = Boolean(batteryDef(client)) || client.readings?.battery !== undefined || client.readings?.chargerState !== undefined;
  return defs.filter((x) => x.key !== "chargeLimit" || battery).map((x) => (BATTERY_KEYS.has(x.key) && battery ? { ...x, group: "Battery" } : x));
}

/** What the battery preview draws with: the staged or saved low-battery threshold and battery mark, and the glow's curve. */
function batteryLook(client, draft, radius) {
  const value = (key, fallback) => (Object.hasOwn(draft.values, key) && draft.values[key] !== null ? draft.values[key] : client.settings[key] ?? fallback);
  const glyphDef = store.types[client.type]?.settings.find((x) => x.key === "batteryGlyph");
  return { below: Number(value("lowBatteryBelow", batteryDef(client).default ?? 15)), glyph: Boolean(Number(value("batteryGlyph", glyphDef?.default ?? 1))), radius };
}

function DeviceTools({ client, schema }) {
  const entity = `device:${client.id}`;
  const glow = glowDef(client);
  const d = draftOf(entity);
  const saved = Number(client.settings.glowCorner ?? glow?.def.default ?? 56);
  const radius = Object.hasOwn(d.values, "glowCorner") && d.values.glowCorner !== null ? Number(d.values.glowCorner) : saved;
  return html`<div class="tools-grid">
    ${glow ? html`<section class="card"><div class="card-h"><h3>Edge glow</h3><span class="dim sm">Drawn the way the device draws it</span></div><div class="card-b">
      <${GlowPreview} client=${client} radius=${radius} saved=${saved} onRadius=${(r) => stage(entity, glow.def, r, client.layers.device.glowCorner, inherited(glow.def, client.layers, "device"))} /></div></section>` : null}
    ${batteryDef(client) ? html`<section class="card"><div class="card-h"><h3>Battery</h3><span class="dim sm">Drawn the way the device draws it</span></div><div class="card-b">
      <${BatteryPreview} client=${client} ...${batteryLook(client, d, radius)} /></div></section>` : null}
    ${schema.actions.some((a) => a.name === "mic") ? html`<section class="card"><div class="card-h"><h3>Microphone levels</h3></div><div class="card-b"><${MicPanel} client=${client} /></div></section>` : null}
  </div>`;
}

function DangerZone({ client }) {
  const firmware = Boolean(client.readings?.axis);
  const reset = async (wifi) => {
    const what = wifi ? "its pairing, settings and Wi-Fi" : "its pairing and settings";
    if (!(await ask({ title: `Reset ${client.name}?`, body: `It forgets ${what} and has to be set up again. This cannot be undone.`, confirm: wifi ? "Reset and forget Wi-Fi" : "Reset", danger: true, typed: client.name }))) return;
    try {
      await api("POST", `/admin/clients/${enc(client.id)}/reset`, { wifi });
      toast(`${client.name} reset and removed.`);
      location.hash = "#clients";
      refresh();
    } catch (error) {
      toast(error.message, "bad");
    }
  };
  const remove = async () => {
    if (!(await ask({ title: `Remove ${client.name}?`, body: "Its token stops working and it must pair again to come back. Its own settings are forgotten.", confirm: "Remove", danger: true, typed: client.name }))) return;
    try {
      await api("DELETE", `/admin/clients/${enc(client.id)}`);
      toast(`${client.name} removed.`);
      location.hash = "#clients";
      refresh();
    } catch (error) {
      toast(error.message, "bad");
    }
  };
  return html`<div class="danger-list">
    ${firmware
      ? html`<section class="card danger"><div class="card-b">
          <h3>Reset this device</h3><p class="dim">It forgets its pairing and settings, keeps its Wi-Fi, and starts its own setup network to be paired again. Only while it is online.</p>
          <button type="button" class="btn danger" disabled=${!client.online} onClick=${() => reset(false)}>Reset…</button>
        </div></section>
        <section class="card danger"><div class="card-b">
          <h3>Reset and forget Wi-Fi</h3><p class="dim">As Reset, and it forgets the Wi-Fi too: for a device that is moving to another network or another person.</p>
          <button type="button" class="btn danger" disabled=${!client.online} onClick=${() => reset(true)}>Reset and forget Wi-Fi…</button>
        </div></section>`
      : null}
    <section class="card danger"><div class="card-b">
      <h3>Remove</h3><p class="dim">Axis forgets it: its token stops working and it must pair again. ${firmware ? "The device itself keeps its settings until it is reset." : ""}</p>
      <button type="button" class="btn danger" id="device-remove" onClick=${remove}>Remove…</button>
    </div></section>
  </div>`;
}

// --- one type ---------------------------------------------------------------------------------------

export function TypePage({ type, tab, focusKey }) {
  useStore();
  const members = store.clients.filter((c) => c.type === type).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const tabs = ["devices", "settings", "firmware"];
  const current = tabs.includes(tab) ? tab : "devices";
  const schema = store.types[type];
  const entity = `type:${type}`;
  const rename = async () => {
    const label = await ask({ title: `Name for ${type}`, body: `What this page calls every "${type}" device. Empty shows ${type} again. The type itself, which the device reports, does not change.`, confirm: "Save", input: { label: "Name", value: store.types[type]?.label ?? "" } });
    if (label === null) return;
    try {
      await api("PATCH", `/admin/types/${enc(type)}`, { label: label.trim() });
      refresh();
    } catch (error) {
      toast(error.message, "bad");
    }
  };
  const n = Object.keys(draftOf(entity).values).length;
  return html`<header class="ph">
      <div class="grow"><div class="crumb"><a href="#clients">Devices</a><span>/</span>Types</div>
        <h1 id="type-title">${typeName(type)}</h1>
        <p class="s">${typeName(type) !== type ? html`<span class="mono">${type}</span> · ` : null}${members.length ? `${plural(members.length, "device")}, ${members.filter((c) => c.online).length} online` : "No device of this type is paired."}</p></div>
      ${members.length ? html`<div class="ph-acts"><button type="button" class="btn" onClick=${rename}>Rename…</button></div>` : null}
    </header>
    ${members.length
      ? html`<nav class="tabs" aria-label="Type">${tabs.map((t) => html`<a key=${t} href=${typeHref(type, t === "devices" ? "" : t)} class=${t === current ? "on" : ""} aria-current=${t === current ? "page" : undefined}>${t[0].toUpperCase() + t.slice(1)}${t === "settings" && n ? html`<span class="badge warn">${n} unsaved</span>` : null}</a>`)}</nav>
        ${current === "devices" ? html`<${TypeDevices} type=${type} members=${members} schema=${schema} />` : null}
        ${current === "settings" ? html`<${TypeSettings} type=${type} members=${members} schema=${schema} focusKey=${focusKey} />` : null}
        ${current === "firmware" ? html`<${TypeFirmware} type=${type} members=${members} />` : null}
        ${current !== "settings" ? html`<${SaveBar} entity=${entity} floating=${true} save=${() => saveType(type, members)} />` : null}`
      : html`<div class="card empty-card"><p>${store.clients.length ? "No device of this type is paired." : "Loading…"}</p><a class="btn" href="#clients">All devices</a></div>`}`;
}

function TypeDevices({ type, members, schema }) {
  const online = members.filter((c) => c.online);
  const runAll = async (a) => {
    if (!(await ask({ title: `${a.label} on ${plural(online.length, "online device")}?`, body: a.help, confirm: a.label }))) return;
    const results = [];
    for (const c of online) {
      const r = await runCommand(c, a).catch((error) => ({ ok: false, text: error.message }));
      results.push({ name: c.name, ...r });
    }
    const failed = results.filter((r) => !r.ok);
    toast(failed.length ? `${a.label}: ${results.length - failed.length} of ${results.length} done. ${failed.map((r) => `${r.name}: ${r.text}`).join("; ")}` : `${a.label}: done on ${plural(results.length, "device")}.`, failed.length ? "bad" : "good");
  };
  return html`<div class="devgrid">${members.map((c) => html`<${DeviceCard} key=${c.id} client=${c} />`)}</div>
    ${schema?.actions.length
      ? html`<section class="card"><div class="card-h"><h3>Run on every online device</h3><span class="dim sm">one after the other</span></div>
          <div class="card-b btnrow">${schema.actions.map((a) => html`<button type="button" key=${a.name} class="btn sm" title=${a.help || ""} disabled=${!online.length} onClick=${() => runAll(a)}>${a.label}</button>`)}</div></section>`
      : null}`;
}

function typeLayers(members) {
  return { global: members[0]?.layers.global ?? store.global, type: members[0]?.layers.type ?? {}, device: {} };
}
function saveType(type, members) {
  const schema = store.types[type] ?? { settings: [] };
  return saveDraft({ entity: `type:${type}`, defs: schema.settings, layers: typeLayers(members), tab: "type", path: `/admin/settings/type/${enc(type)}`, what: `every ${typeName(type)}` });
}

function TypeSettings({ type, members, schema, focusKey }) {
  const entity = `type:${type}`;
  const defs = (schema?.settings ?? []).filter((d) => !DEVICE_ONLY.has(d.key));
  const differ = new Set(members.flatMap(ownKeys)).size;
  const kinds = [...new Set(members.map(kindOf))];
  return html`<${LayerBanner} tab="type" who=${`every ${typeName(type)}`} entity=${entity} save=${() => saveType(type, members)}
      detail=${`${plural(members.length, "device")}${differ ? `, ${plural(differ, "setting")} set differently on some` : ""}. A device's own value still wins.`}
      layers=${[...(members.length === 1 ? [{ label: members[0].name, href: deviceHref(members[0], "settings") }] : []), { label: `Every ${typeName(type)}`, href: typeHref(type, "settings"), on: true }, { label: "Everything", href: "#settings" }]} />
    ${defs.length
      ? html`<${SettingsEditor} defs=${defs} layers=${typeLayers(members)} tab="type" entity=${entity} focusKey=${focusKey} extra=${(def) => differsOn(members, def)}
          hints=${kinds.length === 1 ? { offlineAlert: `Auto for a ${KIND_WORDS[kinds[0]]}: ${autoWords(members[0])}.` } : {}} />`
      : html`<p class="empty">No device of this type has described its settings yet. They do so each time they connect.</p>`}
    <${SaveBar} entity=${entity} save=${() => saveType(type, members)} floating=${true} />`;
}

function TypeFirmware({ type, members }) {
  const held = type === "meta-quest" ? (store.quest?.available ? store.quest : undefined) : store.firmware.find((f) => f.type === type);
  const late = members.filter((c) => behind(c));
  const ready = late.filter((c) => c.online);
  const [note, setNote] = useState(["", ""]);
  const board = type !== "meta-quest";
  const updateAll = async () => {
    if (board) {
      try {
        await startRollout(ready, held.version);
      } catch (error) {
        setNote([error.message, "bad"]);
      }
      return;
    }
    if (!(await ask({ title: `Update ${plural(ready.length, "device")} to ${held.version}?`, body: "Each restarts and is away for about half a minute.", confirm: "Update" }))) return;
    const failed = [];
    for (const c of ready) await updateDevice(c).catch((error) => failed.push(`${c.name}: ${error.message}`));
    setNote(failed.length ? [failed.join(" "), "bad"] : [`${plural(ready.length, "device")} told to update to ${held.version}. They restart by themselves in about half a minute.`, "good"]);
  };
  return html`<section class="card"><div class="card-b">
    ${held
      ? html`<p>Devices are sent ${type === "meta-quest" ? "app" : ""} version <b>${held.version}</b>. ${late.length ? late.map((c) => `${c.name} is on ${c.version}${c.online ? "" : " (offline)"}`).join(", ") + "." : "Every device is on it."}</p>
        <div class="btnrow"><button type="button" class="btn primary" id="update-all" disabled=${!ready.length || (board && rolloutRunning())} title=${board ? "One board first, the rest once it is proven" : ""} onClick=${updateAll}>${board && rolloutRunning() ? "A rollout is running" : ready.length ? `Update ${plural(ready.length, "device")} to ${held.version}` : "Nothing to update"}</button>
          <a class="btn" href=${type === "meta-quest" ? "#apps" : "#firmware"}>${type === "meta-quest" ? "The Quest app on Apps" : "Manage builds on Firmware"}</a></div>`
      : html`<p class="dim">${type === "meta-quest" ? "No Quest app build is on this hub (scripts/build-quest-client.sh)." : "No build has been uploaded for this type yet."}</p>
        <a class="btn" href=${type === "meta-quest" ? "#apps" : "#firmware"}>${type === "meta-quest" ? "Apps" : "Upload one on Firmware"}</a>`}
    ${note[0] ? html`<p class=${`msg ${note[1]}`} role="status">${note[0]}</p>` : null}
  </div></section>
  ${board ? html`<${RolloutCard} type=${type} />` : null}`;
}

// --- Defaults for everything ------------------------------------------------------------------------

/** Not one of Axis's built-ins, but read by Axis from the shared layer. */
const DEFAULT_CLIENT = { key: "defaultClient", label: "Default device", kind: "client", group: "Axis", help: "Where an agent's unprompted speech goes when nobody has spoken lately. Not set: any device that can speak or show text." };

function sharedDeviceSettings(skip) {
  const byKey = new Map();
  for (const [type, schema] of Object.entries(store.types)) {
    for (const def of schema.settings) {
      if (skip.has(def.key)) continue;
      const e = byKey.get(def.key) ?? { def, types: [] };
      e.types.push(type);
      byKey.set(def.key, e);
    }
  }
  return [...byKey.values()].filter((e) => e.types.length > 1);
}

export function Defaults({ focusKey }) {
  useStore();
  const entity = "global";
  const builtIns = [...store.builtIns.filter((d) => !DEVICE_ONLY.has(d.key)), DEFAULT_CLIENT];
  const known = new Set([...builtIns.map((d) => d.key), ...DEVICE_ONLY]);
  const shared = sharedDeviceSettings(known).map((e) => ({ ...e.def, group: `Shared by ${e.types.length} types`, help: `${e.def.help ? `${e.def.help} ` : ""}Used by ${e.types.map(typeName).join(", ")}.` }));
  const described = new Set([...known, ...shared.map((d) => d.key)]);
  const staged = draftOf(entity).values;
  const otherKeys = [...new Set([...Object.keys(store.global), ...Object.keys(staged)])].filter((k) => !described.has(k));
  const others = otherKeys.map((key) => ({ key, label: key, kind: "raw", group: "Other keys", help: "Passed to every device as it is, for firmware with options it does not describe." }));
  const defs = [...builtIns, ...shared, ...others];
  const layers = { global: store.global, type: {}, device: {} };
  const save = () => saveDraft({ entity, defs, layers, tab: "global", path: "/admin/settings/global", what: "everything" });
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const add = () => {
    const k = key.trim();
    if (!k) return;
    if (described.has(k)) return toast(`${k} has its own row on this page.`, "bad");
    setDraft(entity, (d) => ((d.values[k] = value), d));
    setKey("");
    setValue("");
  };
  return html`<header class="ph"><div class="grow"><div class="crumb"><a href="#clients">Devices</a></div><h1>Defaults for everything</h1>
      <p class="s">The base for every device of every type. A type, and then a single device, can set their own value on top.</p></div></header>
    <${LayerBanner} tab="global" who="everything" entity=${entity} save=${save} detail="Every device follows these unless its type or the device itself sets its own." />
    <${SettingsEditor} defs=${defs} layers=${layers} tab="global" entity=${entity} focusKey=${focusKey}
      after=${html`<div class="card add-key"><div class="card-b">
        <h3>Another key</h3><p class="dim sm">For firmware with options it does not describe. true, false and numbers are kept as such. Saved with the other changes.</p>
        <div class="btnrow"><input class="field mono" id="set-key" placeholder="key" aria-label="Key" spellcheck="false" value=${key} onInput=${(e) => setKey(e.target.value)} />
          <input class="field" id="set-value" placeholder="value" aria-label="Value" spellcheck="false" value=${value} onInput=${(e) => setValue(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && add()} />
          <button type="button" class="btn" id="set-add" onClick=${add}>Add</button></div>
      </div></div>`} />
    <${SaveBar} entity=${entity} save=${save} floating=${true} />`;
}

// --- Add a device ------------------------------------------------------------------------------------

const LOCAL_NAMES = ["localhost", "127.0.0.1", "[::1]"];

/** The setup string as a QR code: an SVG of the code's modules, dark on white in any theme, with its quiet zone. */
export function QrCode({ text, label }) {
  const path = useMemo(() => {
    if (!text) return undefined;
    const qr = qrcode(0, "M");
    qr.addData(text, "Byte");
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    return { d, size: n + 8, n };
  }, [text]);
  if (!path) return html`<div class="qr empty" aria-hidden="true"><span>QR code</span></div>`;
  return html`<svg class="qr" viewBox=${`0 0 ${path.size} ${path.size}`} role="img" aria-label=${label} data-text=${text} data-modules=${path.n} shape-rendering="crispEdges">
    <rect width=${path.size} height=${path.size} fill="#fff" /><path d=${path.d} fill="#000" />
  </svg>`;
}

let pairBaseline;
export function AddDevice() {
  useStore();
  const [code, setCode] = useState(undefined);
  const [note, setNote] = useState(["A code works once and expires after 10 minutes.", ""]);
  const [paired, setPaired] = useState();
  const [address, setAddress] = useState(() => localStorage.getItem("axis.deviceAddress") ?? (location.protocol === "http:" && !LOCAL_NAMES.includes(location.hostname) ? location.host : ""));
  const [copied, setCopied] = useState(false);
  const [desktop, setDesktop] = useState();
  const field = useRef();
  const make = async () => {
    try {
      const made = await api("POST", "/admin/pairing-codes");
      pairBaseline = new Set(store.clients.map((c) => c.id));
      setPaired(undefined);
      setCode(made);
      const minutes = Math.max(1, Math.round((made.expiresAt - Date.now()) / 60000));
      setNote([`Works once, for ${plural(minutes, "minute")} (until ${new Date(made.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}). This page notices when a device uses it.`, ""]);
    } catch (error) {
      setNote([error.message, "bad"]);
    }
  };
  useEffect(() => {
    if (location.hash.includes("?new")) {
      history.replaceState(null, "", "#pair");
      make();
    }
    api("GET", "/admin/desktop").then(setDesktop).catch(() => setDesktop(null));
  }, []);
  // A device that pairs with the code shows up in the poll.
  useEffect(() => {
    if (!pairBaseline || !code) return;
    const fresh = store.clients.find((c) => !pairBaseline.has(c.id));
    if (!fresh) return;
    pairBaseline = undefined;
    setPaired(fresh);
    setCode(undefined);
    setNote(["That code has been used.", ""]);
    toast(`${fresh.name} paired.`);
  });
  const typed = address.trim();
  const scheme = /^https:\/\//i.test(typed) ? "axis+tls" : "axis";
  const host = typed.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const setup = host && code ? `${scheme}://${host}/${code.code}` : "";
  const copy = async () => {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup);
    } catch {
      // The clipboard needs https or localhost; selecting the text is the fallback.
      field.current.select();
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const quest = store.quest;
  return html`<header class="ph"><div class="grow"><div class="crumb"><a href="#clients">Devices</a></div><h1>Add a device</h1>
      <p class="s">Make a pairing code, then give it to the device: typed, pasted as a setup string, or scanned.</p></div></header>
    <div class="pair-grid">
      <section class="card pair-code">
        <div class="card-b">
          <h2 class="step"><span>1</span> A pairing code</h2>
          <div class="btnrow"><button type="button" class="btn primary" id="code-new" onClick=${make}>${code ? "Another code" : "New pairing code"}</button>
            ${code ? html`<span class="code" id="code-value">${code.code}</span>` : html`<span class="code" id="code-value"></span>`}</div>
          <p class=${`msg ${note[1]}`} id="code-note">${note[0]}</p>
          ${paired ? html`<p class="msg good" id="pair-done" role="status">${paired.name} (${typeName(paired.type)}) paired. <a href=${deviceHref(paired, "settings")}>Open it</a> to name it and set its location.</p>` : null}
          <h2 class="step"><span>2</span> Where devices reach Axis</h2>
          <label class="dlabel" for="device-address">Axis address for devices</label>
          <input class="field mono" id="device-address" spellcheck="false" placeholder="192.168.1.20:8440" value=${address}
            onInput=${(e) => (setAddress(e.target.value), localStorage.setItem("axis.deviceAddress", e.target.value.trim()))} />
          <p class="help">An address the device can reach over its Wi-Fi, usually this machine's LAN address and port. Not a Tailscale name. Start it with <code>https://</code> for an encrypted link (<code>axis+tls://</code>): the device then needs firmware 0.8.2 or newer and Axis a certificate from a public authority.</p>
          <h2 class="step"><span>3</span> The setup string</h2>
          <div class="setup">
            <div class="setup-t">
              <div class="btnrow"><input class="field mono grow" id="setup-string" ref=${field} readonly placeholder=${code ? "Type the address above" : "Make a code first"} value=${setup} onFocus=${(e) => e.target.select()} aria-label="Setup string" />
                <button type="button" class="btn" id="setup-copy" disabled=${!setup} onClick=${copy}>${copied ? "Copied" : "Copy"}</button></div>
              <p class="help">The address and the code in one: paste it into a board's own setup page (its <code>VorteX-Axis-XXXX</code> network, then <code>http://192.168.4.1</code>), or into the Windows, Mac or Quest app. A phone or headset can scan the code beside it.</p>
            </div>
            <${QrCode} text=${setup} label=${setup ? `QR code of ${setup}` : ""} />
          </div>
        </div>
      </section>
      <section class="card pair-kinds">
        <div class="card-h"><h3>By kind of device</h3></div>
        <div class="kinds">
          <div class="kind"><h4>A new board</h4><p>A board with no VorteX Axis firmware gets it over USB from the <a href="/flash/" target="_blank" rel="noopener">flasher page ↗</a> (Chrome or Edge on a computer, over https or from this machine as localhost). It installs the build on this hub's shelf; then join its setup network and paste the setup string.</p></div>
          <div class="kind"><h4>A browser</h4><p>Open the <a href="/" target="_blank" rel="noopener">web client ↗</a> on the phone or computer and type the code. A browser is never listed as needing attention for being offline.</p></div>
          <div class="kind"><h4>A Windows computer <span class="badge">experimental</span></h4><p>Run the desktop app, then paste the setup string. Agents can see that screen, point, click and type there through the <code>vortex_axis_desktop</code> tool, off until switched on under Tools and MCP. One file; Windows may warn that it is not signed.</p>
            <div class="btnrow"><button type="button" class="btn sm" id="desktop-download" disabled=${!desktop?.available}
              onClick=${() => download("/admin/desktop/app", "VortexAxisDesktop.exe").catch((error) => toast(error.message, "bad"))}>Download the desktop app</button>
              <span class="dim sm" id="desktop-info">${desktop === undefined ? "" : desktop?.available ? `version ${desktop.version ?? "?"} · ${Math.round(desktop.size / 1048576)} MB` : "not built on this hub yet (scripts/build-desktop.sh)"}</span></div></div>
          <div class="kind"><h4>A Mac <span class="badge">experimental</span></h4><p>The Mac menu bar app (<code>clients/macos-desktop</code>) is built on a Mac from the repository; this hub does not serve it. In its window, paste the setup string, give the Mac a name, and Pair. It does not update itself.</p></div>
          <div class="kind"><h4>A Meta Quest headset <span class="badge">experimental</span></h4><p>The Quest panel client is installed once by cable (<code>adb install -r quest-client.apk</code>, from Unknown Sources); then give it the setup string (or the address and code) and Pair. Later builds reach it from this hub by themselves.
            <span class="dim">${quest?.available ? ` This hub holds version ${quest.version}.` : " No Quest build is on this hub yet (scripts/build-quest-client.sh)."}</span></p></div>
        </div>
      </section>
    </div>`;
}
