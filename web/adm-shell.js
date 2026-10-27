// The new admin page's frame: sign-in, the sidebar with its groups, the header's health strip, the command bar,
// toasts, dialogs and the router that keeps every address of the classic page working (docs/admin-revamp/ia.md 1.1).

import { html, useEffect, useMemo, useRef, useState } from "/web/preact.js";
import {
  ago, api, ask, behind, clearDraft, clientById, deviceHref, dirtyEntities, download, draftCount, dropToast, enc, hasToken, heldBuild,
  kept, kindOf, loadSlow, offlineAfter, plural, runCommand, set, setTheme, signIn, signOut, span, store, themeChoice, toast, typeHref, typeName,
  typesInUse, updateDevice, useStore,
} from "/web/adm-core.js";
import { AddDevice, AllDevices, Defaults, DevicePage, TypePage, DeviceCard, findAction } from "/web/adm-devices.js";
import { Face } from "/web/adm-tools.js";
import { History, Live, Overview, clearLive, focusSay } from "/web/adm-activity.js";
import { AgentPage, OpenClawPage, SpeechPage, ToolsPage, VoicesPage, checkAgain, gatewayMark, reconnectGateway } from "/web/adm-agent.js";
import { AppsPage, FacePage, FirmwarePage, WakeWordsPage } from "/web/adm-hardware.js";
import { IntegrationsPage, SystemPage } from "/web/adm-system.js";

// --- pages and routes -------------------------------------------------------------------------

/** Every page, its group, and what it is for (the command bar searches these words too). */
export const PAGES = {
  overview: { title: "Overview", purpose: "What needs attention, and how Axis has been doing." },
  live: { title: "Live", group: "activity", purpose: "Turns, tool calls and wake words as they happen, and what is running now." },
  activity: { title: "History", group: "activity", purpose: "Uptime, turn timings and events over the last day or week." },
  clients: { title: "All devices", group: "devices" },
  settings: { title: "Defaults for everything", short: "Defaults", group: "devices" },
  face: { title: "Face and screen", group: "devices", purpose: "The vortex face's looks, idle looks and tool icons, for every device." },
  pair: { title: "Add a device", group: "devices" },
  agent: { title: "Who answers", group: "agent", purpose: "The OpenClaw agent or another chat endpoint that answers turns." },
  openclaw: { title: "OpenClaw gateway", group: "agent", purpose: "The link to the gateway, what Axis relies on there, and pairing." },
  tools: { title: "Tools and MCP", group: "agent", purpose: "Which tools agents have, trying one, the desktop block list, MCP and its tokens." },
  speech: { title: "Speech", group: "agent", purpose: "Speech recognition and synthesis, and the realtime voice." },
  voices: { title: "Voices", group: "agent", purpose: "Telling voices apart: the voiceprint settings, taught voices and what was heard lately." },
  firmware: { title: "Firmware", group: "hardware", purpose: "The builds Axis holds per device type, and updating devices." },
  wakewords: { title: "Wake words", group: "hardware", purpose: "Wake word models, their cutoffs, and what devices heard." },
  apps: { title: "Apps", group: "hardware", purpose: "The Windows desktop app and the Quest app this hub holds, and the Mac app." },
  integrations: { title: "Integrations", purpose: "Home Assistant, live activities on phones, notifications to browsers." },
  system: { title: "System", purpose: "Public address and proxies, clock and history kept, backup, and about this hub." },
};
const GROUPS = [
  { key: "activity", title: "Activity", icon: "activity", pages: ["live", "activity"] },
  { key: "devices", title: "Devices", icon: "devices" },
  { key: "agent", title: "Agent and voice", icon: "agent", pages: ["agent", "openclaw", "tools", "speech", "voices"] },
  { key: "hardware", title: "Hardware", icon: "chip", pages: ["firmware", "wakewords", "apps"] },
];
export const DEVICE_TABS = ["overview", "settings", "tools", "danger"];
export const TYPE_TABS = ["devices", "settings", "firmware"];

/** Reads an address: #clients/<id>/settings?key=volume, #device/<id>, #type/<type>/firmware, … Anything unknown is the Overview. */
export function parseRoute(hash) {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/");
  const first = parts[0] || "overview";
  const key = new URLSearchParams(query).get("key") || "";
  const id = parts[1] ? safeDecode(parts[1]) : "";
  if (first === "clients" || first === "device") {
    if (!id) return { page: "clients", id: "", tab: "", key };
    return { page: "device", id, tab: DEVICE_TABS.includes(parts[2]) ? parts[2] : key ? "settings" : "overview", key };
  }
  if (first === "type") {
    if (!id) return { page: "settings", id: "", tab: "", key };
    return { page: "type", id, tab: TYPE_TABS.includes(parts[2]) ? parts[2] : key ? "settings" : "devices", key };
  }
  return { page: PAGES[first] ? first : "overview", id: "", tab: parts[1] ?? "", key };
}
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
/** What a page edits, so leaving it with unsaved changes can be caught. */
// Pages with a form of their own stage it as "page:<name>" (web/adm-agent.js, adm-hardware.js, adm-system.js).
const FORM_PAGES = new Set(["agent", "openclaw", "tools", "speech", "voices", "face", "wakewords", "integrations", "system"]);
export const entityOf = (r) => (r.page === "device" ? `device:${r.id}` : r.page === "type" ? `type:${r.id}` : r.page === "settings" ? "global" : FORM_PAGES.has(r.page) ? `page:${r.page}` : "");
const entityLabel = (entity) => {
  const [kind, ...rest] = entity.split(":");
  const id = rest.join(":");
  if (kind === "page") return PAGES[id]?.title ?? id;
  return kind === "device" ? clientById(id)?.name ?? "this device" : kind === "type" ? `every ${typeName(id)}` : "everything";
};

