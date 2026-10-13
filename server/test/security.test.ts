import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, MIN_ADMIN_TOKEN } from "../src/config.js";
import { Store } from "../src/store.js";

describe("safe defaults", () => {
  it("keeps the admin side off with a short admin token, and says why", () => {
    const short = loadConfig({ AXIS_ADMIN_TOKEN: "x".repeat(MIN_ADMIN_TOKEN - 1) } as NodeJS.ProcessEnv);
    expect(short.adminToken).toBeUndefined();
    expect(short.adminTokenTooShort).toBe(true);
    const long = loadConfig({ AXIS_ADMIN_TOKEN: "x".repeat(MIN_ADMIN_TOKEN) } as NodeJS.ProcessEnv);
    expect(long.adminToken).toBe("x".repeat(MIN_ADMIN_TOKEN));
    expect(long.adminTokenTooShort).toBe(false);
    expect(loadConfig({} as NodeJS.ProcessEnv).adminTokenTooShort).toBe(false);
  });

  it("keeps its database and data folder for its own user only", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "axis-modes-")), "data");
    try {
      const store = new Store(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "axis.sqlite")).mode & 0o777).toBe(0o600);
      store.close();
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
});
