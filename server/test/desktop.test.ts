import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newer } from "../src/desktopapp.js";
import { admin, connect, ctx, newPairedClient, useServer } from "./harness.js";

useServer();

/** A computer with the desktop app, answering the way the app does. */
async function computer(name: string) {
  const identity = await newPairedClient({ capabilities: ["desktop"], type: "windows-desktop", name });
  const client = await connect(identity, { capabilities: ["desktop"], type: "windows-desktop" });
  await client.next("status");
  return client;
}

const tryTool = (args: Record<string, unknown>) => admin("POST", "/admin/mcp/tools/try", { name: "vortex_axis_desktop", arguments: args });

describe("the desktop tool (experimental)", () => {
  it("is off until an admin switches it on, and never goes on the node", async () => {
    const { body } = await admin("GET", "/admin/mcp");
    const tool = body.tools.find((t: any) => t.name === "vortex_axis_desktop");
    expect(tool).toMatchObject({ enabled: false });
    expect((await tryTool({ action: "look" })).body.error).toMatch(/switched off/);
    expect((await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true })).status).toBe(200);
    expect((await admin("GET", "/admin/mcp")).body.tools.find((t: any) => t.name === "vortex_axis_desktop")).toMatchObject({ enabled: true });
  });

  it("asks the computer what is on its screen and has it point, carrying the answer back as it came", async () => {
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true });
    expect((await tryTool({ action: "look" })).body.error).toMatch(/no computer is connected/);

    const pc = await computer("Desk PC");
    const looking = tryTool({ action: "look", scope: "mouse" });
    const look = await pc.next("command");
    expect(look).toMatchObject({ name: "desktop.look", params: { scope: "mouse", ocr: false } });
    const elements = [{ id: 1, kind: "button", name: "Send", x: 900, y: 600, w: 80, h: 30 }];
    pc.send({ t: "command.result", id: look.id, ok: true, data: { window: { title: "Chat" }, elements } });
    const looked = (await looking).body;
    expect(looked.result).toMatchObject({ computer: "Desk PC", window: { title: "Chat" }, elements });

    const pointing = tryTool({ action: "point", id: 1, text: "This one" });
    const point = await pc.next("command", 0, (m) => m.name === "desktop.point");
    expect(point).toMatchObject({ name: "desktop.point", params: { id: 1, text: "This one" } });
    pc.send({ t: "command.result", id: point.id, ok: true, payload: { x: 940, y: 615 } });
    expect((await pointing).body.result).toMatchObject({ computer: "Desk PC", pointed: true, x: 940 });

    // An element the app no longer knows is its refusal, passed on.
    const stale = tryTool({ action: "point", id: 7 });
    const again = await pc.next("command", 0, (m) => m.name === "desktop.point" && m.params?.id === 7);
    pc.send({ t: "command.result", id: again.id, ok: false, error: "no element 7 in the last look" });
    expect((await stale).body.error).toMatch(/no element 7/);
    expect((await tryTool({ action: "point" })).body.error).toMatch(/needs an id/);
  });

  it("clicks, types and presses keys, and refuses all three when they are switched off for the computer", async () => {
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true });
    const pc = await computer("Desk PC");
    const answer = async (name: string, reply: Record<string, unknown>, match: (m: any) => boolean = () => true) => {
      const asked = await pc.next("command", 0, (m) => m.name === name && match(m));
      pc.send({ t: "command.result", id: asked.id, ok: true, ...reply });
      return asked;
    };

    const clicking = tryTool({ action: "click", id: 3, button: "double" });
    expect((await answer("desktop.click", { payload: { x: 10, y: 20, how: "mouse" } })).params).toEqual({ id: 3, button: "double" });
    expect((await clicking).body.result).toMatchObject({ computer: "Desk PC", done: "click", how: "mouse" });

    const typing = tryTool({ action: "type", text: "on my way" });
    expect((await answer("desktop.type", { payload: { typed: 9 } })).params).toEqual({ text: "on my way" });
    expect((await typing).body.result).toMatchObject({ done: "type", typed: 9 });

    const pressing = tryTool({ action: "keys", keys: "enter" });
    expect((await answer("desktop.keys", { payload: { pressed: "enter" } })).params).toEqual({ keys: "enter" });
    expect((await pressing).body.result).toMatchObject({ done: "keys", pressed: "enter" });

    expect((await tryTool({ action: "type", text: "x".repeat(501) })).body.error).toMatch(/at most 500/);
    expect((await tryTool({ action: "click", button: "middle", x: 1, y: 1 })).body.error).toMatch(/left, right or double/);

    // Switched off on the computer's page: refused by Axis before the computer hears of it.
    const { body } = await admin("GET", "/admin/clients");
    const id = body.clients.find((c: any) => c.name === "Desk PC").id;
    await admin("PATCH", `/admin/settings/device/${id}`, { values: { allowInput: 0 } });
    expect((await tryTool({ action: "click", x: 5, y: 5 })).body.error).toMatch(/switched off for Desk PC/);
    expect((await tryTool({ action: "keys", keys: "enter" })).body.error).toMatch(/switched off/);
  });

  it("acts by name, runs steps in one call, and checks the presets before the computer hears of them", async () => {
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true });
    const pc = await computer("Desk PC");
    const answer = async (name: string, reply: Record<string, unknown>) => {
      const asked = await pc.next("command", 0, (m) => m.name === name);
      pc.send({ t: "command.result", id: asked.id, ok: true, ...reply });
      return asked;
    };
    // Asking first is tested on its own, below.
    const { body } = await admin("GET", "/admin/clients");
    await admin("PATCH", `/admin/settings/device/${body.clients.find((c: any) => c.name === "Desk PC").id}`, { values: { confirmRisky: 0 } });

    const clicking = tryTool({ action: "click", name: "Send", kind: "button" });
    expect((await answer("desktop.click", { payload: { how: "invoked", name: "Send" } })).params).toEqual({ name: "Send", kind: "button", button: "left" });
    expect((await clicking).body.result).toMatchObject({ done: "click", how: "invoked" });

    const typing = tryTool({ action: "type", into: "Message", text: "hi" });
    expect((await answer("desktop.type", { payload: { typed: 2 } })).params).toEqual({ text: "hi", name: "Message" });
    await typing;

    const opening = tryTool({ action: "open", app: "Spotify" });
    expect((await answer("desktop.open", { payload: { opened: "Spotify" } })).params).toEqual({ app: "Spotify" });
    expect((await opening).body.result).toMatchObject({ opened: "Spotify" });
    expect((await tryTool({ action: "open", url: "file:///C:/Windows" })).body.error).toMatch(/http/);
    expect((await tryTool({ action: "open", app: "x", url: "https://a.example" })).body.error).toMatch(/one of them/);
    expect((await tryTool({ action: "window", do: "close" })).body.error).toMatch(/minimize, maximize, restore or move/);
    expect((await tryTool({ action: "window", do: "move" })).body.error).toMatch(/display/);

    // Several steps go as one command, with the steps as structured data; a failed step comes back as a report, not an error.
    const stepping = tryTool({ action: "steps", steps: [{ action: "switch", window: "Discord" }, { action: "click", name: "Message" }, { action: "type", text: "on my way" }, { action: "keys", keys: "enter" }] });
    const steps = await pc.next("command", 0, (m) => m.name === "desktop.steps");
    expect(steps.data).toEqual({ steps: [
      { action: "switch", window: "Discord" },
      { action: "click", name: "Message", button: "left" },
      { action: "type", text: "on my way" },
      { action: "keys", keys: "enter" },
    ] });
    pc.send({ t: "command.result", id: steps.id, ok: false, error: "step 2 (click) failed: nothing called Message", data: { steps: [{ action: "switch", ok: true }, { action: "click", ok: false, error: "nothing called Message" }], done: 1, failed: 2 } });
    expect((await stepping).body.result).toMatchObject({ done: 1, failed: 2 });
    expect((await tryTool({ action: "steps", steps: [{ action: "look" }] })).body.error).toMatch(/step 1: action must be one of/);
    expect((await tryTool({ action: "steps", steps: Array(11).fill({ action: "wait" }) })).body.error).toMatch(/at most 10/);
  });

  it("asks which computer when there are several", async () => {
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true });
    await computer("Desk PC");
    await computer("Laptop");
    expect((await tryTool({ action: "look" })).body.error).toMatch(/several computers.*say which/);
  });
  it("scrolls, waits for things, reads the clipboard and pastes long text as data", async () => {
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true });
    const pc = await computer("Desk PC");
    const answered = new Set<string>();
    const answer = async (name: string, reply: Record<string, unknown>) => {
      const asked = await pc.next("command", 0, (m) => m.name === name && !answered.has(m.id));
      answered.add(asked.id);
      pc.send({ t: "command.result", id: asked.id, ok: true, ...reply });
      return asked;
    };

    const scrolling = tryTool({ action: "scroll", go: "bottom", name: "Results" });
    expect((await answer("desktop.scroll", { payload: { scrolled: "bottom", how: "scrolled" } })).params).toEqual({ go: "bottom", pages: 1, name: "Results" });
    expect((await scrolling).body.result).toMatchObject({ done: "scroll", how: "scrolled" });
    expect((await tryTool({ action: "scroll", go: "sideways" })).body.error).toMatch(/up, down, left, right, top or bottom/);

    const waiting = tryTool({ action: "wait", name: "Save", seconds: 99 });
    expect((await answer("desktop.wait", { payload: { waited: 800 } })).params).toEqual({ name: "Save", seconds: 20 });
    expect((await waiting).body.result).toMatchObject({ done: "wait", waited: 800 });
    const going = tryTool({ action: "wait", window: "Installer", gone: true });
    expect((await answer("desktop.wait", { payload: { waited: 10 } })).params).toEqual({ window: "Installer", gone: 1, seconds: 10 });
    await going;

    // A fixed pause is cut to a second and the answer says not to bother; waits for a name carry no such note.
    const pausing = tryTool({ action: "wait", ms: 3000 });
    expect((await answer("desktop.wait", { payload: {} })).params).toEqual({ ms: 1000 });
    const paused = (await pausing).body.result as Record<string, unknown>;
    expect(paused).toMatchObject({ done: "wait" });
    expect(String(paused.hint)).toMatch(/paused 1000 ms.*wait with name/);
    expect(((await waiting).body.result as Record<string, unknown>).hint).toBeUndefined();

    const reading = tryTool({ action: "clipboard" });
    await answer("desktop.clipboard", { data: { clipboard: "copied" } });
    expect((await reading).body.result).toEqual({ computer: "Desk PC", clipboard: "copied" });

    const long = "x".repeat(5000);
    const pasting = tryTool({ action: "paste", text: long, into: "Message" });
    const paste = await answer("desktop.paste", { payload: { pasted: 5000 } });
    expect(paste.params).toEqual({ name: "Message" });
    expect(paste.data).toEqual({ text: long });
    expect((await pasting).body.result).toMatchObject({ done: "paste", pasted: 5000 });
    expect((await tryTool({ action: "paste", text: "y".repeat(20_001) })).body.error).toMatch(/at most 20000/);
  });

  it("tells a computer behind the hub's build to update, unless switched off, and serves it the build", async () => {
    expect(newer("0.6.0", "0.5.10")).toBe(true);
    expect(newer("0.5.10", "0.6.0")).toBe(false);
    expect(newer("0.6.0", "0.6.0")).toBe(false);
    const exe = Buffer.from("not really an exe");
    mkdirSync(join(ctx.dataDir, "desktop"), { recursive: true });
    writeFileSync(join(ctx.dataDir, "desktop", "VortexAxisDesktop.exe"), exe);
    writeFileSync(join(ctx.dataDir, "desktop", "version.json"), JSON.stringify({ version: "9.0.0" }));

    const identity = await newPairedClient({ capabilities: ["desktop"], type: "windows-desktop", name: "Old PC" });
    const pc = await connect(identity, { capabilities: ["desktop"], type: "windows-desktop" });
    const update = await pc.next("command", 0, (m) => m.name === "update");
    const sha256 = createHash("sha256").update(exe).digest("hex");
    expect(update.params).toEqual({ version: "9.0.0", size: exe.length, sha256, path: "/v1/desktop/app" });
    pc.send({ t: "command.result", id: update.id, ok: true });

    // The download: only with the computer's own token.
    expect((await fetch(`${ctx.base}/v1/desktop/app`)).status).toBe(401);
    const res = await fetch(`${ctx.base}/v1/desktop/app`, { headers: { authorization: `Bearer ${identity.token}`, "x-axis-client": identity.clientId } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-sha256")).toBe(sha256);
    expect(Buffer.from(await res.arrayBuffer()).equals(exe)).toBe(true);

    // Switched off for a computer: not asked.
    const other = await newPairedClient({ capabilities: ["desktop"], type: "windows-desktop", name: "Quiet PC" });
    await admin("PATCH", `/admin/settings/device/${other.clientId}`, { values: { autoUpdate: 0 } });
    const quiet = await connect(other, { capabilities: ["desktop"], type: "windows-desktop" });
    await expect(quiet.next("command", 0, (m) => m.name === "update")).rejects.toThrow();
  });
  it("tells the screens near a computer while an agent is using it, and lists it on the admin page", async () => {
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true });
    const boardId = await newPairedClient({ capabilities: ["screen", "speaker", "mic"], type: "waveshare-amoled-1.8", name: "Desk board" });
    const board = await connect(boardId, { capabilities: ["screen", "speaker", "mic"], type: "waveshare-amoled-1.8" });
    await board.next("status");
    const pc = await computer("Desk PC");
    const pressing = tryTool({ action: "keys", keys: "ctrl+s" });
    const asked = await pc.next("command", 0, (m) => m.name === "desktop.keys");
    const busy = await board.next("command", 0, (m) => m.name === "desktop.busy");
    expect(busy.params).toEqual({ on: 1, computer: "Desk PC" });
    board.send({ t: "command.result", id: busy.id, ok: true });
    // The computer itself is not told: it knows.
    await expect(pc.next("command", 0, (m) => m.name === "desktop.busy")).rejects.toThrow();
    pc.send({ t: "command.result", id: asked.id, ok: true, payload: { pressed: "ctrl+s" } });
    await pressing;
    const now = (await admin("GET", "/admin/now")).body;
    expect(now.computers).toEqual([expect.objectContaining({ computer: "Desk PC", last: "keys ctrl+s" })]);
  });
});

