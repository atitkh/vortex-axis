import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HomeAssistant } from "../src/homeassistant.js";
import { topicMatches } from "../src/mqtt.js";
import type { TextToSpeech } from "../src/speech.js";
import { admin, ctx, ready, useServer } from "./harness.js";

const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: () =>
    (async function* () {
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
useServer(() => ({ tts }));

/** Just enough of a broker: lets one client in, keeps what it publishes, and can publish to it. */
async function broker() {
  const kept = new Map<string, string>();
  const seen: { connect?: Buffer; subscribed: string[] } = { subscribed: [] };
  let client: Socket | undefined;
  const server = createServer((socket) => {
    client = socket;
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 2) return;
        let length = 0, shift = 0, at = 1;
        for (;;) {
          const byte = pending[at++]!;
          length += (byte & 0x7f) << shift;
          shift += 7;
          if (!(byte & 0x80)) break;
        }
        if (pending.length < at + length) return;
        const type = pending[0]! >> 4;
        const body = pending.subarray(at, at + length);
        pending = pending.subarray(at + length);
        if (type === 1) {
          seen.connect = Buffer.from(body);
          socket.write(Buffer.from([0x20, 2, 0, 0]));
        } else if (type === 3) {
          const topicLength = body.readUInt16BE(0);
          kept.set(body.subarray(2, 2 + topicLength).toString(), body.subarray(2 + topicLength).toString());
        } else if (type === 8) {
          let i = 2;
          while (i < body.length) {
            const n = body.readUInt16BE(i);
            seen.subscribed.push(body.subarray(i + 2, i + 2 + n).toString());
            i += 2 + n + 1;
          }
          socket.write(Buffer.from([0x90, 3, body[0]!, body[1]!, 0]));
        } else if (type === 12) socket.write(Buffer.from([0xd0, 0]));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    kept,
    seen,
    url: `mqtt://ha:secret@127.0.0.1:${(server.address() as any).port}`,
    /** Publishes to the connected client, as the broker would pass on something Home Assistant sent. */
    send(topic: string, payload: string) {
      const t = Buffer.from(topic), p = Buffer.from(payload);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(t.length);
      client!.write(Buffer.concat([Buffer.from([0x30, 2 + t.length + p.length]), length, t, p]));
    },
    close: () => (client?.destroy(), server.close()),
  };
}

// The link looks at the clients once a second.
const WAIT = { timeout: 5000 };

let link: HomeAssistant | undefined;
let mqtt: Awaited<ReturnType<typeof broker>> | undefined;
afterEach(() => {
  link?.stop();
  mqtt?.close();
});

async function linked() {
  mqtt = await broker();
  const { hub, store, delivery } = ctx.app;
  link = new HomeAssistant({ url: mqtt.url, discoveryPrefix: "homeassistant", hub, store, delivery, version: "test" });
  link.start();
  await expect.poll(() => mqtt!.kept.get("vortex-axis/status"), WAIT).toBe("online");
  return mqtt;
}

describe("mqtt topics", () => {
  it("matches filters the way a broker does", () => {
    expect(topicMatches("vortex-axis/+/say", "vortex-axis/c_1/say")).toBe(true);
    expect(topicMatches("vortex-axis/+/say", "vortex-axis/c_1/volume/set")).toBe(false);
    expect(topicMatches("vortex-axis/#", "vortex-axis/c_1/volume/set")).toBe(true);
    expect(topicMatches("a/b", "a/b/c")).toBe(false);
  });
});

describe("home assistant", () => {
  it("logs in with a will, and describes each client as a device with its entities", async () => {
    const { identity } = await ready(["speaker", "screen"], { name: "Desk" });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 70 } });
    const m = await linked();
    const id = identity.clientId;

    const connect = m.seen.connect!.toString("latin1");
    for (const part of ["MQTT", "vortex-axis/status", "offline", "ha", "secret"]) expect(connect).toContain(part);
    expect(m.seen.subscribed).toEqual(expect.arrayContaining(["homeassistant/status", "vortex-axis/+/say", "vortex-axis/+/volume/set"]));

    await expect.poll(() => m.kept.get(`vortex-axis/${id}/state`), WAIT).toBe("idle");
    expect(m.kept.get(`vortex-axis/${id}/online`)).toBe("ON");
    expect(m.kept.get(`vortex-axis/${id}/volume`)).toBe("70");
    expect(m.kept.get("vortex-axis/hub/online")).toBe("1");

    const state = JSON.parse(m.kept.get(`homeassistant/sensor/vortex_axis_${id}/state/config`)!);
    expect(state).toMatchObject({ name: "State", unique_id: `vortex_axis_${id}_state`, state_topic: `vortex-axis/${id}/state`, availability_topic: "vortex-axis/status" });
    expect(state.device).toMatchObject({ identifiers: [`vortex_axis_${id}`], name: "Desk", via_device: "vortex_axis_hub" });
    expect(JSON.parse(m.kept.get(`homeassistant/notify/vortex_axis_${id}/say/config`)!).command_topic).toBe(`vortex-axis/${id}/say`);
    expect(JSON.parse(m.kept.get(`homeassistant/number/vortex_axis_${id}/volume/config`)!).command_topic).toBe(`vortex-axis/${id}/volume/set`);
    expect(JSON.parse(m.kept.get("homeassistant/notify/vortex_axis_hub/say_everywhere/config")!).name).toBe("Say everywhere");
  });

  it("offers a switch Home Assistant turns on when the person is away", async () => {
    await ready(["screen"], { name: "Desk" });
    const m = await linked();
    await expect.poll(() => m.kept.get("vortex-axis/hub/away"), WAIT).toBe("OFF");
    expect(JSON.parse(m.kept.get("homeassistant/switch/vortex_axis_hub/away/config")!)).toMatchObject({
      name: "Away",
      unique_id: "vortex_axis_hub_away",
      state_topic: "vortex-axis/hub/away",
      command_topic: "vortex-axis/hub/away/set",
    });
    expect((await admin("GET", "/admin/now")).body.away).toBe(false);

    m.send("vortex-axis/hub/away/set", "ON");
    await expect.poll(() => m.kept.get("vortex-axis/hub/away"), WAIT).toBe("ON");
    expect((await admin("GET", "/admin/now")).body.away).toBe(true);
    m.send("vortex-axis/hub/away/set", "OFF");
    await expect.poll(() => m.kept.get("vortex-axis/hub/away"), WAIT).toBe("OFF");
  });

  it("speaks what Home Assistant sends, follows the device's state, and takes a volume", async () => {
    const { identity, client } = await ready(["speaker", "screen"], { name: "Desk" });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 70 } });
    const m = await linked();
    const id = identity.clientId;
    await expect.poll(() => m.kept.get(`vortex-axis/${id}/state`), WAIT).toBe("idle");

    m.send(`vortex-axis/${id}/say`, JSON.stringify({ message: "The laundry is done.", title: "" }));
    const end = await client.next("speak.end");
    await expect.poll(() => m.kept.get(`vortex-axis/${id}/state`), WAIT).toBe("speaking");
    expect((await client.next("reply.text", 0, (r) => r.final)).text).toBe("The laundry is done.");
    client.send({ t: "playback", turnId: end.turnId, state: "finished" });
    await expect.poll(() => m.kept.get(`vortex-axis/${id}/state`), WAIT).toBe("idle");

    m.send(`vortex-axis/${id}/volume/set`, "35");
    await expect.poll(() => m.kept.get(`vortex-axis/${id}/volume`), WAIT).toBe("35");
    expect((await client.next("settings", 0, (s) => s.values.volume === 35)).values.volume).toBe(35);
    // Nonsense is ignored.
    m.send(`vortex-axis/${id}/volume/set`, "loud");
    m.send("vortex-axis/nobody/say", "hello");
  });

  it("shows a board's room sound and touch gestures, only once it reports them", async () => {
    const { identity, client } = await ready(["mic", "speaker", "screen"], { name: "Desk" });
    const m = await linked();
    const id = identity.clientId;
    const app = ctx.app as unknown as { hub: { onGesture(l: (s: { client: { id: string } }, g: string) => void): void } };
    app.hub.onGesture((session, gesture) => link!.gesture(session.client.id, gesture));
    await expect.poll(() => m.kept.get(`homeassistant/sensor/vortex_axis_${id}/sound_level/config`), WAIT).toBe("");
    expect(m.kept.get(`homeassistant/event/vortex_axis_${id}/gesture/config`)).toBe("");

    client.send({ t: "sense", readings: { soundDb: -52, soundActive: 1, gestures: 1 } });
    await expect.poll(() => m.kept.get(`vortex-axis/${id}/sound_level`), WAIT).toBe("-52");
    expect(m.kept.get(`vortex-axis/${id}/sound`)).toBe("ON");
    const level = JSON.parse(m.kept.get(`homeassistant/sensor/vortex_axis_${id}/sound_level/config`)!);
    expect(level).toMatchObject({ unit_of_measurement: "dBFS", state_topic: `vortex-axis/${id}/sound_level`, availability_mode: "all" });
    expect(JSON.parse(m.kept.get(`homeassistant/binary_sensor/vortex_axis_${id}/sound/config`)!).device_class).toBe("sound");
    const gesture = JSON.parse(m.kept.get(`homeassistant/event/vortex_axis_${id}/gesture/config`)!);
    expect(gesture.event_types).toEqual(["hold", "swipe_left", "swipe_right", "swipe_up", "swipe_down"]);

    client.send({ t: "gesture", gesture: "swipe_left" });
    await expect.poll(() => m.kept.get(`vortex-axis/${id}/gesture`), WAIT).toBe(JSON.stringify({ event_type: "swipe_left" }));
    client.send({ t: "sense", readings: { soundActive: 0 } });
    await expect.poll(() => m.kept.get(`vortex-axis/${id}/sound`), WAIT).toBe("OFF");
  });

  it("shows a client going away, and takes a removed client out of Home Assistant", async () => {
    const { identity, client } = await ready(["speaker"], { name: "Hall" });
    const m = await linked();
    const id = identity.clientId;
    await expect.poll(() => m.kept.get(`vortex-axis/${id}/online`), WAIT).toBe("ON");

    client.close();
    await expect.poll(() => m.kept.get(`vortex-axis/${id}/state`), WAIT).toBe("offline");
    expect(m.kept.get(`vortex-axis/${id}/online`)).toBe("OFF");

    await admin("DELETE", `/admin/clients/${id}`);
    await expect.poll(() => m.kept.get(`homeassistant/sensor/vortex_axis_${id}/state/config`), WAIT).toBe("");
    expect(m.kept.get(`homeassistant/notify/vortex_axis_${id}/say/config`)).toBe("");
  });
});
