import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuestApp } from "../src/questapp.js";
import { admin, connect, ctx, newPairedClient, useServer } from "./harness.js";

useServer();

const QUEST = { capabilities: ["desktop" as const], type: "quest-panels" };

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
});
