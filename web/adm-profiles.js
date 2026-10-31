// Profiles on the admin page: the named sets of overrides a device can be put on (server/src/profiles.ts).
// Each card edits one profile and saves it on its own with PUT /admin/profiles/:name; nothing is staged.

import { html, useState } from "/web/preact.js";
import { Button, api, ask, enc, refresh, toast } from "/web/adm-core.js";
import { PAGES, PageHead } from "/web/adm-shell.js";
import { Loading, useLoad } from "/web/adm-agent.js";
import { CAPABILITY_OFF } from "/web/adm-settings.js";

const rowsOf = (map) => Object.entries(map ?? {}).map(([key, value]) => ({ key, value: String(value) }));
const CAPS = Object.keys(CAPABILITY_OFF);
const scalar = (text) => (text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text);

function ProfileCard({ profile, keys, onChange }) {
  const [label, setLabel] = useState(profile.label ?? "");
  const [set, setSet] = useState(rowsOf(profile.set));
  const [cap, setCap] = useState(rowsOf(profile.cap));
  const [off, setOff] = useState(profile.capabilitiesOff ?? []);
  const [dirty, setDirty] = useState(false);
  const capNames = CAPS;
  const flip = (c, on) => { setOff(on ? [...off, c] : off.filter((x) => x !== c)); setDirty(true); };
  // Nothing can answer a question: no mic, and no screen to tap.
  const stuck = off.includes("mic") && (off.includes("touch") || off.includes("screen"));
  const edit = (setter, rows) => { setter(rows); setDirty(true); };
  const rowEditor = (rows, setter, what, numeric) => html`<div class="prof-rows" data-rows=${what}>
    ${rows.map((row, i) => html`<div class="prof-row" key=${i}>
      <input class="field mono" list="profile-keys" placeholder="setting" aria-label=${`${what} setting`} value=${row.key} onInput=${(e) => edit(setter, rows.map((r, j) => (j === i ? { ...r, key: e.currentTarget.value.trim() } : r)))} />
      <input class="field" type=${numeric ? "number" : "text"} step=${numeric ? "any" : undefined} placeholder="value" aria-label=${`${what} value`} value=${row.value} onInput=${(e) => edit(setter, rows.map((r, j) => (j === i ? { ...r, value: e.currentTarget.value } : r)))} />
      <button type="button" class="btn" aria-label="Remove row" onClick=${() => edit(setter, rows.filter((_, j) => j !== i))}>Remove</button>
    </div>`)}
    <button type="button" class="btn" data-add=${what} onClick=${() => edit(setter, [...rows, { key: "", value: "" }])}>Add ${what} row</button>
  </div>`;
  const save = async () => {
    const body = { set: {}, cap: {}, capabilitiesOff: capNames.filter((c) => off.includes(c)) };
    if (label.trim()) body.label = label.trim();
    for (const { key, value } of set.filter((r) => r.key)) body.set[key] = scalar(value);
    for (const { key, value } of cap.filter((r) => r.key)) {
      if (value.trim() === "" || !Number.isFinite(Number(value))) throw new Error(`cap ${key} needs a number`);
      body.cap[key] = Number(value);
    }
    onChange((await api("PUT", `/admin/profiles/${enc(profile.name)}`, body)).profiles);
    setDirty(false);
    toast(`Profile ${profile.name} saved`);
  };
  const reset = async () => {
    if (!(await ask({ title: `Reset ${profile.name}?`, body: "Puts it back to the default it ships with.", confirm: "Reset" }))) return;
    onChange((await api("POST", `/admin/profiles/${enc(profile.name)}/reset`)).profiles);
    toast(`Profile ${profile.name} reset`);
  };
  const remove = async () => {
    if (!(await ask({ title: `Delete ${profile.name}?`, body: "Devices on it go back to auto.", confirm: "Delete", danger: true }))) return;
    onChange((await api("DELETE", `/admin/profiles/${enc(profile.name)}`)).profiles);
    toast(`Profile ${profile.name} deleted`);
  };
  return html`<section class="card" id=${`profile-${profile.name}`} data-profile-card=${profile.name}>
    <div class="card-h"><h3>${profile.label || profile.name}</h3><span class="dim sm">${profile.name}${profile.isBuiltIn ? (profile.edited ? " · built in, edited" : " · built in") : ""}</span></div>
    <div class="card-b">
      <label class="f-l">Name shown<input class="field" value=${label} placeholder=${profile.name} onInput=${(e) => { setLabel(e.currentTarget.value); setDirty(true); }} /></label>
      <div class="f-l">Set (replaces the device's value)</div>
      ${rowEditor(set, setSet, "set", false)}
      <div class="f-l">Cap (the highest value allowed)</div>
      ${rowEditor(cap, setCap, "cap", true)}
      <div class="f-l">Capabilities switched off</div>
      <div class="caprow" data-caps>
        ${capNames.map((c) => html`<label key=${c} class=${`chip cap${off.includes(c) ? " off" : ""}`}><input type="checkbox" class="switch" data-cap=${c} aria-label=${`${c} off`} checked=${off.includes(c)} onChange=${(e) => flip(c, e.target.checked)} />${c}</label>`)}
      </div>
      <p class="caphelp">Switched off while this profile is on. Only takes away what a device has.</p>
      ${stuck ? html`<p class="help bad" data-cap-warning>With the microphone and ${off.includes("touch") ? "touch" : "the screen"} both off, a device on this profile cannot answer a question.</p>` : null}
      <div class="row">
        <${Button} class="btn primary" disabled=${!dirty} run=${save}>Save</${Button}>
        ${profile.isBuiltIn ? html`<${Button} run=${reset} disabled=${!profile.edited}>Reset to default</${Button}>` : html`<${Button} class="btn danger" run=${remove}>Delete</${Button}>`}
      </div>
    </div>
  </section>`;
}

export function ProfilesPage() {
  const [data, load, error] = useLoad("/admin/profiles");
  const [name, setName] = useState("");
  const [shown, setShown] = useState();
  const profiles = shown ?? data?.profiles;
  const create = async () => {
    const made = (await api("PUT", `/admin/profiles/${enc(name)}`, { set: {}, cap: {} })).profiles;
    setName("");
    setShown(made);
    await refresh();
  };
  return html`<div class="page">
    <${PageHead} title=${PAGES.profiles.title} purpose=${PAGES.profiles.purpose} />
    <p class="help">A device's Profile setting picks one. <b>Set</b> replaces the device's own value for a setting; <b>cap</b> is the highest value allowed (a lower one the device already has is kept). Changes reach devices on the profile at once. Delete a custom profile and its devices go back to auto.</p>
    ${error ? html`<p class="help bad">${error}</p>` : null}
    ${!profiles ? html`<${Loading} />` : html`
      <datalist id="profile-keys">${(data?.keys ?? []).map((k) => html`<option key=${k} value=${k}></option>`)}</datalist>
      ${profiles.map((p) => html`<${ProfileCard} key=${p.name + JSON.stringify([p.set, p.cap, p.label, p.capabilitiesOff])} profile=${p} keys=${data?.keys} onChange=${(list) => { setShown(list); refresh(); }} />`)}
      <section class="card" id="profile-new"><div class="card-h"><h3>New profile</h3></div><div class="card-b row">
        <input class="field mono" id="profile-new-name" placeholder="name: a-z, 0-9, -" maxlength="24" value=${name} onInput=${(e) => setName(e.currentTarget.value.toLowerCase())} />
        <${Button} class="btn primary" disabled=${!name} run=${create}>Create</${Button}>
      </div></section>`}
  </div>`;
}