function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    let current = location.hash;
    const on = async () => {
      const next = parseRoute(location.hash);
      const leaving = entityOf(parseRoute(current));
      const n = leaving ? draftCount(leaving) : 0;
      if (n && entityOf(next) !== leaving) {
        const target = location.hash;
        // Back where we were until the person says so; this does not fire another hashchange.
        history.replaceState(null, "", current || "#overview");
        const ok = await ask({
          title: "Leave without saving?",
          body: `${plural(n, "unsaved change")} for ${entityLabel(leaving)} will be lost.`,
          confirm: "Discard and leave",
          cancel: "Stay",
          danger: true,
        });
        if (!ok) return;
        clearDraft(leaving);
        location.hash = target;
        return;
      }
      const before = parseRoute(current);
      current = location.hash;
      setRoute(next);
      set({ navOpen: false, cmdk: false });
      // A new page starts at the top; another tab of the same one stays where it is.
      if (before.page !== next.page || before.id !== next.id) window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    const leave = (event) => {
      if (dirtyEntities().length) event.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      window.removeEventListener("hashchange", on);
      window.removeEventListener("beforeunload", leave);
    };
  }, []);
  return route;
}

// --- icons ----------------------------------------------------------------------------------

const PATHS = {
  home: "M3 10.5 10 4l7 6.5M5 9v7h4v-4h2v4h4V9",
  activity: "M2 10h3l2-5 3 10 2-6 1.5 3H18",
  devices: "M6 2.5h8a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 16V4A1.5 1.5 0 0 1 6 2.5ZM9 14.5h2",
  agent: "M10 3a3 3 0 0 1 3 3v3a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5 9a5 5 0 0 0 10 0M10 14v3",
  chip: "M6 6h8v8H6zM8 2v3M12 2v3M8 15v3M12 15v3M2 8h3M2 12h3M15 8h3M15 12h3",
  plug: "M7 2v4M13 2v4M5 6h10v3a5 5 0 0 1-10 0V6ZM10 14v4",
  gear: "M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4",
  search: "M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3ZM13.5 13.5 17 17",
  menu: "M3 5h14M3 10h14M3 15h14",
  close: "M5 5l10 10M15 5 5 15",
  chev: "M7 5l5 5-5 5",
  arrow: "M4 10h12M11 5l5 5-5 5",
  bolt: "M11 2 4 11h5l-1 7 7-9h-5l1-7Z",
};
export const Icon = ({ name, class: cls = "ic" }) =>
  html`<svg class=${cls} viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d=${PATHS[name]} /></svg>`;

// --- attention ------------------------------------------------------------------------------

/** What is wrong with the backup, in a sentence, or nothing when it is fine or not set up. */
function backupTrouble(backup) {
  if (!backup?.configured) return "";
  if (backup.last && !backup.last.ok) return `The last backup failed: ${backup.last.error}`;
  if (backup.overdue) return `No backup has been made for ${span(Date.now() - (backup.last?.at ?? Date.now()))}.`;
  return "";
}

/**
 * Things to look at now, problems first, each with where it is fixed. As the classic page's list, except: a device
 * on other firmware than the shelf's is listed with an Update button, and an offline device only after its Offline
 * alert time (by kind: boards 15 min, computers and headsets 12 h, browsers never), not every one after 10 minutes.
 */
