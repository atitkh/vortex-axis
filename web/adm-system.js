// Integrations and System on the admin page: Home Assistant, live activities and
// notifications to browsers on one page; the hub's own housekeeping (public address, clock and keeping, backup, about)
// on the other. Both edit GET/PATCH /admin/integrations; settings are staged with the save bar, actions run at once.

import { html, useEffect, useState } from "/web/preact.js";
import { Button, ago, api, ask, deviceHref, download, enc, loadSlow, plural, signOut, span, store, toast } from "/web/adm-core.js";
import { SaveBar } from "/web/adm-settings.js";
import { PAGES, PageHead } from "/web/adm-shell.js";
import { F, Loading, copy, Stat, Switch, Text, saveForm, useForm, useLoad } from "/web/adm-agent.js";

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
          <p class="help">Tasks that run longer than 30 seconds, anything waiting for you, timers of a minute or more and reminders (only once they go off) show on the lock screen and in the Dynamic Island of a phone with the Home Assistant app (iOS 17.2+, app 2026.9+, Home Assistant 2026.7+), through an automation made from the blueprint.</p>
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
    <${WebhooksCard} />
    <p class="help">The OpenClaw gateway's address, links and pairing are on <a href="#openclaw">OpenClaw gateway</a>; MCP is on <a href="#tools">Tools and MCP</a>. Public address, clock, history kept, the battery level for power saver and backup are on <a href="#system">System</a>.</p>
    <${SaveBar} entity=${entity} save=${save} floating />`;
}

// --- Webhooks (a card on Integrations) -----------------------------------------------------------

const CEILING_WORDS = { notify: "shown only", speak: "may be spoken", urgent: "may interrupt" };
const BLANK = { id: "", label: "", auth: "bearer", ceiling: "notify", ratePerMin: 30, maxBody: 16384, targetClient: "", targetLocation: "", targetEverywhere: false, public: false };

function WebhooksCard() {
  const [d, load, error] = useLoad("/admin/hooks", 10_000);
  const [edit, setEdit] = useState(null); // null = closed, else a form; `editing` is the id being changed
  const [made, setMade] = useState(null); // { id, secret } shown once
  const put = (k, v) => setEdit((e) => ({ ...e, [k]: v }));
  const hooks = d?.hooks ?? [];
  const save = async () => {
    const body = { label: edit.label.trim(), ceiling: edit.ceiling, ratePerMin: Number(edit.ratePerMin), maxBody: Number(edit.maxBody), targetClient: edit.targetClient.trim() || null, targetLocation: edit.targetLocation.trim() || null, targetEverywhere: Boolean(edit.targetEverywhere), public: Boolean(edit.public) };
    if (edit.editing) {
      await api("PATCH", `/admin/hooks/${enc(edit.editing)}`, body);
      toast("Saved.");
    } else {
      const r = await api("POST", "/admin/hooks", { ...body, id: edit.id.trim(), auth: edit.auth });
      setMade({ id: r.source.id, secret: r.secret, auth: r.source.auth });
    }
    setEdit(null);
    await load();
  };
  const toggle = async (h) => {
    await api("PATCH", `/admin/hooks/${enc(h.id)}`, { enabled: !h.enabled });
    await load();
  };
  const rotate = async (h) => {
    if (!(await ask({ title: `Make a new secret for ${h.label}?`, body: "The old one stops working at once, so the sender must be given the new one.", confirm: "Rotate", danger: true }))) return;
    const r = await api("POST", `/admin/hooks/${enc(h.id)}/rotate`);
    setMade({ id: h.id, secret: r.secret, auth: h.auth });
  };
  const remove = async (h) => {
    if (!(await ask({ title: `Delete ${h.label}?`, body: "Its address stops existing. Notices it already sent stay in the log.", confirm: "Delete", danger: true }))) return;
    await api("DELETE", `/admin/hooks/${enc(h.id)}`);
    toast(`${h.label} is deleted.`);
    await load();
  };
  const test = async (h) => {
    const r = await api("POST", `/admin/hooks/${enc(h.id)}/test`);
    toast(r.duplicate ? "Sent before: nothing new." : "A test notice was sent.");
    await load();
  };
  const origin = location.origin;
  const field = (label, child) => html`<label class="f"><span class="f-l">${label}</span><div class="f-c f-v">${child}</div></label>`;
  return html`<${Card} id="int-hooks" title="Webhooks" mark=${hooks.length ? [`${hooks.length} source${hooks.length === 1 ? "" : "s"}`, "good"] : ["none", ""]}>
    ${error ? html`<p class="msg bad">${error}</p>` : null}
    ${hooks.length
      ? html`<div class="tablebox"><table class="t" id="hook-list"><tbody>${hooks.map((h) => html`<tr key=${h.id} class=${h.enabled ? "" : "off"}>
          <td><input type="checkbox" class="switch" aria-label=${`${h.label} enabled`} checked=${h.enabled} onChange=${() => toggle(h)} /></td>
          <td>${h.label}<div class="dim sm mono">${origin}${h.path}</div></td>
          <td class="dim">${h.auth === "hmac" ? "signature" : "bearer token"} · ${CEILING_WORDS[h.ceiling]}${h.public ? " · public" : ""}</td>
          <td class="dim">${h.lastSeenAt ? `${ago(h.lastSeenAt)}${h.lastStatus ? ` · ${h.lastStatus}` : ""}` : "never used"}</td>
          <td class="acts">
            <${Button} class="btn sm" run=${() => test(h)}>Send test</${Button}>
            <button type="button" class="btn sm ghost" onClick=${() => setEdit({ ...BLANK, ...h, targetClient: h.targetClient ?? "", targetLocation: h.targetLocation ?? "", editing: h.id })}>Edit</button>
            <${Button} class="btn sm" run=${() => rotate(h)}>Rotate</${Button}>
            <${Button} class="btn sm danger" run=${() => remove(h)}>Delete</${Button}>
          </td></tr>`)}</tbody></table></div>`
      : html`<p class="empty" id="hook-list">No webhook sources yet, so nothing outside Axis can post a notice.</p>`}
    ${made
      ? html`<div class="newtoken" id="hook-made">
          <p class="msg good">${made.auth === "hmac" ? "Signing secret" : "Token"} for ${made.id}. Copy it now: it is not shown again.</p>
          <div class="inline"><input class="field mono grow" id="hook-secret" readonly value=${made.secret} />
            <button type="button" class="btn sm" onClick=${(e) => copy(made.secret, e.currentTarget.previousElementSibling)}>Copy</button>
            <button type="button" class="btn sm primary" id="hook-done" onClick=${() => setMade(null)}>Done</button></div>
        </div>`
      : null}
    ${edit
      ? html`<div class="fgrid" id="hook-form">
          ${edit.editing ? null : field("Address name", html`<input class="field mono" id="hook-id" maxlength="40" placeholder="gitea" spellcheck="false" value=${edit.id} onInput=${(e) => put("id", e.currentTarget.value)} />`)}
          ${field("Label", html`<input class="field" id="hook-label" maxlength="60" placeholder="Gitea" value=${edit.label} onInput=${(e) => put("label", e.currentTarget.value)} />`)}
          ${edit.editing ? null : field("Sent with", html`<select class="field" id="hook-auth" value=${edit.auth} onChange=${(e) => put("auth", e.currentTarget.value)}><option value="bearer">A bearer token</option><option value="hmac">An HMAC signature (Gitea, GitHub)</option></select>`)}
          ${field("Most it may do", html`<select class="field" id="hook-ceiling" value=${edit.ceiling} onChange=${(e) => put("ceiling", e.currentTarget.value)}><option value="notify">Show only, never speak</option><option value="speak">Speak at a device you are at</option><option value="urgent">Urgent ones may interrupt</option></select>`)}
          ${field("Per minute", html`<input class="field num" id="hook-rate" type="number" min="1" max="600" value=${edit.ratePerMin} onInput=${(e) => put("ratePerMin", e.currentTarget.value)} />`)}
          ${field("Largest body (bytes)", html`<input class="field num" id="hook-body" type="number" min="1024" max="262144" value=${edit.maxBody} onInput=${(e) => put("maxBody", e.currentTarget.value)} />`)}
          ${field("Default device", html`<input class="field" id="hook-client" maxlength="120" placeholder="a device name, or empty" value=${edit.targetClient} onInput=${(e) => put("targetClient", e.currentTarget.value)} />`)}
          ${field("Default place", html`<input class="field" id="hook-location" maxlength="120" placeholder="a location, or empty" value=${edit.targetLocation} onInput=${(e) => put("targetLocation", e.currentTarget.value)} />`)}
          ${field("Everywhere", html`<input type="checkbox" class="switch" id="hook-everywhere" checked=${edit.targetEverywhere} onChange=${(e) => put("targetEverywhere", e.currentTarget.checked)} />`)}
          ${field("Under the public name", html`<input type="checkbox" class="switch" id="hook-public" checked=${edit.public} onChange=${(e) => put("public", e.currentTarget.checked)} />`)}
          <div class="inline"><${Button} class="btn primary" id="hook-save" run=${save}>${edit.editing ? "Save" : "Make the source"}</${Button}><button type="button" class="btn ghost" onClick=${() => setEdit(null)}>Cancel</button></div>
        </div>`
      : html`<div class="inline add"><button type="button" class="btn primary" id="hook-new" onClick=${() => setEdit({ ...BLANK })}>Add a source</button></div>`}
    <p class="help">A service posts JSON <code>{"title", "body", "priority"}</code> to its address with the token (or a signature of the body). Notices are shown quietly unless the source may speak; the cap above is the most it can ever do. Asking the agent and an inbox are not built yet.</p>
  </${Card}>`;
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
    messageHoldMinutes: s.messageHoldMinutes, powerSaverBelow: s.powerSaverBelow, dockChargeLimit: s.dockChargeLimit, chargeCurrent: s.chargeCurrent, backupEveryHours: s.backupEveryHours, backupKeepDays: s.backupKeepDays,
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
    <${Card} id="sys-power" title="Devices on battery" mark=${[`${s.powerSaverBelow ? `power saver at ${s.powerSaverBelow}%` : "power saver off"} · Dock ${s.dockChargeLimit}% · charge ${s.chargeCurrent} mA`, ""]}>
      <${F} label="Power saver below" id="sys-powerSaverBelow" dirty=${form.dirty("powerSaverBelow")} help="A device on the Auto profile that reports its battery goes to power saver at or below this level while not charging, and back to normal 10 points above it or as soon as it charges. A profile chosen by hand on a device always wins. 0 switches the rule off.">${num("powerSaverBelow", 0, 90, "%")}</${F}>
      <${F} label="Dock charge limit" id="sys-dockChargeLimit" dirty=${form.dirty("dockChargeLimit")} help="A device on the Dock profile, chosen by hand on its page, charges its battery only to this level while on USB and holds it there, charging again 5 points below. 100 is no limit. Auto never picks Dock.">${num("dockChargeLimit", 50, 100, "%")}</${F}>
      <${F} label="Charge current" id="sys-chargeCurrent" dirty=${form.dirty("chargeCurrent")} help="The most a board's charger draws, for every board. It tapers by itself as the battery fills: full to three quarters of the charge limit, then half, a quarter and a tenth near the limit, a step less again when the power chip runs hot. A board uses the nearest step its chip has below this (25 mA steps to 200, 100 mA steps above). 1000 is 1C for the boards' 1000 mAh cell.">${num("chargeCurrent", 100, 1000, "mA")}</${F}>
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
