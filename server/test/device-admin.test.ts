import { describe, expect, it } from "vitest";
import type { Capability } from "@vortex-axis/protocol";
import { admin, connect, newPairedClient, useServer } from "./harness.js";
import type { Describe } from "@vortex-axis/protocol";

useServer();

/** A connected device that paired as type "board", the way a real board does. */
async function board(capabilities: Capability[] = ["speaker"], type = "board") {
  const identity = await newPairedClient({ capabilities, type });
  const client = await connect(identity, { capabilities, type });
  await client.next("status");
  return { identity, client };
}

const description: Describe = {
  t: "describe",
  settings: [
    { key: "volume", label: "Volume", kind: "number", group: "Sound", min: 0, max: 100, default: 60 },
    { key: "rotation", label: "Rotation", kind: "choice", options: [0, 90, 180, 270], default: 90 },
    { key: "listenCue", label: "Listening cue", kind: "toggle", default: 1 },
  ],
  actions: [
    { name: "cue", label: "Play the cue" },
    { name: "reboot", label: "Reboot", confirm: true },
  ],
  links: [{ label: "Device log", path: "/logs" }],
  address: "192.168.1.42",
};

/** Waits until the server has stored what the client described. */
async function described(type: string) {
  for (let i = 0; i < 40; i++) {
    const body = (await admin("GET", "/admin/clients")).body as { types: Record<string, { actions: unknown[] }> };
    if (body.types[type]?.actions.length) return body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the description never arrived");
}

describe("describing a client", () => {
  it("keeps the schema per client type, with Axis's own settings added", async () => {
    const { client } = await board(["speaker", "screen"]);
    client.send(description);
    const body = await described("board");

    const schema = body.types.board as unknown as { settings: { key: string }[]; links: unknown[] };
    expect(schema.settings.map((s) => s.key)).toEqual(["location", "voice", "sentencePauseMs", "quietFrom", "quietTo", "quietVolume", "quietBrightness", "voiceMode", "voiceProvider", "idleLooksOff", "toolIcons", "toolIconMs", "toolIconDots", "wakeWord", "volume", "rotation", "listenCue"]);
    expect(schema.links).toEqual(description.links);

    const row = (body as unknown as { clients: { address: string | null; layers: unknown }[] }).clients[0]!;
    expect(row.address).toBe("192.168.1.42");
    expect(row.layers).toEqual({ global: {}, type: {}, device: {} });
  });

  it("survives the device being offline", async () => {
    const { client } = await board();
    client.send(description);
    await described("board");
    client.close();
    const body = (await admin("GET", "/admin/clients")).body as { types: Record<string, unknown> };
    expect(Object.keys(body.types)).toEqual(["board"]);
  });

  it("does not let a client replace a setting Axis owns", async () => {
    const { client } = await board();
    client.send({ ...description, settings: [{ key: "location", label: "Fake", kind: "number" }], actions: description.actions });
    const body = await described("board");
    const location = (body.types.board as unknown as { settings: { key: string; kind: string }[] }).settings.find((s) => s.key === "location");
    expect(location?.kind).toBe("text");
  });
});

describe("settings are checked against the schema", () => {
  it("refuses a value outside the range, for a device and for its type", async () => {
    const { client, identity } = await board();
    client.send(description);
    await described("board");

    const device = await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 150 } });
    expect(device.status).toBe(400);
    expect(String(device.body.error)).toContain("at most 100");
    expect((await admin("PATCH", "/admin/settings/type/board", { values: { listenCue: 2 } })).status).toBe(400);
    expect((await admin("PATCH", "/admin/settings/type/board", { values: { rotation: 45 } })).status).toBe(400);

    expect((await admin("PATCH", "/admin/settings/type/board", { values: { rotation: 180, listenCue: 0 } })).status).toBe(200);
    expect((await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: 30 } })).status).toBe(200);
    expect((await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { volume: null } })).status).toBe(200);
  });

  it("shows the layers separately and merged", async () => {
    const { identity } = await board();
    await admin("PATCH", "/admin/settings/global", { values: { followUpMs: 4000 } });
    await admin("PATCH", "/admin/settings/type/board", { values: { followUpMs: 5000, rotation: 0 } });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { followUpMs: 6000 } });
    const row = (await admin("GET", `/admin/clients/${identity.clientId}`)).body as {
      settings: Record<string, unknown>;
      layers: Record<string, Record<string, unknown>>;
    };
    expect(row.layers.global).toEqual({ followUpMs: 4000 });
    expect(row.layers.type).toEqual({ followUpMs: 5000, rotation: 0 });
    expect(row.layers.device).toEqual({ followUpMs: 6000 });
    expect(row.settings).toMatchObject({ followUpMs: 6000, rotation: 0 });
  });
});

