import type { Timers } from "./timers.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PAIR_PATH, isPairRequest, type PairResponse, type Scalar, type ScalarMap } from "@vortex-axis/protocol";
import type { Activity } from "./activity.js";
import type { Delivery } from "./delivery.js";
import type { HomeAssistant } from "./homeassistant.js";
import { publicHubSettings, saveHubSettings } from "./hubconfig.js";
import type { Live } from "./live.js";
import type { PushService } from "./push.js";
import type { Config } from "./config.js";
import type { GatewayClient } from "./gateway/client.js";
import { FirmwareStore, MAX_FIRMWARE_BYTES } from "./firmware.js";
import { MAX_WAKE_WORD_BYTES, type WakeWordStore, type WakeWordSync } from "./wakewords.js";
import type { Hub } from "./hub.js";
import { withBuiltIns, settingProblem, type ClientSchema } from "./schema.js";
import type { SettingsScope, Store } from "./store.js";
import type { Services } from "./turns.js";
import { loadRuntimeConfig, publicRuntimeConfig, saveRuntimeConfig, testChatAgent, testServices } from "./upstream.js";

const MAX_BODY_BYTES = 64 * 1024;
const PAIR_ATTEMPTS_PER_MINUTE = 10;
/** Wrong pairing codes, from anywhere, before every unused code is thrown away. A code has a million values. */
const PAIR_FAILURES_BEFORE_RESET = 30;
/** Wrong admin tokens from one address before it is shut out for a while. */
const ADMIN_FAILURES = 10;
const ADMIN_LOCK_MS = 5 * 60_000;
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
/** The pages load only their own files and talk only to Axis. Inline styles are used by the admin page. */
const PAGE_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function isScalarMap(value: unknown): value is ScalarMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      key.length > 0 &&
      key.length <= 64 &&
      (entry === null ||
        typeof entry === "boolean" ||
        (typeof entry === "number" && Number.isFinite(entry)) ||
        (typeof entry === "string" && entry.length <= 512)),
  );
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/** Reads the web pages into memory once. Only files in this flat list can ever be served. */
function loadWebFiles(dir: string | undefined): Map<string, { type: string; body: Buffer }> {
  const files = new Map<string, { type: string; body: Buffer }>();
  if (!dir) return files;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    const type = CONTENT_TYPES[extname(name)];
    if (type && /^[\w.-]+$/.test(name)) files.set(name, { type, body: readFileSync(join(dir, name)) });
  }
  stampWebFiles(files);
  return files;
}

/** The stamp put on every address a page loads its own files by. Changes whenever any web file does. */
let webVersion = "";

/**
 * Makes every reference from one web file to another carry a stamp of the
 * current build (`/web/client.js?v=3f9a…`). A proxy or a phone may keep
 * scripts and styles for hours whatever the server says; with the stamp, a
 * new build is a new address, so the page that is always fetched fresh brings
 * fresh scripts with it.
 */
