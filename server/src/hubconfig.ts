import { isIP } from "node:net";
import type { Config } from "./config.js";
import type { Store } from "./store.js";

/**
 * The settings of Axis itself that an admin can change while it runs: the link
 * to Home Assistant, the public names, the clock and how long things are kept.
 * As with the speech and agent settings, the environment supplies the starting
 * point and a value saved here wins over it.
 */
export interface HubSettings {
  /** Home Assistant's MQTT broker. An empty host means the link is off. */
  mqtt: { host: string; port: number; user: string; password: string; discoveryPrefix: string };
  publicHosts: string[];
  trustedProxies: string[];
  timeZone: string;
  activityDays: number;
  messageHoldMinutes: number;
  /** Hours between backups (0: only when asked) and days a daily copy is kept. Where they go is the host's to say. */
  backupEveryHours: number;
  backupKeepDays: number;
  /** Whether the MCP door answers under a public name too. */
  mcpPublic: boolean;
}

const META_KEY = "hub_config";

type Patch = Partial<Omit<HubSettings, "mqtt">> & { mqtt?: Partial<HubSettings["mqtt"]> };

function fromConfig(config: Config): HubSettings {
  let mqtt = { host: "", port: 1883, user: "", password: "", discoveryPrefix: "homeassistant" };
  if (config.homeAssistant) {
    const url = new URL(config.homeAssistant.url);
    mqtt = {
      host: url.hostname,
      port: Number(url.port || 1883),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      discoveryPrefix: config.homeAssistant.discoveryPrefix,
    };
  }
  return {
    mqtt,
    publicHosts: config.publicHosts,
    trustedProxies: config.trustedProxies,
    timeZone: config.timeZone,
    activityDays: config.activityDays,
    messageHoldMinutes: Math.round(config.messageHoldMs / 60_000),
    backupEveryHours: config.backupEveryHours,
    backupKeepDays: config.backupKeepDays,
    mcpPublic: config.mcpPublic,
  };
}

function merge(base: HubSettings, patch: Patch): HubSettings {
  return { ...base, ...patch, mqtt: { ...base.mqtt, ...patch.mqtt } };
}

/** Writes the saved settings over the ones read from the environment. Called once, before anything is built from them. */
export function applySavedHubSettings(store: Store, config: Config): void {
  const saved = store.getMeta(META_KEY);
  if (saved) intoConfig(config, merge(fromConfig(config), JSON.parse(saved) as Patch));
}

export function hubSettings(config: Config): HubSettings {
  return fromConfig(config);
}

/** The settings as the admin page may see them: the broker's password is only ever said to be set or not. */
export function publicHubSettings(config: Config) {
  const { mqtt, ...rest } = fromConfig(config);
  const { password, ...broker } = mqtt;
  return { ...rest, mqtt: { ...broker, passwordSet: password !== "" } };
}

function intoConfig(config: Config, settings: HubSettings): void {
  const { mqtt } = settings;
  const login = mqtt.user ? `${encodeURIComponent(mqtt.user)}${mqtt.password ? `:${encodeURIComponent(mqtt.password)}` : ""}@` : "";
  config.homeAssistant = mqtt.host ? { url: `mqtt://${login}${mqtt.host}:${mqtt.port}`, discoveryPrefix: mqtt.discoveryPrefix } : undefined;
  config.publicHosts = settings.publicHosts;
  config.trustedProxies = settings.trustedProxies;
  config.timeZone = settings.timeZone;
  config.activityDays = settings.activityDays;
  config.messageHoldMs = settings.messageHoldMinutes * 60_000;
  config.backupEveryHours = settings.backupEveryHours;
  config.backupKeepDays = settings.backupKeepDays;
  config.mcpPublic = settings.mcpPublic;
}

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

