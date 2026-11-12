import { afterEach, describe, expect, it } from "vitest";
import type { Capability } from "@vortex-axis/protocol";
import { Delivery } from "../src/delivery.js";
import type { Hub, Session } from "../src/hub.js";
import { Store, type ClientRecord } from "../src/store.js";

const T0 = 1_800_000_000_000;
const HOLD = 60_000;

const clientOf = (id: string, capabilities: Capability[] = ["speaker", "screen"]) =>
  ({ id, name: id, type: "board", capabilities, reported: capabilities, off: [], version: "1", createdAt: 0, lastSeenAt: null }) as unknown as ClientRecord;

/** A hub with no sockets: clients connect when told to, and `say` resolves (or throws) at once unless held. */
function fakeHub() {
  const onConnect: Array<(s: Session) => void> = [];
  const sessions = new Map<string, Session>();
  const said: Array<{ session: Session; text: string }> = [];
  const state = { quiet: false, fail: false };
  const hub = {
    onConnect: (f: (s: Session) => void) => void onConnect.push(f),
    onProfileChange: () => undefined,
    profile: () => ({ profile: "normal", reason: "setting" }),
    quiet: () => state.quiet,
    say: async (session: Session, text: string) => {
      if (state.fail) throw new Error("the socket went away");
      said.push({ session, text });
      return { heard: true };
    },
    session: (id: string) => sessions.get(id),
    sessions: () => sessions.values(),
  } as unknown as Hub;
  return {
    hub,
    said,
    state,
    connect(client: ClientRecord): Session {
      const session = { client } as unknown as Session;
      sessions.set(client.id, session);
      for (const f of onConnect) f(session);
      return session;
    },
    disconnect(id: string) {
      sessions.delete(id);
    },
  };
}

let store: Store;
let now = T0;
afterEach(() => store?.close());

function setup() {
  now = T0;
  store = new Store(":memory:", () => now);
  const fake = fakeHub();
  const delivery = new Delivery({ hub: fake.hub, store, holdMs: HOLD, now: () => now });
  return { ...fake, delivery };
}
const statusOf = (body: string) => store.listNotifications().find((n) => n.body === body)?.status;

describe("notification rows do not stay pending or held for ever", () => {
  it("a delivery that failed on a still-pending notification marks it dropped", async () => {
    const { delivery, connect, state } = setup();
    const session = connect(clientOf("desk"));
    state.fail = true;
    await expect(delivery.sayOn(session, "Lost.")).rejects.toThrow();
    expect(statusOf("Lost.")).toBe("dropped");
  });

  it("pruning marks dropped a held one pushed out by the cap of five", async () => {
    const { delivery } = setup();
    const porch = clientOf("porch");
    for (let i = 1; i <= 6; i++) {
      now += 1;
      await delivery.sayTo(porch, `Porch ${i}.`);
    }
    delivery.prune();
    expect(statusOf("Porch 1.")).toBe("dropped");
    expect([2, 3, 4, 5, 6].map((i) => statusOf(`Porch ${i}.`))).toEqual(Array(5).fill("held"));
  });

  it("pruning marks dropped a held one a quiet-hours flush could not say on a device with no screen", async () => {
    const { delivery, connect, state } = setup();
    const box = clientOf("box", ["speaker"]);
    await delivery.sayTo(box, "Kept for the box.");
    expect(statusOf("Kept for the box.")).toBe("held");
    state.quiet = true;
    connect(box);
    await new Promise((r) => setTimeout(r, 1700));
    expect(store.deliveriesOf(store.listNotifications()[0]!.id)[0]).toMatchObject({ state: "dropped" });
    delivery.prune();
    expect(statusOf("Kept for the box.")).toBe("dropped");
  });

  it("pruning leaves a delivered one alone, and a held one still kept", async () => {
    const { delivery, connect } = setup();
    await delivery.sayOn(connect(clientOf("desk")), "Said.");
    await delivery.sayTo(clientOf("porch"), "Waiting.");
    delivery.prune();
    expect(statusOf("Said.")).toBe("heard");
    expect(statusOf("Waiting.")).toBe("held");
  });
});
