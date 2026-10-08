import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Tokens and pairing codes are stored only as SHA-256 hashes. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Long-lived client token: 32 random bytes. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** One-time pairing code a person can read out or type, like "483-221". */
export function newPairingCode(): string {
  const digits = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

/** Codes are compared without separators or spaces. */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, "");
}

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function newClientId(): string {
  let id = "c_";
  for (let i = 0; i < 10; i++) id += ID_ALPHABET[randomInt(0, ID_ALPHABET.length)];
  return id;
}
