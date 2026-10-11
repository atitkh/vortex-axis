import type { Delivery } from "./delivery.js";
import type { Hub } from "./hub.js";
import { LIVE_ACK_TOPIC, LIVE_TOPIC, type LiveMessage } from "./liveactivity.js";
import { MqttClient } from "./mqtt.js";
import { GESTURES } from "@vortex-axis/protocol";
import type { ClientRecord, Store } from "./store.js";

/**
 * Shows Axis's clients to Home Assistant as devices, through the MQTT broker
 * Home Assistant already listens to. Home Assistant's "MQTT discovery" does
 * the rest: Axis publishes a description of each entity, and they appear.
 *
 * Each client becomes a device with:
 * - **State** (sensor): offline, idle, listening, thinking, speaking or asked;
 * - **Online** (binary sensor);
 * - **Say** (notify): text sent to it is spoken on that client, by the same
 *   route as an agent's `say`, so quiet hours, notifications to a closed
 *   browser and kept messages all apply. A title of "urgent" speaks through
 *   quiet hours;
 * - **Volume** (number), for a client that has one.
 *
 * The hub itself is a device too, with **Say everywhere** and a count of the
 * clients online.
 */

export interface HomeAssistantOptions {
  /** `mqtt://user:password@host:1883` */
  url: string;
  /** Home Assistant's discovery prefix, `homeassistant` unless it was changed there. */
  discoveryPrefix: string;
  hub: Hub;
  store: Store;
  delivery: Delivery;
  version: string;
  /** Home Assistant's live activities blueprint said it passed one on to a phone. */
  onLiveAck?: (payload: string) => void;
  log?: (line: string) => void;
}

const BASE = "vortex-axis";
const STATUS = `${BASE}/status`;
const HUB = { identifiers: ["vortex_axis_hub"], name: "VorteX Axis", manufacturer: "VorteX Axis", model: "Hub" };

interface Shown {
  described: string;
  /** What the client was last seen to report, kept while it is offline so its entities stay. */
  sound?: boolean;
  gestures?: boolean;
  soundLevel?: string;
  soundActive?: string;
  state?: string;
  online?: string;
  volume?: string;
}