describe("commands to a device", () => {
  it("sends an offered action and returns the answer", async () => {
    const { client, identity } = await board();
    client.send(description);
    await described("board");

    const pending = admin("POST", `/admin/clients/${identity.clientId}/commands/cue`);
    const command = await client.next("command");
    expect(command.name).toBe("cue");
    client.send({ t: "command.result", id: command.id, ok: true, payload: { played: true } });
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, payload: { played: true } });
  });

  it("refuses an action the device never offered", async () => {
    const { client, identity } = await board();
    client.send(description);
    await described("board");
    const result = await admin("POST", `/admin/clients/${identity.clientId}/commands/format-disk`);
    expect(result.status).toBe(400);
  });

  it("says so when the device is offline", async () => {
    const identity = await newPairedClient({ capabilities: ["speaker"] });
    const result = await admin("POST", `/admin/clients/${identity.clientId}/commands/diag`);
    expect(result.status).toBe(409);
  });

  it("reports a failure the device sent back", async () => {
    const { client, identity } = await board();
    client.send(description);
    await described("board");
    const pending = admin("POST", `/admin/clients/${identity.clientId}/commands/cue`);
    const command = await client.next("command");
    client.send({ t: "command.result", id: command.id, ok: false, error: "not implemented on this device" });
    expect((await pending).body).toMatchObject({ ok: false, error: "not implemented on this device" });
  });

  it("settles a waiting command when the device disconnects", async () => {
    const { client, identity } = await board();
    client.send(description);
    await described("board");
    const pending = admin("POST", `/admin/clients/${identity.clientId}/commands/cue`);
    await client.next("command");
    client.close();
    expect((await pending).body).toMatchObject({ ok: false });
  });
});

describe("announcing on a device", () => {
  it("rejects a client that can neither speak nor show text", async () => {
    const { identity } = await board(["mic"]);
    const result = await admin("POST", `/admin/clients/${identity.clientId}/announce`, { text: "hello" });
    expect(result.status).toBe(400);
  });

  it("needs some text", async () => {
    const { identity } = await board(["screen"]);
    expect((await admin("POST", `/admin/clients/${identity.clientId}/announce`, { text: "  " })).status).toBe(400);
  });

  it("is refused while the device is offline", async () => {
    const identity = await newPairedClient({ capabilities: ["screen"] });
    expect((await admin("POST", `/admin/clients/${identity.clientId}/announce`, { text: "hi" })).status).toBe(409);
  });
});


describe("renaming a client", () => {
  it("gives a client type a display name without touching the type itself", async () => {
    const { identity } = await board(["speaker"]);
    expect((await admin("PATCH", "/admin/types/board", { label: "Kitchen displays" })).status).toBe(200);
    const listed = (await admin("GET", "/admin/clients")).body;
    expect(listed.types.board.label).toBe("Kitchen displays");
    expect(listed.clients.find((c: any) => c.id === identity.clientId).type).toBe("board");
    expect((await admin("PATCH", "/admin/types/board", { label: "" })).body.label).toBeNull();
    expect((await admin("GET", "/admin/clients")).body.types.board.label).toBeUndefined();
    expect((await admin("PATCH", "/admin/types/nothing", { label: "x" })).status).toBe(404);
  });

  it("changes the name, also for a connected client", async () => {
    const { identity } = await board();
    const result = await admin("PATCH", `/admin/clients/${identity.clientId}`, { name: "  Kitchen  " });
    expect(result.status).toBe(200);
    expect(result.body.name).toBe("Kitchen");
    expect((await admin("GET", `/admin/clients/${identity.clientId}`)).body).toMatchObject({ name: "Kitchen", online: true });
  });

  it("refuses an empty name, a name another client has, and an unknown client", async () => {
    const first = await newPairedClient({ name: "Desk" });
    const second = await newPairedClient({ name: "Hall" });
    expect((await admin("PATCH", `/admin/clients/${second.clientId}`, { name: " " })).status).toBe(400);
    expect((await admin("PATCH", `/admin/clients/${second.clientId}`, { name: "desk" })).status).toBe(409);
    expect((await admin("PATCH", `/admin/clients/${first.clientId}`, { name: "Desk" })).status).toBe(200);
    expect((await admin("PATCH", "/admin/clients/c_nobody", { name: "X" })).status).toBe(404);
  });
});
