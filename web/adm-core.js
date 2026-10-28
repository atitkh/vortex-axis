// The admin page's shared core: the one store the 3 s poll fills, the API, sign-in, toasts, dialogs,
// staged setting edits (drafts) and small helpers. Every page reads the store; nothing here draws a page.
// Untrusted text (device names, replies) only ever goes into the page through htm's text holes, never as markup.

import { html, useEffect, useRef, useState } from "/web/preact.js";

export { html };

// --- the store -----------------------------------------------------------------------------

const listeners = new Set();
/** Everything fetched, and the page's own state that several parts read. */
export const store = {
  signedIn: false,
  signInError: "",
  loaded: false,
  status: undefined,
  gateway: undefined,
  clients: [],
  types: {},
  global: {},
  builtIns: [],
  now: undefined,
  nowSkew: 0,
  firmware: [],
  shelves: [],
  quest: undefined,
  config: undefined,
  check: undefined,
  integrations: undefined,
  activity: undefined,
  desktop: undefined,
  pollError: "",
  toasts: [],
  dialog: undefined,
  drafts: {},
  cmdk: false,
  navOpen: false,
};

/** Changes the store and redraws whatever reads it. */
export function set(patch) {
  Object.assign(store, typeof patch === "function" ? patch(store) : patch);
  for (const fn of listeners) fn();
}

/** Redraws the calling component whenever the store changes. */
export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return store;
}

// --- the API and sign-in -------------------------------------------------------------------

// The same keys as the classic page, so one sign-in serves both.
const TOKEN_KEY = "axis-admin-token";
let token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && store.signedIn) signOut("That token was not accepted.");
    throw new ApiError(res.status, data.error || `request failed (${res.status})`);
  }
  return data;
}

