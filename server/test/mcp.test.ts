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

describe("trying a tool from the admin page", () => {
  it("runs it through the same function and guard an agent's call goes through", async () => {
    await ready(["speaker"], { name: "Desk" });
    const listed = (await admin("GET", "/admin/mcp")).body.tools;
    expect(listed.find((t: any) => t.name === "vortex_axis_say").parameters.required).toEqual(["text"]);

    const clients = await admin("POST", "/admin/mcp/tools/try", { name: "vortex_axis_clients", arguments: {} });
    expect(clients.body).toMatchObject({ ok: true, ms: expect.any(Number), result: { clients: [{ name: "Desk", online: true }] } });
    // What the tool refuses comes back as its answer, not as a failed request.
    expect((await admin("POST", "/admin/mcp/tools/try", { name: "vortex_axis_config", arguments: {} })).body).toMatchObject({ ok: false, error: "say which client" });
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_diag: false });
    expect((await admin("POST", "/admin/mcp/tools/try", { name: "vortex_axis_diag" })).body.error).toMatch(/switched off/);
    expect((await admin("POST", "/admin/mcp/tools/try", { name: "vortex_axis_fly" })).status).toBe(404);

    // Each call is on the Live page, newest first, with who made it; the refused one too.
    const calls = ctx.app.live.calls();
    expect(calls.map((c: any) => [c.tool, c.via, c.outcome])).toEqual([
      ["vortex_axis_diag", "Admin page", "refused"],
      ["vortex_axis_config", "Admin page", "refused"],
      ["vortex_axis_clients", "Admin page", "ok"],
    ]);
    expect(calls[2].result).toContain('"Desk"');
    const token = await newToken("Coding agent");
    await rpc(token, "tools/call", { name: "vortex_axis_timer", arguments: { action: "list" } });
    expect(ctx.app.live.calls()[0]).toMatchObject({ tool: "vortex_axis_timer", via: "MCP: Coding agent", outcome: "ok", args: '{"action":"list"}' });
  });
});

