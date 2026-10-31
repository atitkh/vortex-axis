// The settings editor of the admin page, one for every layer (a device, a type, everything): grouped rows with
// where each value comes from, edits staged until Save, one PATCH per save, and Undo afterwards (ia.md 2.3).
// Kept from the classic page: a value equal to what the layers below give is sent as null, so nothing is stored and
// the setting keeps following the shared value.

import { html, useEffect, useRef, useState } from "/web/preact.js";
import {
  profileChoices, api, ask, clearDraft, clientById, clientName, deviceHref, draftCount, draftOf, enc, kept, plural, refresh, setDraft, store, toast, typeHref, typeName,
} from "/web/adm-core.js";

/** Words and a line of help for each option of a choice that has them: [value, label, help]. */
const OPTION_WORDS = { get profile() { return profileChoices(); } };
/** Words for some values of a number setting, shown in place of the number. */
export const NUMBER_WORDS = { chargeLimit: { 100: "No limit" } };

/** Keys with their own place on a device page, never a row. */
export const DEVICE_ONLY = new Set(["location", "capabilitiesOff"]);
const OWN_WORD = { device: "this device", type: "this type", global: "everything" };

/** What switching each capability off does. */
export const CAPABILITY_OFF = {
  mic: "no listening, by wake word, tap or talk key",
  speaker: "nothing is spoken on it",
  screen: "nothing is shown; questions go to another device",
  touch: "taps and swipes are ignored",
  buttons: "its buttons are not used",
  vibration: "no buzzing",
  sensors: "its readings are not used",
  images: "no pictures are sent to it",
  "image-frames": "no pictures are sent to it",
  desktop: "agents cannot look at or act on this computer",
};

export function showValue(def, value) {
  if (value === undefined || value === null || value === "") return "not set";
  if (def.kind === "toggle") return Number(value) ? "on" : "off";
  if (def.kind === "client") return clientName(value) ?? String(value);
  const word = def.kind === "number" ? NUMBER_WORDS[def.key]?.[Number(value)] : undefined;
  if (word) return word;
  return `${value}${def.unit && def.kind === "number" ? ` ${def.unit}` : ""}`;
}

/** What the layers below `tab` give a setting, and which one gives it. */
export function inherited(def, layers, tab) {
  const below = { device: ["type", "global"], type: ["global"], global: [] }[tab];
  for (const name of below) if (layers[name][def.key] !== undefined) return { source: name, value: layers[name][def.key] };
  return { source: "default", value: def.default };
}

/** A staged entry (text as typed, a number, 0/1, a choice) as the value it would save; null removes it. */
function normalize(def, raw) {
  if (raw === null || raw === undefined) return null;
  if (def.kind === "number") return String(raw).trim() === "" ? null : Number(raw);
  if (def.kind === "text") return String(raw) === "" ? null : String(raw);
  if (def.kind === "raw") {
    const t = String(raw).trim();
    return t === "true" ? true : t === "false" ? false : t !== "" && !Number.isNaN(Number(t)) ? Number(t) : t === "" ? null : t;
  }
  return raw;
}

