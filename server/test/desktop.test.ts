import { describe, expect, it } from "vitest";
import { admin, connect, newPairedClient, useServer } from "./harness.js";

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

  it("asks which computer when there are several", async () => {
    await admin("PATCH", "/admin/mcp/tools", { vortex_axis_desktop: true });
    await computer("Desk PC");
    await computer("Laptop");
    expect((await tryTool({ action: "look" })).body.error).toMatch(/several computers.*say which/);
  });
});
