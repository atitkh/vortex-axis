import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importBundledFirmware } from "../src/bundled.js";
import { DesktopApp } from "../src/desktopapp.js";
import { FirmwareStore } from "../src/firmware.js";

const made: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "axis-bundled-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Something that passes for an ESP32 application image. */
const image = (fill: number) => Buffer.concat([Buffer.from([0xe9]), Buffer.alloc(70 * 1024, fill)]);

describe("what a release image comes with", () => {
  it("puts its firmware on the shelf only when newer than every build there", () => {
    const bundled = dir(), data = dir();
    mkdirSync(join(bundled, "firmware"));
    writeFileSync(join(bundled, "firmware", "board.bin"), image(1));
    writeFileSync(join(bundled, "firmware", "manifest.json"), JSON.stringify([{ type: "board", version: "0.18.2", file: "board.bin" }]));
    const store = new FirmwareStore(data);
    const log: string[] = [];

    expect(importBundledFirmware(bundled, store, (l) => log.push(l))).toEqual(["board 0.18.2"]);
    expect(store.info("board")?.version).toBe("0.18.2");
    // Its factory image comes along when the image has one, also for a build already on the shelf.
    expect(store.factory("board")).toBeUndefined();
    writeFileSync(join(bundled, "firmware", "board.factory.bin"), image(3));
    writeFileSync(join(bundled, "firmware", "manifest.json"), JSON.stringify([{ type: "board", version: "0.18.2", file: "board.bin", factory: "board.factory.bin" }]));
    expect(importBundledFirmware(bundled, store, () => {})).toEqual([]);
    expect(store.factory("board")).toMatchObject({ version: "0.18.2" });
    // Again: already there.
    expect(importBundledFirmware(bundled, store, () => {})).toEqual([]);
    // Somebody uploaded a newer one by hand: the image's older one stays out.
    store.save("board", "0.19.0", image(2));
    writeFileSync(join(bundled, "firmware", "manifest.json"), JSON.stringify([{ type: "board", version: "0.18.9", file: "board.bin" }]));
    expect(importBundledFirmware(bundled, store, () => {})).toEqual([]);
    expect(store.info("board")?.version).toBe("0.19.0");
    // A file name that leaves the folder is ignored.
    writeFileSync(join(bundled, "firmware", "manifest.json"), JSON.stringify([{ type: "board", version: "9.0.0", file: "../x.bin" }]));
    expect(importBundledFirmware(bundled, store, () => {})).toEqual([]);
    expect(importBundledFirmware(undefined, store, () => {})).toEqual([]);
  });

  it("offers the newer of the hub's own desktop app and the image's", () => {
    const bundled = dir(), data = dir();
    const put = (root: string, version: string, body: string) => {
      mkdirSync(join(root, "desktop"), { recursive: true });
      writeFileSync(join(root, "desktop", "VortexAxisDesktop.exe"), body);
      writeFileSync(join(root, "desktop", "version.json"), JSON.stringify({ version }));
    };
    const app = new DesktopApp(data, { onConnect: () => {}, sessions: () => [] } as never, () => {}, bundled);
    expect(app.build()).toBeUndefined();
    put(bundled, "0.7.7", "from the image");
    expect(app.build()).toMatchObject({ version: "0.7.7", file: join(bundled, "desktop", "VortexAxisDesktop.exe") });
    put(data, "0.7.8", "built here");
    expect(app.build()).toMatchObject({ version: "0.7.8", file: join(data, "desktop", "VortexAxisDesktop.exe") });
    put(bundled, "0.8.0", "a newer image");
    expect(app.build()?.version).toBe("0.8.0");
  });
});
