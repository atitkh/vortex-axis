import { describe, expect, it } from "vitest";
import { Attachment } from "../src/attach.js";
import { Store } from "../src/store.js";

function world() {
  const store = new Store(":memory:");
  let clock = 1_000_000;
  const moved: (string | undefined)[] = [];
  const sessions = [
    { key: "agent:main:vortex-axis", label: "Voice" },
    { key: "agent:main:discord:channel:1", origin: { label: "#Internship Hunt channel id:1" }, classification: "channel" },
    { key: "agent:main:discord:channel:2", origin: { label: "#Homelab channel id:2" }, classification: "channel" },
    { key: "agent:main:discord:channel:3", origin: { label: "#Homelab backups channel id:3" }, classification: "channel" },
    { key: "agent:main:cron:9", label: "Automation: sync", classification: "cron", isBackground: true },
  ];
  const attachment = new Attachment({
    source: { call: async () => ({ sessions }) },
    store,
    isHome: (key) => key === "agent:main:vortex-axis",
    onChange: (a) => void moved.push(a?.title),
    idleMs: 60_000,
    now: () => clock,
  });
  return { attachment, moved, tick: (ms: number) => (clock += ms) };
}

describe("pointing the devices at another conversation", () => {
  it("lists the conversations a person talks in, not jobs and not its own", async () => {
    expect((await world().attachment.list()).map((c) => c.title)).toEqual(["Internship Hunt", "Homelab", "Homelab backups"]);
  });

  it("attaches by the name as it is said, and turns then go there until it is told to let go", async () => {
    const w = world();
    expect(w.attachment.sessionKey()).toBeUndefined();
    expect((await w.attachment.attach("internship hunt")).attached).toMatchObject({ title: "Internship Hunt", sessionKey: "agent:main:discord:channel:1" });
    expect(w.attachment.sessionKey()).toBe("agent:main:discord:channel:1");
    expect(w.attachment.current()?.title).toBe("Internship Hunt");
    expect(w.attachment.detach()).toBe(true);
    expect(w.attachment.detach()).toBe(false);
    expect(w.attachment.sessionKey()).toBeUndefined();
    expect(w.moved).toEqual(["Internship Hunt", undefined]);
  });

  it("takes a name said in full over one that only contains it, and asks when several fit", async () => {
    const w = world();
    expect((await w.attachment.attach("Homelab")).attached?.title).toBe("Homelab");
    expect(await w.attachment.attach("home")).toEqual({ candidates: ["Homelab", "Homelab backups"] });
    // Still where it was: nothing moved for a question.
    expect(w.attachment.current()?.title).toBe("Homelab");
    await expect(w.attachment.attach("taxes")).rejects.toThrow(/no conversation called "taxes"\. There are: Internship Hunt, Homelab, Homelab backups/);
    await expect(w.attachment.attach("  ")).rejects.toThrow(/which conversation/);
  });

  it("lets go by itself when nothing has been said for a while, and each thing said keeps it", async () => {
    const w = world();
    await w.attachment.attach("internship hunt");
    w.tick(50_000);
    expect(w.attachment.sessionKey()).toBe("agent:main:discord:channel:1");
    w.tick(50_000);
    expect(w.attachment.sessionKey()).toBe("agent:main:discord:channel:1");
    w.tick(61_000);
    expect(w.attachment.sessionKey()).toBeUndefined();
    expect(w.moved).toEqual(["Internship Hunt", undefined]);
  });
});
