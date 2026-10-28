/**
 * Whether a device runs an older build than the one Axis holds for it: the one rule behind "old firmware", the
 * Update buttons, the Overview and the map. Versions are dotted numbers ("0.5.0", "v1.2", "0.21.0-dev"; the part
 * after a "-" is ignored). A device on the held build or a newer one is not behind, and neither is one whose version
 * or held version is not dotted numbers, since then which is newer cannot be told.
 */
export function olderThanHeld(current: string | undefined, held: string | undefined): boolean {
  const a = numbers(current), b = numbers(held);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

function numbers(version: string | undefined): number[] | undefined {
  const main = version?.trim().replace(/^v/i, "").split("-")[0];
  return main && /^\d+(\.\d+)*$/.test(main) ? main.split(".").map(Number) : undefined;
}
