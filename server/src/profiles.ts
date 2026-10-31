import type { ScalarMap } from "@vortex-axis/protocol";

/**
 * Profiles: a named set of overrides on settings that already exist, applied in the settings a device is sent,
 * between its own settings and quiet hours (device setting, then the profile, then quiet hours, which stay a hard
 * cap on volume and brightness). No firmware or app knows about profiles: they see ordinary values.
 *
 * A device's `profile` setting is the choice: "auto" (the default) lets the rules decide, any other name is a manual
 * choice that holds until it is set back to "auto". The one rule: a device that reports its battery goes to power
 * saver at or below the hub's `powerSaverBelow` percent while not charging, and back to normal at that plus
 * `POWER_SAVER_HYSTERESIS`, or as soon as it charges.
 *
 * Silent also changes how Axis delivers to the device (turns.ts, delivery.ts): nothing is spoken there, replies and
 * messages are shown as text, and a device without a screen keeps messages until it leaves silent.
 *
 * Dock is normal in every respect but one: the device's `chargeLimit` is the hub's `dockChargeLimit`, so a board left
 * on USB holds its battery there (the firmware does the holding). It is a manual choice only: no rule picks it.
 */

export const BUILT_IN_PROFILE_NAMES = ["normal", "power-saver", "silent", "dock", "pocket"] as const;
/** A profile's name: a lowercase slug. Built-ins and custom profiles alike. */
export type ProfileName = string;

/** Why a device is on its profile: chosen by hand, put there by the battery rule, or "auto" with no rule in force. */
export type ProfileReason = "manual" | "battery" | "auto";

/** The hub's settings a profile's overrides are made from. */
export interface ProfileHubSettings {
  /** The charge limit Dock holds a device's battery at (50 to 100). */
  dockChargeLimit: number;
}

export const DEFAULT_DOCK_CHARGE_LIMIT = 80;

/** Points above `powerSaverBelow` the battery must reach before power saver ends by itself. */
export const POWER_SAVER_HYSTERESIS = 10;

export interface Overrides {
  /** Numbers held at or below the value (a lower one the device already has is kept). */
  cap?: Record<string, number>;
  /** Values put in place of the device's own. */
  set?: ScalarMap;
  /** Capabilities switched off while on the profile. Stored, not applied yet. */
  capabilitiesOff?: string[];
}

/** A stored or built-in profile, whole. */
export interface Profile {
  name: string;
  label?: string;
  set: ScalarMap;
  cap: Record<string, number>;
  capabilitiesOff: string[];
}

/**
 * The built-in profiles' defaults, on settings the boards declare (firmware `main.cpp` tables): `brightness` (10 to 255, default 200),
 * `maxFps` (a choice of 20, 30, 45, 60, default 30; the boards take 15 to 60), `volume` (0 to 100), `listenCue` and `taskChime` (toggles, 0 or 1).
 * The boards have no screen timeout, so power saver does not shorten one; the wake word stays on in both.
 * Pocket is silent's numbers plus a dim screen, for a device in a bag; manual only.
 */
export const PROFILES: Record<string, Overrides & { label: string }> = {
  normal: { label: "Normal" },
  "power-saver": { label: "Power saver", cap: { brightness: 100, maxFps: 15 } },
  silent: { label: "Silent", set: { volume: 0, listenCue: 0, taskChime: 0 } },
  // Its chargeLimit is made from the hub's dockChargeLimit by overridesOf.
  dock: { label: "Dock" },
  pocket: { label: "Pocket", set: { volume: 0, listenCue: 0, taskChime: 0 }, cap: { brightness: 30 } },
};

/** The profiles in force, by name: what `withProfile` and `activeProfile` look names up in. */
export type ProfileTable = Record<string, Overrides>;