export function attentionItems() {
  const items = [];
  const add = (level, text, detail, href, action) => items.push({ level, text, detail, href, action });
  const up = store.status?.upstream ?? {};
  const usesGateway = store.config?.agent?.backend !== "openai";
  if (up.openclaw === "down") add("bad", usesGateway ? "The agent cannot be reached: OpenClaw is not connected." : "The agent endpoint is not answering.", "", (usesGateway ? "#openclaw" : "#agent"));
  for (const check of store.check?.checks ?? []) {
    if (check.state === "problem") add("bad", `${check.label} is not working.`, check.detail, "#openclaw");
  }
  if (up.stt === "down") add("bad", "Speech recognition is down or not set up.", "Spoken turns fail.", "#speech");
  if (up.tts === "down") add("bad", "Speech synthesis is down or not set up.", "Replies are shown but not spoken.", "#speech");
  const gw = store.gateway;
  if (gw?.setupCodePending) add("warn", "A gateway approval is waiting.", "Approve Axis on the gateway.", "#openclaw");
  else if (gw && usesGateway && gw.node.state !== "connected" && gw.operator.state === "connected")
    add("warn", "The gateway command link is not connected.", "Agents cannot speak through Axis.", "#openclaw");
  const now = Date.now();
  for (const c of store.clients) {
    const limit = offlineAfter(c);
    if (!c.online && limit !== Infinity) {
      if (!c.lastSeenAt) add("warn", `${c.name} has never connected.`, typeName(c.type), deviceHref(c));
      else if (now - c.lastSeenAt > limit) add("warn", `${c.name} has been offline for ${span(now - c.lastSeenAt)}.`, `${typeName(c.type)} · last seen ${new Date(c.lastSeenAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`, deviceHref(c));
    }
    if (behind(c)) {
      const held = heldBuild(c);
      add("warn", `${c.name} runs ${c.version}; ${held.version} is on the shelf.`, `${typeName(c.type)} · ${c.online ? "it restarts and is away for about half a minute" : "it can update once it is back online"}`, deviceHref(c), { kind: "update", client: c });
    }
  }
  const trouble = backupTrouble(store.integrations?.backup);
  if (trouble) add("bad", trouble, "", "#system/backup");
  const ha = store.integrations?.homeAssistant;
  if (ha && !ha.connected) add("warn", "Home Assistant is not connected.", ha.error ?? "", "#integrations");
  const data = store.activity;
  if (data) {
    const failed = data.recentTurns.filter((t) => t.outcome === "failed" && now - t.at < 3_600_000).length;
    if (failed) add("bad", `${plural(failed, "turn")} failed in the last hour.`, "", "#activity");
    const today = data.events.filter((e) => now - e.at < 86_400_000);
    const crashes = today.filter((e) => /without shutting down/.test(e.text)).length;
    if (crashes) add("warn", `Axis stopped without shutting down ${crashes === 1 ? "once" : `${crashes} times`} in the last 24 hours.`, "", "#activity");
    const drops = today.filter((e) => e.kind === "client" && /stopped answering/.test(e.text)).length;
    if (drops >= 3) add("warn", `Devices dropped off without saying so ${drops} times in the last 24 hours.`, "Check Wi-Fi and power.", "#activity");
  }
  return items.sort((a, b) => (a.level === b.level ? 0 : a.level === "bad" ? -1 : 1));
}

export function AttentionList({ items }) {
  if (!items.length) return html`<div class="att-ok"><span class="dot good">All good</span><span class="dim">Nothing needs attention.</span></div>`;
  return html`<ul class="att" aria-label="Needs attention">
    ${items.map((it) => html`<li key=${it.text} class=${`att-item ${it.level}`}>
      <span class="att-ico" aria-hidden="true">!</span>
      <div class="att-t"><b>${it.text}</b>${it.detail ? html`<div>${it.detail}</div>` : null}</div>
      ${it.action?.kind === "update"
        ? html`<${UpdateButton} client=${it.action.client} />`
        : html`<a class="btn sm ghost" href=${it.href}>Open</a>`}
    </li>`)}
  </ul>`;
}

/** Update a device to the build Axis holds, after asking. */
export function UpdateButton({ client, label, cls = "btn sm" }) {
  const held = heldBuild(client);
  const [busy, setBusy] = useState(false);
  if (!held) return null;
  const go = async () => {
    const ok = await ask({ title: `Update ${client.name}?`, body: `From ${client.version} to ${held.version}. It restarts and is away for about half a minute.`, confirm: "Update" });
    if (!ok) return;
    setBusy(true);
    try {
      toast(await updateDevice(client));
    } catch (error) {
      toast(error.message, "bad");
    }
    setBusy(false);
  };
  return html`<button type="button" class=${cls} disabled=${!client.online || busy} title=${client.online ? "" : "It can update once it is online"} onClick=${go}>${label ?? `Update ${client.name}`}</button>`;
}

// --- the header's health strip ----------------------------------------------------------------

