import { describe, expect, it } from "vitest";
import type { ClientRecord } from "../src/store.js";
import { createInvokeHandler } from "../src/commands.js";
import { chargerLine, deviceInfo, lowest, spokenSummary } from "../src/deviceinfo.js";
import { activeProfile, withProfile } from "../src/profiles.js";
import { BUILT_IN_SETTINGS, settingProblem } from "../src/schema.js";
import { admin, ctx, ready, useServer } from "./harness.js";

useServer();

function invoke(command: string, params: Record<string, unknown> = {}) {
  const { hub, store, timers, delivery, activity } = ctx.app;
  return createInvokeHandler({ hub, store, timers, delivery, activity, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(
    command,
    params,
  ) as Promise<any>;
}

const client = { id: "c1", name: "Desk board", type: "waveshare-amoled-1.8", capabilities: [], reported: [], off: [], createdAt: 0, lastSeenAt: 0, version: "1" } as unknown as ClientRecord;
const charger = (readings: Record<string, number>, chargeLimit?: number, profile: "dock" | "normal" = "normal") =>
  deviceInfo({ client, settings: {}, session: { connectedAt: 0, readings }, profile: { profile, reason: profile === "dock" ? "manual" : "auto" }, chargeLimit }, 0);

describe("the Dock profile's overlay", () => {
  it("sets chargeLimit from the hub's Dock charge limit, over the device's own", () => {
    expect(withProfile({ chargeLimit: 100, brightness: 200 }, "dock", {}, { dockChargeLimit: 80 })).toEqual({ chargeLimit: 80, brightness: 200 });
    expect(withProfile({ chargeLimit: 90 }, "dock", {}, { dockChargeLimit: 65 })).toEqual({ chargeLimit: 65 });
  });

  it("leaves the device's own chargeLimit in every other profile", () => {
    for (const profile of ["normal", "power-saver", "silent"] as const) {
      expect(withProfile({ chargeLimit: 90 }, profile, {}, { dockChargeLimit: 80 }).chargeLimit).toBe(90);
    }
  });

  it("is never picked by auto, only by hand", () => {
    expect(activeProfile("auto", false).profile).toBe("normal");
    expect(activeProfile("auto", true).profile).toBe("power-saver");
    expect(activeProfile(undefined, true).profile).toBe("power-saver");
    expect(activeProfile("dock", true)).toEqual({ profile: "dock", reason: "manual" });
  });
});

describe("chargeLimit", () => {
  const def = BUILT_IN_SETTINGS.find((d) => d.key === "chargeLimit")!;

  it("is a whole number from 50 to 100, 100 by default", () => {
    expect(def).toMatchObject({ kind: "number", min: 50, max: 100, step: 5, default: 100 });
    expect(settingProblem(def, 80)).toBeUndefined();
    expect(settingProblem(def, 100)).toBeUndefined();
    expect(settingProblem(def, 49)).toMatch(/at least 50/);
    expect(settingProblem(def, 101)).toMatch(/at most 100/);
    expect(settingProblem(def, 82.5)).toMatch(/whole number/);
    expect(settingProblem(def, "80")).toMatch(/number/);
  });

  it("is refused out of range by the admin API and the config tool", async () => {
    const { identity } = await ready(["screen"], { name: "Desk board" });
    expect((await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { chargeLimit: 40 } })).status).toBe(400);
    await expect(invoke("vortex.axis.config", { client: "Desk board", key: "chargeLimit", value: 120 })).rejects.toThrow(/at most 100/);
    await invoke("vortex.axis.config", { client: "Desk board", key: "chargeLimit", value: 90 });
    expect(ctx.app.store.resolveSettings({ id: identity.clientId, type: "web" }).chargeLimit).toBe(90);
  });

  it("is always sent, the device's own outside Dock and the hub's on Dock", async () => {
    const { identity, client: device } = await ready(["screen"], { name: "Desk board" });
    const last = () => (device.received.filter((m) => m.t === "settings").at(-1) as any).values;
    await expect.poll(() => last().chargeLimit).toBe(100);
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { chargeLimit: 90 } });
    await expect.poll(() => last().chargeLimit).toBe(90);
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { profile: "dock" } });
    await expect.poll(() => last().chargeLimit).toBe(80);
    expect((await admin("GET", `/admin/clients/${identity.clientId}`)).body).toMatchObject({ profile: "dock", profileReason: "manual", effective: { chargeLimit: 80 } });
    // A new Dock charge limit reaches a device on Dock at once.
    expect((await admin("PATCH", "/admin/integrations", { dockChargeLimit: 70 })).body.settings.dockChargeLimit).toBe(70);
    await expect.poll(() => last().chargeLimit).toBe(70);
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { profile: "normal" } });
    await expect.poll(() => last().chargeLimit).toBe(90);
  });
});

