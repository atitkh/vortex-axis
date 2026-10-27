import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, admin, ctx, newPairedClient, restart, useServer } from "./harness.js";

useServer();

const folder = () => mkdtempSync(join(tmpdir(), "axis-backup-"));

describe("backup", () => {
  it("is off, and says so, when no folder is set up", async () => {
    expect((await admin("GET", "/admin/integrations")).body.backup).toMatchObject({ configured: false, last: null });
    expect((await admin("POST", "/admin/backup")).status).toBe(409);
  });

  it("copies the database whole, keeps a daily copy, and mirrors firmware and wake words", async () => {
    const backupDir = folder();
    await restart({ backupDir });
    await newPairedClient({ name: "Kitchen" });
    mkdirSync(join(ctx.dataDir, "firmware", "board"), { recursive: true });
    writeFileSync(join(ctx.dataDir, "firmware", "board", "1.0.0.bin"), "firmware bytes");
    mkdirSync(join(backupDir, "firmware"), { recursive: true });
    writeFileSync(join(backupDir, "firmware", "gone.bin"), "left from before");

    const made = await admin("POST", "/admin/backup");
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ configured: true, dir: backupDir, running: false, overdue: false, last: { ok: true, bytes: expect.any(Number) } });

    // The copy is a database in its own right, with the client in it.
    const copy = new DatabaseSync(join(backupDir, "axis.sqlite"), { readOnly: true });
    expect(copy.prepare("SELECT name FROM clients").all()).toEqual([{ name: "Kitchen" }]);
    copy.close();
    expect(readdirSync(join(backupDir, "daily"))).toEqual([`axis-${new Date().toISOString().slice(0, 10)}.sqlite`]);
    expect(readFileSync(join(backupDir, "firmware", "board", "1.0.0.bin"), "utf8")).toBe("firmware bytes");
    expect(existsSync(join(backupDir, "firmware", "gone.bin"))).toBe(false);
    // Nothing half-made is left behind, here or there.
    expect(readdirSync(backupDir).filter((name) => name.endsWith(".part"))).toEqual([]);
    expect(existsSync(join(ctx.dataDir, "axis-backup.tmp"))).toBe(false);
    // The result survives a restart.
    await restart({ backupDir });
    expect((await admin("GET", "/admin/integrations")).body.backup.last).toMatchObject({ ok: true });
    rmSync(backupDir, { recursive: true, force: true });
  });

  it("drops daily copies older than the days kept, and nothing else", async () => {
    const backupDir = folder();
    mkdirSync(join(backupDir, "daily"));
    for (const name of ["axis-2020-01-01.sqlite", "notes.txt"]) writeFileSync(join(backupDir, "daily", name), "old");
    await restart({ backupDir, backupKeepDays: 3 });
    await admin("POST", "/admin/backup");
    expect(readdirSync(join(backupDir, "daily")).sort()).toEqual([`axis-${new Date().toISOString().slice(0, 10)}.sqlite`, "notes.txt"].sort());
    rmSync(backupDir, { recursive: true, force: true });
  });

  it("says why when it fails, and puts it in the events", async () => {
    const backupDir = join(folder(), "a-file");
    writeFileSync(backupDir, "not a folder");
    await restart({ backupDir });
    const failed = await admin("POST", "/admin/backup");
    expect(failed.status).toBe(502);
    expect((await admin("GET", "/admin/integrations")).body.backup.last).toMatchObject({ ok: false, error: expect.any(String) });
    const { events } = (await admin("GET", "/admin/activity")).body;
    expect(events.find((e: any) => e.kind === "backup")).toMatchObject({ level: "bad", state: "failed" });
  });

  it("takes how often and how long to keep from the integrations page", async () => {
    const saved = await admin("PATCH", "/admin/integrations", { backupEveryHours: 6, backupKeepDays: 14 });
    expect(saved.body.settings).toMatchObject({ backupEveryHours: 6, backupKeepDays: 14 });
    expect((await admin("GET", "/admin/integrations")).body.backup).toMatchObject({ everyHours: 6, keepDays: 14 });
    expect((await admin("PATCH", "/admin/integrations", { backupEveryHours: 500 })).status).toBe(400);
  });
  it("hands the admin a fresh copy of the database to download, with or without a backup folder", async () => {
    await newPairedClient({ name: "Hall" });
    expect((await fetch(`${ctx.base}/admin/backup/download`)).status).toBe(401);
    const res = await fetch(`${ctx.base}/admin/backup/download`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="axis-\d{4}-\d{2}-\d{2}\.sqlite"$/);
    const dir = folder();
    writeFileSync(join(dir, "copy.sqlite"), Buffer.from(await res.arrayBuffer()));
    const copy = new DatabaseSync(join(dir, "copy.sqlite"), { readOnly: true });
    expect(copy.prepare("SELECT name FROM clients").all()).toEqual([{ name: "Hall" }]);
    copy.close();
    rmSync(dir, { recursive: true, force: true });
    // The copy made for it is gone once it has been sent.
    await expect.poll(() => readdirSync(tmpdir()).filter((name) => name.startsWith("axis-download-"))).toEqual([]);
  });
});