export class HomeAssistant {
  private readonly mqtt: MqttClient;
  private readonly shown = new Map<string, Shown>();
  private hubShown = "";
  private awayShown = "";
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: HomeAssistantOptions) {
    this.mqtt = new MqttClient({
      url: options.url,
      clientId: `vortex-axis-${Math.random().toString(16).slice(2, 10)}`,
      will: { topic: STATUS, payload: "offline" },
      ...(options.log ? { log: options.log } : {}),
    });
    this.mqtt.onConnect(() => {
      options.log?.("home assistant: connected to the MQTT broker");
      // Everything is said again: the broker may be new, or have lost what it kept.
      this.shown.clear();
      this.hubShown = "";
      this.awayShown = "";
      this.mqtt.publish(STATUS, "online", true);
      this.sync();
    });
    // Home Assistant announces itself when it starts; states sent while it was down were never seen.
    this.mqtt.subscribe(`${options.discoveryPrefix}/status`, (_topic, payload) => {
      if (payload === "online") {
        for (const entry of this.shown.values()) delete entry.state, delete entry.online, delete entry.volume;
        this.hubShown = "";
        this.awayShown = "";
      }
    });
    this.mqtt.subscribe(`${BASE}/+/say`, (topic, payload) => this.say(topic.split("/")[1]!, payload));
    this.mqtt.subscribe(`${BASE}/+/volume/set`, (topic, payload) => this.setVolume(topic.split("/")[1]!, payload));
    this.mqtt.subscribe(LIVE_ACK_TOPIC, (_topic, payload) => options.onLiveAck?.(payload));
    this.mqtt.subscribe(`${BASE}/hub/away/set`, (_topic, payload) => {
      options.store.setMeta("away", payload.trim().toUpperCase() === "ON" ? "1" : "0");
      this.awayShown = "";
      this.sync();
    });
  }

  /** How the link to the broker stands, for the admin page. The password in the address is never part of it. */
  status() {
    const url = new URL(this.options.url);
    return {
      broker: `${url.hostname}:${url.port || 1883}`,
      user: decodeURIComponent(url.username) || null,
      discoveryPrefix: this.options.discoveryPrefix,
      connected: this.mqtt.connected,
      connectedAt: this.mqtt.connected ? this.mqtt.connectedAt ?? null : null,
      error: this.mqtt.connected ? null : this.mqtt.lastError ?? null,
      devices: this.mqtt.connected ? this.shown.size : 0,
    };
  }

  /** Sends a live activity to Home Assistant's blueprint (liveactivity.ts). False when the broker is out of reach. */
  publishLive(message: LiveMessage): boolean {
    if (!this.mqtt.connected) return false;
    this.mqtt.publish(LIVE_TOPIC, JSON.stringify(message));
    return true;
  }

  start(): void {
    this.mqtt.start();
    // What a client is doing changes by the second, and nothing announces it, so look.
    this.timer = setInterval(() => this.sync(), 1000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    if (this.mqtt.connected) this.mqtt.publish(STATUS, "offline", true);
    this.mqtt.stop();
  }

  private config(kind: string, id: string, entity: string): string {
    return `${this.options.discoveryPrefix}/${kind}/vortex_axis_${id}/${entity}/config`;
  }

  /** Publishes what changed since the last look: new or renamed clients, states, clients that are gone. */
  private sync(): void {
    if (!this.mqtt.connected) return;
    const { hub, store } = this.options;
    const doing = new Map(hub.doing().map((d) => [d.clientId, d.state]));
    const clients = store.listClients();

    for (const client of clients) {
      const settings = store.resolveSettings(client);
      const hasVolume = typeof settings.volume === "number";
      const entry = this.shown.get(client.id) ?? { described: "" };
      this.shown.set(client.id, entry);

      // A client that reports the room's sound, or touch gestures, gets entities for them.
      const readings = hub.session(client.id)?.readings ?? {};
      if (typeof readings.soundDb === "number") entry.sound = true;
      if (readings.gestures === 1) entry.gestures = true;
      const described = JSON.stringify([client.name, client.type, client.version, hasVolume, entry.sound ?? false, entry.gestures ?? false]);
      if (entry.described !== described) {
        entry.described = described;
        this.describe(client, hasVolume, entry);
      }
      const online = hub.session(client.id) ? "ON" : "OFF";
      const state = online === "OFF" ? "offline" : (doing.get(client.id) ?? "idle");
      if (entry.online !== online) this.mqtt.publish(`${BASE}/${client.id}/online`, (entry.online = online), true);
      if (entry.state !== state) this.mqtt.publish(`${BASE}/${client.id}/state`, (entry.state = state), true);
      if (typeof readings.soundDb === "number") {
        const level = String(readings.soundDb);
        if (entry.soundLevel !== level) this.mqtt.publish(`${BASE}/${client.id}/sound_level`, (entry.soundLevel = level), true);
      }
      if (typeof readings.soundActive === "number") {
        const active = readings.soundActive ? "ON" : "OFF";
        if (entry.soundActive !== active) this.mqtt.publish(`${BASE}/${client.id}/sound`, (entry.soundActive = active), true);
      }
      if (hasVolume) {
        const volume = String(settings.volume);
        if (entry.volume !== volume) this.mqtt.publish(`${BASE}/${client.id}/volume`, (entry.volume = volume), true);
      }
    }

    // A client removed from Axis is removed from Home Assistant: an empty description deletes the entity.
    for (const id of [...this.shown.keys()]) {
      if (clients.some((c) => c.id === id)) continue;
      for (const [kind, entity] of [["sensor", "state"], ["binary_sensor", "online"], ["notify", "say"], ["number", "volume"], ["sensor", "sound_level"], ["binary_sensor", "sound"], ["event", "gesture"]] as const) {
        this.mqtt.publish(this.config(kind, id, entity), "", true);
      }
      this.shown.delete(id);
    }

    const online = String(clients.filter((c) => hub.session(c.id)).length);
    if (!this.hubShown) {
      // Home Assistant knows whether the person is near their screens; Axis does not. An automation there
      // turns this on when they leave, and an agent's finished task then reaches their phone as well.
      this.mqtt.publish(
        this.config("switch", "hub", "away"),
        JSON.stringify({
          name: "Away",
          unique_id: "vortex_axis_hub_away",
          state_topic: `${BASE}/hub/away`,
          command_topic: `${BASE}/hub/away/set`,
          icon: "mdi:account-arrow-right",
          availability_topic: STATUS,
          device: { ...HUB, sw_version: this.options.version },
        }),
        true,
      );
      this.mqtt.publish(
        this.config("notify", "hub", "say_everywhere"),
        JSON.stringify({ ...this.sayEntity("hub", "Say everywhere"), device: { ...HUB, sw_version: this.options.version } }),
        true,
      );
      this.mqtt.publish(
        this.config("sensor", "hub", "online"),
        JSON.stringify({
          name: "Devices online",
          unique_id: "vortex_axis_hub_online",
          state_topic: `${BASE}/hub/online`,
          icon: "mdi:devices",
          availability_topic: STATUS,
          device: { ...HUB, sw_version: this.options.version },
        }),
        true,
      );
    }
    if (this.hubShown !== online) this.mqtt.publish(`${BASE}/hub/online`, (this.hubShown = online), true);
    const away = store.getMeta("away") === "1" ? "ON" : "OFF";
    if (this.awayShown !== away) this.mqtt.publish(`${BASE}/hub/away`, (this.awayShown = away), true);
  }

  private sayEntity(id: string, name: string) {
    return {
      name,
      unique_id: `vortex_axis_${id}_say`,
      command_topic: `${BASE}/${id}/say`,
      // The title travels too: "urgent" there speaks through quiet hours.
      command_template: '{"message": {{ value | tojson }}, "title": {{ (title | default("")) | tojson }}}',
      icon: "mdi:account-voice",
      availability_topic: STATUS,
    };
  }

  /** A gesture made on a client, as an event of its Gesture entity, for automations to act on. */
  gesture(clientId: string, gesture: string): void {
    if (!this.mqtt.connected || !this.shown.get(clientId)?.gestures) return;
    this.mqtt.publish(`${BASE}/${clientId}/gesture`, JSON.stringify({ event_type: gesture }));
  }

  private describe(client: ClientRecord, hasVolume: boolean, reports: Shown): void {
    const device = {
      identifiers: [`vortex_axis_${client.id}`],
      name: client.name,
      manufacturer: "VorteX Axis",
      model: client.type,
      sw_version: client.version,
      via_device: "vortex_axis_hub",
    };
    const common = { availability_topic: STATUS, device };
    this.mqtt.publish(
      this.config("sensor", client.id, "state"),
      JSON.stringify({ ...common, name: "State", unique_id: `vortex_axis_${client.id}_state`, state_topic: `${BASE}/${client.id}/state`, icon: "mdi:waveform" }),
      true,
    );
    this.mqtt.publish(
      this.config("binary_sensor", client.id, "online"),
      JSON.stringify({
        ...common,
        name: "Online",
        unique_id: `vortex_axis_${client.id}_online`,
        state_topic: `${BASE}/${client.id}/online`,
        device_class: "connectivity",
      }),
      true,
    );
    this.mqtt.publish(this.config("notify", client.id, "say"), JSON.stringify({ ...this.sayEntity(client.id, "Say"), device }), true);
    // Readings from the room are only true while the client is there to take them.
    const live = {
      availability: [{ topic: STATUS }, { topic: `${BASE}/${client.id}/online`, payload_available: "ON", payload_not_available: "OFF" }],
      availability_mode: "all",
      device,
    };
    this.mqtt.publish(
      this.config("sensor", client.id, "sound_level"),
      reports.sound
        ? JSON.stringify({
            ...live,
            name: "Sound level",
            unique_id: `vortex_axis_${client.id}_sound_level`,
            state_topic: `${BASE}/${client.id}/sound_level`,
            // Full scale of its microphone, not calibrated sound pressure: good for "louder than usual", not for decibels.
            unit_of_measurement: "dBFS",
            state_class: "measurement",
            icon: "mdi:volume-vibrate",
          })
        : "",
      true,
    );
    this.mqtt.publish(
      this.config("binary_sensor", client.id, "sound"),
      reports.sound
        ? JSON.stringify({ ...live, name: "Sound", unique_id: `vortex_axis_${client.id}_sound`, state_topic: `${BASE}/${client.id}/sound`, device_class: "sound" })
        : "",
      true,
    );
    this.mqtt.publish(
      this.config("event", client.id, "gesture"),
      reports.gestures
        ? JSON.stringify({
            ...live,
            name: "Gesture",
            unique_id: `vortex_axis_${client.id}_gesture`,
            state_topic: `${BASE}/${client.id}/gesture`,
            event_types: [...GESTURES],
            icon: "mdi:gesture-swipe",
          })
        : "",
      true,
    );
    this.mqtt.publish(
      this.config("number", client.id, "volume"),
      hasVolume
        ? JSON.stringify({
            ...common,
            name: "Volume",
            unique_id: `vortex_axis_${client.id}_volume`,
            state_topic: `${BASE}/${client.id}/volume`,
            command_topic: `${BASE}/${client.id}/volume/set`,
            min: 0,
            max: 100,
            step: 1,
            unit_of_measurement: "%",
            icon: "mdi:volume-high",
          })
        : "",
      true,
    );
  }

  /** Something Home Assistant wants said: on one client, or everywhere when it was sent to the hub. */
  private say(id: string, payload: string): void {
    let message = payload, title = "";
    try {
      const parsed = JSON.parse(payload) as { message?: unknown; title?: unknown };
      if (typeof parsed.message === "string") message = parsed.message;
      if (typeof parsed.title === "string") title = parsed.title;
    } catch {
      // Plain text is as good as the wrapped form.
    }
    message = message.trim().slice(0, 1000);
    if (!message) return;
    const urgent = title.trim().toLowerCase() === "urgent";
    const client = id === "hub" ? undefined : this.options.store.getClient(id);
    if (id !== "hub" && !client) return;
    const done = client ? this.options.delivery.sayTo(client, message, urgent) : this.options.delivery.sayToAll(undefined, message, urgent);
    done.catch((error) => this.options.log?.(`home assistant: could not say that${client ? ` on ${client.name}` : ""}: ${(error as Error).message}`));
  }

  private setVolume(id: string, payload: string): void {
    const client = this.options.store.getClient(id);
    const volume = Math.round(Number(payload));
    if (!client || !Number.isFinite(volume) || volume < 0 || volume > 100) return;
    this.options.store.patchLayer("device", client.id, { volume });
    this.options.hub.pushSettings();
  }
}