describe("dragging, the block list and asking before risky actions", () => {
  async function setUp() {
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true });
    const pc = await computer("Desk PC");
    const answer = async (name: string, reply: Record<string, unknown>, match: (m: any) => boolean = () => true) => {
      const asked = await pc.next("command", 0, (m) => m.name === name && match(m));
      pc.send({ t: "command.result", id: asked.id, ok: true, ...reply });
      return asked;
    };
    return { pc, answer };
  }

  it("drags from a name, id or point to another, with a hold, and says what is missing", async () => {
    const { answer } = await setUp();
    const dragging = tryTool({ action: "drag", name: "Report.pdf", toName: "Archive", holdMs: 500 });
    expect((await answer("desktop.drag", { payload: { how: "mouse" } })).params).toEqual({ name: "Report.pdf", toName: "Archive", holdMs: 500 });
    expect((await dragging).body.result).toMatchObject({ done: "drag", how: "mouse" });
    const byPoint = tryTool({ action: "drag", x: 10, y: 20, toX: 300, toY: 40 });
    expect((await answer("desktop.drag", {}, (m) => m.params.x === 10)).params).toEqual({ x: 10, y: 20, toX: 300, toY: 40 });
    await byPoint;
    expect((await tryTool({ action: "drag", toName: "Archive" })).body.error).toMatch(/needs where from/);
    expect((await tryTool({ action: "drag", id: 3 })).body.error).toMatch(/needs where to/);
    expect((await tryTool({ action: "drag", id: 3, toId: 4, holdMs: 5000 })).body.error).toMatch(/holdMs must be 0 to 2000/);
    expect((await tryTool({ action: "steps", steps: [{ action: "drag", id: 1 }] })).body.error).toMatch(/step 1 \(drag\): drag needs where to/);
  });

  it("keeps blocked apps out: refused by name, not read, passed to the computer", async () => {
    const { answer } = await setUp();
    expect((await admin("PATCH", "/admin/integrations", { desktopBlocked: "Bank, KeePass" })).status).toBe(200);
    expect((await admin("PATCH", "/admin/integrations", { desktopBlocked: ["x"] })).status).toBe(400);
    expect((await tryTool({ action: "switch", window: "KeePassXC" })).body.error).toMatch(/blocked by the user/);
    expect((await tryTool({ action: "steps", steps: [{ action: "open", app: "My Bank" }] })).body.error).toMatch(/step 1 \(open\): My Bank is blocked/);

    const looking = tryTool({ action: "look" });
    expect((await answer("desktop.look", { data: { window: "Online Bank - Edge (msedge) 0,0 800x600", elements: ["1 text 0,0 10x10 balance"] } })).params).toMatchObject({ blocked: "bank|keepass" });
    const refused = (await looking).body.error;
    expect(refused).toMatch(/blocked by the user \(it matches "bank"\)/);
    expect(refused).not.toMatch(/balance/);

    const screen = tryTool({ action: "look", scope: "screen" });
    await answer("desktop.look", { data: { window: "Notepad", windows: ["Notepad", "Online Bank - Edge"] } }, (m) => m.params.scope === "screen");
    expect((await screen).body.result.windows).toEqual(["Notepad", "blocked by the user"]);

    const clicking = tryTool({ action: "click", x: 1, y: 1 });
    await answer("desktop.click", { data: { after: { window: "KeePass", focus: "password" } } });
    expect((await clicking).body.result.after).toEqual({ window: "blocked by the user" });
    await admin("PATCH", "/admin/integrations", { desktopBlocked: [] });
  });

  it("asks the person before a risky click or Enter, and does it only on Allow", async () => {
    const { pc, answer } = await setUp();
    const phone = await connect(await newPairedClient({ capabilities: ["screen"], name: "Phone" }), { capabilities: ["screen"] });
    await phone.next("status");
    const looking = tryTool({ action: "look" });
    await answer("desktop.look", { data: { window: "Inbox - Mail", elements: ["1 button 900,600 80x30 Send", "2 button 10,10 80x30 Search"] } });
    await looking;

    // Not risky: no question.
    const search = tryTool({ action: "click", id: 2 });
    await answer("desktop.click", {}, (m) => m.params.id === 2);
    expect((await search).body.result.confirmed).toBeUndefined();

    // Allowed: done once, and the answer says so.
    const sending = tryTool({ action: "click", id: 1 });
    const question = await phone.next("ask");
    expect(question).toMatchObject({ question: expect.stringMatching(/May the agent click "Send" in Inbox - Mail on Desk PC\?/), choices: ["Allow", "Deny"] });
    phone.send({ t: "answer", askId: question.askId, choice: "Allow" });
    await answer("desktop.click", {}, (m) => m.params.id === 1);
    expect((await sending).body.result.confirmed).toMatch(/allowed: click "Send"/);

    // Declined: the computer never hears of it. Enter in a mail window, and a click at the Send button's spot, ask too.
    const pressing = tryTool({ action: "keys", keys: "ctrl+enter" });
    const asked = await phone.next("ask", 0, (m) => m.askId !== question.askId);
    expect(asked.question).toMatch(/press ctrl\+enter in Inbox - Mail/);
    phone.send({ t: "answer", askId: asked.askId, choice: "Deny" });
    expect((await pressing).body.error).toMatch(/the user declined/);
    const steps = tryTool({ action: "steps", steps: [{ action: "type", text: "hi" }, { action: "click", x: 905, y: 610 }] });
    const third = await phone.next("ask", 0, (m) => m.askId !== question.askId && m.askId !== asked.askId);
    expect(third.question).toMatch(/click "Send"/);
    phone.send({ t: "answer", askId: third.askId, choice: "Deny" });
    expect((await steps).body.error).toMatch(/the user declined/);
    expect(pc.received.some((m: any) => m.name === "desktop.keys" || m.name === "desktop.steps")).toBe(false);

    // Switched off for the computer: no question.
    const { body } = await admin("GET", "/admin/clients");
    await admin("PATCH", `/admin/settings/device/${body.clients.find((c: any) => c.name === "Desk PC").id}`, { values: { confirmRisky: 0 } });
    const unasked = tryTool({ action: "click", name: "Delete" });
    await answer("desktop.click", {}, (m) => m.params.name === "Delete");
    expect((await unasked).body.result.done).toBe("click");
  });
});
