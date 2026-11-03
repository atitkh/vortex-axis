// Pure logic of the Speech page's ranked entry lists: reorder, add, delete, and the PATCH payload.
// No DOM here, so server/test/speech-entries.test.ts can run it.

export const MAX_ENTRIES = 8;
export const COOLDOWN_MIN = 5;
export const COOLDOWN_MAX = 3600;

/** Model ids (by prefix) that act on audio tags. Same list as AUDIO_TAG_MODEL_PREFIXES in server/src/audiotags.ts; a test checks they agree. */
export const AUDIO_TAG_MODEL_PREFIXES = ["eleven_v4", "eleven_v3"];

/** Whether an ElevenLabs model acts on audio tags such as [whispers]. */
export function modelSupportsAudioTags(kind, model) {
  const id = String(model ?? "").trim().toLowerCase();
  return kind === "elevenlabs" && AUDIO_TAG_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** Moves the item at `from` so it ends up at index `to` (both clamped). Returns a new array. */
export function moveEntry(list, from, to) {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/** Index to drop at, given the pointer's Y and the vertical midpoints of the cards (in order). */
export function dropIndex(mids, y) {
  let i = 0;
  while (i < mids.length && y > mids[i]) i++;
  return i;
}

/** Drag-and-drop: the card at `from` released at insertion slot `slot` (0..length, slot between cards). */
export function dropEntry(list, from, slot) {
  return moveEntry(list, from, slot > from ? slot - 1 : slot);
}

let counter = 0;
/** A fresh unsaved entry: no id until the hub gives it one; `key` is the page's own handle. */
export function newEntry(kind = "openai") {
  return { key: `new-${Date.now().toString(36)}-${counter++}`, enabled: true, label: "", kind, url: "", model: kind === "elevenlabs" ? "" : "", voice: "", sampleRate: 24000, audioTags: "auto", apiKey: "" };
}

export const canAdd = (list) => list.length < MAX_ENTRIES;
export const addEntry = (list, kind) => (canAdd(list) ? [...list, newEntry(kind)] : list);
export const removeEntry = (list, index) => list.filter((_, i) => i !== index);

/** The page's working copy of a service from /admin/config: one editable object per entry; keys are never present. */
export function entriesFromConfig(svc) {
  const list = Array.isArray(svc?.entries) && svc.entries.length
    ? svc.entries
    : svc?.url ? [{ id: "main", enabled: true, label: "", kind: svc.kind, url: svc.url, model: svc.model, voice: svc.voice, sampleRate: svc.sampleRate, apiKeySet: svc.apiKeySet, keySource: svc.keySource }] : [];
  return list.map((e) => ({ ...e, key: e.id, label: e.label ?? "", voice: e.voice ?? "", apiKey: "" }));
}

/** True when the working list differs from what is saved (order, fields, a typed key). */
export function listChanged(working, saved) {
  return JSON.stringify(working) !== JSON.stringify(saved);
}

export function cooldownError(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= COOLDOWN_MIN && n <= COOLDOWN_MAX ? "" : `The cooldown is a whole number of seconds from ${COOLDOWN_MIN} to ${COOLDOWN_MAX}.`;
}

/**
 * The PATCH body for one service. Known ids keep the key they have (apiKey omitted unless typed);
 * new entries carry no id. Throws an Error with a message for the save bar on bad input.
 */
export function buildServicePatch(which, working, cooldown) {
  if (working.length > MAX_ENTRIES) throw new Error(`At most ${MAX_ENTRIES} entries for ${which === "stt" ? "speech to text" : "text to speech"}.`);
  const err = cooldownError(cooldown);
  if (err) throw new Error(err);
  const entries = working.map((e, i) => {
    const where = `${which === "stt" ? "Speech to text" : "Text to speech"} #${i + 1}`;
    const out = { enabled: Boolean(e.enabled), label: String(e.label ?? "").trim(), kind: e.kind, url: String(e.url ?? "").trim(), model: String(e.model ?? "").trim() };
    if (!e.key?.startsWith("new-") && e.id) out.id = e.id;
    if (which === "tts") {
      out.voice = String(e.voice ?? "").trim();
      out.audioTags = e.audioTags === "off" ? "off" : "auto";
      if (e.kind !== "elevenlabs") {
        const rate = Number(e.sampleRate);
        if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) throw new Error(`${where}: the PCM sample rate is a whole number from 8000 to 48000.`);
        out.sampleRate = rate;
      }
    }
    if (e.apiKey) out.apiKey = e.apiKey;
    return out;
  });
  return { entries, cooldownSeconds: Number(cooldown) };
}

/** What a status badge says for one entry: [text, badge kind, tooltip]. `now` in ms. */
export function entryBadge(entry, status, now = Date.now()) {
  if (!entry.enabled) return ["disabled", "", ""];
  if (!status) return ["not checked", "", ""];
  if (status.up === true) return ["up", "good", ""];
  if (status.up === false) {
    const secs = status.downUntil ? Math.max(0, Math.ceil((new Date(status.downUntil).getTime() - now) / 1000)) : 0;
    return [secs ? `down, retry in ${secs}s` : "down", "bad", status.lastError ?? ""];
  }
  return ["unknown", "warn", status.lastError ?? ""];
}

export function stateLine(state) {
  return { ok: "All good.", degraded: "Degraded: running on a fallback.", down: "Down: no entry answers.", off: "Off: no entry is switched on." }[state] ?? "";
}
