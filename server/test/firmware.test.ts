import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
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
