import { describe, expect, it } from "vitest";
import { BUILT_IN_SETTINGS, sentDefaults, withBuiltIns } from "../src/schema.js";
import { admin, ctx, ready, restart, useServer } from "./harness.js";

useServer();

describe("the shared listening settings", () => {
  it("are Axis's own, with the boards' labels, ranges and defaults", () => {
    const listening = BUILT_IN_SETTINGS.filter((s) => s.group === "Listening");
    expect(listening.map((s) => [s.key, s.default, s.min, s.max, s.unit])).toEqual([
      ["followUpMs", 6000, 0, 30000, "ms"],
      ["onsetMs", 6000, 1000, 20000, "ms"],
      ["silenceMs", 900, 300, 5000, "ms"],
      ["maxSpeechMs", 20000, 3000, 60000, "ms"],
    ]);
    expect(sentDefaults()).toEqual({ followUpMs: 6000, onsetMs: 6000, silenceMs: 900, maxSpeechMs: 20000 });
    // A board that still declares them gets Axis's: one definition for every client.
    const board = withBuiltIns({ settings: [{ key: "silenceMs", label: "Mine", kind: "number", default: 1 }], actions: [], links: [] });
    expect(board.settings.filter((s) => s.key === "silenceMs")).toEqual([BUILT_IN_SETTINGS.find((s) => s.key === "silenceMs")]);
  });

  it("reach a client that has nothing saved, beneath whatever is saved", async () => {
    const { identity, client } = await ready(["mic", "speaker", "screen"]);
    const first = await client.next("settings");
    expect(first.values).toMatchObject({ followUpMs: 6000, onsetMs: 6000, silenceMs: 900, maxSpeechMs: 20000 });
    // Nothing is stored for them: the admin page's layers stay empty.
    expect(ctx.app.store.resolveSettings({ id: identity.clientId, type: "test" }).silenceMs).toBeUndefined();

    await admin("PATCH", "/admin/settings/global", { values: { silenceMs: 1500 } });
    expect((await client.next("settings", 0, (m) => m.values.silenceMs === 1500)).values).toMatchObject({ silenceMs: 1500, onsetMs: 6000 });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { silenceMs: 700, followUpMs: 0 } });
    expect((await client.next("settings", 0, (m) => m.values.silenceMs === 700)).values).toMatchObject({ followUpMs: 0, maxSpeechMs: 20000 });
  });

  it("moves the settings' version on when the defaults sent are new, once", async () => {
    const store = ctx.app.store;
    const before = store.settingsVersion();
    store.setMeta("sentDefaults", "{}");
    await restart();
    const after = ctx.app.store.settingsVersion();
    expect(after).toBe(before + 1);
    await restart();
    expect(ctx.app.store.settingsVersion()).toBe(after);
  });
});