/** Fetches a file with the admin token and hands it to the browser as a download. */
export async function download(path, name) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error || `download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

let pollTimer;
let attempt = 0;

export function signOut(message = "") {
  token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  clearInterval(pollTimer);
  set({ signedIn: false, signInError: message, loaded: false, drafts: {}, dialog: undefined });
}

/** Signs in with `given` (or the token already kept). `remember` keeps it in this browser, else for this tab only. */
export async function signIn(given, remember) {
  if (given !== undefined) token = given.trim();
  if (!token) return;
  const mine = ++attempt;
  try {
    await api("GET", "/admin/status");
  } catch (error) {
    if (mine !== attempt) return;
    const message =
      error.status === 503 ? "The admin API is off: set AXIS_ADMIN_TOKEN on the hub and restart it."
      : error.status === 401 ? "That token was not accepted."
      : error.message;
    return signOut(given !== undefined || error.status !== 401 ? message : "");
  }
  if (mine !== attempt) return;
  if (remember !== undefined) {
    // Kept in one place only, so unticking the box really does forget it when the tab closes.
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
    (remember ? sessionStorage : localStorage).removeItem(TOKEN_KEY);
  }
  set({ signedIn: true, signInError: "" });
  await Promise.all([refresh(), loadSlow(true)]);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => document.hidden || refresh(), 3000);
}

export const hasToken = () => Boolean(token);
/** The header for a request made without `api()` (the live stream). */
export const authHeader = () => ({ authorization: `Bearer ${token}` });

/** The 3 s poll: what every page and the header read. */
export async function refresh() {
  if (!store.signedIn) return;
  try {
    const [status, gateway, clients, settings, now, firmware, quest] = await Promise.all([
      api("GET", "/admin/status"),
      api("GET", "/admin/gateway"),
      api("GET", "/admin/clients"),
      api("GET", "/admin/settings/global"),
      api("GET", "/admin/now").catch(() => undefined),
      api("GET", "/admin/firmware").catch(() => undefined),
      api("GET", "/admin/quest").catch(() => undefined),
    ]);
    set({
      loaded: true,
      pollError: "",
      status,
      gateway,
      clients: clients.clients,
      types: clients.types || {},
      global: settings.values,
      builtIns: settings.builtIns ?? store.builtIns,
      now,
      nowSkew: now ? now.at - Date.now() : 0,
      firmware: firmware?.firmware ?? [],
      shelves: firmware?.shelves ?? [],
      quest,
    });
  } catch (error) {
    if (error.status !== 401 && store.signedIn) set({ pollError: error.message || "Axis did not answer." });
  }
  if (Date.now() - slowAt > 60_000) loadSlow();
}

let slowAt = 0;
/** What changes slowly, read once a minute: for the attention list and the header (backup, Home Assistant, failed turns). */
export async function loadSlow(first = false) {
  slowAt = Date.now();
  const [config, check, integrations, activity] = await Promise.all([
    first || !store.config ? api("GET", "/admin/config").catch(() => undefined) : Promise.resolve(store.config),
    api("GET", "/admin/selfcheck").catch(() => undefined),
    api("GET", "/admin/integrations").catch(() => undefined),
    api("GET", "/admin/activity?hours=24").catch(() => undefined),
  ]);
  if (store.signedIn) set({ config, check, integrations, activity });
}

// --- toasts and dialogs --------------------------------------------------------------------

let toastId = 0;
/** A short message at the bottom. `undo` adds an Undo button that runs it. */
export function toast(text, kind = "good", undo) {
  const id = ++toastId;
  set({ toasts: [...store.toasts.slice(-2), { id, text, kind, undo }] });
  setTimeout(() => set({ toasts: store.toasts.filter((t) => t.id !== id) }), kind === "bad" || undo ? 8000 : 3500);
}
export const dropToast = (id) => set({ toasts: store.toasts.filter((t) => t.id !== id) });

/**
 * A dialog in place of confirm() and prompt(). Resolves with true (or the typed text when `input` is given)
 * when confirmed, and null when cancelled. `typed`: the person must type this text (a device's name) to confirm.
 */
export function ask({ title, body, confirm = "OK", cancel = "Cancel", danger = false, typed, input }) {
  return new Promise((resolve) => {
    const back = document.activeElement;
    set({
      dialog: {
        title, body, confirm, cancel, danger, typed, input,
        done: (value) => {
          set({ dialog: undefined });
          back?.focus?.();
          resolve(value);
        },
      },
    });
  });
}

/** Runs an action from a button: the button is disabled meanwhile, a failure is said in a toast (or `onError`). */
export async function act(fn, onError) {
  try {
    return await fn();
  } catch (error) {
    if (error.status === 401) return;
    if (onError) onError(error.message);
    else toast(error.message, "bad");
  }
}

/** A button that runs `run` once at a time, disabled while it does. */
export function Button({ run, children, class: cls = "btn", disabled, title, type = "button", ...rest }) {
  const [busy, setBusy] = useState(false);
  const click = async (event) => {
    if (!run) return;
    setBusy(true);
    try {
      await act(() => run(event));
    } finally {
      setBusy(false);
    }
  };
  return html`<button type=${type} class=${cls} disabled=${disabled || busy} title=${title} aria-busy=${busy ? "true" : undefined} onClick=${click} ...${rest}>${children}</button>`;
}

// --- staged edits ---------------------------------------------------------------------------

/**
 * Edits not yet saved, per thing being edited ("device:<id>", "type:<type>", "global"):
 * { values: { key: value }, caps: [off…] | undefined, name: string | undefined }.
 */
export function draftOf(entity) {
  return store.drafts[entity] ?? { values: {} };
}
export function setDraft(entity, change) {
  const next = change({ values: {}, ...store.drafts[entity], values: { ...store.drafts[entity]?.values } });
  const empty = !Object.keys(next.values).length && next.caps === undefined && next.name === undefined;
  const drafts = { ...store.drafts };
  if (empty) delete drafts[entity];
  else drafts[entity] = next;
  set({ drafts });
}
export const clearDraft = (entity) => setDraft(entity, () => ({ values: {} }));
export function draftCount(entity) {
  const d = store.drafts[entity];
  if (!d) return 0;
  return Object.keys(d.values).length + (d.caps !== undefined ? 1 : 0) + (d.name !== undefined ? 1 : 0);
}
/** Every entity with unsaved edits. */
export const dirtyEntities = () => Object.keys(store.drafts).filter((e) => draftCount(e) > 0);

// --- helpers ------------------------------------------------------------------------------

/** "3 min ago" style age of a timestamp. */
export function ago(at) {
  if (!at) return "never";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

/** 4 min, 2 h 14 min, 3 d 2 h. */
export function span(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ""}`;
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const enc = encodeURIComponent;
export const typeHref = (type, tab) => `#type/${enc(type)}${tab ? `/${tab}` : ""}`;
export const deviceHref = (c, tab) => `#clients/${enc(c.id ?? c)}${tab ? `/${tab}` : ""}`;

