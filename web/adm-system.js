// Integrations and System on the new admin page (docs/admin-revamp/ia.md 1): Home Assistant, live activities and
// notifications to browsers on one page; the hub's own housekeeping (public address, clock and keeping, backup, about)
// on the other. Both edit GET/PATCH /admin/integrations; settings are staged with the save bar, actions run at once.

import { html, useEffect, useState } from "/web/preact.js";
import { Button, ago, api, deviceHref, download, enc, loadSlow, plural, signOut, span, store, toast } from "/web/adm-core.js";
import { SaveBar } from "/web/adm-settings.js";
import { PAGES, PageHead } from "/web/adm-shell.js";
import { F, Loading, Stat, Switch, Text, saveForm, useForm, useLoad } from "/web/adm-agent.js";

const Head = ({ page, children }) => html`<${PageHead} title=${PAGES[page].title} purpose=${PAGES[page].purpose}>${children}</${PageHead}>`;
const list = (text) => String(text ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/** The hub settings, read when the page opens and every 10 s; a save also refreshes the header's copy. */
function useIntegrations() {
  const [d, load, error] = useLoad("/admin/integrations", 10_000);
  const reload = async () => {
    const fresh = await load();
    loadSlow();
    return fresh;
  };
  return [d, reload, error];
}

const Card = ({ id, title, mark, children }) => html`<section class="card" id=${id}>
  <div class="card-h"><h3>${title}</h3>${mark ? html`<${Stat} label=${mark[0]} kind=${mark[1]} />` : null}</div>
  <div class="card-b fgrid">${children}</div>
</section>`;
const Row = ({ label, children, id }) => html`<div class="f" id=${id}><span class="f-l">${label}</span><div class="f-c f-v">${children}</div></div>`;

// --- Integrations (#integrations) -----------------------------------------------------------------

const MQTT_KEYS = ["host", "port", "user", "password", "discoveryPrefix"];

export function IntegrationsPage() {
  const entity = "page:integrations";
  const [d, load, error] = useIntegrations();
  const s = d?.settings;
  const saved = s && { host: s.mqtt.host, port: s.mqtt.port, user: s.mqtt.user, password: "", discoveryPrefix: s.mqtt.discoveryPrefix, liveActivities: s.liveActivities };
  const form = useForm(entity, saved);
  if (!d) return html`<${Head} page="integrations" />${error ? html`<p class="msg bad">${error}</p>` : html`<${Loading} />`}`;
  const ha = d.homeAssistant;
  const live = d.liveActivities;
  const push = d.notifications;
  const apply = async (v, keys) => {
    const body = {};
    if (MQTT_KEYS.some((k) => keys.has(k))) {
      body.mqtt = { host: String(v.host ?? "").trim(), port: Number(v.port), user: String(v.user ?? "").trim(), password: v.password ?? "", discoveryPrefix: String(v.discoveryPrefix ?? "").trim() };
    }
    if (keys.has("liveActivities")) body.liveActivities = Boolean(v.liveActivities);
    await api("PATCH", "/admin/integrations", body);
    await load();
  };
  const save = () => saveForm(entity, saved, apply, { secrets: ["password"], words: (st) => (Object.keys(st).some((k) => MQTT_KEYS.includes(k)) ? "Home Assistant: saved. Axis connects to the broker again." : `Live activities ${st.liveActivities ? "on" : "off"}.`) });

  const usable = Boolean(ha?.connected);
  const blueprint = live ? new URL(live.blueprint, location.origin).href : "";
  const heard = live?.lastAck ? `${ago(live.lastAck.at)}${live.lastAck.phone ? `, by ${live.lastAck.phone}` : ""}` : null;
  const liveTest = async () => {
    const { sent, phones } = await api("POST", "/admin/integrations/live-test");
    if (!sent) toast("Not sent: the MQTT broker is out of reach.", "bad");
    else if (!phones.length) toast("Sent, but Home Assistant did not pass it on. Is an automation made from the blueprint, and on?", "bad");
    else toast(`Home Assistant passed a 30 second test to ${phones.join(", ")}.`);
    await load();
  };
  const notifyTest = async (c) => {
    const told = await api("POST", `/admin/clients/${enc(c.id)}/notify-test`);
    toast(`Test notification sent to ${told.sent}.`);
  };

  return html`<${Head} page="integrations" />
    <${Card} id="int-ha" title="Home Assistant" mark=${ha ? (ha.connected ? ["connected", "good"] : ["not connected", "bad"]) : ["off", ""]}>
      <${F} label="MQTT broker" id="ha-host" dirty=${form.dirty("host")} help="The host name or address of the broker Home Assistant uses. Empty switches the link off."><${Text} form=${form} k="host" id="ha-host" mono placeholder="192.168.1.10" /></${F}>
      <${F} label="Port" id="ha-port" dirty=${form.dirty("port")}><${Text} form=${form} k="port" id="ha-port" type="number" min="1" max="65535" class="field num" /></${F}>
      <${F} label="Signs in as" id="ha-user" dirty=${form.dirty("user")}><${Text} form=${form} k="user" id="ha-user" placeholder="no name" /></${F}>
      <${F} label="Password" id="ha-password" dirty=${form.dirty("password")} help="Never shown again once saved."><${Text} form=${form} k="password" id="ha-password" type="password" placeholder=${s.mqtt.passwordSet ? "set; leave empty to keep" : "none"} /></${F}>
      <${F} label="Discovery prefix" id="ha-prefix" dirty=${form.dirty("discoveryPrefix")} help="homeassistant, unless it was changed in Home Assistant."><${Text} form=${form} k="discoveryPrefix" id="ha-prefix" mono /></${F}>
      ${ha ? html`<${Row} label=${ha.connected ? "Connected" : "Last error"}>${ha.connected ? ago(ha.connectedAt) : ha.error ?? "none yet; still trying"}</${Row}>
        <${Row} label="Devices published">${ha.connected ? `${ha.devices}, plus the hub itself` : "none while the broker is unreachable"}</${Row}>` : null}
      <p class="help">Every device appears in Home Assistant as a device: its state, whether it is online, a say entity and its volume. The hub has Say everywhere and a count of devices online. Home Assistant needs its MQTT integration with discovery on. Saving reconnects.</p>
    </${Card}>
    ${live
      ? html`<${Card} id="int-live" title="Live activities on phones"
          mark=${!usable ? ["needs Home Assistant", ""] : !s.liveActivities ? ["off", ""] : heard ? ["on", "good"] : live.sent ? ["no answer from Home Assistant", "warn"] : ["on, nothing sent yet", ""]}>
          <${F} label="Live activities" dirty=${form.dirty("liveActivities")}><${Switch} form=${form} k="liveActivities" label=${form.value("liveActivities") ? "on" : "off"} disabled=${!usable && !s.liveActivities} /></${F}>
          <${Row} label="Blueprint"><a href=${`https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=${encodeURIComponent(blueprint)}`} target="_blank" rel="noopener">Import into Home Assistant ↗</a> or add it by address: <span class="mono">${blueprint}</span></${Row}>
          ${s.liveActivities && usable
            ? html`<${Row} label="Showing now">${plural(live.showing, "activity", "activities")}</${Row}>
              <${Row} label="Home Assistant passed one on">${heard ?? (live.sent ? `not yet; Axis sent ${plural(live.sent, "update")}. Is an automation made from the blueprint?` : "nothing sent yet")}</${Row}>
              <${Row} label=""><${Button} class="btn" id="live-test" run=${liveTest}>Send a test</${Button}></${Row}>`
            : null}
          <p class="help">Tasks that run longer than 30 seconds, anything waiting for you and timers of a minute or more show on the lock screen and in the Dynamic Island of a phone with the Home Assistant app (iOS 17.2+, app 2026.9+, Home Assistant 2026.7+), through an automation made from the blueprint.</p>
        </${Card}>`
      : null}
    <${Card} id="int-push" title="Notifications to browsers" mark=${push.clients.length ? [plural(push.clients.length, "browser"), "good"] : ["no browser has them on", ""]}>
      ${push.clients.length
        ? html`<div class="tablebox"><table class="t" id="push-list"><tbody>${push.clients.map((c) => html`<tr key=${c.id}>
            <td><a href=${deviceHref(c.id)}>${c.name}</a></td><td class="dim">${c.online ? "page open" : "page closed"}${c.waiting ? ` · ${plural(c.waiting, "message")} waiting` : ""}</td>
            <td class="acts"><${Button} class="btn sm" run=${() => notifyTest(c)}>Send a test</${Button}></td></tr>`)}</tbody></table></div>`
        : html`<p class="dim">None of ${plural(push.browsers, "browser client")} has turned them on.</p>`}
      <p class="help">A browser whose page is closed gets speech and questions as notifications, once somebody presses Turn on notifications in it. That is done in the browser itself.</p>
    </${Card}>
    <p class="help">The OpenClaw gateway's address, links and pairing are on <a href="#openclaw">OpenClaw gateway</a>; MCP is on <a href="#tools">Tools and MCP</a>. Public address, clock, history kept and backup are on <a href="#system">System</a>.</p>
    <${SaveBar} entity=${entity} save=${save} floating />`;
}

// --- System (#system) -----------------------------------------------------------------------------

const SECTIONS = { network: "sys-network", clock: "sys-clock", backup: "sys-backup", about: "sys-about" };

function backupMark(b) {
  if (!b?.configured) return ["off", ""];
  if (b.running) return ["copying now", "warn"];
  if (!b.last) return ["no copy made yet", "warn"];
  if (!b.last.ok) return ["last copy failed", "bad"];
  if (b.overdue) return ["overdue", "bad"];
  return ["copied", "good"];
}

let zones;
export function SystemPage({ tab }) {
  const entity = "page:system";
  const [d, load, error] = useIntegrations();
  const s = d?.settings;
  const saved = s && {
    publicHosts: s.publicHosts.join(", "), trustedProxies: s.trustedProxies.join(", "), timeZone: s.timeZone, activityDays: s.activityDays,
    messageHoldMinutes: s.messageHoldMinutes, backupEveryHours: s.backupEveryHours, backupKeepDays: s.backupKeepDays,
  };
  const form = useForm(entity, saved);
  useEffect(() => {
    if (!d || !SECTIONS[tab]) return;
    requestAnimationFrame(() => document.getElementById(SECTIONS[tab])?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, [tab, Boolean(d)]);
  zones ??= Intl.supportedValuesOf?.("timeZone") ?? [];
  if (!d) return html`<${Head} page="system" />${error ? html`<p class="msg bad">${error}</p>` : html`<${Loading} />`}`;
  const b = d.backup;
  const st = store.status;
  const apply = async (v, keys) => {
    const body = {};
    for (const k of keys) body[k] = k === "publicHosts" || k === "trustedProxies" ? list(v[k]) : k === "timeZone" ? String(v[k]).trim() : Number(v[k]);
    await api("PATCH", "/admin/integrations", body);
    await load();
  };
  const save = () => saveForm(entity, saved, apply, { words: (x) => `${plural(Object.keys(x).length, "change")} saved. ${"publicHosts" in x || "trustedProxies" in x ? "It takes effect on the next request." : ""}`.trim() });
  const backUp = async () => {
    await api("POST", "/admin/backup");
    toast("Backup made.");
    await load();
  };
  const num = (k, min, max, unit) => html`<span class="unit"><${Text} form=${form} k=${k} id=${`sys-${k}`} type="number" min=${min} max=${max} class="field num" /> ${unit}</span>`;
  return html`<${Head} page="system" />
    <${Card} id="sys-network" title="Public address" mark=${s.publicHosts.length ? ["set", "good"] : ["local network only", ""]}>
      <${F} label="Names" id="sys-publicHosts" dirty=${form.dirty("publicHosts")} help="Names Axis is reached by from outside, separated by commas, without https://. Under these only the client side answers: the admin pages and the admin API do not. The name you are using this page at cannot be made public.">
        <${Text} form=${form} k="publicHosts" id="sys-publicHosts" mono placeholder="axis.example.org" /></${F}>
      <${F} label="Trusted proxies" id="sys-trustedProxies" dirty=${form.dirty("trustedProxies")} help="Addresses of reverse proxies whose word on who is calling is believed. Leave empty unless Axis sits behind one.">
        <${Text} form=${form} k="trustedProxies" id="sys-trustedProxies" mono placeholder="none" /></${F}>
    </${Card}>
    <${Card} id="sys-clock" title="Clock and keeping" mark=${[s.timeZone, ""]}>
      <${F} label="Time zone" id="sys-timeZone" dirty=${form.dirty("timeZone")} help=${`Quiet hours and the history's days are told by this clock. It is ${new Date().toLocaleTimeString([], { timeZone: zones.includes(s.timeZone) ? s.timeZone : undefined, hour: "2-digit", minute: "2-digit" })} there now.`}>
        <${Text} form=${form} k="timeZone" id="sys-timeZone" list="zone-list" placeholder="America/Chicago" />
        <datalist id="zone-list">${zones.map((z) => html`<option key=${z} value=${z} />`)}</datalist></${F}>
      <${F} label="History kept" id="sys-activityDays" dirty=${form.dirty("activityDays")} help="Days of turns, events and wake word scores. Shortening it deletes what is now too old.">${num("activityDays", 1, 365, "days")}</${F}>
      <${F} label="Messages kept" id="sys-messageHoldMinutes" dirty=${form.dirty("messageHoldMinutes")} help="Minutes a message waits for a device that is away and cannot be notified. 0 keeps none.">${num("messageHoldMinutes", 0, 1440, "minutes")}</${F}>
    </${Card}>
    <${Card} id="sys-backup" title="Backup" mark=${backupMark(b)}>
      ${b?.configured
        ? html`
          <${F} label="Copy every" id="sys-backupEveryHours" dirty=${form.dirty("backupEveryHours")} help="Hours between copies. 0 makes one only when Back up now is pressed.">${num("backupEveryHours", 0, 168, "hours")}</${F}>
          <${F} label="Daily copies kept" id="sys-backupKeepDays" dirty=${form.dirty("backupKeepDays")} help="Besides the latest copy, one copy of the database a day is kept this long.">${num("backupKeepDays", 1, 365, "days")}</${F}>
          <${Row} label="Folder"><span class="mono">${b.dir}</span> <span class="dim">inside the container</span></${Row}>
          ${b.last ? html`<${Row} label="Last run" id="sys-backup-last">${ago(b.last.at)} (${new Date(b.last.at).toLocaleString()})</${Row}>` : null}
          ${b.last?.ok ? html`<${Row} label="It took">${b.last.ms < 1000 ? `${b.last.ms} ms` : `${(b.last.ms / 1000).toFixed(1)} s`} for a ${(b.last.bytes / 1024 / 1024).toFixed(1)} MB database</${Row}>` : null}
          ${b.last && !b.last.ok ? html`<${Row} label="What went wrong"><span class="msg bad">${b.last.error}</span></${Row}>` : null}
          <p class="help">Axis copies its database (checked before it replaces the last copy), firmware and wake words into this folder by itself. Which folder on the host it is, is <code>AXIS_BACKUP_PATH</code> in the hub's <code>.env</code>.</p>`
        : html`<p class="help">Set <code>AXIS_BACKUP_PATH</code> in the hub's <code>.env</code> to a folder on the host, ideally on another disk, and start Axis again with <code>docker compose up -d</code>. Axis then copies its database, firmware and wake words there by itself.</p>`}
      <div class="btnrow">
        ${b?.configured ? html`<${Button} class="btn primary" id="backup-now" run=${backUp}>${b.running ? "Copying…" : "Back up now"}</${Button}>` : null}
        <${Button} class="btn" id="backup-download" run=${() => download("/admin/backup/download", `axis-${new Date().toISOString().slice(0, 10)}.sqlite`)}>Download a copy of the database</${Button}>
      </div>
      <p class="help">The download is made now and holds everything the hub knows, its keys and token hashes among it: keep it somewhere private.</p>
    </${Card}>
    <${Card} id="sys-about" title="About">
      <${Row} label="Axis">${st?.version ?? "…"}${st?.commit ? html` <span class="mono dim">${st.commit}</span>` : null}</${Row}>
      <${Row} label="Protocol"><span title="How devices and Axis talk to each other; it has nothing to do with the release number">${st?.protocol ?? "…"}</span></${Row}>
      <${Row} label="Running for">${st ? `${span(Date.now() - st.startedAt)}, since ${new Date(st.startedAt).toLocaleString()}` : "…"}</${Row}>
      <${Row} label="Data folder"><span class="mono">${d.dataDir}</span> <span class="dim">inside the container</span></${Row}>
      <${Row} label="Devices">${st ? `${st.clientsOnline} of ${st.clientsKnown} online` : "…"} · <a href="#clients">All devices</a></${Row}>
      <${Row} label="This browser"><${Button} class="btn" id="system-signout" run=${() => signOut()}>Sign out</${Button}></${Row}>
    </${Card}>
    <${SaveBar} entity=${entity} save=${save} floating />`;
}