const UP = (v) => (v === "up" ? "good" : v === "down" ? "bad" : "");
function Health({ items }) {
  const s = store.status;
  if (!s) return html`<div class="health" aria-busy="true"><span class="dim">Connecting…</span></div>`;
  const up = s.upstream;
  const usesGateway = store.config?.agent?.backend !== "openai";
  const behindCount = store.clients.filter(behind).length;
  const backup = backupTrouble(store.integrations?.backup);
  const ha = store.integrations?.homeAssistant;
  const gw = store.gateway;
  const links = gw && usesGateway ? (gw.operator.state === "connected" && gw.node.state === "connected" ? "" : gw.operator.state !== "connected" ? "turn link down" : "command link down") : "";
  const bad = items.filter((i) => i.level === "bad").length;
  return html`<div class="health" role="status" aria-label="Health">
    <a class=${`dot ${UP(up.openclaw)}`} href=${(usesGateway ? "#openclaw" : "#agent")} title=${usesGateway ? "OpenClaw gateway" : "Chat endpoint"}><b>Agent</b> <span class="dim">${usesGateway ? (links || "OpenClaw") : "chat endpoint"}</span></a>
    <a class=${`dot ${UP(up.stt)}`} href=${"#speech"}><b>Recognition</b></a>
    <a class=${`dot ${UP(up.tts)}`} href=${"#speech"}><b>Synthesis</b></a>
    <a class=${`dot ${s.clientsOnline ? "good" : ""}`} href="#clients"><b>${s.clientsOnline} of ${s.clientsKnown}</b> <span class="dim">devices online</span></a>
    ${behindCount ? html`<a class="dot warn" href="#clients?behind">${plural(behindCount, "update")} waiting</a>` : null}
    ${backup ? html`<a class="dot bad" href="#system/backup" title=${backup}>Backup</a>` : null}
    ${ha && !ha.connected ? html`<a class="dot bad" href="#integrations">Home Assistant</a>` : null}
    ${store.pollError ? html`<span class="dot bad" title=${store.pollError}>Axis not answering</span>` : null}
    <span class="grow"></span>
    ${items.length
      ? html`<a class=${`att-count ${bad ? "bad" : ""}`} href="#overview" title="Needs attention"><b>${items.length}</b> to check</a>`
      : html`<a class="att-count ok" href="#overview">all good</a>`}
  </div>`;
}

// --- the sidebar ------------------------------------------------------------------------------

function Sidebar({ route, attention }) {
  const open = kept.get("axis.nav", { devices: true });
  const [, redraw] = useState(0);
  const toggle = (key) => {
    kept.set("axis.nav", { ...open, [key]: !isOpen(key) });
    redraw((n) => n + 1);
  };
  const groupOf = route.page === "device" || route.page === "type" ? "devices" : PAGES[route.page]?.group;
  const isOpen = (key) => open[key] ?? key === groupOf;
  const link = (page, label, count, countKind) => {
    const on = route.page === page || (page === "clients" && route.page === "device" && !store.clients.length);
    return html`<a href=${`#${page}`} class=${on ? "on" : ""} aria-current=${on ? "page" : undefined}>${label ?? PAGES[page].short ?? PAGES[page].title}${count ? html`<span class=${`n ${countKind ?? ""}`}>${count}</span>` : null}</a>`;
  };
  const s = store.status;
  const types = typesInUse();
  const devices = [...store.clients].sort((a, b) => a.name.localeCompare(b.name));
  const firmwareBehind = store.clients.filter(behind).length;
  // Devices mid-turn or waiting for an answer, from the poll's /admin/now.
  const busy = store.now?.clients.length ?? 0;
  // The gateway's mark, as the classic page's: "down" when a link is refused or unreachable, "setup" while not both up.
  const gwMark = gatewayMark(store.gateway);
  // Integrations and System are marked when something of theirs is in trouble (the same as the health strip).
  const haDown = store.integrations?.homeAssistant && !store.integrations.homeAssistant.connected;
  const backupBad = backupTrouble(store.integrations?.backup);
  const groupHead = (g) => html`<button type="button" class="gh" aria-expanded=${isOpen(g.key)} onClick=${() => toggle(g.key)}>
    <${Icon} name=${g.icon} /><span>${g.title}</span><${Icon} name="chev" class=${`chev ${isOpen(g.key) ? "open" : ""}`} />
  </button>`;
  // A link to the page already showing changes no address, so the phone drawer is closed on the tap itself.
  return html`<nav class="side" id="nav" aria-label="Pages" onClick=${(e) => e.target.closest("a") && store.navOpen && set({ navOpen: false })}>
    <a class="brand" href="#overview"><span class="brand-face"><${Face} mode="idle" /></span><span>VorteX Axis</span></a>
    <button type="button" class="find" onClick=${() => set({ cmdk: true })} aria-keyshortcuts="Control+K"><${Icon} name="search" /><span>Search or jump</span><kbd>Ctrl K</kbd></button>
    <div class="nav">
      <a href="#overview" class=${route.page === "overview" ? "toplink on" : "toplink"}><${Icon} name="home" /><span>Overview</span>${attention.length ? html`<span class=${`n ${attention.some((a) => a.level === "bad") ? "bad" : "warn"}`}>${attention.length}</span>` : null}</a>
      ${GROUPS.map((g) => html`<div class="grp" key=${g.key}>
        ${groupHead(g)}
        ${isOpen(g.key)
          ? html`<div class="sub">
              ${g.key === "devices"
                ? html`
                  ${link("clients", "All devices", s ? `${s.clientsOnline}/${s.clientsKnown}` : "")}
                  ${devices.length <= 12 ? devices.map((c) => html`<a key=${c.id} href=${deviceHref(c)} class=${`dev ${route.page === "device" && route.id === c.id ? "on" : ""}`}><i class=${`d ${c.online ? "good" : ""}`}></i><span class="nm">${c.name}</span></a>`) : null}
                  ${types.length ? html`<div class="label">Types</div>` : null}
                  ${types.map((t) => {
                    const n = store.clients.filter((c) => c.type === t.type && behind(c)).length;
                    return html`<a key=${t.type} href=${typeHref(t.type)} class=${route.page === "type" && route.id === t.type ? "on" : ""} title=${t.type}><span class="nm">${typeName(t.type)}</span><span class=${`n ${n ? "warn" : ""}`}>${n ? plural(n, "update") : t.total}</span></a>`;
                  })}
                  <div class="label">For everything</div>
                  ${link("settings")}${link("face")}${link("pair")}`
                : g.pages.map((p) => html`<span key=${p}>${p === "live" ? link(p, null, busy ? `${busy} live` : "", "accent") : p === "openclaw" ? link(p, null, gwMark[0], gwMark[1]) : link(p, null, p === "firmware" && firmwareBehind ? String(firmwareBehind) : "", "warn")}</span>`)}
            </div>`
          : null}
      </div>`)}
      <a href="#integrations" class=${route.page === "integrations" ? "toplink on" : "toplink"}><${Icon} name="plug" /><span>Integrations</span>${haDown ? html`<span class="n bad" title="Home Assistant is not connected">down</span>` : null}</a>
      <a href="#system" class=${route.page === "system" ? "toplink on" : "toplink"}><${Icon} name="gear" /><span>System</span>${backupBad ? html`<span class="n bad" title=${backupBad}>backup</span>` : null}</a>
    </div>
    <div class="foot">
      <${ThemeSwitch} />
      <div class="about">
        <span title="The release of Axis and its web pages">Axis ${s?.version ?? "…"}</span>
        ${s?.commit ? html`<span class="mono" title="The commit this build was made from">${s.commit}</span>` : null}
        ${s ? html`<span title="How devices and Axis talk to each other; it has nothing to do with the release number">protocol ${s.protocol}</span>` : null}
      </div>
    </div>
  </nav>`;
}

