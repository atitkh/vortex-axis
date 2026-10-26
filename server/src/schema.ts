import type { ActionDef, LinkDef, Scalar, ScalarMap, SettingDef } from "@vortex-axis/protocol";

/** What the admin page can show and do for one kind of client. */
export interface ClientSchema {
  settings: SettingDef[];
  actions: ActionDef[];
  links: LinkDef[];
}

/** Settings Axis itself reads for every client, whatever it declares. */
export const BUILT_IN_SETTINGS: SettingDef[] = [
  {
    key: "location",
    label: "Location",
    kind: "text",
    group: "Axis",
    help: "Where this device is: a room, a car, anywhere. Agents can send speech to a location by name.",
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
  {
    key: "quietFrom",
    label: "Quiet from",
    kind: "text",
    group: "Quiet hours",
    help: "Time of day quiet hours start, as HH:MM (24-hour, the hub's time zone), for example 22:30. Empty for none. In quiet hours the device is quieter and dimmer, and what an agent says unprompted is shown without sound unless it is urgent. Replies to someone talking to it, and timers, still sound.",
  },
  {
    key: "quietTo",
    label: "Quiet until",
    kind: "text",
    group: "Quiet hours",
    help: "Time of day quiet hours end, as HH:MM, for example 07:00. May be earlier than the start: the quiet stretch then runs over midnight.",
  },
  {
    key: "quietVolume",
    label: "Volume in quiet hours",
    kind: "number",
    group: "Quiet hours",
    min: 0,
    max: 100,
    unit: "%",
    default: 25,
    help: "The device's volume is held at or below this in quiet hours.",
  },
  {
    key: "quietBrightness",
    label: "Brightness in quiet hours",
    kind: "number",
    group: "Quiet hours",
    min: 0,
    max: 255,
    default: 40,
    help: "A device with a screen is held at or below this brightness in quiet hours.",
  },
  {
    key: "voiceMode",
    label: "Who hears and speaks",
    kind: "choice",
    group: "Axis",
    options: ["local", "realtime"],
    default: "local",
    help: "\"local\" is Axis's own chain: its speech recognition, the agent, its voice. \"realtime\" sends what is said through the OpenClaw gateway to a realtime voice model in the cloud, which answers in its own voice and hands real work to the agent. Quicker for small things; the sound leaves the house and the provider may charge for it. Without an OpenClaw gateway it does nothing. The Speech page sets it for every device and tries the voice.",
  },
  {
    key: "voiceProvider",
    label: "Realtime voice provider",
    kind: "text",
    group: "Axis",
    help: "With \"realtime\": which of the gateway's realtime Talk providers to use, such as openai or xai, or a provider and one of its models as openai/gpt-realtime-2.1-mini. Empty leaves the choice to the gateway.",
  },
  {
    key: "realtimeVolume",
    label: "Realtime voice loudness",
    kind: "number",
    group: "Axis",
    min: 10,
    max: 100,
    unit: "%",
    default: 70,
    help: "A realtime voice arrives louder than the local one. This is how much of that it is played at, before the device's own volume; 100 leaves it as it comes.",
  },
  {
    key: "idleLooksOff",
    label: "Idle looks switched off",
    kind: "text",
    group: "Screen",
    help: "Names of idle looks of the vortex face this device should not drift into, separated by commas. Easier to set on the Face page, which shows each one.",
  },
  {
    key: "toolIcons",
    label: "Tool icons while thinking",
    kind: "choice",
    group: "Screen",
    options: ["dots", "line", "off"],
    default: "dots",
    help: "How the vortex face shows what kind of tool the agent has picked up: \"dots\" forms the icon out of the face's own dots, \"line\" draws it at the core, \"off\" shows nothing. The Face page shows each.",
  },
  {
    key: "toolIconMs",
    label: "Tool icon: time to form",
    kind: "number",
    group: "Screen",
    min: 150,
    max: 3000,
    unit: "ms",
    default: 700,
    help: "How long the face takes to turn into a tool icon and back. A tool the agent holds for less time than this never quite forms.",
  },
  {
    key: "toolIconDots",
    label: "Tool icon: dots in the shape",
    kind: "number",
    group: "Screen",
    min: 12,
    max: 78,
    default: 78,
    help: "With tool icons shown as dots: how many of the face's 78 dots draw the shape. The rest keep turning in a ring round it.",
  },
  {
    key: "followUpMs",
    label: "Follow-up listening",
    kind: "number",
    group: "Listening",
    min: 0,
    max: 30000,
    unit: "ms",
    default: 6000,
    help: "After a spoken answer, keep listening this long without the wake word. 0 turns it off.",
  },
  {
    key: "onsetMs",
    label: "Wait for the first word",
    kind: "number",
    group: "Listening",
    min: 1000,
    max: 20000,
    unit: "ms",
    default: 6000,
    help: "How long to wait for you to start talking after a wake or a tap.",
  },
  {
    key: "silenceMs",
    label: "Quiet that ends a sentence",
    kind: "number",
    group: "Listening",
    min: 300,
    max: 5000,
    unit: "ms",
    default: 900,
  },
  {
    key: "maxSpeechMs",
    label: "Longest sentence",
    kind: "number",
    group: "Listening",
    min: 3000,
    max: 60000,
    unit: "ms",
    default: 20000,
  },
  {
    key: "capabilitiesOff",
    label: "Capabilities switched off",
    kind: "text",
    group: "Axis",
    help: "What this device can do that an admin has switched off, separated by commas, such as mic,screen. Set with the switches on the device's page, for this one device only; Axis stops using what is listed and the device stops doing it.",
  },
];

export const EMPTY_SCHEMA: ClientSchema = { settings: [], actions: [], links: [] };

/**
 * Built-in settings whose defaults Axis sends every client beneath the stored layers, so that every client listens
 * by the same numbers and none needs its own: a value saved for everything, a type or a device still wins.
 */
export const SENT_DEFAULT_KEYS = ["followUpMs", "onsetMs", "silenceMs", "maxSpeechMs"] as const;

/** The defaults of `SENT_DEFAULT_KEYS`, as sent. */
export function sentDefaults(): ScalarMap {
  const out: ScalarMap = {};
  for (const def of BUILT_IN_SETTINGS) {
    if ((SENT_DEFAULT_KEYS as readonly string[]).includes(def.key) && def.default !== undefined) out[def.key] = def.default;
  }
  return out;
}

/**
 * What a client type declared as the default of each of `keys`, as numbers (a description may give them as text).
 * Quiet hours cap a device's volume from here when nothing is saved for it.
 */
export function declaredDefaults(schema: ClientSchema | undefined, keys: string[]): ScalarMap {
  const out: ScalarMap = {};
  for (const def of schema?.settings ?? []) {
    if (!keys.includes(def.key) || def.kind !== "number") continue;
    const value = typeof def.default === "number" ? def.default : Number(def.default);
    if (def.default !== undefined && def.default !== null && def.default !== "" && Number.isFinite(value)) out[def.key] = value;
  }
  return out;
}

/**
 * The wake word setting. Its choices are whatever is on the Wake words page at
 * the moment, so it is made on demand and not listed with the fixed ones.
 */
export function wakeWordSetting(ids: string[]): SettingDef {
  return {
    key: "wakeWord",
    label: "Wake word",
    kind: "choice",
    group: "Axis",
    options: ["built-in", ...ids],
    default: "built-in",
    help: "Which wake word a device listens for. \"built-in\" is the one inside its firmware; the others are on the Wake words page. A device restarts to change it, and only devices with their own wake word take notice.",
  };
}

/**
 * A client's own settings after the ones Axis adds. A client cannot replace a
 * built-in key. `wakeWords` are the ids of the stored wake words to offer.
 */
export function withBuiltIns(schema: ClientSchema | undefined, wakeWords: string[] = []): ClientSchema {
  const own = schema ?? EMPTY_SCHEMA;
  const builtIn = [...BUILT_IN_SETTINGS, wakeWordSetting(wakeWords)];
  const taken = new Set(builtIn.map((s) => s.key));
  return {
    settings: [...builtIn, ...own.settings.filter((s) => !taken.has(s.key))],
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
