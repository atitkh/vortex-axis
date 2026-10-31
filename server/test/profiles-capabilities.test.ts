import { describe, expect, it } from "vitest";
import type { Capability } from "@vortex-axis/protocol";
import { canTap } from "../src/hub.js";
import { createInvokeHandler } from "../src/commands.js";
import { parseProfile, Profiles } from "../src/profiles.js";
import { Store } from "../src/store.js";
import { admin, connect, ctx, newPairedClient, useServer } from "./harness.js";

useServer();

function invoke(command: string, params: Record<string, unknown> = {}) {
  const { hub, store, timers, delivery, activity } = ctx.app;
  return createInvokeHandler({ hub, store, timers, delivery, activity, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(command, params) as Promise<any>;
}

async function device(name: string, capabilities: Capability[]) {
  const identity = await newPairedClient({ capabilities, type: "board", name });
  const client = await connect(identity, { capabilities, type: "board" });
  await client.next("status");
  return { identity, client };
}

const setProfile = (id: string, profile: string) => admin("PATCH", `/admin/settings/device/${id}`, { values: { profile } });
const live = (id: string) => ctx.app.hub.online.get(id)!.client;
const lastOff = (c: { received: any[] }) => [...c.received].reverse().find((m) => m.t === "settings")?.values.capabilitiesOff;

describe("capabilities a profile switches off", () => {
  it("take touch from the effective capabilities and from canTap, and give it back on leaving", async () => {
    const d = await device("Desk", ["mic", "screen", "touch"]);
    const id = d.identity.clientId;
    expect(canTap(live(id).capabilities)).toBe(true);
    await setProfile(id, "silent");
    expect(live(id)).toMatchObject({ capabilities: ["mic", "screen"], reported: ["mic", "screen", "touch"], off: [], profileOff: ["touch"] });
    expect(canTap(live(id).capabilities)).toBe(false);
    await setProfile(id, "normal");
    expect(live(id)).toMatchObject({ capabilities: ["mic", "screen", "touch"], profileOff: [] });
    expect(canTap(live(id).capabilities)).toBe(true);
  });

  it("applies at connect time", async () => {
    const identity = await newPairedClient({ capabilities: ["screen", "touch"], type: "board", name: "Bag" });
    await setProfile(identity.clientId, "pocket");
    const client = await connect(identity, { capabilities: ["screen", "touch"], type: "board" });
    await client.next("status");
    expect(live(identity.clientId)).toMatchObject({ capabilities: ["screen"], profileOff: ["touch"] });
  });

  it("tells the device the union of its own and the profile's, leaving the device layer alone", async () => {
    const d = await device("Desk", ["mic", "screen", "touch"]);
    const id = d.identity.clientId;
    await admin("PATCH", `/admin/clients/${id}`, { capabilitiesOff: ["mic"] });
    await setProfile(id, "silent");
    await expect.poll(() => lastOff(d.client)).toBe("mic,touch");
    expect(ctx.app.store.getLayer("device", id).capabilitiesOff).toBe("mic");
    expect(live(id)).toMatchObject({ capabilities: ["screen"], off: ["mic"], profileOff: ["touch"] });
    await setProfile(id, "normal");
    await expect.poll(() => lastOff(d.client)).toBe("mic");
    expect(live(id).capabilities).toEqual(["screen", "touch"]);
  });

  it("ignores a capability the device does not report", async () => {
    const d = await device("Mute", ["speaker"]);
    await setProfile(d.identity.clientId, "silent");
    expect(live(d.identity.clientId)).toMatchObject({ capabilities: ["speaker"], profileOff: [] });
  });

  it("moves a tap-only question when the profile switches touch off, not when the mic can still answer", async () => {
    const desk = await device("Desk", ["screen", "touch"]);
    const hall = await device("Hall", ["mic", "speaker", "screen", "touch"]);
    const asking = invoke("vortex.axis.ask", { question: "Lights off?", choices: ["Yes", "No"], client: "Desk", timeoutSeconds: 30 });
    const ask = await desk.client.next("ask");
    await setProfile(desk.identity.clientId, "silent");
    expect((await desk.client.next("ask.end")).askId).toBe(ask.askId);
    const moved = await hall.client.next("ask");
    hall.client.send({ t: "answer", askId: moved.askId, choice: "Yes" });
    expect(await asking).toMatchObject({ answer: "Yes" });

    const both = await device("Both", ["mic", "speaker", "screen", "touch"]);
    const again = invoke("vortex.axis.ask", { question: "Door?", choices: ["Yes", "No"], client: "Both", timeoutSeconds: 30 });
    const kept = await both.client.next("ask");
    await setProfile(both.identity.clientId, "silent");
    await expect.poll(() => live(both.identity.clientId).profileOff).toEqual(["touch"]);
    expect(both.client.received.some((m) => m.t === "ask.end")).toBe(false);
    both.client.send({ t: "answer", askId: kept.askId, choice: "No" });
    expect(await again).toMatchObject({ answer: "No" });
  });

  it("follows an edit, a reset and a delete of the profile", async () => {
    const d = await device("Desk", ["mic", "screen", "touch"]);
    const id = d.identity.clientId;
    await setProfile(id, "silent");
    await admin("PUT", "/admin/profiles/silent", { set: { volume: 0 }, cap: {}, capabilitiesOff: ["mic"] });
    await expect.poll(() => live(id).capabilities).toEqual(["screen", "touch"]);
    await admin("POST", "/admin/profiles/silent/reset");
    await expect.poll(() => live(id).capabilities).toEqual(["mic", "screen"]);
    await admin("PUT", "/admin/profiles/night", { capabilitiesOff: ["screen"] });
    await setProfile(id, "night");
    await expect.poll(() => live(id).capabilities).toEqual(["mic", "touch"]);
    await admin("DELETE", "/admin/profiles/night");
    await expect.poll(() => live(id).capabilities).toEqual(["mic", "screen", "touch"]);
  });
});

describe("profile defaults and validation", () => {
  it("switch touch off in silent and pocket, and pick the new default up over an unedited old one", () => {
    const store = new Store(":memory:");
    store.setMeta("profiles", JSON.stringify({ silent: { name: "silent", label: "Silent", set: { volume: 0, listenCue: 0, taskChime: 0 }, cap: {}, capabilitiesOff: [] } }));
    const profiles = new Profiles(store);
    const by = (n: string) => profiles.list().find((p) => p.name === n)!;
    expect(by("silent")).toMatchObject({ capabilitiesOff: ["touch"], edited: false });
    expect(by("pocket").capabilitiesOff).toEqual(["touch"]);
    expect(by("dock").capabilitiesOff).toEqual([]);
    // After the move an explicit empty list is an edit and stays.
    profiles.put({ ...by("silent"), capabilitiesOff: [] });
    expect(new Profiles(store).list().find((p) => p.name === "silent")).toMatchObject({ capabilitiesOff: [], edited: true });
    profiles.reset("silent");
    expect(by("silent").capabilitiesOff).toEqual(["touch"]);
    store.close();
  });

  it("rejects unknown and repeated capabilities with a 400", async () => {
    const known = new Set(["volume"]);
    expect(parseProfile("x", { capabilitiesOff: ["eyes"] }, known)).toMatch(/not a capability: eyes/);
    expect(parseProfile("x", { capabilitiesOff: ["touch", "touch"] }, known)).toMatch(/twice/);
    expect(parseProfile("x", { capabilitiesOff: "touch" }, known)).toMatch(/list of capability names/);
    expect(parseProfile("x", { capabilitiesOff: ["touch"] }, known)).toMatchObject({ capabilitiesOff: ["touch"] });
    const bad = await admin("PUT", "/admin/profiles/x", { capabilitiesOff: ["eyes"] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/not a capability: eyes/);
  });
});