export function ThemeSwitch() {
  const choice = themeChoice();
  return html`<div class="seg theme" role="group" aria-label="Theme">
    ${["dark", "light", "system"].map((t) => html`<button type="button" key=${t} aria-pressed=${choice === t} class=${choice === t ? "on" : ""} onClick=${() => setTheme(t)}>${t[0].toUpperCase() + t.slice(1)}</button>`)}
  </div>`;
}

// --- the command bar ----------------------------------------------------------------------------

function settingIndex() {
  const byKey = new Map();
  for (const def of store.builtIns) byKey.set(def.key, { def, types: [] });
  for (const [type, schema] of Object.entries(store.types)) {
    for (const def of schema.settings) {
      const e = byKey.get(def.key) ?? { def, types: [] };
      e.types.push(type);
      byKey.set(def.key, e);
    }
  }
  byKey.delete("capabilitiesOff");
  return [...byKey.values()];
}

function commandItems(route) {
  const items = [];
  for (const [key, p] of Object.entries(PAGES)) {
    const group = GROUPS.find((g) => g.key === p.group)?.title ?? "";
    items.push({ section: "Pages", label: p.title, hint: group, go: `#${key}`, words: `${p.title} ${group} ${p.purpose ?? ""}` });
  }
  for (const t of typesInUse()) items.push({ section: "Pages", label: typeName(t.type), hint: `Type · ${plural(t.total, "device")}`, go: typeHref(t.type), words: `${typeName(t.type)} ${t.type} type` });
  for (const c of store.clients) {
    items.push({
      section: "Devices", label: c.name, hint: `${typeName(c.type)}${c.settings.location ? ` · ${c.settings.location}` : ""} · ${c.online ? "online" : "offline"}`,
      go: deviceHref(c), words: `${c.name} ${c.type} ${typeName(c.type)} ${c.settings.location ?? ""} ${c.id}`, client: c,
    });
  }
  // A setting opens where it can be set: on the device or type being looked at, else for everything.
  const here = route.page === "device" ? deviceHref(route.id, "settings") : route.page === "type" ? typeHref(route.id, "settings") : "#settings";
  const where = route.page === "device" ? clientById(route.id)?.name ?? "this device" : route.page === "type" ? `every ${typeName(route.id)}` : "everything";
  for (const { def, types } of settingIndex()) {
    if (route.page === "device" && !store.types[clientById(route.id)?.type]?.settings.some((d) => d.key === def.key)) continue;
    if (route.page === "type" && !store.types[route.id]?.settings.some((d) => d.key === def.key)) continue;
    items.push({ section: "Settings", label: def.label, hint: `${def.group ?? ""} · set for ${where}${types.length && route.page === "settings" ? "" : ""}`, go: `${here}?key=${enc(def.key)}`, words: `${def.label} ${def.key} ${def.group ?? ""}` });
  }
  const actions = [
    { label: "New pairing code", hint: "Add a device", go: "#pair?new" },
    { label: "Say something…", hint: "on every device, a place or one device", run: focusSay, words: "say something announce speak message" },
    { label: "Back up now", hint: "a backup of the hub's settings and history", run: backUpNow, words: "back up backup now save copy" },
    { label: "Check the gateway again", hint: "what Axis relies on in OpenClaw", run: () => checkAgain().then((c) => toast(c.asked ? `Asked the gateway: ${plural(c.checks.filter((x) => x.state === "problem").length, "problem")}.` : "Nothing to ask: Axis is not connected to an OpenClaw gateway.", c.checks?.some((x) => x.state === "problem") ? "bad" : "good"), (e) => toast(e.message, "bad")), go: "#openclaw", words: "check gateway again openclaw selfcheck" },
    { label: "Reconnect gateway", hint: "OpenClaw links", run: () => reconnectGateway().then(() => toast("Reconnecting to the gateway."), (e) => toast(e.message, "bad")), words: "reconnect gateway openclaw retry" },
    { label: "Clear live words now", hint: "delete the words of recent turns", run: () => clearLive().catch((e) => toast(e.message, "bad")), words: "clear live words turns forget" },
    { label: "Download a copy of the database", hint: "System › Backup", run: () => download("/admin/backup/download", `axis-${new Date().toISOString().slice(0, 10)}.sqlite`).catch((e) => toast(e.message, "bad")), words: "download backup database copy sqlite" },
    { label: "Upload a firmware build", hint: "Firmware", go: "#firmware", words: "upload firmware build bin" },
    { label: "Add a wake word", hint: "Wake words", go: "#wakewords", words: "add upload wake word model tflite" },
    { label: "Theme: dark", run: () => setTheme("dark") },
    { label: "Theme: light", run: () => setTheme("light") },
    { label: "Theme: as the system", run: () => setTheme("system") },
    { label: "Sign out", run: () => signOut() },
  ];
  for (const c of store.clients) {
    const find = findAction(c);
    if (find && c.online) actions.push({ label: `Find ${c.name}`, hint: "chime and flash", run: () => runFind(c, find), words: `find ${c.name}` });
    if (behind(c) && c.online) actions.push({ label: `Update ${c.name}`, hint: `to ${heldBuild(c).version}`, run: () => document.querySelector(`[data-update="${c.id}"]`)?.click() ?? (location.hash = deviceHref(c)), words: `update ${c.name}`, go: deviceHref(c) });
  }
  for (const a of actions) items.push({ section: "Actions", words: a.words ?? a.label, ...a });
  return items;
}