/** The overrides of `profile`, with the hub's values filled in. Dock's chargeLimit goes beneath an admin's own. */
export function overridesOf(profile: ProfileName, hub: ProfileHubSettings, table: ProfileTable = PROFILES): Overrides {
  const own = table[profile] ?? {};
  if (profile === "dock") return { ...own, set: { chargeLimit: hub.dockChargeLimit, ...own.set } };
  return own;
}

/** The profile name a `profile` setting holds, or undefined for "auto" and anything unknown. */
export function chosenProfile(value: unknown, names: readonly string[] = BUILT_IN_PROFILE_NAMES): ProfileName | undefined {
  return typeof value === "string" && names.includes(value) ? value : undefined;
}

/**
 * The settings with `profile`'s overrides applied. Only keys the device has are touched: a value in `settings`, or a
 * default its own description gives (`declared`), so a board is handed `maxFps` and a browser without one is not.
 * A capped value keeps its type (a choice sent as "30" goes out as "20").
 */
export function withProfile(
  settings: ScalarMap,
  profile: ProfileName,
  declared: ScalarMap = {},
  hub: ProfileHubSettings = { dockChargeLimit: DEFAULT_DOCK_CHARGE_LIMIT },
  table: ProfileTable = PROFILES,
): ScalarMap {
  const { cap = {}, set = {} } = overridesOf(profile, hub, table);
  const out: ScalarMap = { ...settings };
  for (const [key, limit] of Object.entries(cap)) {
    const value = key in settings ? settings[key] : declared[key];
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number) || number <= limit) continue;
    out[key] = typeof value === "string" ? String(limit) : limit;
  }
  for (const [key, value] of Object.entries(set)) {
    if (key in settings || key in declared) out[key] = value;
  }
  return out;
}

/**
 * Whether the battery rule puts a device on power saver, given whether it did before (`was`). Unknown battery: off.
 * `below` 0 switches the rule off.
 */
export function batterySaver(was: boolean, battery: number | undefined, charging: boolean | undefined, below: number): boolean {
  if (below <= 0 || battery === undefined || charging) return false;
  if (battery <= below) return true;
  if (battery >= below + POWER_SAVER_HYSTERESIS) return false;
  return was;
}

/** The profile in force: a manual choice beats the rule. The rule only ever picks power saver: never silent or dock. */
export function activeProfile(
  choice: unknown,
  saver: boolean,
  names: readonly string[] = BUILT_IN_PROFILE_NAMES,
): { profile: ProfileName; reason: ProfileReason } {
  const chosen = chosenProfile(choice, names);
  if (chosen) return { profile: chosen, reason: "manual" };
  return saver ? { profile: "power-saver", reason: "battery" } : { profile: "normal", reason: "auto" };
}

const META_KEY = "profiles";
export const PROFILE_NAME = /^[a-z0-9-]{1,24}$/;

const isBuiltIn = (name: string): boolean => Object.hasOwn(PROFILES, name);

function defaultProfile(name: string): Profile {
  const d = PROFILES[name]!;
  return { name, label: d.label, set: { ...d.set }, cap: { ...d.cap }, capabilitiesOff: [...(d.capabilitiesOff ?? [])] };
}

const same = (a: Profile, b: Profile): boolean =>
  JSON.stringify([a.label ?? "", a.set, a.cap, a.capabilitiesOff]) === JSON.stringify([b.label ?? "", b.set, b.cap, b.capabilitiesOff]);

/** The profiles in the hub database: the built-ins' defaults, with what an admin edited or added kept in the `profiles` meta value. */
export class Profiles {
  constructor(private readonly store: { getMeta(key: string): string | undefined; setMeta(key: string, value: string | undefined): void }) {}

  private stored(): Record<string, Profile> {
    try {
      const raw = JSON.parse(this.store.getMeta(META_KEY) ?? "{}") as Record<string, Partial<Profile>>;
      const out: Record<string, Profile> = {};
      for (const [name, p] of Object.entries(raw)) {
        if (!PROFILE_NAME.test(name)) continue;
        out[name] = { name, ...(p.label ? { label: p.label } : {}), set: p.set ?? {}, cap: p.cap ?? {}, capabilitiesOff: p.capabilitiesOff ?? [] };
      }
      return out;
    } catch {
      return {};
    }
  }

