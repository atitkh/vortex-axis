import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { Capability } from "@vortex-axis/protocol";
import { createInvokeHandler } from "../src/commands.js";
import { encryptPush } from "../src/push.js";
import type { TextToSpeech } from "../src/speech.js";
import { admin, connect, ctx, newPairedClient, ready, useServer } from "./harness.js";

// A voice, so a client with a speaker is spoken to and can report it heard.
const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: () =>
    (async function* () {
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
useServer(() => ({ tts }));

function invoke(command: string, params: Record<string, unknown> = {}) {
  const { hub, store, timers, delivery, activity } = ctx.app;
  return createInvokeHandler({ hub, store, timers, delivery, activity, pairingCodeTtlMs: 60_000, version: "test", startedAt: 0 })(
    command,
    params,
  ) as Promise<any>;
}

/** The browser's side of Web Push: its keys, and how it opens what a server sends it. */
function browser() {
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  const auth = randomBytes(16);
  return {
    p256dh: keys.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    open(body: Buffer): string {
      const salt = body.subarray(0, 16);
      const idLength = body.readUInt8(20);
      const serverKey = body.subarray(21, 21 + idLength);
      const sealed = body.subarray(21 + idLength);
      const shared = keys.computeSecret(serverKey);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), keys.getPublicKey(), serverKey]);
      const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
      const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const opener = createDecipheriv("aes-128-gcm", key, nonce);
      opener.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([opener.update(sealed.subarray(0, sealed.length - 16)), opener.final()]);
      // The last byte says "final record"; padding would follow it.
      expect(plain.at(-1)).toBe(2);
      return plain.subarray(0, -1).toString();
    },
  };
}

