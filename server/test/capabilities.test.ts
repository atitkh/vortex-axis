import { describe, expect, it } from "vitest";
import type { Capability } from "@vortex-axis/protocol";
import { createInvokeHandler } from "../src/commands.js";
import { Store } from "../src/store.js";
import { admin, connect, ctx, newPairedClient, useServer } from "./harness.js";

useServer();

function invoke(command: string, params: Record<string, unknown> = {}) {
  const { hub, store, timers, delivery, activity } = ctx.app;
  return createInvokeHandler({ hub, store, timers, delivery, activity, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(
    command,
    params,
  ) as Promise<any>;
}

async function device(name: string, capabilities: Capability[], type = "board") {
  const identity = await newPairedClient({ capabilities, type, name });
  const client = await connect(identity, { capabilities, type });
  await client.next("status");
  return { identity, client };
}

const switchOff = (id: string, capabilitiesOff: unknown) => admin("PATCH", `/admin/clients/${id}`, { capabilitiesOff });

describe("capabilities an admin switched off", () => {
  it("are kept apart from what the client reports, which a hello keeps writing", () => {
    const store = new Store(":memory:");
    const code = store.createPairingCode(60_000).code;
    const { client } = store.pair({ code, type: "board", version: "1", capabilities: ["mic", "speaker", "screen"] })!;
    expect(client).toMatchObject({ capabilities: ["mic", "speaker", "screen"], reported: ["mic", "speaker", "screen"], off: [] });

    expect(store.setCapabilitiesOff(client.id, ["screen"])).toMatchObject({ capabilities: ["mic", "speaker"], reported: ["mic", "speaker", "screen"], off: ["screen"] });
    store.recordHello(client.id, { version: "2", capabilities: ["mic", "speaker", "screen", "image-frames"] });
    expect(store.getClient(client.id)).toMatchObject({ capabilities: ["mic", "speaker", "image-frames"], reported: ["mic", "speaker", "screen", "image-frames"], off: ["screen"] });
    // Something switched off that it does not report takes nothing away, and nothing is ever added.
    store.setCapabilitiesOff(client.id, ["desktop"]);
    expect(store.getClient(client.id)!.capabilities).toEqual(["mic", "speaker", "screen", "image-frames"]);
    store.close();
  });

  it("are set with PATCH, refused when they are not a list of capabilities, and survive a reconnect", async () => {
    const { identity, client } = await device("Desk", ["mic", "speaker", "screen"]);
    const id = identity.clientId;
    expect((await switchOff(id, "screen")).status).toBe(400);
    expect((await switchOff(id, ["screen", "wings"])).body.error).toMatch(/not a capability: wings/);
    expect((await admin("PATCH", `/admin/settings/device/${id}`, { values: { capabilitiesOff: "screen" } })).status).toBe(400);
    expect((await admin("PATCH", "/admin/settings/global", { values: { capabilitiesOff: "screen" } })).status).toBe(400);

    const before = client.received.length;
    const done = await switchOff(id, ["screen", "mic"]);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ capabilities: ["speaker"], reported: ["mic", "speaker", "screen"], off: ["mic", "screen"] });
    expect(done.body.layers.device).toEqual({ capabilitiesOff: "mic,screen" });
    // The device is told through its settings.
    expect((await client.next("settings", before)).values.capabilitiesOff).toBe("mic,screen");
    expect((await invoke("vortex.axis.clients")).clients[0].can).toEqual(["speaker"]);

    client.close();
    await client.closed();
    const again = await connect(identity, { capabilities: ["mic", "speaker", "screen"], type: "board" });
    await again.next("status");
    expect((await admin("GET", `/admin/clients/${id}`)).body).toMatchObject({ online: true, capabilities: ["speaker"], off: ["mic", "screen"] });

    // Everything on again: the setting is gone, so the device's settings are as they were before.
    const mark = again.received.length;
    expect((await switchOff(id, [])).body).toMatchObject({ capabilities: ["mic", "speaker", "screen"], off: [], layers: { device: {} } });
    expect((await again.next("settings", mark)).values).not.toHaveProperty("capabilitiesOff");
  });

  it("leaves the client out of the choice of where agent speech goes", async () => {
    const desk = await device("Desk", ["speaker", "screen"]);
    const hall = await device("Hall", ["speaker", "screen"]);
    await admin("PATCH", "/admin/settings/global", { values: { defaultClient: "Desk" } });
    await switchOff(desk.identity.clientId, ["speaker", "screen"]);
    expect((await admin("POST", `/admin/clients/${desk.identity.clientId}/announce`, { text: "Hello" })).body.error).toMatch(/neither speak nor show/);
    expect(() => ctx.app.hub.pickOutput({ client: "Desk" })).toThrow(/neither speak nor show/);
    expect(ctx.app.hub.pickOutput({}).client.name).toBe("Hall");
    await switchOff(desk.identity.clientId, []);
    expect(ctx.app.hub.pickOutput({}).client.name).toBe("Desk");
    void hall;
  });

  it("stops the desktop tool using a computer with desktop switched off", async () => {
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true });
    const one = await device("Desk PC", ["desktop"], "windows-desktop");
    const lab = await device("Lab PC", ["desktop"], "windows-desktop");
    await switchOff(one.identity.clientId, ["desktop"]);
    const tool = (args: Record<string, unknown>) => admin("POST", "/admin/mcp/tools/try", { name: "vortex_axis_desktop", arguments: args });
    // With one of the two left, it is the computer a call means.
    const looking = tool({ action: "look" });
    const look = await lab.client.next("command", 0, (m) => m.name === "desktop.look");
    lab.client.send({ t: "command.result", id: look.id, ok: true, data: { elements: [] } });
    expect((await looking).body.result).toMatchObject({ computer: "Lab PC" });
    expect(one.client.received.some((m) => m.t === "command" && m.name === "desktop.look")).toBe(false);
  });

  it("takes a question off a device whose screen was switched off and asks it elsewhere", async () => {
    const desk = await device("Desk", ["screen", "touch"]);
    const hall = await device("Hall", ["mic", "speaker", "screen", "touch"]);
    const asking = invoke("vortex.axis.ask", { question: "Lights off?", choices: ["Yes", "No"], client: "Desk", timeoutSeconds: 30 });
    const ask = await desk.client.next("ask");
    await switchOff(desk.identity.clientId, ["screen"]);
    expect((await desk.client.next("ask.end")).askId).toBe(ask.askId);

    const moved = await hall.client.next("ask");
    expect(moved).toMatchObject({ question: "Lights off?", choices: ["Yes", "No"] });
    expect(moved.timeoutMs).toBeLessThanOrEqual(30_000);
    hall.client.send({ t: "answer", askId: moved.askId, choice: "Yes" });
    expect(await asking).toMatchObject({ client: "Desk", answer: "Yes", how: "tap" });
  });

  it("ends a question unanswered when nowhere else can take it", async () => {
    const desk = await device("Desk", ["screen", "touch"]);
    const asking = invoke("vortex.axis.ask", { question: "Lights off?", choices: ["Yes", "No"], client: "Desk" });
    await desk.client.next("ask");
    await switchOff(desk.identity.clientId, ["screen"]);
    await desk.client.next("ask.end");
    expect(await asking).toMatchObject({ answer: null });
  });

  it("takes touch off a client's capabilities like any other, and a screen without it is not asked a choice", async () => {
    const store = new Store(":memory:");
    const code = store.createPairingCode(60_000).code;
    const { client } = store.pair({ code, type: "board", version: "1", capabilities: ["screen", "touch"] })!;
    expect(client.capabilities).toEqual(["screen", "touch"]);
    expect(store.setCapabilitiesOff(client.id, ["touch"])).toMatchObject({ capabilities: ["screen"], reported: ["screen", "touch"], off: ["touch"] });
    store.close();

    const flat = await device("Flat", ["screen"]);
    const refused = await admin("POST", "/admin/mcp/tools/try", { name: "vortex_axis_ask", arguments: { question: "Lights off?", choices: ["Yes", "No"], client: "Flat" } });
    expect(JSON.stringify(refused.body)).toMatch(/no microphone and no tappable screen/);
    expect(flat.client.received.some((m) => m.t === "ask")).toBe(false);
  });

  it("moves a question waiting on a tap when touch is switched off live", async () => {
    const desk = await device("Desk", ["screen", "touch"]);
    const hall = await device("Hall", ["mic", "speaker", "screen", "touch"]);
    const asking = invoke("vortex.axis.ask", { question: "Lights off?", choices: ["Yes", "No"], client: "Desk", timeoutSeconds: 30 });
    const ask = await desk.client.next("ask");
    await switchOff(desk.identity.clientId, ["touch"]);
    expect((await desk.client.next("ask.end")).askId).toBe(ask.askId);
    const moved = await hall.client.next("ask");
    expect(moved).toMatchObject({ question: "Lights off?", choices: ["Yes", "No"] });
    hall.client.send({ t: "answer", askId: moved.askId, choice: "No" });
    expect(await asking).toMatchObject({ client: "Desk", answer: "No" });
  });
});
