import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, admin, connect, ctx, newPairedClient, useServer } from "./harness.js";

useServer();

/** Something shaped like a TensorFlow Lite model: the tag at offset 4, then filler. */
function model(bytes = 8000, fill = 3): Buffer {
  const data = Buffer.alloc(bytes, fill);
  data.write("TFL3", 4, "latin1");
  return data;
}

function upload(name: string, data: Buffer, extra = "cutoff=87&window=5") {
  return fetch(`${ctx.base}/admin/wakewords?name=${encodeURIComponent(name)}&${extra}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/octet-stream" },
    body: data,
  });
}

async function micDevice(name: string) {
  const identity = await newPairedClient({ type: "board", capabilities: ["mic", "speaker"], name });
  const client = await connect(identity, { type: "board", capabilities: ["mic", "speaker"] });
  await client.next("status");
  return { identity, client };
}

describe("wake words", () => {
  it("keeps one model per phrase, and refuses what is not one", async () => {
    const saved = await upload("Hey Vortex", model());
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ id: "hey-vortex", name: "Hey Vortex", cutoff: 87, window: 5, size: 8000 });
    // The same phrase again replaces it: there is no history.
    expect((await upload("hey vortex", model(9000), "cutoff=90&window=4")).status).toBe(201);
    expect((await admin("GET", "/admin/wakewords")).body.wakeWords).toMatchObject([{ id: "hey-vortex", cutoff: 90, window: 4, size: 9000 }]);

    expect((await upload("Bad", Buffer.alloc(8000))).status).toBe(400);
    expect((await upload("Bad", model(), "cutoff=20&window=5")).status).toBe(400);
    expect((await upload("  ", model())).status).toBe(400);
    expect((await upload("Built in", model())).status).toBe(400);

    expect((await admin("PATCH", "/admin/wakewords/hey-vortex", { cutoff: 80 })).body).toMatchObject({ cutoff: 80, window: 4 });
    expect((await admin("PATCH", "/admin/wakewords/hey-vortex", { cutoff: 10 })).status).toBe(400);
    expect((await admin("DELETE", "/admin/wakewords/hey-vortex")).status).toBe(200);
    expect((await admin("GET", "/admin/wakewords")).body.wakeWords).toEqual([]);
  });

  it("offers the stored ones as the choices of the wake word setting, and tells devices which is theirs", async () => {
    const { identity, client } = await micDevice("Desk");
    // On connect, with nothing chosen: the firmware's own.
    expect((await client.next("command", 0, (m) => m.name === "wake.model")).params).toEqual({ id: "" });

    const data = model();
    await upload("Computer", data);
    const types = (await admin("GET", "/admin/clients")).body.types;
    expect(types.board.settings.find((s: any) => s.key === "wakeWord").options).toEqual(["built-in", "computer"]);
    expect((await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { wakeWord: "nothing-like-it" } })).status).toBe(400);

    const before = client.received.length;
    expect((await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { wakeWord: "computer" } })).status).toBe(200);
    const told = await client.next("command", before, (m) => m.name === "wake.model");
    expect(told.params).toMatchObject({ id: "computer", name: "Computer", size: data.length, cutoff: 87, window: 5, path: "/v1/wakewords/computer" });
    expect((await admin("GET", "/admin/wakewords")).body.wakeWords[0].usedBy).toEqual(["Desk"]);

    // The device fetches it with its own token.
    const own = { authorization: `Bearer ${identity.token}`, "x-axis-client": identity.clientId };
    const file = await fetch(`${ctx.base}/v1/wakewords/computer`, { headers: own });
    expect(Buffer.from(await file.arrayBuffer()).equals(data)).toBe(true);
    expect((await fetch(`${ctx.base}/v1/wakewords/computer`)).status).toBe(401);

    // Removing the model sends the device back to its own.
    const mark = client.received.length;
    await admin("DELETE", "/admin/wakewords/computer");
    expect((await client.next("command", mark, (m) => m.name === "wake.model")).params).toEqual({ id: "" });
  });
});
