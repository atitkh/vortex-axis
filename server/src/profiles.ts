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
 */

export const PROFILE_NAMES = ["normal", "power-saver", "silent"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];
/** What the `profile` setting may hold. */
export const PROFILE_CHOICES = ["auto", ...PROFILE_NAMES] as const;
/** Why a device is on its profile: chosen by hand, put there by the battery rule, or "auto" with no rule in force. */
export type ProfileReason = "manual" | "battery" | "auto";

/** Points above `powerSaverBelow` the battery must reach before power saver ends by itself. */
export const POWER_SAVER_HYSTERESIS = 10;

interface Overrides {
  /** Numbers held at or below the value (a lower one the device already has is kept). */
  cap?: Record<string, number>;
  /** Values put in place of the device's own. */
  set?: ScalarMap;
}

/**
 * The overrides, on settings the boards declare (firmware `main.cpp` tables): `brightness` (10 to 255, default 200),
 * `maxFps` (a choice of 20, 30, 45, 60, default 30; the boards take 15 to 60), `volume` (0 to 100), `listenCue` and `taskChime` (toggles, 0 or 1).
 * The boards have no screen timeout, so power saver does not shorten one; the wake word stays on in both.
 */
export const PROFILES: Record<ProfileName, Overrides> = {
  normal: {},
  "power-saver": { cap: { brightness: 100, maxFps: 15 } },
  silent: { set: { volume: 0, listenCue: 0, taskChime: 0 } },
};

/** The profile name a `profile` setting holds, or undefined for "auto" and anything unknown. */
export function chosenProfile(value: unknown): ProfileName | undefined {
  return (PROFILE_NAMES as readonly unknown[]).includes(value) ? (value as ProfileName) : undefined;
}

/**
 * The settings with `profile`'s overrides applied. Only keys the device has are touched: a value in `settings`, or a
 * default its own description gives (`declared`), so a board is handed `maxFps` and a browser without one is not.
 * A capped value keeps its type (a choice sent as "30" goes out as "20").
 */
export function withProfile(settings: ScalarMap, profile: ProfileName, declared: ScalarMap = {}): ScalarMap {
  const { cap = {}, set = {} } = PROFILES[profile];
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

/** The profile in force: a manual choice beats the rule. */
export function activeProfile(choice: unknown, saver: boolean): { profile: ProfileName; reason: ProfileReason } {
  const chosen = chosenProfile(choice);
  if (chosen) return { profile: chosen, reason: "manual" };
  return saver ? { profile: "power-saver", reason: "battery" } : { profile: "normal", reason: "auto" };
}
