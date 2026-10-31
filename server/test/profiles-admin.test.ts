import { describe, expect, it } from "vitest";
import { overridesOf, PROFILES, Profiles } from "../src/profiles.js";
import { Store } from "../src/store.js";
import { admin, ready, useServer } from "./harness.js";

useServer();

const BOARD_SETTINGS = [
  { key: "brightness", label: "Brightness", kind: "number", group: "Screen", min: 10, max: 255, default: 200 },
  { key: "volume", label: "Volume", kind: "number", group: "Sound", min: 0, max: 100, default: 60 },
  { key: "listenCue", label: "Listening cue", kind: "toggle", group: "Sound", default: 1 },
  { key: "taskChime", label: "Task chime", kind: "toggle", group: "Sound", default: 1 },
];

const find = (body: any, name: string) => body.profiles.find((p: any) => p.name === name);

describe("profiles in the database", () => {
  it("start as the four old profiles plus pocket", () => {
    const store = new Store(":memory:");
    const profiles = new Profiles(store);
    expect(profiles.names()).toEqual(["normal", "power-saver", "silent", "dock", "pocket"]);
    expect(PROFILES.normal).toMatchObject({});
    expect(overridesOf("power-saver", { dockChargeLimit: 80 }, profiles.table())).toMatchObject({ cap: { brightness: 100, maxFps: 15 } });
    expect(overridesOf("silent", { dockChargeLimit: 80 }, profiles.table())).toMatchObject({ set: { volume: 0, listenCue: 0, taskChime: 0 } });
    expect(overridesOf("pocket", { dockChargeLimit: 80 }, profiles.table())).toMatchObject({ set: { volume: 0, listenCue: 0, taskChime: 0 }, cap: { brightness: 30 } });
    expect(overridesOf("dock", { dockChargeLimit: 70 }, profiles.table()).set).toEqual({ chargeLimit: 70 });
    // An edit of dock adds on top; a chargeLimit set by hand wins.
    profiles.put({ name: "dock", set: { volume: 10 }, cap: {}, capabilitiesOff: [] });
    expect(overridesOf("dock", { dockChargeLimit: 70 }, profiles.table()).set).toEqual({ chargeLimit: 70, volume: 10 });
    profiles.put({ name: "dock", set: { chargeLimit: 90 }, cap: {}, capabilitiesOff: [] });
    expect(overridesOf("dock", { dockChargeLimit: 70 }, profiles.table()).set).toEqual({ chargeLimit: 90 });
    store.close();
  });
});

describe("the profiles admin API", () => {
  it("lists, creates, edits, resets and deletes", async () => {
    const list = await admin("GET", "/admin/profiles");
    expect(list.status).toBe(200);
    expect(list.body.profiles.map((p: any) => p.name)).toEqual(["normal", "power-saver", "silent", "dock", "pocket"]);
    expect(find(list.body, "pocket")).toMatchObject({ isBuiltIn: true, edited: false, set: { volume: 0 }, cap: { brightness: 30 } });

    const made = await admin("PUT", "/admin/profiles/night", { label: "Night", set: { volume: 5 }, cap: { brightness: 20 } });
    expect(made.status).toBe(201);
    expect(find(made.body, "night")).toMatchObject({ isBuiltIn: false, label: "Night", set: { volume: 5 }, cap: { brightness: 20 } });
    expect((await admin("PUT", "/admin/profiles/night", { set: { volume: 7 } })).status).toBe(200);

    const edited = await admin("PUT", "/admin/profiles/silent", { set: { volume: 0 }, cap: {} });
    expect(find(edited.body, "silent")).toMatchObject({ edited: true, set: { volume: 0 } });
    const reset = await admin("POST", "/admin/profiles/silent/reset");
    expect(find(reset.body, "silent")).toMatchObject({ edited: false, set: { volume: 0, listenCue: 0, taskChime: 0 } });

    expect((await admin("POST", "/admin/profiles/night/reset")).status).toBe(400);
    expect((await admin("POST", "/admin/profiles/nope/reset")).status).toBe(404);
    expect((await admin("DELETE", "/admin/profiles/silent")).status).toBe(400);
    expect((await admin("DELETE", "/admin/profiles/nope")).status).toBe(404);
    const gone = await admin("DELETE", "/admin/profiles/night");
    expect(gone.status).toBe(200);
    expect(find(gone.body, "night")).toBeUndefined();
  });

  it("refuses what is not a profile", async () => {
    const put = (name: string, body: unknown) => admin("PUT", `/admin/profiles/${name}`, body);
    expect((await put("Bad Name", {})).status).toBe(400);
    expect((await put("x".repeat(25), {})).status).toBe(400);
    expect((await put("a", [])).status).toBe(400);
    expect((await put("a", { extra: 1 })).body.error).toMatch(/unknown field extra/);
    expect((await put("a", { set: { notASetting: 1 } })).body.error).toMatch(/notASetting/);
    expect((await put("a", { set: { volume: [1] } })).body.error).toMatch(/set.volume/);
    expect((await put("a", { cap: { brightness: "high" } })).body.error).toMatch(/cap.brightness must be a number/);
    expect((await put("a", { cap: { brightness: null } })).status).toBe(400);
  });

  it("pushes settings to devices on an edited profile, and a deleted one falls back to auto", async () => {
    const { identity, client } = await ready(["mic", "speaker", "screen"], { name: "Desk board" });
    client.send({ t: "describe", settings: BOARD_SETTINGS as any, actions: [], links: [] });
    await admin("PUT", "/admin/profiles/night", { set: { volume: 5 } });
    await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { profile: "night" } });
    await client.next("settings", 0, (m) => m.values.volume === 5);

    await admin("PUT", "/admin/profiles/night", { set: { volume: 9 } });
    await client.next("settings", 0, (m) => m.values.volume === 9);

    await admin("DELETE", "/admin/profiles/night");
    const back = await client.next("settings", 0, (m) => m.values.volume !== 9);
    expect(back.values.volume).toBeUndefined();
    expect((await admin("GET", `/admin/clients/${identity.clientId}`)).body).toMatchObject({ profile: "normal", profileReason: "auto" });
  });

  it("offers the live profile names as the choices of the profile setting", async () => {
    await admin("PUT", "/admin/profiles/night", {});
    const global = await admin("GET", "/admin/settings/global");
    const def = global.body.builtIns.find((s: any) => s.key === "profile");
    expect(def.options).toEqual(["auto", "normal", "power-saver", "silent", "dock", "pocket", "night"]);
    const { identity } = await ready(["screen"], { name: "Desk" });
    expect((await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { profile: "night" } })).status).toBe(200);
    expect((await admin("PATCH", `/admin/settings/device/${identity.clientId}`, { values: { profile: "nope" } })).status).toBe(400);
  });
});
