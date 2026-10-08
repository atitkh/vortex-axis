import type { ActionDef, LinkDef, Scalar, SettingDef } from "@vortex-axis/protocol";

/** What the admin page can show and do for one kind of client. */
export interface ClientSchema {
  settings: SettingDef[];
  actions: ActionDef[];
  links: LinkDef[];
}

/** Settings Axis itself reads for every client, whatever it declares. */
export const BUILT_IN_SETTINGS: SettingDef[] = [
  {
    key: "room",
    label: "Room",
    kind: "text",
    group: "Axis",
    help: "Where this device is. Agents can send speech to a room by name.",
  },
  {
    key: "voice",
    label: "Voice",
    kind: "text",
    group: "Axis",
    help: "Voice for this device's speech. Empty uses the default voice in the Speech section.",
  },
  {
    key: "sentencePauseMs",
    label: "Pause between sentences",
    kind: "number",
    group: "Axis",
    min: 0,
    max: 1500,
    unit: "ms",
    default: 300,
    help: "Silence Axis puts between spoken sentences. Half of it after a comma, one and a half times at a new paragraph.",
  },
];

export const EMPTY_SCHEMA: ClientSchema = { settings: [], actions: [], links: [] };

/** A client's own settings after the ones Axis adds. A client cannot replace a built-in key. */
export function withBuiltIns(schema: ClientSchema | undefined): ClientSchema {
  const own = schema ?? EMPTY_SCHEMA;
  const taken = new Set(BUILT_IN_SETTINGS.map((s) => s.key));
  return {
    settings: [...BUILT_IN_SETTINGS, ...own.settings.filter((s) => !taken.has(s.key))],
    actions: own.actions,
    links: own.links,
  };
}

/** Why `value` is not allowed for `def`, or undefined when it is. `null` always is: it removes the value. */
export function settingProblem(def: SettingDef, value: Scalar): string | undefined {
  if (value === null) return undefined;
  switch (def.kind) {
    case "text":
      return typeof value === "string" ? undefined : `${def.label} must be text`;
    case "toggle":
      return value === 0 || value === 1 ? undefined : `${def.label} must be 0 or 1`;
    case "choice":
      return def.options?.some((o) => o === value || String(o) === String(value))
        ? undefined
        : `${def.label} must be one of ${def.options?.join(", ") ?? "its options"}`;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${def.label} must be a number`;
      if (def.min !== undefined && value < def.min) return `${def.label} must be at least ${def.min}`;
      if (def.max !== undefined && value > def.max) return `${def.label} must be at most ${def.max}`;
      return undefined;
    }
  }
}
