import { describe, expect, it } from "vitest";
import { createInvokeHandler, NODE_TOOLS } from "../src/commands.js";
import type { TextToSpeech } from "../src/speech.js";
import { ADMIN_TOKEN, admin, ctx, ready, restart, useServer } from "./harness.js";

const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: () =>
    (async function* () {
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
useServer(() => ({ tts }));

let nextId = 0;
/** Sends one JSON-RPC message the way an MCP client does. */
async function rpc(token: string, method: string, params?: unknown, extra: { id?: number | null; headers?: Record<string, string> } = {}) {
  const id = extra.id === null ? undefined : (extra.id ?? ++nextId);
  const res = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra.headers },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, id };
}

async function newToken(name = "Test harness"): Promise<string> {
  const made = await admin("POST", "/admin/mcp/tokens", { name });
  expect(made.status).toBe(201);
  return made.body.token;
}

describe("MCP", () => {
  it("lets nobody in without a token an admin made, and shuts out an address that keeps guessing", async () => {
    expect((await rpc("", "tools/list")).status).toBe(401);
    expect((await rpc(ADMIN_TOKEN, "tools/list")).status).toBe(401);
    const token = await newToken();
    expect((await rpc(token, "ping")).body).toMatchObject({ result: {} });
    for (let i = 0; i < 10; i++) await rpc("wrong", "ping");
    // The tenth wrong one closes the door, even to the right token, from that address.
    expect((await rpc(token, "ping")).status).toBe(429);
  });

  it("introduces itself and says how to use it", async () => {
    const token = await newToken();
    const { body } = await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "vortex-axis" } });
    expect(body.result.instructions).toMatch(/from\)/);
    // A revision it does not know is answered with the newest it does.
    expect((await rpc(token, "initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe("2025-06-18");
    // A notification is taken in and gets no answer.
    expect(await rpc(token, "notifications/initialized", undefined, { id: null })).toMatchObject({ status: 202, body: undefined });
    expect((await rpc(token, "no/such/method")).body.error.code).toBe(-32601);
    expect((await fetch(`${ctx.base}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });

  it("offers exactly the tools the OpenClaw node does", async () => {
    const token = await newToken();
    const { body } = await rpc(token, "tools/list");
    expect(body.result.tools.map((t: any) => t.name)).toEqual(NODE_TOOLS.map((t) => t.name));
    const say = body.result.tools.find((t: any) => t.name === "vortex_axis_say");
    expect(say).toEqual({ name: "vortex_axis_say", description: NODE_TOOLS[0]!.description, inputSchema: NODE_TOOLS[0]!.parameters });
  });

  it("carries out a tool call with the same function, and gives the same answer", async () => {
    const token = await newToken();
    const { client } = await ready(["speaker", "screen"], { name: "Desk" });
    const listed = await rpc(token, "tools/call", { name: "vortex_axis_clients", arguments: {} });
    const { hub, store, timers, delivery, activity } = ctx.app;
    const direct = await createInvokeHandler({ hub, store, timers, delivery, activity, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })("vortex.axis.clients", {});
    expect(listed.body.result).toMatchObject({ isError: false, structuredContent: direct });
    expect(JSON.parse(listed.body.result.content[0].text)).toEqual(direct);

    // Speech: the call returns when the device has played it.
    const saying = rpc(token, "tools/call", { name: "vortex_axis_say", arguments: { text: "Build finished.", client: "Desk" } });
    const start = await client.next("speak.start");
    await client.next("speak.end");
    client.send({ t: "playback", turnId: start.turnId, state: "finished" });
    expect((await saying).body.result.structuredContent).toMatchObject({ client: "Desk", heard: true, shown: true });

    // A tool that cannot do what was asked answers with an error the agent can read.
    const lost = await rpc(token, "tools/call", { name: "vortex_axis_say", arguments: { text: "Hello?", client: "Nobody" } });
    expect(lost.body.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/no client called "Nobody"/) }] });
    expect((await rpc(token, "tools/call", { name: "vortex_axis_fly" })).body.error.code).toBe(-32602);
  });

  it("answers a batch, leaving out the notifications in it", async () => {
    const token = await newToken();
    const res = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    });
    expect(((await res.json()) as any[]).map((a) => a.id)).toEqual([1, 2]);
  });

  it("stops working for a token the moment it is revoked", async () => {
    const token = await newToken("Coding agent");
    const { body } = await admin("GET", "/admin/mcp");
    expect(body.tokens).toEqual([{ id: expect.any(Number), name: "Coding agent", createdAt: expect.any(Number), lastUsedAt: null }]);
    // The token itself is never given out again.
    expect(JSON.stringify(body)).not.toContain(token);
    expect((await rpc(token, "ping")).status).toBe(200);
    expect((await admin("GET", "/admin/mcp")).body.tokens[0].lastUsedAt).toEqual(expect.any(Number));
    expect((await admin("DELETE", `/admin/mcp/tokens/${body.tokens[0].id}`)).status).toBe(200);
    expect((await rpc(token, "ping")).status).toBe(401);
    expect((await admin("POST", "/admin/mcp/tokens", { name: " " })).status).toBe(400);
  });

  it("is hidden under a public name unless that is switched on", async () => {
    const token = await newToken();
    await admin("PATCH", "/admin/integrations", { publicHosts: "axis.example.org" });
    const outside = { headers: { "x-forwarded-host": "axis.example.org" } };
    expect((await rpc(token, "ping", undefined, outside)).status).toBe(404);
    expect((await rpc(token, "ping")).status).toBe(200);
    expect((await admin("PATCH", "/admin/integrations", { mcpPublic: true })).body.settings.mcpPublic).toBe(true);
    expect((await rpc(token, "ping", undefined, outside)).status).toBe(200);
  });
});

describe("tools switched on and off", () => {
  it("takes a tool away from every agent, by MCP and by the OpenClaw node alike, and keeps it so across a restart", async () => {
    const token = await newToken();
    expect((await admin("PATCH", "/admin/mcp/tools", { vortex_axis_admin: false, vortex_axis_say: false })).body.tools.filter((t: any) => !t.enabled).map((t: any) => t.name)).toEqual([
      "vortex_axis_say",
      "vortex_axis_admin",
    ]);
    await restart();
    const names = (await rpc(token, "tools/list")).body.result.tools.map((t: any) => t.name);
    expect(names).not.toContain("vortex_axis_admin");
    expect(names).toContain("vortex_axis_timer");
    expect((await rpc(token, "tools/call", { name: "vortex_axis_admin", arguments: { action: "pairing_code" } })).body.result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringMatching(/switched off/) }],
    });

    // The node's door goes through the same guard; the gateway's `nodes notify` is the say tool by another name.
    const invoke = ctx.app.tools.guard(async () => ({ done: true }));
    await expect(invoke("vortex.axis.admin", {})).rejects.toThrow(/switched off/);
    await expect(invoke("system.notify", { body: "hello" })).rejects.toThrow(/vortex_axis_say is switched off/);
    await expect(invoke("vortex.axis.timer", {})).resolves.toEqual({ done: true });

    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_admin: true });
    expect((await rpc(token, "tools/list")).body.result.tools.map((t: any) => t.name)).toContain("vortex_axis_admin");
    expect((await admin("PATCH", "/admin/mcp/tools", { vortex_axis_fly: true })).status).toBe(400);
  });
});