function names(value: unknown, what: string): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (!list || list.some((item) => typeof item !== "string")) throw new Error(`${what} must be a list of names`);
  return [...new Set((list as string[]).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function whole(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${what} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/**
 * Checks a change, saves it and writes it into `config`. Only the fields given
 * are changed. An empty broker password keeps the one there is; `null` removes
 * it. `reachedBy` is the name this request came in under: it may not be made a
 * public name, since the admin page would vanish from under the person using it.
 */
export function saveHubSettings(store: Store, config: Config, input: unknown, reachedBy = ""): HubSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("body must be an object of settings");
  const body = input as Record<string, unknown>;
  const patch: Patch = {};

  if (body.mqtt !== undefined) {
    if (typeof body.mqtt !== "object" || body.mqtt === null) throw new Error("mqtt must be an object");
    const given = body.mqtt as Record<string, unknown>;
    const mqtt: Partial<HubSettings["mqtt"]> = {};
    if (given.host !== undefined) {
      const host = String(given.host).trim().toLowerCase();
      if (host && !HOST.test(host) && !isIP(host)) throw new Error("the broker must be a host name or an address, without mqtt:// or a port");
      mqtt.host = host;
    }
    if (given.port !== undefined) mqtt.port = whole(given.port, "the broker's port", 1, 65535);
    if (given.user !== undefined) mqtt.user = String(given.user).trim().slice(0, 200);
    if (given.password === null) mqtt.password = "";
    else if (typeof given.password === "string" && given.password !== "") mqtt.password = given.password.slice(0, 500);
    if (given.discoveryPrefix !== undefined) {
      const prefix = String(given.discoveryPrefix).trim();
      if (!/^[\w-]{1,64}$/.test(prefix)) throw new Error("the discovery prefix is one word, such as homeassistant");
      mqtt.discoveryPrefix = prefix;
    }
    patch.mqtt = mqtt;
  }
  if (body.publicHosts !== undefined) {
    const hosts = names(body.publicHosts, "public names");
    const wrong = hosts.find((host) => !HOST.test(host));
    if (wrong) throw new Error(`"${wrong}" is not a host name. Give names only, without https:// or a port.`);
    const here = reachedBy.trim().toLowerCase().replace(/:\d+$/, "");
    if (here && hosts.includes(here)) {
      throw new Error(`You are using this page at ${here}. Making that a public name would hide the admin page from you there.`);
    }
    patch.publicHosts = hosts;
  }
  if (body.trustedProxies !== undefined) {
    const proxies = names(body.trustedProxies, "trusted proxies");
    const wrong = proxies.find((address) => !isIP(address));
    if (wrong) throw new Error(`"${wrong}" is not an IP address`);
    patch.trustedProxies = proxies;
  }
  if (body.timeZone !== undefined) {
    const zone = String(body.timeZone).trim();
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    } catch {
      throw new Error(`"${zone}" is not a time zone this system knows. Use a name such as America/Chicago.`);
    }
    if (!zone) throw new Error("give a time zone, such as America/Chicago");
    patch.timeZone = zone;
  }
  if (body.activityDays !== undefined) patch.activityDays = whole(body.activityDays, "days of history", 1, 365);
  if (body.backupEveryHours !== undefined) patch.backupEveryHours = whole(body.backupEveryHours, "hours between backups", 0, 168);
  if (body.backupKeepDays !== undefined) patch.backupKeepDays = whole(body.backupKeepDays, "days a daily copy is kept", 1, 365);
  if (body.mcpPublic !== undefined) {
    if (typeof body.mcpPublic !== "boolean") throw new Error("mcpPublic must be true or false");
    patch.mcpPublic = body.mcpPublic;
  }
  if (body.messageHoldMinutes !== undefined) patch.messageHoldMinutes = whole(body.messageHoldMinutes, "minutes a message is kept", 0, 1440);

  const earlier = store.getMeta(META_KEY);
  const saved = merge(earlier ? (JSON.parse(earlier) as Patch) as HubSettings : ({} as HubSettings), patch) as Patch;
  store.setMeta(META_KEY, JSON.stringify(saved));
  const next = merge(fromConfig(config), patch);
  intoConfig(config, next);
  return next;
}
