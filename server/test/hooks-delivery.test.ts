import { createECDH, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { describe, expect, it } from "vitest";
import { minuteOfDay } from "../src/quiet.js";
import type { TextToSpeech } from "../src/speech.js";
import { admin, ctx, newPairedClient, ready, restart, useServer } from "./harness.js";

// Webhook notices go on through Delivery.routeNotice, after the 202: quiet hours, urgent, the silent profile and Away are Delivery's.

const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: () =>
    (async function* () {
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
useServer(() => ({ tts }));

const WAIT = { timeout: 3000, interval: 20 };

async function post(id: string, body: unknown, auth: Record<string, string>) {
  const res = await fetch(`${ctx.base}/v1/hook/${id}`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const source = (ceiling: "notify" | "speak" | "urgent", extra: Record<string, unknown> = {}, id = "ci") => {
  const made = ctx.app.hooks.create({ id, label: "CI", auth: "bearer", ceiling, ...extra } as any);
  return { authorization: `Bearer ${made.secret}` };
};
const row = (id: number) => ctx.app.store.getNotification(id)!;
const settled = (id: number) => expect.poll(() => row(id).status, WAIT).not.toBe("pending");
const spoke = (client: { received: { t: string }[] }) => client.received.some((m) => m.t === "speak.start");

function aroundNow() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = minuteOfDay(Date.now(), zone);
  const hhmm = (m: number) => `${String(Math.floor(((m + 1440) % 1440) / 60)).padStart(2, "0")}:${String((m + 1440) % 60).padStart(2, "0")}`;
  return { quietFrom: hhmm(now - 5), quietTo: hhmm(now + 120) };
}

async function board(name = "Desk", values: Record<string, unknown> = {}) {
  const made = await ready(["speaker", "screen", "mic"], { name });
  if (Object.keys(values).length) {
    await admin("PATCH", `/admin/settings/device/${made.identity.clientId}`, { values });
    await made.client.next("settings", 0, (m) => Object.keys(values).every((k) => k === "profile" || m.values[k] !== undefined));
  }
  return made;
}

/** Answers each speech as played to the end, so a spoken notice is recorded heard. */
function finishSpeech(client: { next: (t: any, n?: number, f?: any) => Promise<any>; send: (m: any) => void }) {
  let on = true;
  const done = new Set<string>();
  void (async () => {
    while (on) {
      const end = await client.next("speak.end", 0, (m: any) => !done.has(m.turnId)).catch(() => undefined);
      if (!end || !on) return;
      done.add(end.turnId);
      client.send({ t: "playback", turnId: end.turnId, state: "finished" });
    }
  })();
  return () => (on = false);
}

async function closedPhone() {
  const posts: Buffer[] = [];
  const server = createHttpServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      posts.push(Buffer.alloc(0));
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  const identity = await newPairedClient({ capabilities: ["screen", "speaker"], name: "Phone" });
  ctx.app.store.setPushSubscription(identity.clientId, {
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/push/abc`,
    p256dh: keys.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  });
  return { identity, posts, close: () => server.close() };
}

describe("webhook notices, delivered", () => {
  it("normal under ceiling notify: shown on the screen, nothing spoken", async () => {
    const { client } = await board();
    const sent = await post("ci", { title: "Deploy", body: "finished" }, source("notify"));
    expect(sent.status).toBe(202);
    expect((await client.next("reply.text", 0, (m) => m.final)).text).toBe("From CI: Deploy. finished");
    await settled(sent.body.id);
    expect(row(sent.body.id).status).toBe("delivered");
    expect(ctx.app.store.deliveriesOf(sent.body.id)).toMatchObject([{ route: "silent", state: "shown" }]);
    expect(spoke(client)).toBe(false);
    // One row only: Delivery updated the webhook row, it made no second one.
    expect(ctx.app.store.listNotifications()).toHaveLength(1);
    // The admin's inbox names the device it went to; a device chip carries the route and state in its title.
    const listed = await admin("GET", "/admin/notifications");
    expect(listed.body.items[0].devices).toEqual([{ name: "Desk", route: "silent", state: "shown" }]);
  });

  it("normal under ceiling speak: spoken; in quiet hours shown, not spoken", async () => {
    const { client } = await board();
    const stop = finishSpeech(client);
    const auth = source("speak");
    const loud = await post("ci", { body: "build green" }, auth);
    await expect.poll(() => row(loud.body.id).status, WAIT).toBe("heard");
    stop();
    const { client: night } = await board("Night", aroundNow());
    const quiet = await post("ci", { body: "build red", client: "Night" }, auth);
    await settled(quiet.body.id);
    expect(ctx.app.store.deliveriesOf(quiet.body.id)).toMatchObject([{ route: "silent", state: "shown" }]);
    expect(spoke(night)).toBe(false);
  });

  it("urgent under ceiling urgent speaks in quiet hours; under ceiling notify it stays silent", async () => {
    const { client } = await board("Desk", aroundNow());
    const stop = finishSpeech(client);
    const urgent = await post("ci", { body: "prod down", priority: "urgent" }, source("urgent"));
    expect(urgent.body).toMatchObject({ priority: "urgent", clamped: false });
    await expect.poll(() => row(urgent.body.id).status, WAIT).toBe("heard");
    stop();
    const before = client.received.filter((m) => m.t === "speak.start").length;
    const muted = await post("quiet", { body: "prod down", priority: "urgent" }, source("notify", {}, "quiet"));
    expect(muted.body).toMatchObject({ priority: "normal", clamped: true });
    await settled(muted.body.id);
    expect(ctx.app.store.deliveriesOf(muted.body.id)).toMatchObject([{ route: "silent", state: "shown" }]);
    expect(client.received.filter((m) => m.t === "speak.start").length).toBe(before);
  });

  it("on the silent profile: never spoken, even urgent", async () => {
    const { client } = await board("Desk", { profile: "silent" });
    const sent = await post("ci", { body: "prod down", priority: "urgent" }, source("urgent"));
    await settled(sent.body.id);
    expect(ctx.app.store.deliveriesOf(sent.body.id)).toMatchObject([{ route: "silent", state: "shown" }]);
    expect(spoke(client)).toBe(false);
  });

  it("while Away: one push to the closed phone and nothing on the board; not Away: no push", async () => {
    await restart({}, { tts });
    const { client } = await board();
    const phone = await closedPhone();
    try {
      const auth = source("speak");
      ctx.app.store.setMeta("away", "1");
      const away = await post("ci", { body: "deploy done" }, auth);
      await expect.poll(() => phone.posts.length, WAIT).toBe(1);
      await settled(away.body.id);
      expect(ctx.app.store.deliveriesOf(away.body.id)).toMatchObject([{ clientId: phone.identity.clientId, route: "push", state: "pushed" }]);
      expect(spoke(client)).toBe(false);
      ctx.app.store.setMeta("away", undefined);
      const stop = finishSpeech(client);
      const home = await post("ci", { body: "deploy again" }, auth);
      await expect.poll(() => row(home.body.id).status, WAIT).toBe("heard");
      stop();
      expect(phone.posts.length).toBe(1);
    } finally {
      phone.close();
    }
  });

  it("the one order: an old browser with a subscription is never the Away target, and pickOutput stays on a live session", async () => {
    await restart({}, { tts });
    const { client } = await board();
    const phone = await closedPhone();
    const old = await newPairedClient({ capabilities: ["screen"], name: "Brave Windows" });
    ctx.app.store.setPushSubscription(old.clientId, { endpoint: "http://127.0.0.1:9/never", p256dh: "x", auth: "y" });
    try {
      ctx.app.store.setMeta("away", "1");
      const where = ctx.app.hub.pickDestination({}, true);
      expect("push" in where && where.push.id).toBe(phone.identity.clientId);
      // A caller that needs a live session gets the board, never the closed phone.
      expect(ctx.app.hub.pickOutput({}).client.id).not.toBe(phone.identity.clientId);
      expect(client).toBeTruthy();
      ctx.app.store.setMeta("away", undefined);
      const home = ctx.app.hub.pickDestination({}, true);
      expect("session" in home).toBe(true);
    } finally {
      phone.close();
    }
  });

  it("while Away the default phone wins over the other phone", async () => {
    await restart({}, { tts });
    await board();
    const first = await closedPhone();
    const second = await newPairedClient({ capabilities: ["screen"], name: "iPhone Two" });
    ctx.app.store.setPushSubscription(second.clientId, { endpoint: "http://127.0.0.1:9/never", p256dh: "x", auth: "y" });
    try {
      ctx.app.store.setMeta("away", "1");
      // Pinned either way round: the default phone wins whichever was seen last.
      for (const pin of [first.identity.clientId, second.clientId]) {
        ctx.app.store.patchLayer("global", "", { defaultPhone: pin });
        const where = ctx.app.hub.pickDestination({}, true);
        expect("push" in where && where.push.id).toBe(pin);
      }
    } finally {
      first.close();
    }
  });

  it("explicit client, location and everywhere follow the say mapping", async () => {
    const { client: desk } = await board("Desk", { location: "office" });
    const { identity: denId, client: den } = await board("Den", { location: "den" });
    const stops = [finishSpeech(desk), finishSpeech(den)];
    const auth = source("speak");
    const named = await post("ci", { body: "one", client: "Den" }, auth);
    await expect.poll(() => row(named.body.id).status, WAIT).toBe("heard");
    expect(ctx.app.store.deliveriesOf(named.body.id)).toMatchObject([{ clientId: denId.clientId }]);
    const placed = await post("ci", { body: "two", location: "den" }, auth);
    await expect.poll(() => row(placed.body.id).status, WAIT).toBe("heard");
    expect(ctx.app.store.deliveriesOf(placed.body.id)).toMatchObject([{ clientId: denId.clientId }]);
    const all = await post("ci", { body: "three", everywhere: true }, auth);
    await expect.poll(() => ctx.app.store.deliveriesOf(all.body.id).length, WAIT).toBe(2);
    stops.forEach((stop) => stop());
    expect(row(all.body.id)).toMatchObject({ everywhere: true });
  });

  it("a named board that is offline: row recorded, nothing kept, and the answer says so", async () => {
    const { identity, client } = await board("Shed");
    client.close();
    await expect.poll(() => ctx.app.hub.session(identity.clientId), WAIT).toBeUndefined();
    const sent = await post("ci", { body: "x", client: "Shed" }, source("speak"));
    expect(sent.body.note).toMatch(/offline/);
    await new Promise((r) => setTimeout(r, 50));
    expect(row(sent.body.id).status).toBe("recorded");
    expect(ctx.app.delivery.waitingFor(identity.clientId)).toBe(0);
  });

  it("low is recorded only: no say and no push", async () => {
    const { client } = await board();
    const phone = await closedPhone();
    try {
      ctx.app.store.setMeta("away", "1");
      const sent = await post("ci", { body: "fyi", priority: "low" }, source("urgent"));
      await new Promise((r) => setTimeout(r, 100));
      expect(row(sent.body.id).status).toBe("recorded");
      expect(ctx.app.store.deliveriesOf(sent.body.id)).toEqual([]);
      expect(phone.posts.length).toBe(0);
      expect(client.received.some((m) => m.t === "reply.text" || m.t === "speak.start")).toBe(false);
    } finally {
      ctx.app.store.setMeta("away", undefined);
      phone.close();
    }
  });

  it("answers 202 before a stalling speaker has finished", async () => {
    let release = () => {};
    const stalling: TextToSpeech = {
      ...tts,
      synthesize: () =>
        (async function* () {
          await new Promise<void>((r) => (release = r));
          yield Buffer.alloc(400, 1);
        })(),
    };
    await restart({}, { tts: stalling });
    await board();
    const sent = await post("ci", { body: "slow" }, source("speak"));
    expect(sent.status).toBe(202);
    expect(row(sent.body.id).status).toBe("pending");
    release();
  });

  it("a store call that throws inside deliver() is logged, not an unhandled rejection", async () => {
    const { client: desk } = await board("Desk");
    const stop = finishSpeech(desk);
    const auth = source("speak");
    const rejections: unknown[] = [];
    const seen = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", seen);
    const real = ctx.app.store.getNotification.bind(ctx.app.store);
    let armed = true;
    let calls = 0;
    ctx.app.store.getNotification = ((id: number) => {
      calls++;
      if (armed) throw new Error("db gone");
      return real(id);
    }) as typeof ctx.app.store.getNotification;
    try {
      expect((await post("ci", { body: "hello", priority: "normal" }, auth)).status).toBe(202);
      await new Promise((r) => setTimeout(r, 300));
      expect(rejections).toEqual([]);
      expect(calls).toBeGreaterThan(0);
    } finally {
      armed = false;
      stop();
      ctx.app.store.getNotification = real;
      process.off("unhandledRejection", seen);
    }
  });
});