describe("the Dock charge limit", () => {
  it("is a hub setting from 50 to 100", async () => {
    expect((await admin("GET", "/admin/integrations")).body.settings.dockChargeLimit).toBe(80);
    expect((await admin("PATCH", "/admin/integrations", { dockChargeLimit: 100 })).body.settings.dockChargeLimit).toBe(100);
    expect((await admin("PATCH", "/admin/integrations", { dockChargeLimit: 45 })).status).toBe(400);
    expect((await admin("PATCH", "/admin/integrations", { dockChargeLimit: 101 })).status).toBe(400);
  });
});

describe("the charger line", () => {
  it("says the phase in plain words", () => {
    expect(chargerLine(0, false, 100)).toBe("charging (trickle)");
    expect(chargerLine(1, false, 100)).toBe("charging (pre-charge)");
    expect(chargerLine(2, false, 100)).toBe("charging (constant current)");
    expect(chargerLine(3, false, 100)).toBe("charging, tapering");
    expect(chargerLine(4, false, 100)).toBe("full");
    expect(chargerLine(5, false, 100)).toBe("not charging");
    expect(chargerLine(5, true, 80)).toBe("held at 80% by the charge limit");
    expect(chargerLine(undefined, undefined, 80)).toBeUndefined();
  });

  it("goes into the vitals with USB volts for the admin page", () => {
    const info = charger({ battery: 80, charging: 0, chargerState: 5, chargeHeld: 1, usbMv: 4980 }, 80, "dock");
    expect(info.vitals.charger).toEqual({ state: 5, held: true, limit: 80, usbMv: 4980, usbText: "USB 4.98 V", line: "held at 80% by the charge limit" });
    expect(charger({ chargerState: 9 }).vitals.charger).toBeUndefined();
  });

  it("is spoken only when it explains something, never the USB volts", () => {
    const held = spokenSummary(charger({ battery: 80, charging: 0, chargerState: 5, chargeHeld: 1, usbMv: 4980 }, 80, "dock"), 0);
    expect(held).toContain("held at 80% by the charge limit");
    expect(held).toContain("Dock: charging held at 80%");
    expect(held).not.toMatch(/USB|4\.98/);
    expect(spokenSummary(charger({ battery: 100, charging: 0, chargerState: 4, chargeHeld: 0 }), 0)).toContain("full");
    const charging = spokenSummary(charger({ battery: 50, charging: 1, chargerState: 2, chargeHeld: 0, usbMv: 5010 }), 0);
    expect(charging).not.toMatch(/constant|USB/);
  });

  it("drops the charger readings after five minutes like the other vitals", () => {
    const readings = { battery: 80, chargerState: 2, chargeHeld: 0, usbMv: 5000 };
    const readAt = { battery: 400_000, chargerState: 0, chargeHeld: 0, usbMv: 0 };
    const info = deviceInfo({ client, settings: {}, session: { connectedAt: 0, readings, readAt } }, 400_000);
    expect(info.vitals.charger).toBeUndefined();
    expect(info.vitals.battery?.percent).toBe(80);
  });

  it("does not name a held battery the lowest", () => {
    const held = charger({ battery: 60, charging: 0, chargeHeld: 1 }, 60, "dock");
    expect(lowest([held])).toBeUndefined();
  });
});