async function backUpNow() {
  if (!(await ask({ title: "Back up now?", body: "Axis makes a backup of its settings and history now, as it does on its schedule.", confirm: "Back up" }))) return;
  try {
    await api("POST", "/admin/backup");
    toast("Backup made.");
    loadSlow();
  } catch (error) {
    toast(error.message, "bad");
  }
}

async function runFind(client, action) {
  try {
    const r = await runCommand(client, action);
    toast(r.ok ? `${client.name} is chiming and flashing now.` : r.text, r.ok ? "good" : "bad");
  } catch (error) {
    toast(error.message, "bad");
  }
}

function score(item, words) {
  const hay = item.words.toLowerCase();
  const label = item.label.toLowerCase();
  let total = 0;
  for (const w of words) {
    if (label.startsWith(w)) total += 3;
    else if (label.includes(w)) total += 2;
    else if (hay.includes(w)) total += 1;
    else return 0;
  }
  return total;
}

function CommandBar({ route }) {
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef();
  const list = useRef();
  useEffect(() => input.current?.focus(), []);
  const all = useMemo(() => commandItems(route), [route, store.clients, store.types]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = words.length
    ? all.map((it) => [it, score(it, words)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || a[0].label.length - b[0].label.length).map(([it]) => it).slice(0, 40)
    : all.filter((it) => it.section === "Pages" || it.section === "Devices").slice(0, 24);
  const sections = ["Devices", "Settings", "Pages", "Actions"].map((s) => [s, found.filter((it) => it.section === s)]).filter(([, l]) => l.length);
  const flat = sections.flatMap(([, l]) => l);
  const chosen = Math.min(index, Math.max(0, flat.length - 1));
  const close = () => set({ cmdk: false });
  const pick = (item, alt) => {
    close();
    if (alt && item.client) {
      const find = findAction(item.client);
      if (find) return runFind(item.client, find);
    }
    if (item.run) return item.run();
    if (item.go.startsWith("/")) location.href = item.go;
    else location.hash = item.go;
  };
  useEffect(() => list.current?.querySelector(".cmdk-it.on")?.scrollIntoView({ block: "nearest" }), [chosen, q]);
  const key = (event) => {
    if (event.key === "ArrowDown") (event.preventDefault(), setIndex((chosen + 1) % Math.max(1, flat.length)));
    else if (event.key === "ArrowUp") (event.preventDefault(), setIndex((chosen - 1 + flat.length) % Math.max(1, flat.length)));
    else if (event.key === "Enter" && flat[chosen]) (event.preventDefault(), pick(flat[chosen], event.altKey));
    else if (event.key === "Escape") (event.preventDefault(), close());
    else if (event.key === "Tab") event.preventDefault();
  };
  let n = -1;
  const mark = (label) => {
    const w = words.find((w) => label.toLowerCase().includes(w));
    if (!w) return label;
    const at = label.toLowerCase().indexOf(w);
    return html`${label.slice(0, at)}<mark>${label.slice(at, at + w.length)}</mark>${label.slice(at + w.length)}`;
  };
  return html`<div class="cmdk-shade" onClick=${close}></div>
    <div class="cmdk" role="dialog" aria-modal="true" aria-label="Search or jump">
      <div class="cmdk-in"><${Icon} name="search" />
        <input ref=${input} value=${q} placeholder="Devices, settings, pages, actions" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="cmdk-list"
          aria-activedescendant=${flat.length ? `cmdk-${chosen}` : undefined} onInput=${(e) => (setQ(e.target.value), setIndex(0))} onKeyDown=${key} spellcheck="false" autocomplete="off" />
        <kbd>Esc</kbd></div>
      <div class="cmdk-list" id="cmdk-list" role="listbox" ref=${list}>
        ${flat.length ? null : html`<p class="empty">Nothing matches “${q}”.</p>`}
        ${sections.map(([name, l]) => html`<div class="cmdk-sec" key=${name}><div class="caps">${name}</div>
          ${l.map((it) => {
            n++;
            const i = n;
            return html`<div key=${it.section + it.label + it.go} id=${`cmdk-${i}`} role="option" aria-selected=${i === chosen} class=${`cmdk-it ${i === chosen ? "on" : ""}`}
              onMouseMove=${() => i !== chosen && setIndex(i)} onClick=${(e) => pick(it, e.altKey)}>
              <span class="tt">${mark(it.label)}${it.hint ? html`<span>${it.hint}</span>` : null}</span>
              ${i === chosen ? html`<kbd>↵</kbd>` : null}
            </div>`;
          })}
        </div>`)}
      </div>
      <div class="cmdk-f"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Alt</kbd> <kbd>↵</kbd> find device</span></div>
    </div>`;
}

// --- dialogs and toasts -------------------------------------------------------------------------

function Dialog({ d }) {
  const [text, setText] = useState(d.input?.value ?? "");
  const box = useRef();
  useEffect(() => {
    const first = box.current.querySelector("input, .btn.primary, .btn.danger-solid");
    first?.focus();
    first?.select?.();
  }, []);
  const ok = d.typed ? text.trim() === d.typed : true;
  const confirm = () => ok && d.done(d.input ? text : true);
  const key = (event) => {
    if (event.key === "Escape") (event.preventDefault(), d.done(null));
    if (event.key === "Tab") {
      // Focus stays inside the dialog.
      const all = [...box.current.querySelectorAll("button, input, a[href]")].filter((e) => !e.disabled);
      const at = all.indexOf(document.activeElement);
      if (event.shiftKey && at <= 0) (event.preventDefault(), all.at(-1).focus());
      else if (!event.shiftKey && at === all.length - 1) (event.preventDefault(), all[0].focus());
    }
  };
  return html`<div class="shade on" onClick=${() => d.done(null)}></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref=${box} onKeyDown=${key}>
      <h2 id="dialog-title">${d.title}</h2>
      ${d.body ? html`<p>${d.body}</p>` : null}
      ${d.input || d.typed
        ? html`<label class="dlabel"><span>${d.input?.label ?? html`Type <b>${d.typed}</b> to confirm`}</span>
            <input class="field" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && confirm()} spellcheck="false" autocomplete="off" placeholder=${d.input?.placeholder ?? ""} />
          </label>`
        : null}
      <div class="dactions">
        <button type="button" class="btn" onClick=${() => d.done(null)}>${d.cancel}</button>
        <button type="button" class=${d.danger ? "btn danger-solid" : "btn primary"} disabled=${!ok} onClick=${confirm}>${d.confirm}</button>
      </div>
    </div>`;
}

function Toasts() {
  return html`<div class="toasts" aria-live="polite">
    ${store.toasts.map((t) => html`<div key=${t.id} class=${`toast ${t.kind}`} role=${t.kind === "bad" ? "alert" : "status"}>
      <span>${t.text}</span>
      ${t.undo ? html`<button type="button" class="btn sm" onClick=${() => (dropToast(t.id), t.undo())}>Undo</button>` : null}
      <button type="button" class="x" aria-label="Close" onClick=${() => dropToast(t.id)}><${Icon} name="close" /></button>
    </div>`)}
  </div>`;
}

// --- sign-in --------------------------------------------------------------------------------

function SignIn() {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const submit = (event) => {
    event.preventDefault();
    signIn(value, remember);
    setValue("");
  };
  return html`<form class="signin" id="signin-form" onSubmit=${submit}>
    <span class="signin-face"><${Face} mode="idle" /></span>
    <h1>VorteX Axis</h1>
    <label for="token">Admin token</label>
    <input id="token" class="field" type="password" autocomplete="off" required autofocus value=${value} onInput=${(e) => setValue(e.target.value)} />
    <p class="help">The <code>AXIS_ADMIN_TOKEN</code> value from the hub's <code>.env</code>.</p>
    <label class="remember"><input id="remember" type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.target.checked)} /> Remember on this device</label>
    <p class="help">Unticked, the token is kept for this tab only. Ticked, this browser keeps it until you sign out.</p>
    <button class="btn primary" type="submit">Sign in</button>
    <p class="msg bad" id="signin-error" role="alert">${store.signInError}</p>
    <${ThemeSwitch} />
  </form>`;
}

// --- page header ------------------------------------------------------------------------------

function PageHead({ title, purpose, crumb, children }) {
  return html`<header class="ph">
    <div class="grow">${crumb ? html`<div class="crumb">${crumb}</div>` : null}<h1>${title}</h1>${purpose ? html`<p class="s">${purpose}</p>` : null}</div>
    ${children ? html`<div class="ph-acts">${children}</div>` : null}
  </header>`;
}
export { PageHead };

// --- the app ----------------------------------------------------------------------------------

function Page({ route, attention }) {
  if (!store.loaded) return html`<div class="loading" aria-busy="true"><span class="spinner"></span> Loading…</div>`;
  switch (route.page) {
    case "overview": return html`<${Overview} attention=${attention} />`;
    case "live": return html`<${Live} tab=${route.tab} />`;
    case "activity": return html`<${History} />`;
    case "clients": return html`<${AllDevices} />`;
    case "device": return html`<${DevicePage} id=${route.id} tab=${route.tab} focusKey=${route.key} />`;
    case "type": return html`<${TypePage} type=${route.id} tab=${route.tab} focusKey=${route.key} />`;
    case "settings": return html`<${Defaults} focusKey=${route.key} />`;
    case "pair": return html`<${AddDevice} />`;
    case "agent": return html`<${AgentPage} />`;
    case "openclaw": return html`<${OpenClawPage} />`;
    case "tools": return html`<${ToolsPage} />`;
    case "speech": return html`<${SpeechPage} />`;
    case "voices": return html`<${VoicesPage} />`;
    case "face": return html`<${FacePage} />`;
    case "firmware": return html`<${FirmwarePage} />`;
    case "wakewords": return html`<${WakeWordsPage} />`;
    case "apps": return html`<${AppsPage} />`;
    case "integrations": return html`<${IntegrationsPage} />`;
    case "system": return html`<${SystemPage} tab=${route.tab} />`;
    default: return html`<${Overview} attention=${attention} />`;
  }
}

function where(route) {
  if (route.page === "device") return clientById(route.id)?.name ?? "Device";
  if (route.page === "type") return typeName(route.id);
  return PAGES[route.page]?.short ?? PAGES[route.page]?.title ?? "";
}

export function App() {
  useStore();
  const route = useRoute();
  useEffect(() => {
    const key = (event) => {
      const typing = event.target.closest?.("input, textarea, select, [contenteditable]");
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        if (!store.signedIn) return;
        event.preventDefault();
        set({ cmdk: !store.cmdk });
      } else if (event.key === "/" && !typing && store.signedIn && !store.dialog) {
        event.preventDefault();
        set({ cmdk: true });
      } else if (event.key === "Escape" && store.navOpen) set({ navOpen: false });
    };
    window.addEventListener("keydown", key);
    if (hasToken()) signIn();
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    document.title = `${where(route) || "Admin"} · VorteX Axis`;
  }, [route, store.clients]);
  if (!store.signedIn) return html`<${SignIn} /><${Toasts} />`;
  const attention = attentionItems();
  return html`<a class="skip" href="#main">Skip to the page</a>
    <div class=${`shell ${store.navOpen ? "nav-open" : ""}`} id="app">
      <div class="shade" onClick=${() => set({ navOpen: false })}></div>
      <${Sidebar} route=${route} attention=${attention} />
      <div class="col">
        <header class="top">
          <button type="button" class="icon-btn menu" id="menu" aria-label="Menu" aria-expanded=${store.navOpen} aria-controls="nav" onClick=${() => set({ navOpen: !store.navOpen })}><${Icon} name="menu" /></button>
          <span class="where" id="where">${where(route)}</span>
          <button type="button" class="icon-btn srch" aria-label="Search or jump" onClick=${() => set({ cmdk: true })}><${Icon} name="search" /></button>
          <${Health} items=${attention} />
          <button type="button" class="btn ghost sm signout" id="signout" onClick=${() => signOut()}>Sign out</button>
        </header>
        <main id="main" tabindex="-1">
          <${Page} route=${route} attention=${attention} />
        </main>
      </div>
    </div>
    ${store.cmdk ? html`<${CommandBar} route=${route} />` : null}
    ${store.dialog ? html`<${Dialog} d=${store.dialog} />` : null}
    <${Toasts} />`;
}
