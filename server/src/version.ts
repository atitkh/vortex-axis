import { readFileSync } from "node:fs";

/**
 * Which Axis this is. The number is the one in the repository's top-level
 * `package.json`, the only place it is written: the server and the web pages
 * ship together in one container, so they share it. The commit says exactly
 * which build, when the build was told (`AXIS_COMMIT`, set by `npm run deploy`).
 *
 * This is not the protocol's version (`PROTOCOL_VERSION`, a single
 * whole number that only changes when devices and Axis must change how they
 * talk), and not a firmware version, which each device type counts for itself.
 */
function read(): string {
  try {
    // From server/src or server/dist alike, the top-level package.json is two folders up.
    const found = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof found.version === "string" && found.version ? found.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const AXIS_VERSION = read();
export const AXIS_COMMIT = (process.env.AXIS_COMMIT ?? "").trim().slice(0, 12);
