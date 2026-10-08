import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/** Gateway protocol version Axis speaks. */
export const GATEWAY_PROTOCOL = 4;

/**
 * Signed into every connect. Deliberately not "linux": the gateway takes a
 * Linux node host to be its own headless node, expects it to report the
 * gateway's version, and pins a device family that the operator link then has
 * to match. A platform it does not know is treated as a plain custom device.
 */
export const PLATFORM = "vortex-axis";

export type Role = "operator" | "node";

/**
 * `client.id` and `client.mode` are closed lists on the gateway. A descriptive
 * name is rejected before authentication is even looked at.
 */
export const CLIENT_KIND: Record<Role, { id: string; mode: string }> = {
  operator: { id: "cli", mode: "cli" },
  node: { id: "node-host", mode: "node" },
};

export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params: unknown;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: any;
  error?: { code?: string; message?: string; details?: { code?: string } };
}

export interface EventFrame {
  type: "event";
  event: string;
  payload?: any;
}

/** A request the gateway refused, or one that never got an answer. */
export class GatewayError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** The detailed code separates the stages cleanly; the message often names the wrong cause. */
export function errorCode(error: ResponseFrame["error"]): string {
  return error?.details?.code ?? error?.code ?? "UNKNOWN";
}

/** True for failures that mean the credential or pairing is wrong, not one method call. */
export function isAuthCode(code: string): boolean {
  return code.startsWith("AUTH_") || code.startsWith("DEVICE_AUTH_") || code === "PAIRING_REQUIRED";
}

/** The Ed25519 key that is this hub's identity on the gateway. */
export class DeviceIdentity {
  /** SHA-256 of the raw public key, in hex. */
  readonly deviceId: string;
  /** Raw 32-byte public key, base64. */
  readonly publicKey: string;

  private constructor(private readonly privateKey: KeyObject) {
    const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const raw = spki.subarray(spki.length - 32);
    this.deviceId = createHash("sha256").update(raw).digest("hex");
    this.publicKey = raw.toString("base64");
  }

  static generate(): DeviceIdentity {
    return new DeviceIdentity(generateKeyPairSync("ed25519").privateKey);
  }

  /** Restores an identity from the string `serialize` produced. */
  static restore(serialized: string): DeviceIdentity {
    return new DeviceIdentity(
      createPrivateKey({ key: Buffer.from(serialized, "base64"), type: "pkcs8", format: "der" }),
    );
  }

  serialize(): string {
    return this.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  }

  sign(payload: string): string {
    return sign(null, Buffer.from(payload, "utf8"), this.privateKey).toString("base64");
  }
}

/**
 * The text the device signs. The gateway rebuilds it from the fields it
 * received and compares bytes, so a field that is not sent is signed as "".
 * A bootstrap or device token is signed; a password never is.
 */
export function authPayload(input: {
  deviceId: string;
  role: Role;
  scopes: readonly string[];
  signedAtMs: number;
  token: string;
  nonce: string;
}): string {
  const kind = CLIENT_KIND[input.role];
  return [
    "v3",
    input.deviceId,
    kind.id,
    kind.mode,
    input.role,
    input.scopes.join(","),
    String(input.signedAtMs),
    input.token,
    input.nonce,
    PLATFORM,
    "", // deviceFamily is not sent
  ].join("|");
}

export interface SetupCode {
  bootstrapToken: string;
  /** Gateway addresses the code advertises, primary first. */
  urls: string[];
}

/** Decodes a setup code from `openclaw qr`: base64url JSON holding a token and addresses. */
export function decodeSetupCode(raw: string): SetupCode {
  let code = raw.trim();
  const scheme = code.indexOf("://");
  if (scheme >= 0) code = code.slice(scheme + 3);
  code = code.replace(/\/+$/, "");
  if (!code) throw new Error("setup code is empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  } catch {
    throw new Error("setup code is not valid: it should be the text `openclaw qr --setup-code-only` prints");
  }
  const doc = parsed as { bootstrapToken?: unknown; url?: unknown; urls?: unknown };
  if (typeof doc.bootstrapToken !== "string" || !doc.bootstrapToken) {
    throw new Error("setup code has no bootstrap token");
  }
  const urls: string[] = [];
  if (typeof doc.url === "string" && doc.url) urls.push(doc.url);
  if (Array.isArray(doc.urls)) {
    for (const url of doc.urls) if (typeof url === "string" && url && !urls.includes(url)) urls.push(url);
  }
  return { bootstrapToken: doc.bootstrapToken, urls };
}

/** Turns an http(s) or ws(s) address into the WebSocket address of the gateway. */
export function toSocketUrl(url: string): string {
  const parsed = new URL(url.includes("://") ? url : `ws://${url}`);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error(`unsupported gateway address: ${url}`);
  return parsed.toString();
}
