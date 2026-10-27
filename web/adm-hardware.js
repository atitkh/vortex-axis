// Face and screen, and the Hardware group of the new admin page: Firmware, Wake words and Apps (docs/admin-revamp/ia.md 1).
// Everything the classic pages #face, #firmware and #wakewords do is here. What is a setting (idle looks, tool icons,
// wake word cutoffs) is staged and saved with the save bar; uploads, downloads, removals and updates run at once.

import { html, useEffect, useRef, useState } from "/web/preact.js";
import { HELD, IDLE, LOOKS, LOOK_FIELDS, Vortex } from "/web/vortex.js";
import { ICONS } from "/web/icons.js";
import {
  Button, ago, api, ask, authHeader, behind, deviceHref, download, draftOf, enc, plural, refresh, setDraft, store, toast, typeHref, typeName,
  typesInUse, updateDevice,
} from "/web/adm-core.js";
import { SaveBar } from "/web/adm-settings.js";
import { PAGES, PageHead, UpdateButton } from "/web/adm-shell.js";
import { F, Loading, Note, Seg, Stat, saveForm, useForm, useLoad } from "/web/adm-agent.js";

const Head = ({ page, children }) => html`<${PageHead} title=${PAGES[page].title} purpose=${PAGES[page].purpose}>${children}</${PageHead}>`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1048576 ? 2 : 1)} MB`;

/** Sends a file as the raw body of a POST, as the classic page did, and answers with the JSON or throws its error. */
async function upload(path, file) {
  const res = await fetch(path, { method: "POST", headers: { ...authHeader(), "content-type": "application/octet-stream" }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `upload failed (${res.status})`);
  return data;
}

// --- Face and screen (#face) ----------------------------------------------------------------------

/** What each look is for, as docs/face.md words it. */
const FACE_READS = {
  calm: "the plain one: an easy turn",
  breathe: "slowly swelling and settling",
  unwind: "turning the other way, wide",
  open: "arms flung wide",
  curl: "wound up tight and small",
  drift: "the centre wanders about",
  shimmer: "a few dots flash",
  galaxy: "a disc seen at an angle, a few stars",
  tendril: "arms that ripple like something under water",
  bloom: "big soft dots, opening and closing like a flower",
  pinwheel: "nearly straight arms, turning briskly",
  deep: "small, dark blue, slow",
  orbit: "a tilted wheel, like rings",
  sway: "hardly turning, arms swaying from side to side",
  setup: "amber, waiting to be set up",
  offline: "small, slow, grey",
  listening: "pulled in tight, green; swells with your voice",
  thinking: "fast, violet, a little sparkle",
  speaking: "open, pulsing, white-blue; follows the voice being played",
  error: "slow, red, the centre trembles",
  compacting: "while thinking, when the agent stops to tidy its memory: wound in tight, slow, deep blue",
  retrying: "while thinking, when the agent's provider failed and it is trying again: amber, turning backwards",
};
const FACE_UNITS = {
  spin: "radians a second", radius: "of the space", twist: "turns", pulse: "of the radius", pulseHz: "a second",
  wander: "pixels of 240", sparkle: "chance per dot per frame", dot: "times normal size", r: "red", g: "green", b: "blue",
  wave: "radians at the tip", tilt: "0 is flat on",
};
/** Which tools show as each kind of icon. */
const ICON_READS = {
  search: "looking something up: a web search, a search of its sessions or files",
  web: "reading a web page or using a browser",
  home: "Home Assistant: lights, switches, the state of a room",
  calendar: "the calendar and its events",
  list: "tasks, to-dos, notes and other lists",
  files: "reading or changing a file or a document",
  code: "running a command or a script",
  timer: "timers, reminders and scheduled jobs",
  message: "saying or sending something: a device, a chat, a mail",
  memory: "its own memory and notes",
  image: "making or looking at a picture",
  computer: "the desktop tool, looking at or using a computer",
  tool: "any other tool",
};
const ICON_STYLE_HELP = {
  dots: "The face's own dots leave their arms and form the icon, in a colour of its kind, then swirl back.",
  line: "The arms stand back from the centre and the icon is drawn there with a pen, in the face's colour.",
  off: "Nothing is shown: the face thinks the way it always has.",
};
const ALL_LOOKS = [
  ...IDLE.map(([name, look]) => ({ name, look, mode: "idle", group: "idle" })),
  ...Object.entries(LOOKS).map(([name, look]) => ({ name, look, mode: name, group: "state" })),
  // Thinking with the agent's run held up: drawn as thinking is, from numbers of their own.
  ...Object.entries(HELD).map(([name, look]) => ({ name, look, mode: "thinking", group: "state" })),
];
const ICON_KINDS = Object.keys(ICONS);
const offList = (text) => String(text ?? "").split(",").map((n) => n.trim()).filter(Boolean);

/** A face on a canvas of its own, running while it is on screen; `setup` is given the Vortex on every draw. */
function LiveFace({ setup, id, deps = [] }) {
  const ref = useRef();
  const face = useRef();
  useEffect(() => {
    face.current = new Vortex(ref.current);
    face.current.calm = false; // a viewer shows the real motion, whatever the page was asked to tone down
    setup(face.current, true);
    return () => face.current.stop();
  }, []);
  useEffect(() => {
    if (face.current) setup(face.current, false);
  }, deps);
  return html`<canvas class="face" id=${id} ref=${ref} aria-hidden="true"></canvas>`;
}

export function FacePage() {
  const entity = "page:face";
  const g = store.global;
  const saved = { idleLooksOff: g.idleLooksOff ?? "", toolIcons: g.toolIcons ?? "dots", toolIconMs: g.toolIconMs ?? 700, toolIconDots: g.toolIconDots ?? 78 };
  const form = useForm(entity, saved);
  const [chosen, choose] = useState("calm");
  const [level, setLevel] = useState(0);
  const [replay, setReplay] = useState(0);
  const off = new Set(offList(form.value("idleLooksOff")));
  const style = ["dots", "line", "off"].includes(form.value("toolIcons")) ? form.value("toolIcons") : "dots";
  const ms = Number(form.value("toolIconMs"));
  const dots = Number(form.value("toolIconDots"));
  const icon = chosen.startsWith("icon:") ? chosen.slice(5) : "";
  const entry = icon ? undefined : ALL_LOOKS.find((l) => l.name === chosen) ?? ALL_LOOKS[0];
  const voiced = entry && (entry.mode === "listening" || entry.mode === "speaking");

  const toggleIdle = (name, on) => {
    const next = new Set(off);
    if (on) next.delete(name);
    else next.add(name);
    if (next.size >= IDLE.length) return toast("One look has to stay on.", "warn");
    form.put("idleLooksOff", IDLE.map(([n]) => n).filter((n) => next.has(n)).join(","));
  };
  const apply = async (v, keys) => {
    const values = {};
    for (const k of keys) values[k] = k === "idleLooksOff" ? v[k] || null : k === "toolIcons" ? v[k] : Number(v[k]);
    await api("PATCH", "/admin/settings/global", { values });
    await refresh();
  };
  const save = () =>
    saveForm(entity, saved, apply, {
      words: (s) => (Object.keys(s).length === 1 && "idleLooksOff" in s ? "The idle looks are saved for every device." : `${plural(Object.keys(s).length, "change")} saved for every device. Devices take it in a few seconds.`),
    });
  // Takes every icon down and puts it up again, so the way it forms can be watched.
  const playAgain = () => setReplay((n) => n + 1);
  useEffect(() => {
    if (draftOf(entity).values.toolIconMs !== undefined || draftOf(entity).values.toolIconDots !== undefined) playAgain();
  }, [ms, dots]);

  const big = (f, first) => {
    f.setIconTuning(ms, dots);
    if (icon) {
      f.hold(LOOKS.thinking, "thinking");
      f.setLevel(-1);
      f.setIconStyle(style);
      f.setIcon(undefined);
      setTimeout(() => f.setIcon(icon), first ? 0 : 50);
    } else {
      f.setIcon(undefined);
      f.hold(entry.look, entry.mode);
      // At zero the face breathes by itself, as it does when no loudness is known.
      f.setLevel(voiced && level > 0 ? level / 100 : -1);
    }
  };
  const tile = (l) => html`<button type="button" class=${`face-tile ${chosen === l.name ? "on" : ""}`} data-look=${l.name} aria-pressed=${chosen === l.name} onClick=${() => choose(l.name)}>
    <${LiveFace} setup=${(f) => { f.now = { ...l.look }; f.hold(l.look, l.mode); }} /><span>${l.name}</span>
  </button>`;

  return html`<${Head} page="face" />
    <section class="card" id="face-stage">
      <div class="card-b face-stage">
        <div class="face-big"><${LiveFace} id="face-big" setup=${big} deps=${[chosen, level, style, ms, dots, replay]} /></div>
        <div class="face-detail">
          <h2 id="face-name">${icon ? `${icon} (tool icon)` : `${entry.name} (${entry.group === "idle" ? "idle look" : "state look"})`}</h2>
          <p class="help" id="face-reads">${icon ? `Shown while thinking when the agent picks up ${ICON_READS[icon] ?? "a tool of this kind"}.` : FACE_READS[entry.name] ?? ""}</p>
          ${voiced
            ? html`<label class="slider" id="face-voice-row">Voice level: ${entry.mode === "listening" ? "the microphone" : "the speech being played"}
                <input id="face-voice" type="range" min="0" max="100" value=${level} onInput=${(e) => setLevel(Number(e.currentTarget.value))} /></label>`
            : null}
          ${entry
            ? html`<div class="tablebox"><table class="t"><tbody id="face-numbers">${LOOK_FIELDS.map((k) => html`<tr key=${k}><td class="mono">${k}</td><td class="mono">${String(entry.look[k])}</td><td class="dim">${FACE_UNITS[k] ?? ""}</td></tr>`)}</tbody></table></div>`
            : null}
        </div>
      </div>
      <p class="help card-foot">Every look the vortex face has, drawn by the same code the web client uses; the boards draw the same looks from the same numbers. These settings are in the layer every device shares (Defaults for everything); a type or a device can still set its own.</p>
    </section>
    <section class="card" id="face-idle-card">
      <div class="card-h"><h3>Idle looks</h3>${form.dirty("idleLooksOff") ? html`<span class="src-chip unsaved">unsaved</span>` : null}<span class="dim sm">${IDLE.length - off.size} of ${IDLE.length} in use</span></div>
      <div class="card-b">
        <p class="help">Picked at random while nothing is happening. Untick a look to take it out of what devices drift through; one always stays on.</p>
        <div class="face-grid" id="face-idle">
          ${ALL_LOOKS.filter((l) => l.group === "idle").map((l) => html`<div key=${l.name} class=${`face-cell ${off.has(l.name) ? "off" : ""}`} data-look=${l.name}>
            ${tile(l)}
            <label class="switch-l"><input type="checkbox" checked=${!off.has(l.name)} onChange=${(e) => toggleIdle(l.name, e.currentTarget.checked)} /> in the idle looks</label>
          </div>`)}
        </div>
      </div>
    </section>
    <section class="card">
      <div class="card-h"><h3>State looks</h3></div>
      <div class="card-b">
        <p class="help">One for each thing a device can be doing. The last two are thinking with the agent's run held up, which only an OpenClaw agent reports.</p>
        <div class="face-grid" id="face-state">${ALL_LOOKS.filter((l) => l.group === "state").map((l) => html`<div key=${l.name}>${tile(l)}</div>`)}</div>
      </div>
    </section>
    <section class="card" id="face-icons-card">
      <div class="card-h"><h3>Tool icons</h3></div>
      <div class="card-b fgrid">
        <${F} label="How they are shown" dirty=${form.dirty("toolIcons")} help=${ICON_STYLE_HELP[style]}>
          <span id="face-icon-style"><${Seg} form=${form} k="toolIcons" label="How tool icons are shown" options=${[["dots", "Dot shapes"], ["line", "Line at the core"], ["off", "Off"]]} /></span>
        </${F}>
        <${F} hidden=${style === "off"} label="Time to form" dirty=${form.dirty("toolIconMs")}>
          <div class="inline"><input id="face-icon-ms" type="range" min="150" max="3000" step="50" value=${ms} onInput=${(e) => form.put("toolIconMs", Number(e.currentTarget.value))} />
            <span class="dim sm" id="face-icon-ms-note">${(ms / 1000).toFixed(2).replace(/0$/, "")} s</span>
            <button type="button" class="btn sm" id="face-icon-replay" onClick=${playAgain}>Play it again</button></div>
        </${F}>
        <${F} hidden=${style !== "dots"} label="Dots in the shape" dirty=${form.dirty("toolIconDots")}>
          <div class="inline"><input id="face-icon-dots" type="range" min="12" max="78" step="3" value=${dots} onInput=${(e) => form.put("toolIconDots", Number(e.currentTarget.value))} />
            <span class="dim sm" id="face-icon-dots-note">${dots >= 78 ? "all 78" : `${dots} of 78; the other ${78 - dots} turn in a ring round it`}</span></div>
        </${F}>
        <p class="help">While it thinks, the face can show what kind of tool the agent has picked up (only an OpenClaw agent says which). Each kind is drawn below as the devices will show it.</p>
        <div class=${`face-grid ${style === "off" ? "off" : ""}`} id="face-icons">
          ${ICON_KINDS.map((kind) => html`<button type="button" key=${kind} class=${`face-tile ${chosen === `icon:${kind}` ? "on" : ""}`} data-look=${`icon:${kind}`} title=${ICON_READS[kind]} onClick=${() => choose(`icon:${kind}`)}>
            <${LiveFace} deps=${[style, ms, dots, replay]} setup=${(f, first) => {
              if (first) { f.now = { ...LOOKS.thinking }; f.hold(LOOKS.thinking, "thinking"); }
              f.setIconStyle(style);
              f.setIconTuning(ms, dots);
              f.setIcon(undefined);
              setTimeout(() => f.setIcon(kind), first ? 0 : ms + 250);
            }} /><span>${kind}</span>
          </button>`)}
        </div>
      </div>
    </section>
    <${SaveBar} entity=${entity} save=${save} floating />`;
}

// --- Firmware (#firmware) -------------------------------------------------------------------------

/** Every client type with devices or builds, by name. */
function firmwareTypes() {
  return [...new Set([...typesInUse().map((t) => t.type), ...store.shelves.map((s) => s.type)])].filter((t) => t !== "meta-quest").sort((a, b) => typeName(a).localeCompare(typeName(b)));
}

/** Tells every online device of a type that is not on the build Axis sends to update, after asking. */
export async function updateType(type) {
  const held = store.firmware.find((f) => f.type === type) ?? (type === "meta-quest" && store.quest?.available ? store.quest : undefined);
  const ready = store.clients.filter((c) => c.type === type && c.online && behind(c));
  if (!held || !ready.length) return "";
  if (!(await ask({ title: `Update ${plural(ready.length, "device")} to ${held.version}?`, body: "Each restarts and is away for about half a minute.", confirm: "Update" }))) return "";
  const failed = [];
  for (const c of ready) await updateDevice(c).catch((error) => failed.push(`${c.name}: ${error.message}`));
  if (failed.length) throw new Error(failed.join(" "));
  const text = `${plural(ready.length, "device")} told to update to ${held.version}. They restart by themselves in about half a minute.`;
  toast(text);
  return text;
}

function AddBuild() {
  const [type, setType] = useState("");
  const [version, setVersion] = useState("");
  const [m, setM] = useState();
  const file = useRef();
  const types = firmwareTypes();
  const go = async () => {
    const t = type.trim();
    const v = version.trim();
    const f = file.current.files[0];
    if (!t) return setM({ kind: "bad", text: "Say which client type this build is for." });
    if (!v) return setM({ kind: "bad", text: "Say which version this build is." });
    if (!f) return setM({ kind: "bad", text: "Choose the firmware.bin from the build." });
    setM({ text: "Uploading…" });
    try {
      const data = await upload(`/admin/firmware/${enc(t)}?version=${enc(v)}`, f);
      setM({ kind: "good", text: `${typeName(data.type)} ${data.version} is held and is the build devices are sent. Update them to put it on.` });
      file.current.value = "";
      setVersion("");
      await refresh();
    } catch (error) {
      setM({ kind: "bad", text: error.message });
    }
  };
  return html`<section class="card" id="firmware-add">
    <div class="card-h"><h3>Add a build</h3></div>
    <div class="card-b fgrid">
      <${F} label="Client type" id="firmware-type" help="The type the board reports; pick one in use or on the shelf, or type a new one.">
        <input id="firmware-type" class="field mono" list="firmware-types" value=${type} onInput=${(e) => setType(e.currentTarget.value)} spellcheck="false" autocomplete="off" />
        <datalist id="firmware-types">${types.map((t) => html`<option key=${t} value=${t}>${typeName(t)}</option>`)}</datalist>
      </${F}>
      <${F} label="Version" id="firmware-version"><input id="firmware-version" class="field mono" placeholder="1.2.3" value=${version} onInput=${(e) => setVersion(e.currentTarget.value)} spellcheck="false" autocomplete="off" /></${F}>
      <${F} label="Build" id="firmware-file" help="The firmware.bin from the build. It becomes the build devices of that type are sent."><input id="firmware-file" class="field" type="file" accept=".bin,application/octet-stream" ref=${file} /></${F}>
      <div class="f"><span class="f-l"></span><div class="f-c"><${Button} class="btn primary" id="firmware-upload" run=${go}>Upload</${Button}><${Note} m=${m} id="firmware-note" /></div></div>
    </div>
  </section>`;
}

function Shelf({ type }) {
  const shelf = store.shelves.find((s) => s.type === type) ?? { type, current: undefined, builds: [] };
  const members = store.clients.filter((c) => c.type === type);
  const [m, setM] = useState();
  const path = (b) => `/admin/firmware/${enc(type)}/${enc(b.version)}`;
  const held = store.firmware.find((f) => f.type === type);
  const ready = members.filter((c) => c.online && behind(c));
  const run = (fn) => async () => {
    try {
      const text = await fn();
      if (text) setM({ kind: "good", text });
    } catch (error) {
      setM({ kind: "bad", text: error.message });
    }
  };
  const send = (b) => run(async () => {
    await api("PUT", `${path(b)}/current`);
    await refresh();
    return `Devices are now sent ${b.version}. Update them to put it on.`;
  });
  const remove = (b) => run(async () => {
    if (!(await ask({ title: `Remove ${typeName(type)} ${b.version}?`, body: "Devices already running it keep it.", confirm: "Remove", danger: true }))) return "";
    await api("DELETE", path(b));
    await refresh();
    return `${b.version} removed.`;
  });
  const removeAll = run(async () => {
    if (!(await ask({ title: `Remove every build for ${typeName(type)}?`, body: `${plural(shelf.builds.length, "build")} go. Devices keep what they run, but cannot be updated until a build is uploaded again. Type the type to confirm.`, typed: type, confirm: "Remove all", danger: true }))) return "";
    await api("DELETE", `/admin/firmware/${enc(type)}`);
    await refresh();
    return "Every build for this type removed.";
  });
  return html`<section class="card shelf" data-type=${type}>
    <div class="card-h"><h3><a href=${typeHref(type, "firmware")}>${typeName(type)}</a> ${typeName(type) === type ? null : html`<span class="dim mono sm">${type}</span>`}</h3>
      ${held ? html`<${Stat} label=${`sends ${held.version}`} kind="good" />` : html`<${Stat} label="no build" />`}</div>
    <div class="card-b">
      <p class="chips">${members.length
        ? members.map((c) => html`<a key=${c.id} class=${`chip ${behind(c) ? "warn" : ""}`} href=${deviceHref(c)}><i class=${`d ${c.online ? "good" : ""}`}></i>${c.name} <span class="mono">${c.version || "?"}</span>${!c.online ? " · offline" : behind(c) ? " · behind" : ""}</a>`)
        : html`<span class="dim">No devices of this type are paired.</span>`}</p>
      ${shelf.builds.length
        ? html`<div class="tablebox"><table class="t builds"><thead><tr><th>Version</th><th>Size</th><th>Uploaded</th><th>Checksum</th><th></th><th></th></tr></thead><tbody>
            ${shelf.builds.map((b) => html`<tr key=${b.version}>
              <td class="mono">${b.version}</td><td>${mb(b.size)}</td><td>${ago(b.uploadedAt)}</td><td class="mono dim" title=${b.md5}>${b.md5.slice(0, 10)}</td>
              <td>${b.version === shelf.current ? html`<${Stat} label="sent to devices" kind="good" />` : null}</td>
              <td class="acts">
                ${b.version === shelf.current ? null : html`<${Button} class="btn sm" run=${send(b)}>Send this one</${Button}>`}
                <${Button} class="btn sm" run=${() => download(path(b), `${type}-${b.version}.bin`)}>Download</${Button}>
                <${Button} class="btn sm ghost" run=${remove(b)}>Remove</${Button}>
              </td></tr>`)}
          </tbody></table></div>`
        : html`<p class="empty">No builds held for this type. Add one above.</p>`}
      <div class="btnrow">
        ${held ? html`<${Button} class="btn primary" disabled=${!ready.length} run=${run(() => updateType(type))}>${ready.length ? `Update ${plural(ready.length, "device")} to ${held.version}` : "Nothing to update"}</${Button}>` : null}
        ${shelf.builds.length ? html`<${Button} class="btn ghost" run=${removeAll}>Remove every build</${Button}>` : null}
      </div>
      <${Note} m=${m} />
    </div>
  </section>`;
}

export function FirmwarePage() {
  const types = firmwareTypes();
  return html`<${Head} page="firmware" />
    <${AddBuild} />
    <div id="firmware-shelves">
      ${types.length ? types.map((t) => html`<${Shelf} key=${t} type=${t} />`) : html`<p class="empty">No devices are paired and no builds are held yet.</p>`}
    </div>
    <p class="help">A new board gets its first build over USB from the <a href="/flash/" target="_blank" rel="noopener">flasher page ↗</a>; after that, builds reach it over Wi-Fi from here. The Quest app and the Windows app are on <a href="#apps">Apps</a>.</p>`;
}

// --- Wake words (#wakewords) ----------------------------------------------------------------------

/** Where a score sits on the strip, which runs from 50 % to 100 %. */
const scoreAt = (score) => `${Math.min(100, Math.max(0, (score * 100 - 50) * 2))}%`;

function WakeScores({ words }) {
  const [hours, setHours] = useState(168);
  const [data, load] = useLoad(`/admin/wakes?hours=${hours}`, 10_000);
  useEffect(() => void load(), [hours]);
  const wakes = data?.wakes ?? [];
  const groups = new Map();
  for (const w of wakes) groups.set(`${w.clientId}|${w.word}`, [...(groups.get(`${w.clientId}|${w.word}`) ?? []), w]);
  const cutoffOf = (word) => words?.wakeWords.find((k) => k.id === word)?.cutoff;
  const show = (n) => `${Math.round(n * 100)} %`;
  return html`<section class="card" id="wakes">
    <div class="card-h"><h3>What devices heard</h3>
      <div class="seg" id="wake-range" role="group" aria-label="How far back">
        ${[[24, "24 hours"], [168, "7 days"]].map(([h, label]) => html`<button type="button" key=${h} class=${hours === h ? "on" : ""} aria-pressed=${hours === h} data-hours=${h} onClick=${() => setHours(h)}>${label}</button>`)}
      </div></div>
    <div class="card-b" id="wake-scores">
      ${!data
        ? html`<${Loading} />`
        : !wakes.length
          ? html`<p class="empty">No device has reported a wake word in this time.</p>`
          : html`<div class="tablebox"><table class="t"><thead><tr><th>Device</th><th>Wake word</th><th>Heard</th><th>Answered</th><th>Lowest</th><th>Typical</th><th>Highest</th><th>Each one, 50 % to 100 %</th><th>Last</th></tr></thead><tbody>
              ${[...groups.values()].map((list) => {
                const scores = list.map((w) => w.score).sort((a, b) => a - b);
                const cutoff = cutoffOf(list[0].word);
                return html`<tr key=${list[0].clientId + list[0].word}>
                  <td><a href=${deviceHref(list[0].clientId)}>${list[0].client}</a></td>
                  <td><span class="mono">${list[0].word}</span> <span class="dim sm">${cutoff ? `cutoff ${cutoff} %` : "cutoff set in the build"}</span></td>
                  <td>${list.length}</td><td>${list.filter((w) => w.outcome === "answered").length}</td>
                  <td>${show(scores[0])}</td><td>${show(scores[Math.floor((scores.length - 1) / 2)])}</td><td>${show(scores.at(-1))}</td>
                  <td><div class="scorestrip" title=${`${list.length} wake words, lowest ${show(scores[0])}, highest ${show(scores.at(-1))}`}>
                    ${cutoff ? html`<i class="cut" style=${`left:${scoreAt(cutoff / 100)}`}></i>` : null}
                    ${list.slice(0, 200).map((w, i) => html`<i key=${i} class=${w.outcome} style=${`left:${scoreAt(w.score)}`}></i>`)}
                  </div></td>
                  <td class="dim">${ago(list[0].at)}</td></tr>`;
              })}
            </tbody></table></div>
            <p class="legend"><span><i class="swatch" style="background:var(--good)"></i>answered</span><span><i class="swatch" style="background:var(--dim)"></i>another device answered</span>
              <span><i class="swatch" style="background:var(--warn)"></i>ignored: a device nearby was speaking</span><span><i class="linekey" style="background:var(--text)"></i>the stored cutoff</span></p>`}
    </div>
  </section>`;
}

function AddWakeWord({ done }) {
  const [v, setV] = useState({ name: "", cutoff: 90, window: 5 });
  const [m, setM] = useState();
  const model = useRef();
  const manifest = useRef();
  const put = (k) => (e) => setV({ ...v, [k]: e.currentTarget.value });
  // A manifest fills in the phrase, cutoff and window, so they do not have to be copied by hand.
  const readManifest = async () => {
    const file = manifest.current.files[0];
    if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      setV({
        name: j.wake_word || v.name,
        cutoff: j.micro?.probability_cutoff ? Math.round(j.micro.probability_cutoff * 100) : v.cutoff,
        window: j.micro?.sliding_window_size || v.window,
      });
      const step = j.micro?.feature_step_size;
      setM(step && step !== 10 ? { kind: "bad", text: `This model uses a ${step} ms feature step; devices only run 10 ms models.` } : { text: "Filled in from the manifest." });
    } catch {
      setM({ kind: "bad", text: "That manifest is not valid JSON." });
    }
  };
  const add = async () => {
    const file = model.current.files[0];
    if (!file) return setM({ kind: "bad", text: "Choose the .tflite model." });
    if (!v.name.trim()) return setM({ kind: "bad", text: "Say what the phrase is." });
    try {
      const data = await upload(`/admin/wakewords?${new URLSearchParams({ name: v.name.trim(), cutoff: v.cutoff, window: v.window })}`, file);
      setM({ kind: "good", text: `"${data.name}" is stored as ${data.id}. Choose it with the Wake word setting.` });
      model.current.value = "";
      manifest.current.value = "";
      done();
    } catch (error) {
      setM({ kind: "bad", text: error.message });
    }
  };
  return html`<section class="card" id="wake-add">
    <div class="card-h"><h3>Add a wake word</h3></div>
    <div class="card-b fgrid">
      <${F} label="Model" id="wake-file" help="A microWakeWord .tflite model with a 10 ms feature step."><input id="wake-file" class="field" type="file" accept=".tflite" ref=${model} /></${F}>
      <${F} label="Manifest (optional)" id="wake-manifest" help="Its .json fills in the phrase, cutoff and window."><input id="wake-manifest" class="field" type="file" accept=".json,application/json" ref=${manifest} onChange=${readManifest} /></${F}>
      <${F} label="Phrase" id="wake-name"><input id="wake-name" class="field" value=${v.name} onInput=${put("name")} placeholder="Hey Jarvis" /></${F}>
      <${F} label="Cutoff" id="wake-cutoff" help="How sure the model must be, 50 to 99 %."><span class="unit"><input id="wake-cutoff" class="field num" type="number" min="50" max="99" value=${v.cutoff} onInput=${put("cutoff")} /> %</span></${F}>
      <${F} label="Window" id="wake-window" help="How many frames in a row it must be that sure, 1 to 12."><input id="wake-window" class="field num" type="number" min="1" max="12" value=${v.window} onInput=${put("window")} /></${F}>
      <div class="f"><span class="f-l"></span><div class="f-c"><${Button} class="btn primary" id="wake-upload" run=${add}>Add</${Button}><${Note} m=${m} id="wake-note" /></div></div>
    </div>
  </section>`;
}

export function WakeWordsPage() {
  const entity = "page:wakewords";
  const [data, load, error] = useLoad("/admin/wakewords", 5000);
  const saved = {};
  for (const w of data?.wakeWords ?? []) {
    saved[`${w.id}.cutoff`] = w.cutoff;
    saved[`${w.id}.window`] = w.window;
  }
  const form = useForm(entity, saved);
  const apply = async (v, keys) => {
    const byWord = new Map();
    for (const k of keys) {
      const [id, field] = [k.slice(0, k.lastIndexOf(".")), k.slice(k.lastIndexOf(".") + 1)];
      byWord.set(id, { ...byWord.get(id), [field]: Number(v[k]) });
    }
    for (const [id, body] of byWord) await api("PATCH", `/admin/wakewords/${enc(id)}`, body);
    await load();
  };
  const save = () => saveForm(entity, saved, apply, { words: (s) => `${plural(Object.keys(s).length, "change")} saved. Devices listening with it restart to take it.` });
  const remove = async (w) => {
    if (!(await ask({ title: `Remove "${w.name}"?`, body: "Devices listening with it go back to their built-in wake word.", confirm: "Remove", danger: true }))) return;
    await api("DELETE", `/admin/wakewords/${enc(w.id)}`);
    setDraft(entity, (d) => {
      delete d.values[`${w.id}.cutoff`];
      delete d.values[`${w.id}.window`];
      return d;
    });
    toast(`"${w.name}" removed.`);
    await load();
  };
  const users = (names) => (names.length ? names.join(", ") : html`<span class="dim">nobody online</span>`);
  const num = (w, field, min, max) => html`<input class="field num" type="number" min=${min} max=${max} data-f=${`${w.id}.${field}`} aria-label=${`${field} for ${w.name}`}
    value=${form.value(`${w.id}.${field}`)} onInput=${(e) => form.put(`${w.id}.${field}`, e.currentTarget.value === "" ? "" : Number(e.currentTarget.value))} />`;
  return html`<${Head} page="wakewords" />
    <section class="card" id="wakewords-card">
      <div class="card-h"><h3>Stored wake words</h3></div>
      ${!data
        ? html`<div class="card-b">${error ? html`<p class="msg bad">${error}</p>` : html`<${Loading} />`}</div>`
        : html`<div class="tablebox flat"><table class="t" id="wakewords-list"><thead><tr><th>Phrase</th><th>Name in settings</th><th>Cutoff %</th><th>Window</th><th>Size</th><th>Listening with it</th><th></th></tr></thead><tbody>
            <tr><td>The firmware's own</td><td class="mono">built-in</td><td class="dim">set in the build</td><td></td><td></td><td>${users(data.builtInUsedBy)}</td><td></td></tr>
            ${data.wakeWords.map((w) => html`<tr key=${w.id} class=${form.dirty(`${w.id}.cutoff`) || form.dirty(`${w.id}.window`) ? "dirty" : ""}>
              <td>${w.name}</td><td class="mono">${w.id}</td><td>${num(w, "cutoff", 50, 99)}</td><td>${num(w, "window", 1, 12)}</td>
              <td>${Math.round(w.size / 1024)} KB</td><td>${users(w.usedBy)}</td>
              <td class="acts"><${Button} class="btn sm" run=${() => download(`/admin/wakewords/${enc(w.id)}`, `${w.id}.tflite`)}>Download</${Button}><${Button} class="btn sm ghost" run=${() => remove(w)}>Remove</${Button}></td>
            </tr>`)}
          </tbody></table></div>
          <div class="card-b"><p class="help">To put a device on one of these, set <b>Wake word</b> for <a href="#settings?key=wakeWord">every device</a>, for a type, or on a device's own Settings tab.</p></div>`}
    </section>
    <${WakeScores} words=${data} />
    <${AddWakeWord} done=${load} />
    <${SaveBar} entity=${entity} save=${save} floating />`;
}

// --- Apps (#apps) ---------------------------------------------------------------------------------

/** Tells a Windows computer to fetch the desktop app this hub holds, after asking. */
function DesktopUpdate({ client, app }) {
  if (!app?.available || !client.version || client.version === app.version) return null;
  const go = async () => {
    if (!(await ask({ title: `Update ${client.name}?`, body: `From ${client.version} to ${app.version}. The app restarts and is away for a few seconds.`, confirm: "Update" }))) return;
    toast(await updateDevice(client));
  };
  return html`<${Button} class="btn sm" disabled=${!client.online} title=${client.online ? "" : "It can update once it is online"} run=${go}>Update to ${app.version}</${Button}>`;
}

function AppDevices({ type, app }) {
  const list = store.clients.filter((c) => c.type === type);
  if (!list.length) return html`<p class="dim sm">None paired.</p>`;
  return html`<div class="tablebox"><table class="t"><tbody>${list.map((c) => html`<tr key=${c.id}>
    <td><i class=${`d ${c.online ? "good" : ""}`}></i> <a href=${deviceHref(c)}>${c.name}</a></td><td class="mono">${c.version || "?"}</td><td class="dim">${c.online ? "online" : `last seen ${ago(c.lastSeenAt)}`}</td>
    <td class="acts">${type === "meta-quest" ? (behind(c) ? html`<${UpdateButton} client=${c} label=${`Update to ${store.quest.version}`} />` : null) : html`<${DesktopUpdate} client=${c} app=${app} />`}</td></tr>`)}</tbody></table></div>`;
}

export function AppsPage() {
  const [desktop] = useLoad("/admin/desktop");
  const quest = store.quest;
  const built = (at) => (at ? ` · built ${ago(at)}` : "");
  return html`<${Head} page="apps" />
    <section class="card" id="app-windows">
      <div class="card-h"><h3>Windows desktop app</h3><span class="badge">experimental</span>
        ${desktop === undefined ? null : desktop?.available ? html`<${Stat} label=${`version ${desktop.version ?? "?"}`} kind="good" />` : html`<${Stat} label="not on this hub" />`}</div>
      <div class="card-b">
        <p>One file to run on the computer, then paste a setup string from <a href="#pair">Add a device</a>. Agents can see that screen, point, click and type there through the <code>vortex_axis_desktop</code> tool, off until switched on under <a href="#tools">Tools and MCP</a>. Windows may warn that it is not signed.</p>
        <div class="btnrow"><${Button} class="btn primary" id="apps-desktop-download" disabled=${!desktop?.available} run=${() => download("/admin/desktop/app", "VortexAxisDesktop.exe")}>Download the desktop app</${Button}>
          <span class="dim sm" id="apps-desktop-info">${desktop === undefined ? "" : desktop?.available ? `version ${desktop.version ?? "?"} · ${mb(desktop.size)}${built(desktop.builtAt)}` : "Not built on this hub yet: run scripts/build-desktop.sh on the hub."}</span></div>
        <h4 class="sub-h">Windows computers</h4>
        <${AppDevices} type="windows-desktop" app=${desktop} />
      </div>
    </section>
    <section class="card" id="app-quest">
      <div class="card-h"><h3>Meta Quest panel app</h3><span class="badge">experimental</span>
        ${quest?.available ? html`<${Stat} label=${`version ${quest.version}`} kind="good" />` : html`<${Stat} label="not on this hub" />`}</div>
      <div class="card-b">
        <p>Installed once by cable (<code>adb install -r quest-client.apk</code>, from Unknown Sources); then give it the setup string and Pair. Later builds reach a headset from this hub: its Update button installs the one held here.</p>
        <p class="dim sm" id="apps-quest-info">${quest?.available
          ? html`This hub holds version <b>${quest.version}</b> · ${mb(quest.size)}${built(quest.builtAt)} · sha256 <span class="mono" title=${quest.sha256}>${String(quest.sha256 ?? "").slice(0, 12)}</span>`
          : "No Quest build is on this hub yet: run scripts/build-quest-client.sh on the hub."}</p>
        <h4 class="sub-h">Headsets</h4>
        <${AppDevices} type="meta-quest" />
      </div>
    </section>
    <section class="card" id="app-mac">
      <div class="card-h"><h3>Mac menu bar app</h3><span class="badge">experimental</span><${Stat} label="built on a Mac" /></div>
      <div class="card-b">
        <p>Built on a Mac from the repository (<code>clients/macos-desktop</code>); this hub does not hold or serve it. In its window, paste the setup string, give the Mac a name, and Pair. It does not update itself: build and run the new one by hand.</p>
        <h4 class="sub-h">Macs</h4>
        <${AppDevices} type="macos-desktop" />
      </div>
    </section>`;
}