  private save(all: Record<string, Profile>): void {
    this.store.setMeta(META_KEY, Object.keys(all).length ? JSON.stringify(all) : undefined);
  }

  /** Every profile: built-ins first, in their order, then custom ones by name. */
  list(): Array<Profile & { isBuiltIn: boolean; edited: boolean }> {
    const stored = this.stored();
    const out = Object.keys(PROFILES).map((name) => {
      const profile = stored[name] ?? defaultProfile(name);
      return { ...profile, isBuiltIn: true, edited: stored[name] !== undefined && !same(stored[name]!, defaultProfile(name)) };
    });
    for (const name of Object.keys(stored).sort()) if (!isBuiltIn(name)) out.push({ ...stored[name]!, isBuiltIn: false, edited: false });
    return out;
  }

  names(): string[] {
    return this.list().map((p) => p.name);
  }

  has(name: string): boolean {
    return this.names().includes(name);
  }

  /** What `withProfile` and `activeProfile` look up. */
  table(): ProfileTable {
    return Object.fromEntries(this.list().map((p) => [p.name, { set: p.set, cap: p.cap, capabilitiesOff: p.capabilitiesOff }]));
  }

  /** Creates or replaces a profile (a built-in's edit is kept apart from its default). */
  put(profile: Profile): void {
    const all = this.stored();
    all[profile.name] = profile;
    this.save(all);
  }

  /** Removes a custom profile. False when there is none. Built-ins are not removed here. */
  remove(name: string): boolean {
    const all = this.stored();
    if (isBuiltIn(name) || !(name in all)) return false;
    delete all[name];
    this.save(all);
    return true;
  }

  /** Puts a built-in back to its default. */
  reset(name: string): void {
    const all = this.stored();
    delete all[name];
    this.save(all);
  }
}

/** Why `body` is not a profile an admin may save, or the profile. `known` are the setting keys that exist. */
export function parseProfile(name: string, body: unknown, known: ReadonlySet<string>): Profile | string {
  if (!PROFILE_NAME.test(name)) return "a profile name is 1 to 24 characters of a-z, 0-9 and -";
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be { label?, set: { key: value }, cap: { key: number } }";
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!["label", "set", "cap", "capabilitiesOff"].includes(key)) return `unknown field ${key}`;
  const obj = (v: unknown, what: string): Record<string, unknown> | string =>
    v === undefined ? {} : typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : `${what} must be an object`;
  const set = obj(b.set, "set");
  if (typeof set === "string") return set;
  const cap = obj(b.cap, "cap");
  if (typeof cap === "string") return cap;
  const outSet: ScalarMap = {};
  for (const [key, value] of Object.entries(set)) {
    if (!known.has(key)) return `set: ${key} is not a setting of any device`;
    if (!(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) return `set.${key} must be a text, number or boolean`;
    outSet[key] = typeof value === "boolean" ? (value ? 1 : 0) : value;
  }
  const outCap: Record<string, number> = {};
  for (const [key, value] of Object.entries(cap)) {
    if (!known.has(key)) return `cap: ${key} is not a setting of any device`;
    if (typeof value !== "number" || !Number.isFinite(value)) return `cap.${key} must be a number`;
    outCap[key] = value;
  }
  if (b.label !== undefined && (typeof b.label !== "string" || b.label.length > 40)) return "label must be text of at most 40 characters";
  const off = b.capabilitiesOff;
  if (off !== undefined && (!Array.isArray(off) || off.some((x) => typeof x !== "string"))) return "capabilitiesOff must be a list of texts";
  const label = typeof b.label === "string" && b.label.trim() ? b.label.trim() : undefined;
  return { name, ...(label ? { label } : {}), set: outSet, cap: outCap, capabilitiesOff: (off as string[] | undefined) ?? [] };
}
