import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, admin, ctx, restart, useServer } from "./harness.js";

useServer();

const image = (fill: number, size = 70 * 1024) => Buffer.concat([Buffer.from([0xe9]), Buffer.alloc(size, fill)]);
const upload = (path: string, body: Buffer) =>
  fetch(`${ctx.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, body });

describe("the flasher page", () => {
  it("installs what is on the hub's own shelf, once a factory image is there", async () => {
    // A flasher folder of our own, so the test does not need the installer fetched from npm.
    const dir = mkdtempSync(join(tmpdir(), "axis-flasher-"));
    mkdirSync(join(dir, "esp-web-tools"));
    writeFileSync(join(dir, "index.html"), "<h1>Flash</h1>");
    writeFileSync(join(dir, "flash.js"), "// page");
    writeFileSync(join(dir, "esp-web-tools", "install-button.js"), "// installer");
    await restart({ flasherDir: dir });
    try {
      const get = (path: string) => fetch(`${ctx.base}${path}`, { redirect: "manual" });
      expect((await get("/flash")).headers.get("location")).toBe("/flash/");
      const page = await get("/flash/");
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await (await get("/flash/esp-web-tools/install-button.js")).text()).toBe("// installer");
      expect((await get("/flash/esp-web-tools/..%2Findex.html")).status).toBe(404);
      expect((await get("/flash/nope.js")).status).toBe(404);

      // Nothing to install yet.
      expect((await get("/flash/manifest.json")).status).toBe(404);
      // A factory image needs its build on the shelf first.
      expect((await upload("/admin/firmware/board?version=1.2.0&part=factory", image(2))).status).toBe(400);
      expect((await upload("/admin/firmware/board?version=1.2.0", image(1))).status).toBe(201);
      // The build alone is not enough for a new board.
      expect((await get("/flash/manifest.json")).status).toBe(404);
      const factory = image(2, 200 * 1024);
      expect((await upload("/admin/firmware/board?version=1.2.0&part=factory", factory)).status).toBe(201);

      const manifest = await (await get("/flash/manifest.json")).json();
      expect(manifest).toMatchObject({ name: "board", version: "1.2.0", builds: [{ chipFamily: "ESP32-S3", parts: [{ path: "firmware/board.bin", offset: 0 }] }] });
      const got = Buffer.from(await (await get("/flash/firmware/board.bin")).arrayBuffer());
      expect(got.equals(factory)).toBe(true);
      expect((await get("/flash/firmware/other.bin")).status).toBe(404);

      // A second kind of board: the page is told both, and each has its own manifest.
      expect(await (await get("/flash/types.json")).json()).toEqual([{ type: "board", name: "board", version: "1.2.0", manifest: "manifest.json?type=board" }]);
      expect((await upload("/admin/firmware/round?version=0.1.0", image(3))).status).toBe(201);
      expect((await upload("/admin/firmware/round?version=0.1.0&part=factory", image(4, 200 * 1024))).status).toBe(201);
      const types = (await (await get("/flash/types.json")).json()) as { type: string; manifest: string }[];
      expect(types.map((t) => t.type).sort()).toEqual(["board", "round"]);
      const round = await (await get(`/flash/${types.find((t) => t.type === "round")!.manifest}`)).json();
      expect(round).toMatchObject({ version: "0.1.0", builds: [{ parts: [{ path: "firmware/round.bin" }] }] });
      expect((await admin("DELETE", "/admin/firmware/round/0.1.0")).status).toBe(200);

      // Removing the build takes its factory image with it.
      expect((await admin("DELETE", "/admin/firmware/board/1.2.0")).status).toBe(200);
      expect((await get("/flash/manifest.json")).status).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
