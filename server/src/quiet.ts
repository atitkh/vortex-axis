import type { ScalarMap } from "@vortex-axis/protocol";

/**
 * Quiet hours: a stretch of the day, set per device like any other setting,
 * when a device keeps its voice down and its screen dim, and when things an
 * agent wants to say unprompted are shown without sound unless marked urgent.
 * A person talking to the device is always answered aloud, just more quietly,
 * and timers always sound.
 *
 * `quietFrom` and `quietTo` are times of day as "HH:MM" in the hub's time
 * zone. Both empty (or equal) means there are no quiet hours. A stretch may
 * run over midnight ("22:30" to "07:00").
 */

/** Minutes since midnight for "HH:MM", or undefined when it is not a time. */
export function minutesOf(value: unknown): number | undefined {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(typeof value === "string" ? value : "");
  if (!match) return undefined;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

/** The time of day at `at` in `timeZone`, as minutes since midnight. */
export function minuteOfDay(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return part("hour") * 60 + part("minute");
}

/** True when a client with these settings is in its quiet hours at `at`. */
export function isQuiet(settings: ScalarMap, at: number, timeZone: string): boolean {
  const from = minutesOf(settings.quietFrom), to = minutesOf(settings.quietTo);
  if (from === undefined || to === undefined || from === to) return false;
  const now = minuteOfDay(at, timeZone);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/**
 * The settings a device is actually sent: during its quiet hours the volume
 * and brightness are capped. Only values the device already has are touched,
 * so a device with no screen is not handed a brightness.
 */
export function withQuiet(settings: ScalarMap, at: number, timeZone: string): ScalarMap {
  if (!isQuiet(settings, at, timeZone)) return settings;
  const cap = (key: string, limitKey: string, fallback: number): ScalarMap => {
    const limit = typeof settings[limitKey] === "number" ? (settings[limitKey] as number) : fallback;
    return typeof settings[key] === "number" ? { [key]: Math.min(settings[key] as number, limit) } : {};
  };
  return { ...settings, ...cap("volume", "quietVolume", 25), ...cap("brightness", "quietBrightness", 40) };
}