/** A stand-in push service: remembers what it was sent and answers with `status`. */
async function pushService(status = 201) {
  const posts: { headers: Record<string, any>; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      posts.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { posts, endpoint: `http://127.0.0.1:${(server.address() as any).port}/push/abc`, close: () => server.close() };
}

/** Plays the part of a device that has played something to the end. Each stretch of speech is finished once. */
type TestClient = Awaited<ReturnType<typeof ready>>["client"];
const finished = new WeakMap<TestClient, Set<string>>();
const finish = async (client: TestClient) => {
  const done = finished.get(client) ?? new Set<string>();
  finished.set(client, done);
  const end = await client.next("speak.end", 0, (m) => !done.has(m.turnId));
  done.add(end.turnId);
  client.send({ t: "playback", turnId: end.turnId, state: "finished" });
};

describe("web push", () => {
  it("encrypts so that only the browser it was meant for can read it", () => {
    const mine = browser();
    const body = encryptPush({ endpoint: "https://push.example/x", p256dh: mine.p256dh, auth: mine.auth }, Buffer.from("héllo, browser"));
    expect(mine.open(body)).toBe("héllo, browser");
    expect(() => browser().open(body)).toThrow();
  });

  it("takes a subscription from a paired browser only, and only a real one", async () => {
    const identity = await newPairedClient({ capabilities: ["screen", "speaker"], name: "Phone" });
    const mine = browser();
    const send = (headers: Record<string, string>, body: unknown, method = "POST") =>
      fetch(`${ctx.base}/v1/push/subscription`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const asMe = { authorization: `Bearer ${identity.token}`, "x-axis-client": identity.clientId };
    const good = { endpoint: "https://push.example/send/abc", keys: { p256dh: mine.p256dh, auth: mine.auth } };

    expect((await fetch(`${ctx.base}/v1/push/key`).then((r) => r.json())).key).toMatch(/^[\w-]{87}$/);
    expect((await send({}, good)).status).toBe(401);
    expect((await send(asMe, { ...good, endpoint: "http://10.0.0.1/inside" })).status).toBe(400);
    expect((await send(asMe, { endpoint: good.endpoint, keys: { p256dh: "short", auth: mine.auth } })).status).toBe(400);
    expect((await admin("GET", `/admin/clients/${identity.clientId}`)).body.notifications).toBe(false);

    expect((await send(asMe, good)).status).toBe(200);
    expect((await admin("GET", `/admin/clients/${identity.clientId}`)).body.notifications).toBe(true);
    expect((await send(asMe, {}, "DELETE")).status).toBe(200);
    expect((await admin("GET", `/admin/clients/${identity.clientId}`)).body.notifications).toBe(false);
  });

  it("sends a closed browser a notification instead of speaking", async () => {
    const service = await pushService();
    const mine = browser();
    try {
      const identity = await newPairedClient({ capabilities: ["screen", "speaker"], name: "Phone" });
      ctx.app.store.setPushSubscription(identity.clientId, { endpoint: service.endpoint, p256dh: mine.p256dh, auth: mine.auth });

      const said = await invoke("vortex.axis.say", { text: "Dinner is ready.", client: "Phone" });
      expect(said).toMatchObject({ client: "Phone", heard: false, shown: true });
      expect(said.note).toMatch(/notification/);

      const post = service.posts[0]!;
      expect(post.headers["content-encoding"]).toBe("aes128gcm");
      expect(post.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
      const claims = JSON.parse(Buffer.from(String(post.headers.authorization).split(".")[1]!, "base64url").toString());
      expect(claims.aud).toBe(new URL(service.endpoint).origin);
      expect(JSON.parse(mine.open(post.body))).toMatchObject({ title: "Vortex", body: "Dinner is ready." });
    } finally {
      service.close();
    }
  });

  it("sends a test notification from the admin page, open or closed", async () => {
    const service = await pushService();
    const mine = browser();
    try {
      const { identity } = await ready(["screen", "speaker"], { name: "Laptop" });
      expect((await admin("POST", `/admin/clients/${identity.clientId}/notify-test`)).status).toBe(409);
      ctx.app.store.setPushSubscription(identity.clientId, { endpoint: service.endpoint, p256dh: mine.p256dh, auth: mine.auth });
      // The page is open and connected; the notification goes out all the same.
      expect(await admin("POST", `/admin/clients/${identity.clientId}/notify-test`)).toMatchObject({ status: 200, body: { sent: "Laptop" } });
      expect(JSON.parse(mine.open(service.posts[0]!.body))).toMatchObject({ title: "Vortex", body: "Test notification for Laptop." });
    } finally {
      service.close();
    }
  });

  it("forgets a subscription the browser has dropped, and keeps the message instead", async () => {
    const service = await pushService(410);
    const mine = browser();
    try {
      const identity = await newPairedClient({ capabilities: ["screen", "speaker"], name: "Phone" });
      ctx.app.store.setPushSubscription(identity.clientId, { endpoint: service.endpoint, p256dh: mine.p256dh, auth: mine.auth });
      expect(await invoke("vortex.axis.say", { text: "Hello?", client: "Phone" })).toMatchObject({ held: true });
      expect(ctx.app.push.has(identity.clientId)).toBe(false);
    } finally {
      service.close();
    }
  });

  it("asks a closed browser by notification and takes the choice that comes back", async () => {
    const service = await pushService();
    const mine = browser();
    try {
      const identity = await newPairedClient({ capabilities: ["screen", "speaker"], name: "Phone" });
      ctx.app.store.setPushSubscription(identity.clientId, { endpoint: service.endpoint, p256dh: mine.p256dh, auth: mine.auth });

      const asked = invoke("vortex.axis.ask", { question: "Tea or coffee?", choices: ["Tea", "Coffee"], client: "Phone", timeoutSeconds: 20 });
      await expect.poll(() => service.posts.length).toBe(1);
      const { ask } = JSON.parse(mine.open(service.posts[0]!.body));
      expect(ask).toMatchObject({ question: "Tea or coffee?", choices: ["Tea", "Coffee"] });

      // A page that was just opened can ask what is waiting for it, since a phone may not say which notification opened it.
      const waiting = (headers: Record<string, string>) => fetch(`${ctx.base}/v1/push/asks`, { headers });
      expect((await waiting({})).status).toBe(401);
      const mineToAnswer = await (await waiting({ authorization: `Bearer ${identity.token}`, "x-axis-client": identity.clientId })).json();
      expect(mineToAnswer.asks).toEqual([{ id: ask.id, token: ask.token, question: "Tea or coffee?", choices: ["Tea", "Coffee"] }]);

      const answer = (body: unknown) =>
        fetch(`${ctx.base}/v1/push/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      // A wrong token, or something that was not offered, is not an answer.
      expect((await answer({ id: ask.id, token: "guess", choice: "Tea" })).status).toBe(410);
      expect((await answer({ id: ask.id, token: ask.token, choice: "Wine" })).status).toBe(410);
      expect((await answer({ id: ask.id, token: ask.token, choice: "Coffee" })).status).toBe(200);
      expect(await asked).toMatchObject({ client: "Phone", answer: "Coffee", how: "tap" });
      // And only once.
      expect((await answer({ id: ask.id, token: ask.token, choice: "Tea" })).status).toBe(410);
    } finally {
      service.close();
    }
  });
});

describe("messages for a client that is away", () => {
  it("keeps a message and says it when the client comes back", async () => {
    const capabilities: Capability[] = ["speaker", "screen"];
    const identity = await newPairedClient({ capabilities, name: "Kitchen" });

    const said = await invoke("vortex.axis.say", { text: "The oven is hot.", client: "Kitchen" });
    expect(said).toMatchObject({ client: "Kitchen", heard: false, shown: false, held: true });
    expect((await admin("GET", `/admin/clients/${identity.clientId}`)).body.waiting).toBe(1);

    const client = await connect(identity, { capabilities });
    await client.next("status");
    await finish(client);
    await expect.poll(async () => (await admin("GET", `/admin/clients/${identity.clientId}`)).body.waiting).toBe(0);
    const events = (await admin("GET", "/admin/activity")).body.events as { text: string }[];
    expect(events.some((e) => e.text === "Said a kept message on Kitchen now that it is back")).toBe(true);
  });
});

describe("saying something everywhere", () => {
  it("speaks on every device that can, or on those in one location", async () => {
    const den = await ready(["speaker"], { name: "Den" });
    const hall = await ready(["speaker"], { name: "Hall" });
    const panel = await ready(["screen"], { name: "Panel" });
    await admin("PATCH", `/admin/settings/device/${den.identity.clientId}`, { values: { location: "den" } });

    const everywhere = invoke("vortex.axis.say", { text: "Dinner.", everywhere: true });
    await Promise.all([finish(den.client), finish(hall.client)]);
    const all = await everywhere;
    expect(all.heard).toBe(true);
    expect(all.clients.map((c: any) => c.client).sort()).toEqual(["Den", "Hall"]);
    void panel;

    const inDen = invoke("vortex.axis.say", { text: "Den only.", everywhere: true, location: "Den" });
    await finish(den.client);
    expect((await inDen).clients).toMatchObject([{ client: "Den", heard: true }]);

    await expect(invoke("vortex.axis.say", { text: "x", everywhere: true, location: "attic" })).rejects.toThrow(/no client that can speak is online in "attic"/);
    await expect(invoke("vortex.axis.say", { text: "x", everywhere: true, client: "Den" })).rejects.toThrow(/not both/);
  });
});