function stampWebFiles(files: Map<string, { type: string; body: Buffer }>): void {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) hash.update(name).update(files.get(name)!.body);
  webVersion = hash.digest("hex").slice(0, 12);
  for (const [name, file] of files) {
    if (!/\.(html|js|css|webmanifest)$/.test(name)) continue;
    const stamped = file.body
      .toString()
      .replace(/(\/web\/[\w.-]+\.(?:js|css|png)|\/sw\.js|\/manifest\.webmanifest)(?=["'`)\s])/g, `$1?v=${webVersion}`);
    files.set(name, { type: file.type, body: Buffer.from(stamped) });
  }
}

export interface HttpDeps {
  config: Config;
  store: Store;
  hub: Hub;
  /** Turns, connections and changes, for the activity and overview pages. */
  activity?: Activity;
  /** Turns and wake words as they happen, for the Live view. */
  live?: Live;
  /** The link to Home Assistant as it is now, when one is set up. It is rebuilt when its settings change. */
  homeAssistant?: () => HomeAssistant | undefined;
  /** Carries saved hub settings to the parts of Axis that use them. */
  applyHubSettings?: (changed: { mqtt: boolean }) => void;
  /** When this process started, for uptime. */
  startedAt?: number;
  version?: string;
  gateway: GatewayClient;
  services: Services;
  /** Wake word models, and the thing that keeps devices on the one their settings choose. */
  wakeWords?: WakeWordStore;
  wakeWordSync?: WakeWordSync;
  /** Timers agents set, shown and cancelled on the admin page. */
  timers?: Timers;
  /** Notifications to browser clients whose page is closed. */
  push?: PushService;
  delivery?: Delivery;
  /** Rebuilds the upstream clients after the saved settings changed. */
  reloadServices: () => void;
  now?: () => number;
}

/** Builds the request handler for pairing, health and the admin API. */
export function createHttpHandler(deps: HttpDeps) {
  const { config, store, hub, gateway, services, activity } = deps;
  const startedAt = deps.startedAt ?? Date.now();
  const web = loadWebFiles(config.webDir);
  const now = deps.now ?? Date.now;
  const pairAttempts = new Map<string, number[]>();
  const firmware = new FirmwareStore(config.dataDir);
  const wakeIds = () => (deps.wakeWords?.list() ?? []).map((word) => word.id);

  function allowPairAttempt(address: string): boolean {
    const cutoff = now() - 60_000;
    const recent = (pairAttempts.get(address) ?? []).filter((at) => at > cutoff);
    if (recent.length >= PAIR_ATTEMPTS_PER_MINUTE) {
      pairAttempts.set(address, recent);
      return false;
    }
    recent.push(now());
    pairAttempts.set(address, recent);
    return true;
  }

  /**
   * Who is asking. Behind a reverse proxy every connection comes from the
   * proxy, so its `X-Forwarded-For` is used, but only when the connection
   * really is from a proxy named in AXIS_TRUSTED_PROXIES. Anyone else could
   * write whatever they like in that header.
   */
  function addressOf(req: IncomingMessage): string {
    const peer = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    if (!config.trustedProxies.includes(peer)) return peer;
    const forwarded = String(req.headers["x-forwarded-for"] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    // The last entry is the one the trusted proxy added itself.
    return forwarded.at(-1) ?? peer;
  }

  /** True when the request came in under a public name, where only the client side is served. */
  function isPublic(req: IncomingMessage): boolean {
    if (!config.publicHosts.length) return false;
    const names = [req.headers.host, req.headers["x-forwarded-host"]]
      .flatMap((value) => String(value ?? "").split(","))
      .map((value) => value.trim().toLowerCase().replace(/:\d+$/, ""))
      .filter(Boolean);
    return names.some((name) => config.publicHosts.includes(name));
  }

  const adminFailures = new Map<string, { count: number; until: number }>();
  let pairFailures: number[] = [];

  function requireAdmin(req: IncomingMessage): void {
    if (!config.adminToken) throw new HttpError(503, "admin API is disabled: AXIS_ADMIN_TOKEN is not set");
    const address = addressOf(req);
    const record = adminFailures.get(address);
    if (record && record.count >= ADMIN_FAILURES) {
      if (now() < record.until) throw new HttpError(429, "too many wrong admin tokens from this address, wait five minutes");
      adminFailures.delete(address);
    }
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    const expected = Buffer.from(config.adminToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      // A request with no token at all is the sign-in page asking, not a guess.
      if (given.length) {
        const failed = adminFailures.get(address) ?? { count: 0, until: 0 };
        failed.count += 1;
        failed.until = now() + ADMIN_LOCK_MS;
        adminFailures.set(address, failed);
        if (failed.count === ADMIN_FAILURES) activity?.note("admin", "", `Ten wrong admin tokens from ${address}; that address is shut out for five minutes`, "warn");
        if (adminFailures.size > 5000) adminFailures.clear();
      }
      throw new HttpError(401, "missing or wrong admin token");
    }
    adminFailures.delete(address);
  }

  /** A wrong pairing code. Enough of them, from anywhere, and every unused code is thrown away. */
  function pairingFailed(address: string): void {
    const cutoff = now() - config.pairingCodeTtlMs;
    pairFailures = pairFailures.filter((at) => at > cutoff);
    pairFailures.push(now());
    if (pairFailures.length < PAIR_FAILURES_BEFORE_RESET) return;
    pairFailures = [];
    const dropped = store.clearPairingCodes();
    if (dropped) {
      activity?.note("admin", "", `${PAIR_FAILURES_BEFORE_RESET} wrong pairing codes (last from ${address}); ${dropped} unused ${dropped === 1 ? "code was" : "codes were"} thrown away. Make a new one.`, "warn");
    }
  }

  function describeClient(id: string) {
    const client = store.getClient(id);
    if (!client) throw new HttpError(404, "no such client");
    const session = hub.session(id);
    return {
      ...client,
      online: Boolean(session),
      settings: store.resolveSettings(client),
      // The three layers separately, so the editor can show which one a value comes from.
      layers: {
        global: store.getLayer("global", ""),
        type: store.getLayer("type", client.type),
        device: store.getLayer("device", client.id),
      },
      readings: session?.readings ?? {},
      address: session?.address ?? null,
      // Whether it can be reached with its page closed, and what is being kept for it while it is away.
      notifications: deps.push?.has(id) ?? false,
      waiting: deps.delivery?.waitingFor(id) ?? 0,
    };
  }

  /** The schema for each client type that exists, built-ins included. */
  /**
   * What each client type in use offers, with the name a person gave it. The
   * type itself is the firmware's own identifier: settings, firmware builds
   * and the firmware all go by it, so only this display name can be changed.
   */
  function typeSchemas(): Record<string, ClientSchema & { label?: string }> {
    const out: Record<string, ClientSchema & { label?: string }> = {};
    for (const client of store.listClients()) {
      if (out[client.type]) continue;
      const label = store.getMeta(`type_label:${client.type}`);
      out[client.type] = { ...withBuiltIns(store.getSchema(client.type), wakeIds()), ...(label ? { label } : {}) };
    }
    return out;
  }

  /** What the backup script last left in the data folder, if it has ever run against it. */
  function backupStatus() {
    try {
      const told = JSON.parse(readFileSync(join(config.dataDir, "backup-status.json"), "utf8")) as { at?: unknown; ok?: unknown; to?: unknown; note?: unknown };
      const at = Date.parse(String(told.at ?? ""));
      if (!Number.isFinite(at)) return null;
      return { at, ok: told.ok === true, to: String(told.to ?? ""), note: String(told.note ?? "") };
    } catch {
      return null;
    }
  }

  function requireOnline(id: string) {
    const client = store.getClient(id);
    if (!client) throw new HttpError(404, "no such client");
    const session = hub.session(id);
    if (!session) throw new HttpError(409, `${client.name} is offline`);
    return { client, session };
  }

  /** Refuses a value the client's own schema does not allow. Unknown keys are allowed. */
  function checkAgainstSchema(type: string, values: Record<string, unknown>) {
    const schema = withBuiltIns(store.getSchema(type), wakeIds());
    for (const [key, value] of Object.entries(values)) {
      const def = schema.settings.find((s) => s.key === key);
      const problem = def ? settingProblem(def, value as Scalar) : undefined;
      if (problem) throw new HttpError(400, problem);
    }
  }

  async function patchSettings(req: IncomingMessage, scope: SettingsScope, scopeId: string) {
    const body = (await readJson(req)) as { values?: unknown };
    if (!isScalarMap(body.values)) {
      throw new HttpError(400, "body must be { values: { key: string | number | boolean | null } }");
    }
    if (scope === "device") {
      const client = store.getClient(scopeId);
      if (!client) throw new HttpError(404, "no such client");
      checkAgainstSchema(client.type, body.values);
    }
    if (scope === "type") checkAgainstSchema(scopeId, body.values);
    const before = store.getLayer(scope, scopeId);
    const version = store.patchLayer(scope, scopeId, body.values);
    recordSettingsChange(scope, scopeId, before, body.values);
    hub.pushSettings();
    return { version, values: store.getLayer(scope, scopeId) };
  }

  /** Notes a settings change in the event list, old value to new, so it can be traced later. */
  function recordSettingsChange(scope: SettingsScope, scopeId: string, before: ScalarMap, values: ScalarMap) {
    if (!activity) return;
    const show = (v: Scalar | undefined) => (v === undefined || v === null ? "unset" : JSON.stringify(v));
    const changes = Object.entries(values)
      .filter(([key, value]) => (before[key] ?? null) !== value)
      .map(([key, value]) => (value === null ? `${key} back to shared (was ${show(before[key])})` : `${key} ${show(before[key])} → ${show(value)}`));
    if (!changes.length) return;
    const where =
      scope === "global" ? "All devices"
      : scope === "type" ? `All ${scopeId} devices`
      : store.getClient(scopeId)?.name ?? scopeId;
    activity.note("settings", scope === "global" ? "" : scopeId, `${where}: ${changes.join("; ")}`);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://axis");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }

    // The stamp of the web files being served, so an open page can tell it has been replaced.
    if (method === "GET" && url.pathname === "/v1/web-version") return sendJson(res, 200, { version: webVersion });

    // The pages themselves hold no secrets. Everything they do goes through
    // the same endpoints, with the same checks, as any other caller.
    if (method === "GET") {
      const file =
        url.pathname === "/" ? web.get("index.html")
        : url.pathname === "/admin" ? (isPublic(req) ? undefined : web.get("admin.html"))
        : parts.length === 2 && parts[0] === "web" ? web.get(parts[1]!)
        // The service worker has to live at the top to be allowed to act for the whole web client.
        : url.pathname === "/sw.js" ? web.get("sw.js")
        : url.pathname === "/manifest.webmanifest" ? web.get("manifest.webmanifest")
        : undefined;
      if (file) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "content-security-policy": PAGE_POLICY,
          "content-type": file.type,
          "content-length": file.body.length,
          // A stamped address never changes what it means, so it may be kept for good; anything else is checked every time.
          "cache-control": url.searchParams.get("v") === webVersion ? "public, max-age=31536000, immutable" : "no-cache",
        });
        res.end(file.body);
        return;
      }
    }

    // A device fetching the firmware Axis told it to install. It proves who it is with its own token.
    if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "firmware") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const client = store.authenticate(String(req.headers["x-axis-client"] ?? ""), token);
      if (!client) throw new HttpError(401, "unknown client or wrong token");
      const info = client.type === parts[2] ? firmware.info(client.type) : undefined;
      if (!info) throw new HttpError(404, "there is no firmware for this client type");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": info.size, "x-md5": info.md5 });
      createReadStream(firmware.path(info.type, info.version)).pipe(res);
      return;
    }

    // A client with a cancel button on its countdown, cancelling the timer it is showing.
    if (method === "POST" && url.pathname === "/v1/timers/cancel" && deps.timers) {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const client = store.authenticate(String(req.headers["x-axis-client"] ?? ""), token);
      if (!client) throw new HttpError(401, "unknown client or wrong token");
      const body = (await readJson(req)) as { id?: unknown };
      if (typeof body.id !== "number") throw new HttpError(400, "say which timer: id");
      const gone = deps.timers.cancel({ id: body.id });
      if (gone.length) activity?.note("timer", client.id, `Timer "${gone[0]!.label || "Timer"}" cancelled from ${client.name}`);
      return sendJson(res, 200, { cancelled: gone.length });
    }

    // --- notifications for a browser client whose page is closed ---
    if (parts.length === 3 && parts[0] === "v1" && parts[1] === "push" && deps.push) {
      // The key a browser needs before it can subscribe. It is public.
      if (method === "GET" && parts[2] === "key") return sendJson(res, 200, { key: deps.push.publicKey() });

      // A browser client handing over, or withdrawing, the address its browser can be reached at.
      if (parts[2] === "subscription" && (method === "POST" || method === "DELETE")) {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
        const client = store.authenticate(String(req.headers["x-axis-client"] ?? ""), token);
        if (!client) throw new HttpError(401, "unknown client or wrong token");
        if (method === "DELETE") {
          store.setPushSubscription(client.id, undefined);
          activity?.note("client", client.id, `${client.name} turned notifications off`);
          return sendJson(res, 200, { notifications: false });
        }
        const body = (await readJson(req)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
        const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
        const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
        const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
        let target: URL | undefined;
        try {
          target = new URL(endpoint);
        } catch {
          target = undefined;
        }
        // Axis will post to this address, so it must be a push service on the open web, not something inside the network.
        if (!target || target.protocol !== "https:" || endpoint.length > 2000 || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth)) {
          throw new HttpError(400, "that is not a push subscription");
        }
        const fresh = !deps.push.has(client.id);
        store.setPushSubscription(client.id, { endpoint, p256dh, auth });
        if (fresh) activity?.note("client", client.id, `${client.name} turned notifications on`);
        return sendJson(res, 200, { notifications: true });
      }

      // A browser client asking which questions are waiting for it, on being opened.
      if (method === "GET" && parts[2] === "asks" && deps.delivery) {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
        const client = store.authenticate(String(req.headers["x-axis-client"] ?? ""), token);
        if (!client) throw new HttpError(401, "unknown client or wrong token");
        return sendJson(res, 200, { asks: deps.delivery.openAsks(client.id), messages: deps.delivery.takeNotified(client.id) });
      }

      // A choice picked from a notification. The one-time token in the notification is what proves the answer is real.
      if (method === "POST" && parts[2] === "answer" && deps.delivery) {
        const body = (await readJson(req)) as { id?: unknown; token?: unknown; choice?: unknown };
        const taken = deps.delivery.answer(String(body.id ?? ""), String(body.token ?? ""), String(body.choice ?? ""));
        if (!taken) throw new HttpError(410, "that question is no longer open");
        return sendJson(res, 200, { answered: true });
      }
    }

    // A device fetching the wake word its settings chose, again with its own token.
    if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "wakewords") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      if (!store.authenticate(String(req.headers["x-axis-client"] ?? ""), token)) throw new HttpError(401, "unknown client or wrong token");
      const word = deps.wakeWords?.get(parts[2]!);
      if (!word) throw new HttpError(404, "there is no such wake word");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": word.size, "x-md5": word.md5 });
      createReadStream(deps.wakeWords!.path(word.id)).pipe(res);
      return;
    }

    if (method === "POST" && url.pathname === PAIR_PATH) {
      if (!allowPairAttempt(addressOf(req))) {
        throw new HttpError(429, "too many pairing attempts, wait a minute");
      }
      const body = await readJson(req);
      if (!isPairRequest(body)) throw new HttpError(400, "invalid pairing request");
      const paired = store.pair(body);
      if (!paired) {
        pairingFailed(addressOf(req));
        throw new HttpError(403, "pairing code is wrong, expired or already used");
      }
      const reply: PairResponse = { clientId: paired.client.id, token: paired.token, name: paired.client.name };
      activity?.note("admin", paired.client.id, `${paired.client.name} paired (${paired.client.type})`);
      return sendJson(res, 200, reply);
    }

    if (parts[0] === "admin") {
      // Under a public name the admin side does not exist. It is reached on the local network only.
      if (isPublic(req)) throw new HttpError(404, "not found");
      requireAdmin(req);

      if (method === "POST" && parts.length === 2 && parts[1] === "pairing-codes") {
        return sendJson(res, 201, store.createPairingCode(config.pairingCodeTtlMs));
      }
      if (method === "GET" && parts.length === 2 && parts[1] === "clients") {
        return sendJson(res, 200, {
          clients: store.listClients().map((client) => describeClient(client.id)),
          types: typeSchemas(),
        });
      }
      if (method === "POST" && parts.length === 5 && parts[1] === "clients" && parts[3] === "commands") {
        const { client, session } = requireOnline(parts[2]!);
        const name = parts[4]!;
        const allowed = withBuiltIns(store.getSchema(client.type)).actions.some((a) => a.name === name);
        if (!allowed) throw new HttpError(400, `${client.name} does not offer "${name}"`);
        try {
          return sendJson(res, 200, await hub.command(session, name));
        } catch (error) {
          throw new HttpError(504, (error as Error).message);
        }
      }
      if (method === "POST" && parts.length === 4 && parts[1] === "clients" && parts[3] === "announce") {
        const { client, session } = requireOnline(parts[2]!);
        const body = (await readJson(req)) as { text?: unknown };
        if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "body must be { text: string }");
        if (!client.capabilities.includes("speaker") && !client.capabilities.includes("screen")) {
          throw new HttpError(400, `${client.name} can neither speak nor show text`);
        }
        try {
          return sendJson(res, 200, await hub.say(session, body.text.trim().slice(0, 1000)));
        } catch (error) {
          throw new HttpError(409, (error as Error).message);
        }
      }
      if (parts.length === 3 && parts[1] === "clients") {
        const id = parts[2]!;
        if (method === "GET") return sendJson(res, 200, describeClient(id));
        if (method === "PATCH") {
          const body = (await readJson(req)) as { name?: unknown };
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name || name.length > 60) throw new HttpError(400, "name must be 1 to 60 characters");
          const renamed = store.renameClient(id, name);
          if (renamed === "taken") throw new HttpError(409, `another client is already called ${name}`);
          if (!renamed) throw new HttpError(404, "no such client");
          // A connected client keeps its record in its session; the next turn's header uses the new name.
          const session = hub.session(id);
          if (session) session.client = renamed;
          activity?.note("admin", id, `Renamed to ${renamed.name}`);
          return sendJson(res, 200, describeClient(id));
        }
        if (method === "DELETE") {
          const removing = store.getClient(id);
          if (!store.removeClient(id)) throw new HttpError(404, "no such client");
          activity?.note("admin", id, `${removing?.name ?? id} removed`, "warn");
          hub.disconnect(id);
          return sendJson(res, 200, { removed: id });
        }
      }
      if (method === "PATCH" && parts.length === 3 && parts[1] === "types") {
        const type = parts[2]!;
        if (!store.listClients().some((client) => client.type === type)) throw new HttpError(404, "no device of that type is paired");
        const body = (await readJson(req)) as { label?: unknown };
        const label = typeof body.label === "string" ? body.label.trim() : "";
        if (label.length > 60) throw new HttpError(400, "a name can be at most 60 characters");
        // An empty name goes back to showing the type itself.
        store.setMeta(`type_label:${type}`, label || undefined);
        activity?.note("admin", "", label ? `Client type ${type} is now shown as "${label}"` : `Client type ${type} is shown by its own name again`);
        return sendJson(res, 200, { type, label: label || null });
      }
      // Wake words: one model per phrase, chosen per device with the wakeWord setting.
      if (parts[1] === "wakewords" && deps.wakeWords) {
        const words = deps.wakeWords;
        const id = parts[2] ?? "";
        if (method === "GET" && parts.length === 2) {
          // Which online devices each one is in use on, as their settings stand.
          const users = new Map<string, string[]>();
          for (const session of hub.sessions()) {
            if (!session.client.capabilities.includes("mic")) continue;
            const chosen = deps.wakeWordSync?.chosen(session)?.id ?? "built-in";
            users.set(chosen, [...(users.get(chosen) ?? []), session.client.name]);
          }
          return sendJson(res, 200, {
            wakeWords: words.list().map((word) => ({ ...word, usedBy: users.get(word.id) ?? [] })),
            builtInUsedBy: users.get("built-in") ?? [],
          });
        }
        if (method === "POST" && parts.length === 2) {
          try {
            const word = words.save(
              {
                name: url.searchParams.get("name") ?? "",
                cutoff: Number(url.searchParams.get("cutoff") ?? 90),
                window: Number(url.searchParams.get("window") ?? 5),
              },
              await readBytes(req, MAX_WAKE_WORD_BYTES),
            );
            activity?.note("admin", "", `Wake word "${word.name}" stored`);
            deps.wakeWordSync?.tellAll();
            return sendJson(res, 201, word);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, (error as Error).message);
          }
        }
        if (method === "GET" && parts.length === 3) {
          const word = words.get(id);
          if (!word) throw new HttpError(404, "there is no such wake word");
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            "content-type": "application/octet-stream",
            "content-length": word.size,
            "content-disposition": `attachment; filename="${word.id}.tflite"`,
          });
          createReadStream(words.path(word.id)).pipe(res);
          return;
        }
        if (method === "PATCH" && parts.length === 3) {
          const body = (await readJson(req)) as { cutoff?: unknown; window?: unknown };
          try {
            const word = words.tune(id, {
              cutoff: typeof body.cutoff === "number" ? body.cutoff : undefined,
              window: typeof body.window === "number" ? body.window : undefined,
            });
            if (!word) throw new HttpError(404, "there is no such wake word");
            activity?.note("admin", "", `Wake word "${word.name}": cutoff ${word.cutoff} %, window ${word.window}`);
            deps.wakeWordSync?.tellAll();
            return sendJson(res, 200, word);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, (error as Error).message);
          }
        }
        if (method === "DELETE" && parts.length === 3) {
          const word = words.get(id);
          if (!word || !words.remove(id)) throw new HttpError(404, "there is no such wake word");
          activity?.note("admin", "", `Wake word "${word.name}" removed; devices that used it go back to their built-in one`);
          deps.wakeWordSync?.tellAll();
          return sendJson(res, 200, { removed: id });
        }
      }
      // Firmware: the last few builds kept per client type, one of them current, sent to devices over Wi-Fi.
      if (parts[1] === "firmware") {
        const type = parts[2] ?? "";
        const version = parts[3] ?? "";
        if (method === "GET" && parts.length === 2) {
          const shelves = firmware.shelves();
          return sendJson(res, 200, {
            // The current build of each type, for callers that only want to know what devices get.
            firmware: shelves.map((shelf) => shelf.builds.find((b) => b.version === shelf.current)!),
            shelves,
          });
        }
        if (method === "POST" && parts.length === 3) {
          try {
            const info = firmware.save(type, url.searchParams.get("version") ?? "", await readBytes(req, MAX_FIRMWARE_BYTES));
            activity?.note("admin", "", `Firmware ${info.version} uploaded for ${info.type}; it is now the one devices are sent`);
            return sendJson(res, 201, info);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, (error as Error).message);
          }
        }
        // A copy of a build, for keeping elsewhere or flashing by cable.
        if (method === "GET" && parts.length === 4) {
          const info = firmware.build(type, version);
          if (!info) throw new HttpError(404, "there is no such build");
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            "content-type": "application/octet-stream",
            "content-length": info.size,
            "content-disposition": `attachment; filename="${info.type}-${info.version}.bin"`,
          });
          createReadStream(firmware.path(info.type, info.version)).pipe(res);
          return;
        }
        // Chooses the build devices are sent. Going back to an older one is this, then an update.
        if (method === "PUT" && parts.length === 5 && parts[4] === "current") {
          if (!firmware.setCurrent(type, version)) throw new HttpError(404, "there is no such build");
          activity?.note("admin", "", `Firmware for ${type}: devices are now sent ${version}`);
          return sendJson(res, 200, firmware.shelf(type));
        }
        if (method === "DELETE" && parts.length === 4) {
          if (!firmware.removeBuild(type, version)) throw new HttpError(404, "there is no such build");
          activity?.note("admin", "", `Firmware ${version} for ${type} removed`);
          return sendJson(res, 200, firmware.shelf(type));
        }
        if (method === "DELETE" && parts.length === 3) {
          if (!firmware.remove(type)) throw new HttpError(404, "there is no firmware for that client type");
          activity?.note("admin", "", `All firmware for ${type} removed`);
          return sendJson(res, 200, { removed: type });
        }
      }
      // Sends a browser client a notification whether or not its page is open, to see that notifications reach it.
      if (method === "POST" && parts.length === 4 && parts[1] === "clients" && parts[3] === "notify-test") {
        const client = store.getClient(parts[2]!);
        if (!client) throw new HttpError(404, "no such client");
        if (!deps.push?.has(client.id)) throw new HttpError(409, `${client.name} has not turned notifications on`);
        const outcome = await deps.push.notify(client.id, { title: "Vortex", body: `Test notification for ${client.name}.`, tag: "test" });
        if (outcome === "gone") throw new HttpError(409, `${client.name}'s browser has dropped its subscription. Turn notifications on there again.`);
        if (outcome !== "sent") throw new HttpError(502, "the browser's push service did not take it. The Axis log says why.");
        activity?.note("admin", client.id, `Test notification sent to ${client.name}`);
        return sendJson(res, 200, { sent: client.name });
      }

      // Returns a device to how it was before it was set up, and forgets it here too. Only from the admin page.
      if (method === "POST" && parts.length === 4 && parts[1] === "clients" && parts[3] === "reset") {
        const { client, session } = requireOnline(parts[2]!);
        const body = (await readJson(req)) as { wifi?: unknown };
        const wifi = body.wifi === true;
        let outcome;
        try {
          outcome = await hub.command(session, "reset", { wifi: wifi ? 1 : 0 });
        } catch (error) {
          throw new HttpError(504, (error as Error).message);
        }
        if (!outcome.ok) throw new HttpError(409, `${client.name} cannot reset itself (${outcome.error ?? "refused"}). Its firmware may be too old; remove it here and reset it by cable.`);
        // The device has thrown its token away, so its record here is of no more use.
        store.removeClient(client.id);
        hub.disconnect(client.id);
        activity?.note("admin", client.id, `${client.name} reset (${wifi ? "pairing, settings and Wi-Fi" : "pairing and settings"}) and removed`, "warn");
        return sendJson(res, 200, { reset: client.name, wifi });
      }
      // Moves a device to another address for Axis, keeping its pairing. Only here: agents have no way to send it.
      if (method === "POST" && parts.length === 4 && parts[1] === "clients" && parts[3] === "address") {
        const { client, session } = requireOnline(parts[2]!);
        const body = (await readJson(req)) as { address?: unknown };
        const given = typeof body.address === "string" ? body.address.trim() : "";
        let target: URL;
        try {
          target = new URL(/^https?:\/\//i.test(given) ? given : `http://${given}`);
        } catch {
          throw new HttpError(400, "give an address such as https://axis.example.org or 10.0.0.6:8440");
        }
        if (!given || !["http:", "https:"].includes(target.protocol) || target.username || target.search || target.hash || !["", "/"].includes(target.pathname)) {
          throw new HttpError(400, "give only the address: http or https, a host, and a port if it is not the usual one");
        }
        const url = `${target.protocol}//${target.host}`;
        let outcome;
        try {
          outcome = await hub.command(session, "address", { url });
        } catch (error) {
          throw new HttpError(504, (error as Error).message);
        }
        if (!outcome.ok) throw new HttpError(409, `${client.name} cannot change its address (${outcome.error ?? "refused"}). Its firmware may be too old.`);
        activity?.note("admin", client.id, `${client.name} told to reach Axis at ${url}`);
        return sendJson(res, 202, { client: client.name, address: url });
      }
      if (method === "POST" && parts.length === 4 && parts[1] === "clients" && parts[3] === "update") {
        const { client, session } = requireOnline(parts[2]!);
        const info = firmware.info(client.type);
        if (!info) throw new HttpError(404, `no firmware has been uploaded for ${client.type}`);
        let outcome;
        try {
          outcome = await hub.command(session, "update", {
            version: info.version,
            size: info.size,
            md5: info.md5,
            path: `/v1/firmware/${encodeURIComponent(info.type)}`,
          });
        } catch (error) {
          throw new HttpError(504, (error as Error).message);
        }
        if (!outcome.ok) {
          throw new HttpError(409, `${client.name} cannot update itself over Wi-Fi (${outcome.error ?? "refused"}). Flash it by cable once.`);
        }
        activity?.note("admin", client.id, `${client.name} told to update from ${client.version} to ${info.version}`);
        return sendJson(res, 202, { client: client.name, from: client.version, to: info.version });
      }
      // Says something from the admin page: on one client, in one location, or on every client that can speak.
      if (method === "POST" && parts.length === 2 && parts[1] === "announce" && deps.delivery) {
        const body = (await readJson(req)) as { text?: unknown; client?: unknown; location?: unknown; urgent?: unknown };
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 1000) : "";
        if (!text) throw new HttpError(400, "body must be { text: string, client?: string, location?: string, urgent?: boolean }");
        const urgent = body.urgent === true;
        try {
          if (typeof body.client === "string" && body.client) {
            const client = store.getClient(body.client);
            if (!client) throw new HttpError(404, "no such client");
            const said = await deps.delivery.sayTo(client, text, urgent);
            activity?.note("admin", client.id, `Announcement sent to ${client.name} from the admin page`);
            return sendJson(res, 200, { clients: [said], heard: said.heard });
          }
          const location = typeof body.location === "string" && body.location.trim() ? body.location.trim() : undefined;
          const said = await deps.delivery.sayToAll(location, text, urgent);
          activity?.note("admin", "", `Announcement sent to ${location ? `every device in ${location}` : "every device"} from the admin page (${said.clients.length})`);
          return sendJson(res, 200, said);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(409, (error as Error).message);
        }
      }
      // Everything as it happens, for as long as the page keeps the request open: turns stage by stage, wake words.
      if (method === "GET" && parts.length === 2 && parts[1] === "live" && deps.live) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        });
        const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        write("snapshot", { at: now(), turns: deps.live.snapshot() });
        const stop = deps.live.subscribe((event) =>
          write(event.type, event.type === "turn" ? event.turn : event.type === "wake" ? event.wake : { at: now(), turns: event.turns }),
        );
        // A line now and then keeps proxies from closing a quiet stream.
        const beat = setInterval(() => res.write(": still here\n\n"), 20_000);
        beat.unref();
        res.on("close", () => {
          clearInterval(beat);
          stop();
        });
        return;
      }
      // Forgets, now, every word Axis is holding in memory for the admin page: the live turns and the device sketches.
      if (method === "POST" && parts.length === 3 && parts[1] === "live" && parts[2] === "clear" && deps.live) {
        deps.live.clear();
        hub.forgetScreens(true);
        activity?.note("admin", "", "Live view cleared: the words of recent turns were deleted from memory");
        return sendJson(res, 200, { cleared: true });
      }
      // Wake words devices reported: how sure each was and what came of it, for tuning the cutoff.
      if (method === "GET" && parts.length === 2 && parts[1] === "wakes") {
        const hours = Number(url.searchParams.get("hours") ?? 24 * 7);
        if (!Number.isFinite(hours) || hours <= 0) throw new HttpError(400, "hours must be a positive number");
        const names = new Map(store.listClients().map((c) => [c.id, c.name]));
        return sendJson(res, 200, {
          from: now() - hours * 3_600_000,
          wakes: store.wakesSince(now() - hours * 3_600_000).map((w) => ({ ...w, client: names.get(w.clientId) ?? "removed client" })),
        });
      }
      // What Axis is connected to besides its devices and the agent, and whether each is working.
      if (method === "PATCH" && parts.length === 2 && parts[1] === "integrations") {
        const body = await readJson(req);
        const before = JSON.stringify(config.homeAssistant ?? null);
        try {
          saveHubSettings(store, config, body, String(req.headers.host ?? ""));
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        deps.applyHubSettings?.({ mqtt: JSON.stringify(config.homeAssistant ?? null) !== before });
        // What changed is named, never its value: one of these is a password.
        activity?.note("admin", "", `Hub settings saved: ${Object.keys(body as object).join(", ") || "nothing"}`);
        return sendJson(res, 200, { settings: publicHubSettings(config) });
      }
      if (method === "GET" && parts.length === 2 && parts[1] === "integrations") {
        const clients = store.listClients();
        const gw = gateway.status();
        return sendJson(res, 200, {
          homeAssistant: deps.homeAssistant?.()?.status() ?? null,
          settings: publicHubSettings(config),
          notifications: {
            ready: Boolean(deps.push),
            clients: clients.filter((c) => deps.push?.has(c.id)).map((c) => ({ id: c.id, name: c.name, online: hub.isOnline(c.id), waiting: deps.delivery?.waitingFor(c.id) ?? 0 })),
            browsers: clients.filter((c) => c.type === "web").length,
          },
          publicAddress: { hosts: config.publicHosts, trustedProxies: config.trustedProxies },
          backup: backupStatus(),
          gateway: { url: gw.url ?? null, operator: gw.operator.state, node: gw.node.state },
          timeZone: config.timeZone,
          messageHoldMs: config.messageHoldMs,
          activityDays: config.activityDays,
          dataDir: config.dataDir,
        });
      }
      // What is going on at this moment: timers running, questions waiting, clients mid-turn.
      if (method === "GET" && parts.length === 2 && parts[1] === "now") {
        const nameOf = (id: string) => store.getClient(id)?.name ?? id;
        return sendJson(res, 200, {
          at: now(),
          timers: (deps.timers?.list() ?? []).map((t) => ({
            id: t.id,
            label: t.label,
            clientId: t.clientId,
            client: nameOf(t.clientId),
            seconds: t.seconds,
            dueAt: t.dueAt,
          })),
          clients: hub.doing().map((c) => ({ ...c, client: nameOf(c.clientId) })),
          // The words on each client's screen just now, for the sketch on its page. Never stored.
          screens: hub.showing(),
        });
      }
      if (method === "DELETE" && parts.length === 3 && parts[1] === "timers") {
        const gone = deps.timers?.cancel({ id: Number(parts[2]) }) ?? [];
        if (!gone.length) throw new HttpError(404, "no such timer");
        return sendJson(res, 200, { cancelled: gone[0]!.id });
      }
      if (method === "GET" && parts.length === 2 && parts[1] === "status") {
        return sendJson(res, 200, {
          version: deps.version ?? "",
          upstream: hub.upstreamStatus(),
          clientsOnline: [...hub.sessions()].length,
          clientsKnown: store.listClients().length,
          startedAt,
          uptimeMs: Date.now() - startedAt,
        });
      }
      if (parts[1] === "config") {
        if (method === "GET" && parts.length === 2) {
          return sendJson(res, 200, publicRuntimeConfig(loadRuntimeConfig(store, config)));
        }
        if (method === "PATCH" && parts.length === 2) {
          let saved;
          try {
            saved = saveRuntimeConfig(store, config, await readJson(req));
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, (error as Error).message);
          }
          deps.reloadServices();
          activity?.note("admin", "", "Speech or agent settings saved");
          return sendJson(res, 200, publicRuntimeConfig(saved));
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "test") {
          return sendJson(res, 200, await testServices(services));
        }
        // Tries a chat endpoint as typed, before it is saved. Nothing is stored.
        if (method === "POST" && parts.length === 3 && parts[2] === "test-agent") {
          const typed = (await readJson(req)) as { url?: unknown; model?: unknown; token?: unknown; systemPrompt?: unknown };
          try {
            return sendJson(res, 200, await testChatAgent(loadRuntimeConfig(store, config).agent, typed));
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
        }
      }
      if (parts[1] === "gateway") {
        if (method === "GET" && parts.length === 2) return sendJson(res, 200, gateway.status());
        if (method === "PATCH" && parts.length === 2) {
          const body = (await readJson(req)) as { agentId?: unknown; url?: unknown };
          const isTextOrNull = (v: unknown) => v === undefined || v === null || typeof v === "string";
          if (!isTextOrNull(body.agentId) || !isTextOrNull(body.url)) {
            throw new HttpError(400, "body must be { agentId?: string | null, url?: string | null }");
          }
          if (body.agentId !== undefined && (body.agentId || null) !== (gateway.agentId() ?? null)) {
            gateway.setAgentId((body.agentId as string | null) || undefined);
            activity?.note("admin", "", `Agent set to ${body.agentId || "the gateway default"}`);
          }
          if (body.url !== undefined) {
            try {
              gateway.setUrl((body.url as string | null) || undefined);
            } catch (error) {
              throw new HttpError(400, (error as Error).message);
            }
          }
          return sendJson(res, 200, gateway.status());
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "setup-code") {
          const body = (await readJson(req)) as { code?: unknown; url?: unknown };
          if (typeof body.code !== "string" || (body.url !== undefined && typeof body.url !== "string")) {
            throw new HttpError(400, "body must be { code: string, url?: string }");
          }
          try {
            gateway.applySetupCode(body.code, body.url);
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
          activity?.note("admin", "", "Gateway setup code given");
          return sendJson(res, 202, gateway.status());
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "retry") {
          gateway.retryNow();
          return sendJson(res, 202, gateway.status());
        }
        if (method === "GET" && parts.length === 3 && parts[2] === "agents") {
          // Before pairing there is nobody to ask. An empty list says so without an error.
          const agents = await gateway.listAgents().catch(() => []);
          return sendJson(res, 200, { agents, selected: gateway.agentId() ?? null });
        }
      }
      if (method === "GET" && parts.length === 2 && parts[1] === "activity") {
        if (!activity) throw new HttpError(404, "not found");
        const hours = Number(url.searchParams.get("hours") ?? 24);
        if (!Number.isFinite(hours) || hours <= 0) throw new HttpError(400, "hours must be a positive number");
        const client = url.searchParams.get("client") ?? undefined;
        if (client && !store.getClient(client)) throw new HttpError(404, "no such client");
        return sendJson(res, 200, activity.summary(hours, client));
      }
      if (parts[1] === "settings") {
        const scope = parts[2];
        if (scope === "global" && parts.length === 3) {
          if (method === "GET") return sendJson(res, 200, { values: store.getLayer("global", "") });
          if (method === "PATCH") return sendJson(res, 200, await patchSettings(req, "global", ""));
        }
        if ((scope === "type" || scope === "device") && parts.length === 4) {
          const scopeId = parts[3]!;
          if (method === "GET") return sendJson(res, 200, { values: store.getLayer(scope, scopeId) });
          if (method === "PATCH") return sendJson(res, 200, await patchSettings(req, scope, scopeId));
        }
      }
    }

    throw new HttpError(404, "not found");
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
      else sendJson(res, 500, { error: "internal error" });
    });
  };
}