describe("progress on the screens", () => {
  it("shows a task an agent reports on, step by step, and takes it away when asked", async () => {
    const token = await newToken();
    const { client } = await ready(["screen"], { name: "Desk" });
    await ready(["speaker"], { name: "No screen" });
    const call = async (args: Record<string, unknown>) => (await rpc(token, "tools/call", { name: "vortex_axis_progress", arguments: args })).body.result;
    const shown = async (from: number) => {
      const command = await client.next("command", from, (m) => m.name === "progress.show");
      client.send({ t: "command.result", id: command.id, ok: true });
      return command.params;
    };

    let from = client.received.length;
    expect((await call({ title: "Backup", note: "copying", done: 1, total: 3 })).structuredContent).toEqual({
      task: { id: "task", title: "Backup", note: "copying", done: 1, total: 3, state: "running" },
      screens: 1,
    });
    expect(await shown(from)).toEqual({ title: "Backup", note: "copying", done: 1, total: 3, state: "running", count: 1 });

    // The title and the number of steps are remembered; only what changed need be said.
    from = client.received.length;
    await call({ note: "checking", done: 2 });
    expect(await shown(from)).toMatchObject({ title: "Backup", note: "checking", done: 2, total: 3 });
    expect((await admin("GET", "/admin/now")).body.tasks).toMatchObject([{ id: "task", title: "Backup", done: 2, total: 3, state: "running" }]);

    from = client.received.length;
    await call({ state: "done", done: 3 });
    expect(await shown(from)).toMatchObject({ state: "done", done: 3 });
    from = client.received.length;
    expect((await call({ action: "clear" })).structuredContent).toEqual({ cleared: 1 });
    expect(await shown(from)).toMatchObject({ count: 0, state: "none" });

    // What cannot be shown is refused with a reason an agent can act on.
    expect(await call({ note: "no title yet" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/title/) }] });
    expect(await call({ title: "Odd", done: 5, total: 3 })).toMatchObject({ isError: true });
  });

  it("lists the steps by name, marks the finish with a sound once, and keeps what is over", async () => {
    const token = await newToken();
    const { client } = await ready(["screen"], { name: "Desk" });
    const call = async (args: Record<string, unknown>) => (await rpc(token, "tools/call", { name: "vortex_axis_progress", arguments: args })).body.result;
    const shown = async (from: number) => {
      const command = await client.next("command", from, (m) => m.name === "progress.show");
      client.send({ t: "command.result", id: command.id, ok: true });
      return command.params;
    };

    // Plain names: `done` says how many are behind, and the next one is in hand.
    let from = client.received.length;
    expect((await call({ title: "Release", steps: ["Build", "Test", "Deploy"], done: 1, note: "running tests" })).structuredContent).toMatchObject({
      task: { title: "Release", done: 1, total: 3, steps: 3 },
    });
    expect(await shown(from)).toEqual({ title: "Release", note: "running tests", done: 1, total: 3, state: "running", count: 1, steps: "xBuild\n>Test\n-Deploy" });

    // The names are remembered, so a later report only moves along them.
    from = client.received.length;
    await call({ done: 2 });
    expect(await shown(from)).toMatchObject({ done: 2, steps: "xBuild\nxTest\n>Deploy" });
    expect((await admin("GET", "/admin/now")).body.tasks[0].steps).toEqual([
      { text: "Build", state: "done" },
      { text: "Test", state: "done" },
      { text: "Deploy", state: "running" },
    ]);

    // Steps given with how each stands, the way an agent's own plan has them, are taken at their word.
    from = client.received.length;
    await call({ steps: [{ step: "Build", status: "completed" }, { step: "Test", status: "in_progress" }, { step: "Deploy", status: "pending" }] });
    expect(await shown(from)).toMatchObject({ done: 1, total: 3, steps: "xBuild\n>Test\n-Deploy" });

    // Finishing marks every step done and asks for a sound, once.
    from = client.received.length;
    await call({ state: "done" });
    expect(await shown(from)).toMatchObject({ state: "done", done: 3, steps: "xBuild\nxTest\nxDeploy", chime: true });
    from = client.received.length;
    await call({ title: "Second", note: "starting" });
    expect(await shown(from)).not.toHaveProperty("chime");
    expect((await call({ action: "clear" })).structuredContent).toEqual({ cleared: 1 });

    // Both are kept once over: the one that finished, and the one taken off before it did.
    const ended = (await admin("GET", "/admin/now")).body.tasksEnded;
    expect(ended).toMatchObject([
      { title: "Second", ending: "cleared", note: "starting" },
      { title: "Release", ending: "done", done: 3, total: 3 },
    ]);

    // A list that arrives as its own text is read as the list.
    expect((await call({ title: "Texted", steps: '["One", "Two"]' })).structuredContent).toMatchObject({ task: { total: 2, steps: 2 } });
    await call({ action: "clear" });
    expect(await call({ title: "Odd", steps: "one, two" })).toMatchObject({ isError: true });
    expect(await call({ title: "Odd", steps: [{ step: "One", status: "soon" }] })).toMatchObject({ isError: true });
    expect(await call({ title: "Odd", steps: Array.from({ length: 13 }, (_, i) => `Step ${i}`) })).toMatchObject({ isError: true });
  });

  it("puts a task that waits for the person first, counts the rest, and chimes once for finishes close together", async () => {
    const token = await newToken();
    const { client } = await ready(["screen"], { name: "Desk" });
    const call = async (args: Record<string, unknown>) => (await rpc(token, "tools/call", { name: "vortex_axis_progress", arguments: args })).body.result;
    const shown = async (from: number) => {
      const command = await client.next("command", from, (m) => m.name === "progress.show");
      client.send({ t: "command.result", id: command.id, ok: true });
      return command.params;
    };

    await call({ id: "a", title: "Backup", done: 1, total: 3 });
    await call({ id: "b", title: "Report", note: "which month?", state: "blocked" });
    let from = client.received.length;
    await call({ id: "c", title: "Build", note: "compiling" });
    // The newest is not on the line: the one that needs the person is, and the others are named for the list.
    expect(await shown(from)).toMatchObject({ title: "Report", state: "blocked", count: 3, others: " Build: compiling\n Backup 1/3" });

    from = client.received.length;
    await call({ id: "b", title: "Report", note: "writing" });
    expect(await shown(from)).toMatchObject({ title: "Report", state: "running", others: " Build: compiling\n Backup 1/3" });

    from = client.received.length;
    await call({ id: "a", state: "done" });
    expect(await shown(from)).toMatchObject({ title: "Backup", state: "done", chime: true });
    from = client.received.length;
    await call({ id: "c", state: "done" });
    expect(await shown(from)).not.toHaveProperty("chime");
    await call({ action: "clear" });
  });

  it("tells a screen that connects later what is going on", async () => {
    const token = await newToken();
    await rpc(token, "tools/call", { name: "vortex_axis_progress", arguments: { title: "Build", note: "tests", done: 2, total: 4 } });
    const { client } = await ready(["screen"], { name: "Late" });
    expect((await client.next("command", 0, (m) => m.name === "progress.show")).params).toMatchObject({ title: "Build", done: 2, total: 4, count: 1 });
  });
});

