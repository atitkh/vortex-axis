/** Wall-clock arithmetic for reminders: local time in an IANA zone to instants, repeat rules, next occurrence. Pure, `Intl` only. */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_AHEAD_MS = 366 * DAY;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LONG = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function localParts(at: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return { year, month, day, hour: part("hour"), minute: part("minute"), weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** Milliseconds the zone's clock is ahead of UTC at `at`, whole minutes. */
function offsetAt(at: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  const floored = Math.floor(at / MINUTE) * MINUTE;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - floored;
}

/**
 * The instant at which the zone's clock shows this date and time. In a DST overlap the first of the two; in a gap the
 * first valid instant after it (02:30 in a gap that skips 02:00 to 03:00 gives 03:00).
 */
export function localToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  const valid = [before, after].map((o) => wall - o).filter((t, i, all) => all.indexOf(t) === i && offsetAt(t, timeZone) === wall - t);
  if (valid.length > 0) return Math.min(...valid);
  // A gap: find the minute the offset changes.
  let lo = wall - before;
  let hi = wall - after;
  if (lo > hi) [lo, hi] = [hi, lo];
  const start = offsetAt(lo, timeZone);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE || lo + MINUTE;
    if (offsetAt(mid, timeZone) === start) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Reads the `at` of a one-off reminder: "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM[:SS]", with an optional Z or +hh:mm,
 * which is hub local time when absent. Throws unless it is in the future and within 366 days.
 */
export function parseWhen(at: string, timeZone: string, now: number): number {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/i.exec(at ?? "");
  if (!m) throw new Error(`"${at}" is not a date and time like 2026-10-31 09:00`);
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (hour > 23 || minute > 59 || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) throw new Error(`"${at}" is not a real date and time`);
  let ms: number;
  const zone = m[7];
  if (zone) {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.replace(/[^0-9]/g, "");
    const offset = zone.toUpperCase() === "Z" ? 0 : sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * MINUTE;
    ms = Date.UTC(year, month - 1, day, hour, minute) - offset;
  } else {
    ms = localToUtc(year, month, day, hour, minute, timeZone);
  }
  if (ms <= now) throw new Error(`${at} is in the past`);
  if (ms > now + MAX_AHEAD_MS) throw new Error(`${at} is more than 366 days away`);
  return ms;
}

/** Weekdays of a repeat rule as "1,2,3,4,5" (0 = Sunday). `weekly` needs `firstWeekday`, the weekday of the first occurrence. */
export function parseRepeat(repeat: string, firstWeekday?: number): string {
  const rule = (repeat ?? "").trim().toLowerCase();
  if (rule === "daily") return "0,1,2,3,4,5,6";
  if (rule === "weekdays") return "1,2,3,4,5";
  if (rule === "weekends") return "0,6";
  if (rule === "weekly") {
    if (firstWeekday === undefined) throw new Error("weekly needs the weekday of the first occurrence");
    return String(firstWeekday);
  }
  const days = new Set<number>();
  for (const name of rule.split(",").map((s) => s.trim())) {
    const index = DAY_NAMES.includes(name) ? DAY_NAMES.indexOf(name) : DAY_LONG.indexOf(name);
    if (index < 0) throw new Error(`"${repeat}" is not daily, weekdays, weekends, weekly or days like mon,wed,fri`);
    days.add(index);
  }
  return [...days].sort((a, b) => a - b).join(",");
}

/** The weekday (0 = Sunday) of an instant in the zone. */
export function weekdayOf(at: number, timeZone: string): number {
  return localParts(at, timeZone).weekday;
}

/** The zone's wall-clock "HH:MM" at an instant. */
export function timeOfDayOf(at: number, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** The first occurrence strictly after `afterMs` of a repeating reminder, in the zone as it is now. */
export function nextOccurrence(rule: { timeOfDay: string; days: string }, afterMs: number, timeZone: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(rule.timeOfDay);
  const hour = Number(m?.[1]);
  const minute = Number(m?.[2]);
  const days = rule.days.split(",").filter(Boolean).map(Number);
  if (!m || hour > 23 || minute > 59 || days.length === 0 || days.some((d) => !(d >= 0 && d <= 6))) throw new Error("bad repeat rule");
  const start = localParts(afterMs, timeZone);
  for (let i = 0; i < 9; i++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    if (!days.includes(date.getUTCDay())) continue;
    const t = localToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone);
    if (t > afterMs) return t;
  }
  throw new Error("no next occurrence");
}

/** "Sat 31 Oct 09:00" in the zone. */
export function describeWhen(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(ms);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
}
