import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";
import type { Store } from "./store.js";

/**
 * Web Push: how Axis reaches a browser client whose page is closed. The
 * browser gives the page a subscription (an address at the browser maker's
 * push service, and two keys); Axis encrypts a small message to those keys and
 * posts it to that address, signed with its own key pair so the push service
 * knows who is sending. The browser wakes the page's service worker, which
 * shows a notification. Nothing but the encrypted message leaves Axis.
 *
 * RFC 8291 (the encryption), RFC 8188 (the `aes128gcm` framing) and RFC 8292
 * (VAPID, the signature) are implemented here with Node's own crypto; there is
 * no dependency.
 */

export interface PushSubscription {
  endpoint: string;
  /** The browser's public key, base64url, 65 bytes uncompressed. */
  p256dh: string;
  /** The shared secret the browser chose, base64url, 16 bytes. */
  auth: string;
}

/** What the service worker is given to show. */
export interface PushMessage {
  title: string;
  body: string;
  /** Groups notifications: a newer one with the same tag replaces the older. */
  tag?: string;
  /** A question with choices: the worker offers them as buttons where the system allows. */
  ask?: { id: string; token: string; question: string; choices: string[] };
}

export type PushOutcome = "sent" | "gone" | "failed";

const b64url = (data: Buffer): string => data.toString("base64url");
const fromB64url = (text: string): Buffer => Buffer.from(text, "base64url");

const VAPID_META = "push_vapid";

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/**
 * Encrypts `plaintext` to a subscription. Returns the request body, already
 * framed as one `aes128gcm` record. Exported for the tests, which decrypt it
 * the way a browser would.
 */
export function encryptPush(subscription: PushSubscription, plaintext: Buffer): Buffer {
  const theirPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  if (theirPublic.length !== 65 || authSecret.length !== 16) throw new Error("the subscription's keys are not the right size");

  const ours = createECDH("prime256v1");
  ours.generateKeys();
  const ourPublic = ours.getPublicKey();
  const shared = ours.computeSecret(theirPublic);

  // RFC 8291, section 3.4: mix the shared secret with the browser's own secret and both public keys.
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), theirPublic, ourPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);

  const salt = randomBytes(16);
  const key = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  // One record: the text, then 0x02 to say it is the last.
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(ourPublic.length, 20);
  return Buffer.concat([header, ourPublic, sealed]);
}

/** Axis's own key pair for push, made once and kept with the rest of its data. */
interface Vapid {
  publicKey: string;
  privateKey: string;
}

export class PushService {
  private readonly vapid: Vapid;

  constructor(
    private readonly store: Store,
    /** Who the push service may contact about this sender: an https address or a mailto. */
    private readonly contact: string,
    private readonly log: (line: string) => void = () => {},
    private readonly send: typeof fetch = fetch,
  ) {
    const saved = store.getMeta(VAPID_META);
    if (saved) this.vapid = JSON.parse(saved) as Vapid;
    else {
      const pair = createECDH("prime256v1");
      pair.generateKeys();
      this.vapid = { publicKey: b64url(pair.getPublicKey()), privateKey: b64url(pair.getPrivateKey()) };
      store.setMeta(VAPID_META, JSON.stringify(this.vapid));
    }
  }

  /** The key a browser needs to subscribe. It is public. */
  publicKey(): string {
    return this.vapid.publicKey;
  }

  /** The signed header that tells a push service who is sending (RFC 8292). */
  private authorization(endpoint: string): string {
    const part = (value: object) => b64url(Buffer.from(JSON.stringify(value)));
    const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: this.contact,
    })}`;
    const publicKey = fromB64url(this.vapid.publicKey);
    const key = createPrivateKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        d: this.vapid.privateKey,
        x: b64url(publicKey.subarray(1, 33)),
        y: b64url(publicKey.subarray(33, 65)),
      },
    });
    const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
    return `vapid t=${unsigned}.${b64url(signature)}, k=${this.vapid.publicKey}`;
  }

  has(clientId: string): boolean {
    return this.store.getPushSubscription(clientId) !== undefined;
  }

  /**
   * Sends a notification to a client's browser. "gone" means the browser has
   * dropped the subscription (the person turned notifications off, or removed
   * the app); it is forgotten here too.
   */
  async notify(clientId: string, message: PushMessage, ttlSeconds = 3600): Promise<PushOutcome> {
    const subscription = this.store.getPushSubscription(clientId);
    if (!subscription) return "failed";
    try {
      const body = encryptPush(subscription, Buffer.from(JSON.stringify(message)));
      const res = await this.send(subscription.endpoint, {
        method: "POST",
        headers: {
          authorization: this.authorization(subscription.endpoint),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(ttlSeconds),
          urgency: "high",
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel();
      if (res.status === 404 || res.status === 410) {
        this.store.setPushSubscription(clientId, undefined);
        this.log(`push: ${clientId}'s browser has dropped its subscription`);
        return "gone";
      }
      if (!res.ok) {
        this.log(`push: the push service answered ${res.status} for ${clientId}`);
        return "failed";
      }
      return "sent";
    } catch (error) {
      this.log(`push: could not reach the push service for ${clientId}: ${(error as Error).message}`);
      return "failed";
    }
  }
}