/** Names for client types that have one before a person gives their own. */
const TYPE_NAMES = { "meta-quest": "Meta Quest", web: "Web browser", "windows-desktop": "Windows computer", "macos-desktop": "Mac" };
/** The name a person gave a client type, or a known type's name, or the firmware's own identifier. */
export const typeName = (type) => store.types[type]?.label || TYPE_NAMES[type] || type;

export const clientById = (id) => store.clients.find((c) => c.id === id);
export const clientName = (idOrName) =>
  store.clients.find((c) => c.id === idOrName || c.name.toLowerCase() === String(idOrName).toLowerCase())?.name;

/** Every client type that has a device, with how many are online. */
export function typesInUse() {
  const types = new Map();
  for (const c of store.clients) {
    const t = types.get(c.type) || { type: c.type, total: 0, online: 0 };
    t.total++;
    if (c.online) t.online++;
    types.set(c.type, t);
  }
  return [...types.values()].sort((a, b) => typeName(a.type).localeCompare(typeName(b.type)));
}

/** The build Axis holds for a device: firmware for its type, or the Quest app for a headset. */
export function heldBuild(client) {
  if (client.type === "meta-quest") return store.quest?.available ? store.quest : undefined;
  return store.firmware.find((f) => f.type === client.type);
}
/** True when Axis holds a different build than the one the device runs. */
export function behind(client) {
  const held = heldBuild(client);
  return Boolean(held && client.version && held.version !== client.version);
}

/** What kind of thing a device is, for its picture and for when being offline matters. */
export function kindOf(client) {
  if (client.type === "web") return "browser";
  if (client.type === "meta-quest" || client.type === "quest-panels") return "headset";
  if ((client.reported ?? client.capabilities).includes("desktop")) return "computer";
  if (Number(client.readings?.screenRound) === 1) return "round";
  return "board";
}

/** How long a device may be offline before it needs attention, by its Offline alert setting; Infinity for never. */
export const AUTO_OFFLINE_MS = { board: 15 * 60_000, round: 15 * 60_000, computer: 12 * 3_600_000, headset: 12 * 3_600_000, browser: Infinity };
export function offlineAfter(client) {
  const choice = client.settings?.offlineAlert ?? "auto";
  if (choice === "never") return Infinity;
  if (choice === "always") return 10 * 60_000;
  return AUTO_OFFLINE_MS[kindOf(client)] ?? 15 * 60_000;
}

/** Runs one of a device's actions and words the answer. */
export async function runCommand(client, action) {
  const result = await api("POST", `/admin/clients/${enc(client.id)}/commands/${enc(action.name)}`);
  const detail = Object.entries(result.payload || {}).map(([k, v]) => `${k}: ${v}`).join(" · ");
  return { ok: result.ok, text: result.ok ? `${action.label}: done${detail ? ` · ${detail}` : ""}` : `${action.label}: ${result.error || "failed"}` };
}

/** Tells a device to install the build Axis holds for it. */
export async function updateDevice(client) {
  const told = await api("POST", `/admin/clients/${enc(client.id)}/update`);
  return `${told.client} is updating from ${told.from} to ${told.to}. It restarts by itself in about half a minute.`;
}

/** Puts a DOM node made elsewhere (charts.js) into a component. */
export function Dom({ node, class: cls }) {
  const ref = useRef();
  useEffect(() => {
    ref.current.replaceChildren(...(node ? [node] : []));
  }, [node]);
  return html`<div class=${cls} ref=${ref}></div>`;
}

/** localStorage that never throws (private windows, full quota). */
export const kept = {
  get: (key, fallback) => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// --- theme ----------------------------------------------------------------------------------

/** Dark (the default), light, or whatever the system prefers; kept in this browser. */
export function setTheme(choice) {
  try {
    localStorage.setItem("axis.theme", choice);
  } catch {}
  applyTheme();
  set({});
}
export const themeChoice = () => document.documentElement.dataset.themeChoice || "dark";
function applyTheme() {
  let chosen = "dark";
  try {
    chosen = localStorage.getItem("axis.theme") || "dark";
  } catch {}
  const light = chosen === "light" || (chosen === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  document.documentElement.dataset.themeChoice = chosen;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#f6f6f3" : "#000000");
}
matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => themeChoice() === "system" && (applyTheme(), set({})));
applyTheme();
