import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { QuestApp } from "../src/questapp.js";
import { Store } from "../src/store.js";
import { admin, connect, ctx, newPairedClient, restart, useServer } from "./harness.js";

useServer();

const QUEST = { capabilities: ["desktop" as const], type: "meta-quest" };
/** What a headset still on the Quest app 0.2.0 says it is. */
const LEGACY = { capabilities: ["desktop" as const], type: "quest-panels" };

/** Puts a Quest app build in a data folder, as scripts/build-quest-client.sh does. */
function putBuild(root: string, version: string, body: Buffer | string) {
  mkdirSync(join(root, "quest"), { recursive: true });
  writeFileSync(join(root, "quest", "quest-client.apk"), body);
  writeFileSync(join(root, "quest", "version.json"), JSON.stringify({ version, builtAt: "2026-10-14T12:00:00Z" }));
}

describe("the Quest panel client's updates (experimental)", () => {
  it("has nothing to offer before a build is on the hub", async () => {
    expect((await admin("GET", "/admin/quest")).body).toEqual({ available: false });
    const identity = await newPairedClient({ ...QUEST, name: "Bare Quest" });
    const headset = await connect(identity, { ...QUEST, version: "0.2.0" });
    await headset.next("status");
    const res = await fetch(`${ctx.base}/v1/quest/app`, { headers: { authorization: `Bearer ${identity.token}`, "x-axis-client": identity.clientId } });
    expect(res.status).toBe(404);
    const told = await admin("POST", `/admin/clients/${identity.clientId}/update`);
    expect(told.status).toBe(409);
    expect(told.body.error).toMatch(/has not been built/);
    headset.close();
  });

  it("tells a headset behind the hub's build to update, unless switched off, and serves it the build to it alone", async () => {
    const apk = Buffer.from("not really an apk");
    putBuild(ctx.dataDir, "9.1.0", apk);
    const sha256 = createHash("sha256").update(apk).digest("hex");
    expect((await admin("GET", "/admin/quest")).body).toEqual({ available: true, size: apk.length, version: "9.1.0", sha256, builtAt: "2026-10-14T12:00:00Z" });

    const identity = await newPairedClient({ ...QUEST, name: "Old Quest" });
    const headset = await connect(identity, { ...QUEST, version: "0.2.0" });
    const update = await headset.next("command", 0, (m) => m.name === "update");
    expect(update.params).toEqual({ version: "9.1.0", size: apk.length, sha256, path: "/v1/quest/app" });
    headset.send({ t: "command.result", id: update.id, ok: true, payload: { version: "9.1.0" } });

    // The download: only with the headset's own token, only for a headset.
    expect((await fetch(`${ctx.base}/v1/quest/app`)).status).toBe(401);
    const res = await fetch(`${ctx.base}/v1/quest/app`, { headers: { authorization: `Bearer ${identity.token}`, "x-axis-client": identity.clientId } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(apk.length));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-sha256")).toBe(sha256);
    expect(Buffer.from(await res.arrayBuffer()).equals(apk)).toBe(true);
    const pc = await newPairedClient({ capabilities: ["desktop"], type: "windows-desktop", name: "A PC" });
    expect((await fetch(`${ctx.base}/v1/quest/app`, { headers: { authorization: `Bearer ${pc.token}`, "x-axis-client": pc.clientId } })).status).toBe(404);

    // The admin page's Update: the same command, carried back.
    const told = admin("POST", `/admin/clients/${identity.clientId}/update`);
    const again = await headset.next("command", 0, (m) => m.name === "update" && m.id !== update.id);
    expect(again.params).toMatchObject({ version: "9.1.0", path: "/v1/quest/app" });
    headset.send({ t: "command.result", id: again.id, ok: true });
    expect((await told).status).toBe(202);
    expect((await told).body).toMatchObject({ client: "Old Quest", from: "0.2.0", to: "9.1.0" });

    // A refusal comes back in the headset's words.
    const refused = admin("POST", `/admin/clients/${identity.clientId}/update`);
    const third = await headset.next("command", 0, (m) => m.name === "update" && m.id !== update.id && m.id !== again.id);
    headset.send({ t: "command.result", id: third.id, ok: false, error: "update failed: the download does not match its checksum" });
    expect((await refused).status).toBe(409);
    expect((await refused).body.error).toMatch(/checksum/);
    headset.close();

    // Switched off for a headset: not asked.
    const other = await newPairedClient({ ...QUEST, name: "Quiet Quest" });
    await admin("PATCH", `/admin/settings/device/${other.clientId}`, { values: { autoUpdate: 0 } });
    const quiet = await connect(other, { ...QUEST, version: "0.2.0" });
    await expect(quiet.next("command", 0, (m) => m.name === "update")).rejects.toThrow();
    quiet.close();
  });

  it("never offers an older or the same build, not even from the admin page", async () => {
    putBuild(ctx.dataDir, "0.2.0", "the same version");
    const identity = await newPairedClient({ ...QUEST, name: "New Quest" });
    const headset = await connect(identity, { ...QUEST, version: "0.3.0" });
    await expect(headset.next("command", 0, (m) => m.name === "update")).rejects.toThrow();
    const told = await admin("POST", `/admin/clients/${identity.clientId}/update`);
    expect(told.status).toBe(409);
    expect(told.body.error).toMatch(/never an older one/);
    headset.close();
  });

  it("offers the newer of the hub's own build and the image's", () => {
    const made = [mkdtempSync(join(tmpdir(), "axis-quest-")), mkdtempSync(join(tmpdir(), "axis-quest-"))];
    try {
      const [data, bundled] = made as [string, string];
      const app = new QuestApp(data, { onConnect: () => {}, sessions: () => [] } as never, () => {}, bundled);
      expect(app.build()).toBeUndefined();
      putBuild(bundled, "0.2.0", "from the image");
      expect(app.build()).toMatchObject({ version: "0.2.0", file: join(bundled, "quest", "quest-client.apk") });
      putBuild(data, "0.2.1", "built here");
      expect(app.build()).toMatchObject({ version: "0.2.1", file: join(data, "quest", "quest-client.apk"), size: 10 });
      writeFileSync(join(data, "quest", "version.json"), "{}");
      expect(app.build()?.version).toBe("0.2.1"); // cached while the APK is unchanged
    } finally {
      for (const d of made) rmSync(d, { recursive: true, force: true });
    }
  });

  it("takes a headset still on 0.2.0, which says quest-panels, as a meta-quest, and still updates it", async () => {
    const apk = Buffer.from("the 0.3.0 build");
    putBuild(ctx.dataDir, "0.3.0", apk);
    // Paired after the rename by an old app: kept under the new name.
    const fresh = await newPairedClient({ ...LEGACY, name: "Old App Quest" });
    // Paired before the rename: its record says quest-panels until Axis next starts.
    const before = await newPairedClient({ ...LEGACY, name: "Paired Long Ago" });
    await ctx.app.close();
    ctx.app = undefined as never;
    const db = new DatabaseSync(join(ctx.dataDir, "axis.sqlite"));
    db.prepare("UPDATE clients SET type = 'quest-panels' WHERE id = ?").run(before.clientId);
    db.prepare("INSERT INTO settings (scope, scope_id, key, value) VALUES ('type', 'quest-panels', 'allowScreenshot', '1')").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('type_label:quest-panels', 'Headsets')").run();
    db.close();
    await restart();

    const listed = (await admin("GET", "/admin/clients")).body;
    for (const id of [fresh.clientId, before.clientId]) {
      expect(listed.clients.find((c: { id: string }) => c.id === id).type).toBe("meta-quest");
    }
    const headset = await connect(before, { ...LEGACY, version: "0.2.0" });
    const settings = await headset.next("settings");
    expect(settings.values).toMatchObject({ allowScreenshot: 1 });
    const update = await headset.next("command", 0, (m) => m.name === "update");
    expect(update.params).toMatchObject({ version: "0.3.0", path: "/v1/quest/app" });
    headset.send({ t: "command.result", id: update.id, ok: true });
    const res = await fetch(`${ctx.base}/v1/quest/app`, { headers: { authorization: `Bearer ${before.token}`, "x-axis-client": before.clientId } });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(apk)).toBe(true);

    const after = (await admin("GET", "/admin/clients")).body;
    expect(after.clients.find((c: { id: string }) => c.id === before.clientId)).toMatchObject({ type: "meta-quest", version: "0.2.0", online: true });
    expect(Object.keys(after.types)).toContain("meta-quest");
    expect(Object.keys(after.types)).not.toContain("quest-panels");
    expect(after.types["meta-quest"]).toMatchObject({ label: "Headsets" });
    headset.close();
  });
});

