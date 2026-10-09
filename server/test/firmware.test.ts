import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInvokeHandler } from "../src/commands.js";
import { ADMIN_TOKEN, admin, connect, ctx, newPairedClient, useServer } from "./harness.js";

useServer();

/** Something shaped like an ESP32 application image: the magic byte, then filler. */
function image(bytes = 80_000, fill = 7): Buffer {
  const data = Buffer.alloc(bytes, fill);
  data[0] = 0xe9;
  return data;
}

function upload(type: string, version: string, data: Buffer, token = ADMIN_TOKEN) {
  return fetch(`${ctx.base}/admin/firmware/${type}?version=${version}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: data,
  });
}

describe("firmware for updates over Wi-Fi", () => {
  it("keeps one build per client type and refuses what is not firmware", async () => {
    const data = image();
    const saved = await upload("board", "1.2.0", data);
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({
      type: "board",
      version: "1.2.0",
      size: data.length,
      md5: createHash("md5").update(data).digest("hex"),
    });
    expect((await upload("board", "1.3.0", image(90_000))).status).toBe(201);
    expect((await admin("GET", "/admin/firmware")).body.firmware).toMatchObject([{ type: "board", version: "1.3.0", size: 90_000 }]);

    expect((await upload("board", "1.4.0", Buffer.alloc(80_000))).status).toBe(400);
    expect((await upload("board", "1.4.0", image(1000))).status).toBe(400);
    expect((await upload("board", "", image())).status).toBe(400);
    expect((await upload("board", "1.4.0", image(), "wrong")).status).toBe(401);
    expect((await admin("DELETE", "/admin/firmware/board")).status).toBe(200);
    expect((await admin("GET", "/admin/firmware")).body.firmware).toEqual([]);
  });

  it("keeps earlier builds, lets one be made current again, downloaded and removed", async () => {
    await upload("board", "1.0.0", image(80_000, 1));
    await new Promise((r) => setTimeout(r, 5));
    await upload("board", "1.1.0", image(80_000, 2));
    let shelf = (await admin("GET", "/admin/firmware")).body.shelves[0];
    expect(shelf).toMatchObject({ type: "board", current: "1.1.0" });
    expect(shelf.builds.map((b: any) => b.version)).toEqual(["1.1.0", "1.0.0"]);

    // Going back: the older build becomes the one devices are sent.
    expect((await admin("PUT", "/admin/firmware/board/1.0.0/current")).body.current).toBe("1.0.0");
    expect((await admin("GET", "/admin/firmware")).body.firmware).toMatchObject([{ version: "1.0.0" }]);
    expect((await admin("PUT", "/admin/firmware/board/9.9.9/current")).status).toBe(404);

    const copy = await fetch(`${ctx.base}/admin/firmware/board/1.1.0`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(copy.headers.get("content-disposition")).toContain("board-1.1.0.bin");
    expect(Buffer.from(await copy.arrayBuffer()).equals(image(80_000, 2))).toBe(true);

    // Removing the current build hands the place to the newest one left.
    shelf = (await admin("DELETE", "/admin/firmware/board/1.0.0")).body;
    expect(shelf).toMatchObject({ current: "1.1.0" });
    expect(shelf.builds).toHaveLength(1);

    for (let i = 2; i < 9; i++) {
      await new Promise((r) => setTimeout(r, 3));
      await upload("board", `1.${i}.0`, image(70_000, i));
    }
    shelf = (await admin("GET", "/admin/firmware")).body.shelves[0];
    expect(shelf.builds.map((b: any) => b.version)).toEqual(["1.8.0", "1.7.0", "1.6.0", "1.5.0", "1.4.0"]);
  });

  it("hands a device its own type's build, and only with its token", async () => {
    const data = image();
    await upload("board", "1.2.0", data);
    const identity = await newPairedClient({ type: "board", capabilities: ["speaker"] });
    const get = (headers: Record<string, string>, type = "board") => fetch(`${ctx.base}/v1/firmware/${type}`, { headers });
    const own = { authorization: `Bearer ${identity.token}`, "x-axis-client": identity.clientId };

    const ok = await get(own);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-length")).toBe(String(data.length));
    expect(Buffer.from(await ok.arrayBuffer()).equals(data)).toBe(true);
    expect((await get({ ...own, authorization: "Bearer nope" })).status).toBe(401);
    expect((await get({})).status).toBe(401);
    expect((await get(own, "other")).status).toBe(404);
  });

  it("moves a device to another address, from the admin API only", async () => {
    const identity = await newPairedClient({ type: "board", capabilities: ["speaker"], name: "Desk" });
    const client = await connect(identity, { type: "board", capabilities: ["speaker"] });
    await client.next("status");
    const move = (address: unknown) => admin("POST", `/admin/clients/${identity.clientId}/address`, { address });

    for (const bad of ["", "ftp://x", "https://axis.example.org/path", "https://user@axis.example.org", "http://"]) {
      expect((await move(bad)).status).toBe(400);
    }
    const asked = move("https://Axis.Example.org/");
    const command = await client.next("command", 0, (m) => m.name === "address");
    expect(command.params).toEqual({ url: "https://axis.example.org" });
    client.send({ t: "command.result", id: command.id, ok: true });
    expect(await asked).toMatchObject({ status: 202, body: { client: "Desk", address: "https://axis.example.org" } });

    // A device that lists the command as one of its actions still cannot have an agent run it.
    client.send({ t: "describe", settings: [], actions: [{ name: "address", label: "Move" }, { name: "chime", label: "Chime" }], links: [] });
    const { hub, store, timers } = ctx.app;
    const invoke = createInvokeHandler({ hub, store, timers, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 });
    for (let i = 0; i < 40 && !store.getSchema("board")?.actions.length; i++) await new Promise((r) => setTimeout(r, 25));
    await expect(invoke("vortex.axis.admin", { action: "run", client: "Desk", run: "address" })).rejects.toThrow(/does not offer "address"/);
    const listed = (await invoke("vortex.axis.admin", { action: "actions", client: "Desk" })) as any;
    expect(listed.clients[0].actions.map((a: any) => a.name)).not.toContain("address");
  });

  it("resets a device and forgets it, and leaves it alone when it cannot reset itself", async () => {
    const identity = await newPairedClient({ type: "board", capabilities: ["speaker"], name: "Desk" });
    const client = await connect(identity, { type: "board", capabilities: ["speaker"] });
    await client.next("status");

    const refused = admin("POST", `/admin/clients/${identity.clientId}/reset`, { wifi: true });
    const first = await client.next("command", 0, (m) => m.name === "reset");
    expect(first.params).toEqual({ wifi: 1 });
    client.send({ t: "command.result", id: first.id, ok: false, error: "not implemented on this device" });
    expect((await refused).status).toBe(409);
    expect((await admin("GET", `/admin/clients/${identity.clientId}`)).status).toBe(200);

    const asked = admin("POST", `/admin/clients/${identity.clientId}/reset`, {});
    const second = await client.next("command", 0, (m) => m.name === "reset" && m.id !== first.id);
    expect(second.params).toEqual({ wifi: 0 });
    client.send({ t: "command.result", id: second.id, ok: true });
    expect(await asked).toMatchObject({ status: 200, body: { reset: "Desk", wifi: false } });
    expect((await admin("GET", "/admin/clients")).body.clients).toEqual([]);
  });

  it("tells a connected device to update, and says so when it cannot", async () => {
    const identity = await newPairedClient({ type: "board", capabilities: ["speaker"], name: "Desk" });
    const client = await connect(identity, { type: "board", capabilities: ["speaker"] });
    await client.next("status");
    expect((await admin("POST", `/admin/clients/${identity.clientId}/update`)).status).toBe(404);

    const data = image();
    await upload("board", "1.2.0", data);
    const asked = admin("POST", `/admin/clients/${identity.clientId}/update`);
    const command = await client.next("command", 0, (m) => m.name === "update");
    expect(command.params).toEqual({
      version: "1.2.0",
      size: data.length,
      md5: createHash("md5").update(data).digest("hex"),
      path: "/v1/firmware/board",
    });
    client.send({ t: "command.result", id: command.id, ok: true });
    expect(await asked).toMatchObject({ status: 202, body: { client: "Desk", to: "1.2.0" } });

    const again = admin("POST", `/admin/clients/${identity.clientId}/update`);
    const second = await client.next("command", 0, (m) => m.name === "update" && m.id !== command.id);
    client.send({ t: "command.result", id: second.id, ok: false, error: "not implemented on this device" });
    const refused = await again;
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/cable/);
  });
});