/** Why a value is not allowed, the way the server says it (schema.ts settingProblem), or "". */
export function problemOf(def, value) {
  if (value === null) return "";
  switch (def.kind) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${def.label} must be a number`;
      if (def.min !== undefined && value < def.min) return `${def.label} must be at least ${def.min}`;
      if (def.max !== undefined && value > def.max) return `${def.label} must be at most ${def.max}`;
      if (Number.isInteger(def.step) && !Number.isInteger(value)) return `${def.label} must be a whole number`;
      return "";
    case "choice":
      return (def.options ?? []).some((o) => String(o) === String(value)) ? "" : `${def.label} must be one of ${(def.options ?? []).join(", ")}`;
    case "text":
      return String(value).length > 512 ? `${def.label} is too long` : "";
    default:
      return "";
  }
}

const same = (a, b) => (a === undefined || a === null ? b === undefined || b === null : b !== undefined && b !== null && String(a) === String(b));

/**
 * Stages a value for `key` on `entity`; a value that changes nothing (what is set now, or what would be inherited
 * anyway) takes the staged entry away again.
 */
export function stage(entity, def, raw, own, below) {
  const value = normalize(def, raw);
  // Typed fields compare as typed, so emptying one to type afresh does not snap back to the shared value.
  const typed = def.kind === "number" || def.kind === "text" || def.kind === "raw";
  setDraft(entity, (d) => {
    const unchanged = typed
      ? own !== undefined && own !== null ? raw !== null && String(raw) === String(own) : raw !== null && raw !== "" && String(raw) === String(below?.value ?? "")
      : same(value, own) || ((own === undefined || own === null) && value !== null && same(value, below?.value));
    if (unchanged) delete d.values[def.key];
    else d.values[def.key] = raw;
    return d;
  });
}

/**
 * Saves everything staged for `entity`: one PATCH of the settings layer at `path` (the server checks the whole map
 * and refuses it all for one bad value), then the device's name and switched-off capabilities, then a toast with Undo.
 * `defs` resolves keys; `layers`/`tab` give what each key falls back to. Returns an error text, or "".
 */
export async function saveDraft({ entity, defs, layers, tab, path, what, clientId }) {
  const d = draftOf(entity);
  const values = {};
  const before = {};
  const problems = [];
  for (const [key, raw] of Object.entries(d.values)) {
    const def = defs.find((x) => x.key === key) ?? { key, label: key, kind: "raw" };
    let value = normalize(def, raw);
    const p = problemOf(def, value);
    if (p) problems.push(p);
    const below = inherited(def, layers, tab);
    if (value !== null && below.value !== undefined && String(value) === String(below.value)) value = null;
    values[key] = value;
    before[key] = layers[tab][key] ?? null;
  }
  if (problems.length) return `${problems.join(". ")}.`;
  const client = clientId ? clientById(clientId) : undefined;
  const done = [];
  try {
    if (Object.keys(values).length) {
      await api("PATCH", path, { values });
      done.push(...Object.keys(values));
    }
    if (client && d.name !== undefined && d.name.trim() && d.name.trim() !== client.name) {
      await api("PATCH", `/admin/clients/${enc(client.id)}`, { name: d.name.trim() });
      done.push("name");
    }
    if (client && d.caps !== undefined) {
      await api("PATCH", `/admin/clients/${enc(client.id)}`, { capabilitiesOff: d.caps });
      done.push("capabilities");
    }
  } catch (error) {
    await refresh();
    return error.message;
  }
  clearDraft(entity);
  const oldName = client?.name;
  const oldCaps = client?.off ?? [];
  const undo = async () => {
    try {
      if (Object.keys(before).length) await api("PATCH", path, { values: before });
      if (client && done.includes("name")) await api("PATCH", `/admin/clients/${enc(client.id)}`, { name: oldName });
      if (client && done.includes("capabilities")) await api("PATCH", `/admin/clients/${enc(client.id)}`, { capabilitiesOff: oldCaps });
      toast(`Put back as it was on ${what}.`);
    } catch (error) {
      toast(error.message, "bad");
    }
    refresh();
  };
  const one = Object.entries(values);
  const words =
    done.length === 1 && one.length === 1
      ? (() => {
          const [key, value] = one[0];
          const def = defs.find((x) => x.key === key) ?? { key, label: key };
          const below = inherited(def, layers, tab);
          return value === null
            ? `${def.label} on ${what} now follows ${below.source === "default" ? "the default" : below.source === "type" ? "its type" : "everything"} (${showValue(def, below.value)}).`
            : `${def.label} set to ${showValue(def, value)} on ${what}.`;
        })()
      : `${plural(done.length, "change")} saved on ${what}.`;
  toast(words, "good", undo);
  await refresh();
  return "";
}

// --- the page parts ---------------------------------------------------------------------------

/** The save bar: how many changes wait, Discard and Save, and what went wrong. */
export function SaveBar({ entity, save, floating = false }) {
  const n = draftCount(entity);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(""), [n]);
  if (!n) return null;
  const discard = async () => {
    if (n > 3 && !(await ask({ title: "Discard the changes?", body: `${plural(n, "unsaved change")} will be lost.`, confirm: "Discard", danger: true }))) return;
    clearDraft(entity);
  };
  const go = async () => {
    setBusy(true);
    setError(await save());
    setBusy(false);
  };
  return html`<div class=${`savebar${floating ? " floating" : ""}`} role="region" aria-label="Unsaved changes" data-savebar=${entity}>
    <span class="n" aria-live="polite">${plural(n, "unsaved change")}</span>
    ${error ? html`<span class="msg bad save-error" role="alert">${error}</span>` : null}
    <button type="button" class="btn ghost sm" onClick=${discard} disabled=${busy}>Discard</button>
    <button type="button" class="btn primary sm" onClick=${go} disabled=${busy} data-save>${busy ? "Saving…" : "Save"}</button>
  </div>`;
}

/** The banner at the top of every settings view: which layer this edits, a way to the others, and the save bar. */
export function LayerBanner({ tab, who, detail, layers: switcher, entity, save }) {
  return html`<div class="banner" data-layer=${tab}>
    <div class="who">Editing <b>${OWN_WORD[tab] === "everything" ? "everything" : who}</b>${detail ? html`<div>${detail}</div>` : null}</div>
    ${switcher?.length ? html`<nav class="layers" aria-label="Layer">${switcher.map((l) => html`<a key=${l.label} href=${l.href} class=${l.on ? "on" : ""} aria-current=${l.on ? "page" : undefined}>${l.label}</a>`)}</nav>` : null}
    <${SaveBar} entity=${entity} save=${save} />
  </div>`;
}

/** One input for one setting. `value` is what shows; `onStage` gets what was typed or chosen. */
function Editor({ def, value, onStage, label }) {
  if (def.kind === "toggle") {
    const on = Number(value) === 1;
    return html`<label class="switch-l"><input type="checkbox" class="switch" data-edit=${def.key} aria-label=${label} checked=${on} onChange=${(e) => onStage(e.target.checked ? 1 : 0)} /><span>${on ? "on" : "off"}</span></label>`;
  }
  if (def.kind === "choice" || def.kind === "client") {
    const options = def.kind === "client" ? store.clients.map((c) => [c.id, c.name]) : (def.options ?? []).map((o) => [o, OPTION_WORDS[def.key]?.find(([v]) => v === o)?.[1] ?? String(o)]);
    const current = def.kind === "client" ? store.clients.find((c) => c.id === value || c.name.toLowerCase() === String(value ?? "").toLowerCase())?.id ?? value : value;
    const numeric = def.kind === "choice" && (def.options ?? []).every((o) => typeof o === "number");
    const has = current !== undefined && current !== null && current !== "";
    return html`<select class="field" data-edit=${def.key} aria-label=${label} value=${has ? String(current) : ""} onChange=${(e) => onStage(e.target.value === "" ? null : numeric ? Number(e.target.value) : e.target.value)}>
      ${def.kind === "client" || !has ? html`<option value="">${def.kind === "client" ? "not set" : "choose"}</option>` : null}
      ${options.map(([v, l]) => html`<option key=${String(v)} value=${String(v)}>${l}</option>`)}
    </select>`;
  }
  // A number with a few steps between its bounds (a charge limit by fives) is a list of them, named where it has words.
  const steps = def.kind === "number" && def.step > 0 && def.min !== undefined && def.max !== undefined ? Math.floor((def.max - def.min) / def.step) + 1 : 0;
  if (steps > 1 && steps <= 21) {
    const values = Array.from({ length: steps }, (_, i) => def.min + i * def.step);
    const has = value !== undefined && value !== null && value !== "";
    if (has && !values.includes(Number(value))) values.push(Number(value));
    return html`<select class="field" data-edit=${def.key} aria-label=${label} value=${has ? String(Number(value)) : ""} onChange=${(e) => onStage(e.target.value === "" ? null : Number(e.target.value))}>
      ${!has ? html`<option value="">choose</option>` : null}
      ${values.sort((a, b) => a - b).map((v) => html`<option key=${v} value=${String(v)}>${NUMBER_WORDS[def.key]?.[v] ?? `${v}${def.unit ? ` ${def.unit}` : ""}`}</option>`)}
    </select>`;
  }
  const input = html`<input class=${`field${def.kind === "number" ? " num" : ""}`} type=${def.kind === "number" ? "number" : "text"} data-edit=${def.key} aria-label=${label}
    value=${value ?? ""} placeholder=${def.placeholder ?? "not set"} spellcheck="false" min=${def.min} max=${def.max} step=${def.step}
    onInput=${(e) => onStage(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />`;
  return def.kind === "number" && def.unit ? html`<span class="unit">${input}<span>${def.unit}</span></span>` : input;
}

/** Where a value comes from, as a chip. */
function SourceChip({ tab, mine, dirty, below, problem }) {
  if (problem) return html`<span class="src-chip bad" title=${problem}>refused</span>`;
  if (dirty) return html`<span class="src-chip unsaved">unsaved</span>`;
  if (mine) return html`<span class="src-chip here">${OWN_WORD[tab]}</span>`;
  if (below.value === undefined || below.value === null) return html`<span class="src-chip">not set</span>`;
  return html`<span class=${`src-chip ${below.source}`}>${below.source === "global" ? "everything" : below.source}</span>`;
}

/** One row: label, help, control, where its value comes from, and the way back. */
function Row({ def, layers, tab, entity, extra, flash, hint }) {
  const own = layers[tab][def.key];
  const below = inherited(def, layers, tab);
  const staged = draftOf(entity).values;
  const dirty = Object.hasOwn(staged, def.key);
  const raw = dirty ? staged[def.key] : undefined;
  const mine = dirty ? raw !== null && raw !== "" : own !== undefined;
  const shown = dirty ? (raw === null ? below.value : raw) : own !== undefined ? own : below.value;
  const value = normalize(def, shown);
  const problem = dirty ? problemOf(def, normalize(def, raw)) : "";
  const changed = def.default !== undefined ? !same(value, def.default) : value !== null && value !== undefined && value !== "";
  const onStage = (v) => stage(entity, def, v, own, below);
  const backTo = `${below.source === "default" ? "default" : below.source === "type" ? "type's" : "everything's"} ${showValue(def, below.value)}`;
  const reset = dirty
    ? html`<button type="button" class="btn ghost sm" onClick=${() => setDraft(entity, (d) => (delete d.values[def.key], d))} title="Take back this change">Undo</button>`
    : own !== undefined
      ? html`<button type="button" class="btn ghost sm" title=${`Remove the value set on ${OWN_WORD[tab]}; it goes back to the ${backTo}`} onClick=${() => onStage(null)} data-reset=${def.key}>${tab === "global" ? "Clear" : below.value === undefined ? "Clear" : `Use ${backTo}`}</button>`
      : null;
  return html`<div class=${`row${mine ? " mine" : " follows"}${dirty ? " dirty" : ""}${flash ? " flash" : ""}`} data-key=${def.key} id=${`set-${def.key}`}>
    <div class="lbl-col">
      <div class="lbl">${def.label}${changed ? html`<i class="chg" title="Changed from the default"></i>` : null}<span class="mono key">${def.key}</span></div>
      ${def.help || hint ? html`<div class="hlp">${def.help}${hint ? html` <b>${hint}</b>` : null}</div>` : null}
      ${OPTION_WORDS[def.key] ? html`<div class="hlp" data-option-help>${OPTION_WORDS[def.key].map(([v, l, h]) => html`<div key=${v} class=${String(value) === v ? "" : "dim"}><b>${l}</b>: ${h}</div>`)}</div>` : null}
      ${problem ? html`<div class="msg bad">${problem}</div>` : null}
    </div>
    <div class="ctl"><${Editor} def=${def} value=${shown} onStage=${onStage} label=${def.label} /></div>
    <div class="src"><${SourceChip} tab=${tab} mine=${mine} dirty=${dirty} below=${below} problem=${problem} /></div>
    <div class="rst">${reset}${extra?.(def, own, dirty)}</div>
  </div>`;
}

const groupsOf = (defs) => {
  const groups = new Map();
  for (const def of defs) {
    const name = def.group || "Other";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(def);
  }
  return [...groups];
};

/** A group of rows that opens and closes, its state remembered in this browser. */
function Group({ name, count, children, open, onToggle }) {
  return html`<details class="group" id=${`group-${slug(name)}`} open=${open} onToggle=${(e) => e.target.open !== open && onToggle(e.target.open)}>
    <summary class="group-h"><span class="chev" aria-hidden="true"></span><h3>${name}</h3><span class="cnt">${count}</span></summary>
    <div class="group-b">${children}</div>
  </details>`;
}
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * The editor for one layer. `defs`: the settings to show; `layers`: { global, type, device } as stored; `tab`: the
 * layer edited; `entity`: the drafts' key. `head`: extra groups first (the device's capabilities), as
 * [{ name, count, body, dirty }]. `extra(def, own, dirty)`: more in a row's last cell. `rail`: the column on the right.
 */
export function SettingsEditor({ defs, layers, tab, entity, head = [], extra, rail, focusKey, hints = {}, after }) {
  const [filter, setFilter] = useState("");
  const [opened, setOpened] = useState(() => kept.get("axis.groups", {}));
  const [flash, setFlash] = useState("");
  const staged = draftOf(entity).values;
  const words = filter.trim().toLowerCase();
  const shown = words ? defs.filter((d) => [d.label, d.key, d.help ?? "", d.group ?? ""].some((t) => t.toLowerCase().includes(words))) : defs;
  const groups = groupsOf(shown);
  const isOpen = (name) => (words ? true : opened[name] ?? true);
  const toggle = (name, open) => {
    const next = { ...opened, [name]: open };
    setOpened(next);
    kept.set("axis.groups", next);
  };
  const jump = (name) => {
    if (!isOpen(name)) toggle(name, true);
    requestAnimationFrame(() => document.getElementById(`group-${slug(name)}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  // A link to one setting (?key=…) opens its group, scrolls to the row and flashes it.
  useEffect(() => {
    if (!focusKey) return;
    const def = defs.find((d) => d.key === focusKey);
    // Or a group by name (?key=capabilities opens the device's switches).
    const group = head.find((g) => g.name.toLowerCase() === focusKey.toLowerCase());
    if (group) return void setTimeout(() => jump(group.name), 60);
    if (!def) return;
    const name = def.group || "Other";
    if (!isOpen(name)) toggle(name, true);
    setFlash(focusKey);
    setTimeout(() => document.getElementById(`set-${focusKey}`)?.scrollIntoView({ block: "center" }), 60);
    const t = setTimeout(() => setFlash(""), 1800);
    return () => clearTimeout(t);
  }, [focusKey, defs.length]);
  const counts = (list) => {
    const set = list.filter((d) => layers[tab][d.key] !== undefined).length;
    const dirty = list.filter((d) => Object.hasOwn(staged, d.key)).length;
    return { set, dirty, text: [plural(list.length, "setting"), set ? `${set} set here` : "", dirty ? `${dirty} unsaved` : ""].filter(Boolean).join(" · ") };
  };
  const index = [...head.map((g) => ({ name: g.name, set: 0, dirty: g.dirty ? 1 : 0, note: g.note })), ...groupsOf(defs).map(([name, list]) => ({ name, ...counts(list) }))];
  return html`<div class=${`edit-grid${rail ? " with-rail" : ""}`}>
    <nav class="index" aria-label="Groups on this page">
      <div class="caps">On this page</div>
      ${index.map((g) => html`<button type="button" key=${g.name} onClick=${() => jump(g.name)}>
        <span>${g.name}</span>${g.dirty ? html`<span class="n warn">${g.dirty} unsaved</span>` : g.note ? html`<span class="n">${g.note}</span>` : g.set ? html`<span class="n accent">${g.set}</span>` : null}
      </button>`)}
      <div class="index-help"><b>Where a value comes from</b> A device's own value wins over its type's, which wins over everything's, which wins over the default.</div>
    </nav>
    <div class="edit-main">
      <div class="stools">
        <input class="field" type="search" placeholder="Filter settings: volume, glow, quiet…" aria-label="Filter settings" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
        <button type="button" class="btn ghost sm" onClick=${() => {
          const allOpen = index.every((g) => isOpen(g.name));
          const next = Object.fromEntries(index.map((g) => [g.name, !allOpen]));
          setOpened(next);
          kept.set("axis.groups", next);
        }}>${index.every((g) => isOpen(g.name)) ? "Collapse all" : "Expand all"}</button>
      </div>
      ${words ? null : head.map((g) => html`<${Group} key=${g.name} name=${g.name} count=${g.count} open=${isOpen(g.name)} onToggle=${(o) => toggle(g.name, o)}>${g.body}<//>`)}
      ${groups.length
        ? groups.map(([name, list]) => html`<${Group} key=${name} name=${name} count=${counts(list).text} open=${isOpen(name)} onToggle=${(o) => toggle(name, o)}>
            ${list.map((def) => html`<${Row} key=${def.key} def=${def} layers=${layers} tab=${tab} entity=${entity} extra=${extra} flash=${flash === def.key} hint=${hints[def.key]} />`)}
          <//>`)
        : html`<p class="empty">${words ? `No setting matches “${filter}”.` : "Nothing to set here yet."}</p>`}
      ${after}
    </div>
    ${rail ? html`<aside class="rail">${rail}</aside>` : null}
  </div>`;
}

/** The capability switches of a device, staged like any setting. */
export function capabilityGroup(client, entity) {
  const reported = client.reported ?? client.capabilities;
  const d = draftOf(entity);
  const off = new Set(d.caps ?? client.off ?? []);
  const flip = (capability, on) =>
    setDraft(entity, (x) => {
      const next = new Set(x.caps ?? client.off ?? []);
      if (on) next.delete(capability);
      else next.add(capability);
      const list = reported.filter((c) => next.has(c));
      x.caps = list.join() === (client.off ?? []).filter((c) => reported.includes(c)).join() ? undefined : list;
      return x;
    });
  const nOff = reported.filter((c) => off.has(c)).length;
  return {
    name: "Capabilities",
    count: `What Axis uses on this device${nOff ? ` · ${nOff} switched off` : ""}${d.caps !== undefined ? " · unsaved" : ""}`,
    note: nOff ? `${nOff} off` : "",
    dirty: d.caps !== undefined,
    body: reported.length
      ? html`<div class="caprow">
          ${reported.map((c) => html`<label key=${c} class=${`chip cap${off.has(c) ? " off" : ""}`}><input type="checkbox" class="switch" data-edit=${`capability-${c}`} aria-label=${c} checked=${!off.has(c)} onChange=${(e) => flip(c, e.target.checked)} />${c}</label>`)}
        </div>
        <p class="caphelp">Switch one off to stop Axis using it on this device; nothing is added that it does not report. Off means: ${reported.map((c) => `${c}: ${CAPABILITY_OFF[c] ?? "not used"}`).join("; ")}. The device may need a moment to follow.</p>`
      : html`<p class="caphelp">This device reports no capabilities.</p>`,
  };
}

/** "differs on Desk (35 %)" on a type's row: devices with their own value, which a change here does not reach. */
export function differsOn(members, def) {
  const odd = members.filter((c) => c.layers.device[def.key] !== undefined);
  if (!odd.length) return null;
  return html`<span class="differ" title="These devices have their own value, so a change here does not reach them">${odd.length === 1 ? "differs on " : `${odd.length} differ: `}${odd.map((c, i) => html`${i ? ", " : ""}<a href=${deviceHref(c, "settings")}>${c.name} (${showValue(def, c.layers.device[def.key])})</a>`)}</span>`;
}

/** "Share with type" on a device's row: its value becomes the type's, and the device follows it. */
export function shareWithType(client) {
  return (def, own, dirty) =>
    own === undefined || dirty
      ? null
      : html`<button type="button" class="btn ghost sm" title=${`Make ${showValue(def, own)} the value for every ${typeName(client.type)}`} onClick=${async () => {
          try {
            await api("PATCH", `/admin/settings/type/${enc(client.type)}`, { values: { [def.key]: own } });
            await api("PATCH", `/admin/settings/device/${enc(client.id)}`, { values: { [def.key]: null } });
            toast(`${def.label} ${showValue(def, own)} is now shared by every ${typeName(client.type)}.`);
          } catch (error) {
            toast(error.message, "bad");
          }
          refresh();
        }}>Share with type</button>`;
}

export { typeHref };