describe("renaming a client type in the store", () => {
  it("moves clients, the type layer, the schema and the label, keeps the new name's rows when both exist, and does it once", () => {
    const dir = mkdtempSync(join(tmpdir(), "axis-rename-"));
    try {
      new Store(dir).close();
      const db = new DatabaseSync(join(dir, "axis.sqlite"));
      const add = db.prepare("INSERT INTO clients (id, name, type, capabilities, version, token_hash, created_at) VALUES (?, ?, ?, '[\"desktop\"]', '0.2.0', 'x', 0)");
      add.run("c1", "Quest", "quest-panels");
      add.run("c2", "Board", "esp32s3-speaker");
      const setting = db.prepare("INSERT INTO settings (scope, scope_id, key, value) VALUES ('type', ?, ?, ?)");
      setting.run("quest-panels", "allowLook", "0");
      setting.run("quest-panels", "autoUpdate", "0");
      setting.run("meta-quest", "autoUpdate", "1");
      const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      meta.run("schema:quest-panels", JSON.stringify({ settings: [], actions: [{ name: "old", label: "Old" }], links: [] }));
      meta.run("schema:meta-quest", JSON.stringify({ settings: [], actions: [{ name: "new", label: "New" }], links: [] }));
      meta.run("type_label:quest-panels", "My headsets");
      db.close();

      const store = new Store(dir);
      expect(store.getClient("c1")?.type).toBe("meta-quest");
      expect(store.getClient("c2")?.type).toBe("esp32s3-speaker");
      expect(store.getLayer("type", "meta-quest")).toEqual({ allowLook: 0, autoUpdate: 1 });
      expect(store.getLayer("type", "quest-panels")).toEqual({});
      expect(store.getSchema("meta-quest")?.actions.map((a) => a.name)).toEqual(["new"]);
      expect(store.getSchema("quest-panels")).toBeUndefined();
      expect(store.getMeta("type_label:meta-quest")).toBe("My headsets");
      expect(store.getMeta("type_label:quest-panels")).toBeUndefined();
      expect(store.renameTypes({ "quest-panels": "meta-quest" })).toBe(0);
      store.close();
      const again = new Store(dir);
      expect(again.getClient("c1")?.type).toBe("meta-quest");
      expect(again.getLayer("type", "meta-quest")).toEqual({ allowLook: 0, autoUpdate: 1 });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
