import { AXIS_VERSION } from "../src/version.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceIdentity, authPayload, decodeSetupCode, toSocketUrl } from "../src/gateway/wire.js";
import { DEFAULT_GATEWAY_NOTE } from "../src/agent.js";
import { NODE_COMMANDS } from "../src/commands.js";
import type { SpeechToText, TextToSpeech } from "../src/speech.js";
import { FakeGateway } from "./fake-gateway.js";
import { admin, ctx, ready, restart, useServer } from "./harness.js";

const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: () =>
    (async function* () {
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
const stt: SpeechToText = { transcribe: async () => "hello", healthy: async () => true };

let gateway: FakeGateway;
useServer(() => ({ stt, tts }));
beforeEach(async () => {
  gateway = new FakeGateway();
  await gateway.listening();
});
afterEach(async () => {
  await gateway.close();
});

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const status = async () => (await admin("GET", "/admin/gateway")).body;
const bothConnected = async () => {
  const s = await status();
  return s.operator.state === "connected" && s.node.state === "connected";
};

/**
 * Pastes a setup code and approves what comes in, as a person would: first the
 * device as an operator, then its request to also be a node.
 */
async function pairWithGateway(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await admin("POST", "/admin/gateway/setup-code", { code: gateway.setupCode(), ...extra });
  expect(res.status).toBe(202);
  const deviceId = res.body.deviceId as string;
  for (const role of ["operator", "node"]) {
    await until(() => gateway.pendingRequests.has(`${deviceId}:${role}`), `the ${role} request`);
    gateway.approve(deviceId);
  }
  await until(bothConnected, "both links to connect");
  return deviceId;
}

describe("wire helpers", () => {
  it("derives a stable device id and survives a restart", () => {
    const identity = DeviceIdentity.generate();
    const restored = DeviceIdentity.restore(identity.serialize());
    expect(restored.deviceId).toBe(identity.deviceId);
    expect(identity.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(identity.publicKey, "base64")).toHaveLength(32);
  });

  it("builds the signed text field by field", () => {
    expect(
      authPayload({ deviceId: "dev", role: "operator", scopes: ["a", "b"], signedAtMs: 5, token: "tok", nonce: "n" }),
    ).toBe("v3|dev|cli|cli|operator|a,b|5|tok|n|vortex-axis|");
    expect(authPayload({ deviceId: "dev", role: "node", scopes: [], signedAtMs: 5, token: "", nonce: "n" })).toBe(
      "v3|dev|node-host|node|node||5||n|vortex-axis|",
    );
  });

  it("decodes a setup code and rejects junk", () => {
    const code = Buffer.from(JSON.stringify({ url: "ws://a:1", urls: ["ws://a:1", "ws://b:2"], bootstrapToken: "t" })).toString("base64url");
    expect(decodeSetupCode(`  openclaw://${code}/ `)).toEqual({ bootstrapToken: "t", urls: ["ws://a:1", "ws://b:2"] });
    expect(() => decodeSetupCode("")).toThrow(/empty/);
    expect(() => decodeSetupCode("not a code")).toThrow(/not valid/);
    expect(() => decodeSetupCode(Buffer.from("{}").toString("base64url"))).toThrow(/bootstrap token/);
  });

  it("accepts http and bare addresses", () => {
    expect(toSocketUrl("http://host:18789")).toBe("ws://host:18789/");
    expect(toSocketUrl("https://host")).toBe("wss://host/");
    expect(toSocketUrl("host:18789")).toBe("ws://host:18789/");
  });
});

describe("pairing with the gateway", () => {
  it("starts unconfigured and connects nothing", async () => {
    const s = await status();
    expect(s.operator.state).toBe("unconfigured");
    expect(s.node.state).toBe("unconfigured");
    expect(s.setupCodePending).toBe(false);
    expect(gateway.connects).toEqual([]);
  });

  it("pairs one role at a time, each waiting for its own approval", async () => {
    const res = await admin("POST", "/admin/gateway/setup-code", { code: gateway.setupCode() });
    const deviceId = res.body.deviceId as string;
    await until(async () => (await status()).operator.state === "pairing_required", "the operator request");

    // The node link stands by. It must not present the code while the operator's request is open.
    let s = await status();
    expect(s.node).toEqual({ state: "pairing_required", error: "waiting for the other link to be approved first" });
    expect(s.setupCodePending).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(gateway.connects.every((c) => c.role === "operator")).toBe(true);
    expect([...gateway.pendingRequests]).toEqual([`${deviceId}:operator`]);

    gateway.approve(deviceId);
    await until(async () => (await status()).operator.state === "connected", "the operator link");
    await until(() => gateway.pendingRequests.has(`${deviceId}:node`), "the node request");
    s = await status();
    expect(s.node.state).toBe("pairing_required");
    expect(s.setupCodePending).toBe(true);

    gateway.approve(deviceId);
    await until(bothConnected, "both links to connect");
    s = await status();
    expect(s.setupCodePending).toBe(false);
    expect(gateway.connected("operator")?.deviceId).toBe(deviceId);
    expect(gateway.connected("node")?.deviceId).toBe(deviceId);
  });

  it("needs one approval when the gateway grants both roles at once", async () => {
    const res = await admin("POST", "/admin/gateway/setup-code", { code: gateway.setupCode() });
    await until(() => gateway.pendingRequests.size > 0, "the operator request");
    gateway.approve(res.body.deviceId, ["operator", "node"]);
    await until(bothConnected, "both links to connect");
    // The node never asked: its token came with the operator's handshake.
    expect(gateway.connects.filter((c) => c.role === "node").every((c) => c.auth.deviceToken)).toBe(true);
  });

  it("declares the full command list and publishes tools and presence", async () => {
    await pairWithGateway();
    const node = gateway.connects.filter((c) => c.role === "node").at(-1);
    expect(node.client).toMatchObject({ id: "node-host", mode: "node", platform: "vortex-axis", displayName: "VorteX Axis", version: AXIS_VERSION });
    expect(gateway.connects.every((c) => c.client.platform === "vortex-axis" && c.client.deviceFamily === undefined)).toBe(true);
    expect(node.commands).toEqual([...NODE_COMMANDS]);
    expect(node.scopes).toEqual([]);

    await until(() => gateway.nodeRequests.some((r) => r.method === "node.event"), "presence");
    const methods = gateway.nodeRequests.map((r) => r.method);
    expect(methods.slice(0, 2)).toEqual(["node.pluginTools.update", "node.event"]);
    expect(methods).not.toContain("node.pluginSurface.refresh");
    const tools = gateway.nodeRequests[0]!.params.tools;
    expect(tools.map((t: any) => t.name)).toEqual(["vortex_axis_say", "vortex_axis_ask", "vortex_axis_timer", "vortex_axis_admin", "vortex_axis_clients", "vortex_axis_config", "vortex_axis_sense", "vortex_axis_diag"]);
    expect(tools.every((t: any) => t.pluginId === "vortex-axis" && NODE_COMMANDS.includes(t.command))).toBe(true);
    expect(gateway.nodeRequests[1]!.params).toMatchObject({ event: "node.presence.alive", payload: { platform: "vortex-axis" } });
  });

  it("reconnects with its stored tokens after a restart, without a setup code", async () => {
    await pairWithGateway();
    await restart();
    await until(bothConnected, "both links to reconnect");
    const last = gateway.connects.slice(-2);
    expect(last.every((c) => c.auth.deviceToken && !c.auth.bootstrapToken)).toBe(true);
  });

  it("reconnects when the gateway drops the connection", async () => {
    await pairWithGateway();
    gateway.dropAll();
    await until(async () => !(await bothConnected()), "the drop to be noticed");
    await until(bothConnected, "both links to reconnect");
  });

  it("reports a spent setup code instead of retrying forever", async () => {
    const code = gateway.setupCode();
    gateway.bootstrapTokens.clear();
    await admin("POST", "/admin/gateway/setup-code", { code });
    await until(async () => (await status()).operator.state === "auth_failed", "the code to be refused");
    await until(async () => (await status()).node.state === "unconfigured", "the node link to stand down");
    const s = await status();
    expect(s.operator.error).toMatch(/new one is needed/);
    expect(s.setupCodePending).toBe(false);
    const attempts = gateway.connects.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(gateway.connects.length).toBe(attempts);
  });

  it("uses the address given with the code over the one inside it", async () => {
    const code = gateway.setupCode(["ws://name-that-does-not-resolve.invalid:1"]);
    const res = await admin("POST", "/admin/gateway/setup-code", { code, url: gateway.url });
    await until(() => gateway.pendingRequests.size > 0, "the operator request");
    gateway.approve(res.body.deviceId, ["operator", "node"]);
    await until(bothConnected, "both links to connect");
  });

  it("rejects a malformed setup code", async () => {
    const res = await admin("POST", "/admin/gateway/setup-code", { code: "nonsense" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not valid/);
  });

  it("tells clients when OpenClaw comes up", async () => {
    const { client } = await ready();
    expect((await client.next("status")).upstream.openclaw).toBe("unknown");
    await pairWithGateway();
    expect((await client.next("status", 0, (m) => m.upstream.openclaw === "up")).upstream).toEqual({ openclaw: "up", stt: "up", tts: "up" });
  });
});

describe("agent turns over the gateway", () => {
  it("sends the turn to the chosen agent in one shared session", async () => {
    await pairWithGateway();
    expect((await admin("PATCH", "/admin/gateway", { agentId: "vertex" })).body.agentId).toBe("vertex");

    const { client } = await ready(["mic", "speaker", "screen"], { name: "Desk" });
    client.send({ t: "text", turnId: "t1", text: "hi there" });

    expect((await client.next("reply.text", 0, (m) => m.final)).text).toBe("Hello from the agent.");
    const request = gateway.agentRequests[0];
    expect(request).toMatchObject({ agentId: "vertex", sessionKey: "vortex-axis" });
    expect(request.message).toBe("[from: Desk, type: web, location: unknown, can: mic+speaker+screen]\nhi there");
    expect(request.idempotencyKey).toMatch(/^axis-/);
    // The note rides beside the message as an addition to the agent's own prompt, not inside the words.
    expect(request.extraSystemPrompt).toBe(DEFAULT_GATEWAY_NOTE);
    expect(Object.keys(request).sort()).toEqual(["agentId", "extraSystemPrompt", "idempotencyKey", "message", "sessionKey"]);

    await admin("PATCH", "/admin/config", { agent: { gatewayNote: "Be brief." } });
    client.send({ t: "text", turnId: "t2", text: "again" });
    await vi.waitFor(() => expect(gateway.agentRequests.length).toBe(2));
    expect(gateway.agentRequests[1].extraSystemPrompt).toBe("Be brief.");
    await admin("PATCH", "/admin/config", { agent: { gatewayNote: "-" } });
    client.send({ t: "text", turnId: "t3", text: "and again" });
    await vi.waitFor(() => expect(gateway.agentRequests.length).toBe(3));
    expect("extraSystemPrompt" in gateway.agentRequests[2]).toBe(false);
  });

  it("falls back to the gateway's default agent", async () => {
    await pairWithGateway();
    const { client } = await ready();
    client.send({ t: "text", turnId: "t1", text: "hi" });
    await client.next("speak.end");
    expect(gateway.agentRequests[0].agentId).toBe("main");
  });

  it("lists agents and takes the agent from the environment", async () => {
    await pairWithGateway();
    await restart({ gateway: { url: undefined, agentId: "vertex", sessionKey: "desk-test", displayName: "VorteX Axis" } });
    await until(bothConnected, "both links to reconnect");
    const agents = (await admin("GET", "/admin/gateway/agents")).body;
    expect(agents).toEqual({ agents: [{ id: "main", default: true }, { id: "vertex", default: false }], selected: "vertex" });

    const { client } = await ready();
    client.send({ t: "text", turnId: "t1", text: "hi" });
    await client.next("speak.end");
    expect(gateway.agentRequests[0]).toMatchObject({ agentId: "vertex", sessionKey: "desk-test" });
  });

  it("reports an agent the gateway does not have", async () => {
    await pairWithGateway();
    await admin("PATCH", "/admin/gateway", { agentId: "nobody" });
    const { client } = await ready();
    client.send({ t: "text", turnId: "t1", text: "hi" });
    expect((await client.turn("t1", "error")).detail).toMatch(/unknown agent nobody/);
  });

  it("fails a turn cleanly while unpaired", async () => {
    const { client } = await ready();
    client.send({ t: "text", turnId: "t1", text: "hi" });
    expect((await client.turn("t1", "error")).detail).toBe("not connected to OpenClaw");
  });
});

describe("commands from an agent", () => {
  it("speaks on the client last spoken to", async () => {
    await pairWithGateway();
    const desk = await ready(["mic", "speaker"], { name: "Desk" });
    const kitchen = await ready(["mic", "speaker"], { name: "Kitchen" });
    kitchen.client.send({ t: "text", turnId: "t1", text: "hi" });
    await kitchen.client.next("speak.end");
    kitchen.client.send({ t: "playback", turnId: "t1", state: "finished" });
    await kitchen.client.turn("t1", "idle");

    const pending = gateway.invoke("vortex.axis.say", { text: "The build finished." });
    const start = await kitchen.client.next("speak.start", 0, (m) => m.turnId.startsWith("say-"));
    await kitchen.client.next("speak.end", 0, (m) => m.turnId === start.turnId);
    kitchen.client.send({ t: "playback", turnId: start.turnId, state: "finished" });

    expect(await pending).toMatchObject({ ok: true, payload: { client: "Kitchen", heard: true, shown: false } });
    expect((await pending).payload.note).toBeUndefined();
    expect(desk.client.types()).not.toContain("speak.start");
  });

  it("speaks in a named location or on a named client", async () => {
    await pairWithGateway();
    const desk = await ready(["speaker"], { name: "Desk" });
    const bed = await ready(["speaker"], { name: "Bedside" });
    await admin("PATCH", `/admin/settings/device/${bed.identity.clientId}`, { values: { location: "Bedroom" } });

    const finish = async (c: typeof desk.client) => {
      const end = await c.next("speak.end");
      c.send({ t: "playback", turnId: end.turnId, state: "finished" });
    };
    const byLocation = gateway.invoke("vortex.axis.say", { text: "Good night.", location: "bedroom" });
    await finish(bed.client);
    expect((await byLocation).payload).toMatchObject({ client: "Bedside", heard: true });

    // "room" is the old word for a location and still works, as a target and as a setting name.
    const byOldWord = await gateway.invoke("vortex.axis.timer", { action: "set", seconds: 600, room: "bedroom" });
    expect(byOldWord.payload).toMatchObject({ set: { client: "Bedside" } });
    const moved = await gateway.invoke("vortex.axis.config", { client: "Desk", key: "room", value: "Car" });
    expect((moved.payload as { settings: Record<string, unknown> }).settings).toMatchObject({ location: "Car" });

    const byName = gateway.invoke("vortex.axis.say", { text: "Still up?", client: "desk" });
    await finish(desk.client);
    expect((await byName).payload).toMatchObject({ client: "Desk", heard: true });
  });

  it("treats system.notify as speech", async () => {
    await pairWithGateway();
    const { client } = await ready(["screen"], { name: "Panel" });
    const result = await gateway.invoke("system.notify", { title: "Build finished", body: "All tests pass" });
    // A screen has nothing to play, so the words count as shown and not as heard.
    expect(result).toMatchObject({ ok: true, payload: { client: "Panel", heard: false, shown: true } });
    expect(result.payload.note).toMatch(/shown on the client's screen/);
    expect((await client.next("reply.text", 0, (m) => m.final)).text).toBe("Build finished. All tests pass");
  });

  it("reports speech a client could not play as not heard, without waiting", async () => {
    await pairWithGateway();
    const { client } = await ready(["speaker"], { name: "Muted tab" });
    const started = Date.now();
    const pending = gateway.invoke("vortex.axis.say", { text: "Anyone there?" });
    const start = await client.next("speak.start");
    client.send({ t: "playback", turnId: start.turnId, state: "blocked" });

    const result = await pending;
    expect(result).toMatchObject({ ok: true, payload: { client: "Muted tab", heard: false, shown: false } });
    expect(result.payload.note).toMatch(/no screen/);
    expect(Date.now() - started).toBeLessThan(2000);
    await client.turn(start.turnId, "idle");
  });

  it("refuses when nothing can take the message", async () => {
    await pairWithGateway();
    expect(await gateway.invoke("vortex.axis.say", { text: "hello" })).toMatchObject({
      ok: false,
      error: { message: "no client that can speak or show text is online" },
    });
    expect((await gateway.invoke("vortex.axis.say", { text: "hello", client: "Ghost" })).error.message).toMatch(/no client called "Ghost"/);
    expect((await gateway.invoke("vortex.axis.say", {})).error.message).toMatch(/nothing to say/);
  });

  it("lists clients with what they can do", async () => {
    await pairWithGateway();
    const { identity } = await ready(["mic", "speaker"], { name: "Desk" });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { location: "office" } });
    const result = await gateway.invoke("vortex.axis.clients", {});
    expect(result.payload.clients).toEqual([
      { id: identity.clientId, name: "Desk", type: "web", location: "office", can: ["mic", "speaker"], online: true },
    ]);
  });

  it("reads and changes a client's settings", async () => {
    await pairWithGateway();
    const { client } = await ready(["speaker"], { name: "Desk" });
    await admin("PATCH", "/admin/settings/global", { values: { volume: 50 } });
    const seen = client.received.length;

    const changed = await gateway.invoke("vortex.axis.config", { client: "Desk", key: "volume", value: 80 });
    expect(changed.payload).toEqual({ client: "Desk", settings: { volume: 80 } });
    expect((await client.next("settings", seen, (m) => m.values.volume === 80)).values).toEqual({ volume: 80 });

    expect((await gateway.invoke("vortex.axis.config", { client: "Desk" })).payload.settings).toEqual({ volume: 80 });
    expect((await gateway.invoke("vortex.axis.config", { client: "Desk", key: "volume", value: [1] })).ok).toBe(false);
  });

  it("reports sensor readings and hub health", async () => {
    await pairWithGateway();
    const { client } = await ready(["sensors", "screen"], { name: "Watch" });
    client.send({ t: "sense", readings: { battery: 0.7 } });
    await until(async () => (await gateway.invoke("vortex.axis.sense", { client: "Watch" })).payload.readings[0]?.readings.battery === 0.7, "the reading");

    const diag = (await gateway.invoke("vortex.axis.diag", {})).payload;
    expect(diag).toMatchObject({ version: AXIS_VERSION, clientsOnline: 1, clientsKnown: 1, upstream: { openclaw: "up" } });
  });

  it("answers the newer commands over the gateway, and refuses one it does not know", async () => {
    await pairWithGateway();
    expect((await gateway.invoke("vortex.axis.timer", {})).payload).toEqual({ timers: [] });
    expect((await gateway.invoke("vortex.axis.ask", {})).error.message).toMatch(/nothing to ask/);
    expect((await gateway.invoke("made.up", {})).error.message).toBe("unknown command made.up");
  });
});
