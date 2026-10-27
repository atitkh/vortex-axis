import type { Timers } from "./timers.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CAPABILITIES, PAIR_PATH, PROTOCOL_VERSION, isPairRequest, type Capability, type PairResponse, type Scalar, type ScalarMap } from "@vortex-axis/protocol";
import type { Activity } from "./activity.js";
import type { Backup } from "./backup.js";
import type { Delivery } from "./delivery.js";
import type { HomeAssistant } from "./homeassistant.js";
import { publicHubSettings, saveHubSettings } from "./hubconfig.js";
import type { Live } from "./live.js";
import { DEFAULT_GUEST_NOTE, type Voiceprints } from "./voiceprint.js";
import type { Attachment } from "./attach.js";
import type { SelfCheck } from "./selfcheck.js";
import type { RealtimeTalk } from "./talk.js";
import type { Progress } from "./progress.js";
import type { PushService } from "./push.js";
import type { Config } from "./config.js";
import type { GatewayClient, InvokeHandler } from "./gateway/client.js";
import { createMcpHandler } from "./mcp.js";
import type { ToolAccess } from "./tools.js";
import { DESKTOP_TYPE, MACOS_DESKTOP_TYPE, type DesktopApp } from "./desktopapp.js";
import { QUEST_TYPE, type QuestApp } from "./questapp.js";
import type { Desktops } from "./desktop.js";
import { FirmwareStore, MAX_FIRMWARE_BYTES } from "./firmware.js";
import { MAX_WAKE_WORD_BYTES, type WakeWordStore, type WakeWordSync } from "./wakewords.js";
import type { Hub } from "./hub.js";
import { withBuiltIns, settingProblem, type ClientSchema } from "./schema.js";
import type { SettingsScope, Store } from "./store.js";
import type { Services } from "./turns.js";
import { BLUEPRINT, type LiveActivities } from "./liveactivity.js";
import type { MediaStore } from "./media.js";
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
function loadWebFiles(dir: string | undefined, version = ""): Map<string, { type: string; body: Buffer }> {
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
    if (!type || !/^[\w.-]+$/.test(name)) continue;
    let body = readFileSync(join(dir, name));
    // The pages say which Axis they came with: the web client reports it as its own version.
    if (/\.(html|js)$/.test(name)) body = Buffer.from(body.toString().replaceAll("__AXIS_VERSION__", version || "0.0.0"));
    files.set(name, { type, body });
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
  /** The desktop app build computers update to. */
  desktopApp?: DesktopApp;
  /** The Quest panel client build headsets update to. */
  questApp?: QuestApp;
  /** The computers, for which ones an agent is using. */
  desktops?: Desktops;
  config: Config;
  store: Store;
  hub: Hub;
  /** Turns, connections and changes, for the activity and overview pages. */
  activity?: Activity;
  /** Turns and wake words as they happen, for the Live view. */
  live?: Live;
  /** The link to Home Assistant as it is now, when one is set up. It is rebuilt when its settings change. */
  homeAssistant?: () => HomeAssistant | undefined;
  /** Pictures from agent replies, served at their unguessable addresses. */
  mediaStore?: MediaStore;
  /** Tasks and timers as live activities on phones, through Home Assistant. */
  liveActivities?: LiveActivities;
  /** Which tools agents have and which agents hold a token, and the function that carries a tool call out. */
  tools?: ToolAccess;
  invoke?: InvokeHandler;
  /** Long work agents are doing, shown on the screens and on the admin page. */
  progress?: Progress;
  talk?: RealtimeTalk;
  selfCheck?: SelfCheck;
  attachment?: Attachment;
  /** Telling voices apart: the voices taught, the settings, and turns heard lately. */
  voices?: Voiceprints;
  /** Copies of the data folder, when a backup folder is set up. */
  backup?: Backup;
  /** Carries saved hub settings to the parts of Axis that use them. */
  applyHubSettings?: (changed: { mqtt: boolean }) => void;
  /** When this process started, for uptime. */
  startedAt?: number;
  version?: string;
  /** The commit this build was made from, when the build was told. */
  commit?: string;
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
  const web = loadWebFiles(config.webDir, deps.version);
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

  const mcp = deps.tools && deps.invoke ? createMcpHandler({ tools: deps.tools, invoke: deps.invoke, version: deps.version ?? "" }) : undefined;
  /** Wrong agent tokens per address, shut out the same way wrong admin tokens are. */
  const mcpFailures = new Map<string, { count: number; until: number }>();

  const adminFailures = new Map<string, { count: number; until: number }>();
  let pairFailures: number[] = [];

  function requireAdmin(req: IncomingMessage): void {
    if (!config.adminToken)
      throw new HttpError(503, config.adminTokenTooShort ? "admin API is disabled: AXIS_ADMIN_TOKEN is too short (24 characters or more)" : "admin API is disabled: AXIS_ADMIN_TOKEN is not set");
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
      // Sent to its closed page as notifications and not yet opened there.
      notified: deps.delivery?.notifiedFor(id) ?? 0,
    };
  }

  /**
   * Switches capabilities off for one client, or on again: only what it reports can be taken away, nothing given.
   * The device is told through its own settings (`capabilitiesOff`); Axis itself goes by the record from now on.
   */
  function setCapabilitiesOff(id: string, value: unknown): void {
    if (!Array.isArray(value) || value.some((c) => typeof c !== "string")) {
      throw new HttpError(400, "capabilitiesOff must be a list of capability names, such as [\"mic\"]; an empty list switches everything back on");
    }
    const unknown = value.filter((c) => !(CAPABILITIES as readonly string[]).includes(c));
    if (unknown.length) throw new HttpError(400, `not a capability: ${unknown.join(", ")} (known: ${CAPABILITIES.join(", ")})`);
    const before = store.getClient(id);
    if (!before) throw new HttpError(404, "no such client");
    const off = CAPABILITIES.filter((c) => value.includes(c)) as Capability[];
    if (off.join() === before.off.join()) return;
    const client = store.setCapabilitiesOff(id, off)!;
    store.patchLayer("device", id, { capabilitiesOff: off.length ? off.join(",") : null });
    hub.capabilitiesChanged(client);
    activity?.note("admin", id, off.length ? `${client.name}: switched off ${off.join(", ")}` : `${client.name}: everything it reports switched on again`);
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
    // Kept in step with the client's record, so it is only set through the client itself.
    if ("capabilitiesOff" in body.values) {
      throw new HttpError(400, "capabilitiesOff is set per device with PATCH /admin/clients/:id { capabilitiesOff: [...] }");
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

    // The Home Assistant blueprint for live activities, for Home Assistant to import by address. It holds nothing private,
    // but like the admin page it is there on the local network only.
    if (method === "GET" && url.pathname === "/ha/vortex_axis_live_activities.yaml" && !isPublic(req)) {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/yaml; charset=utf-8", "cache-control": "no-cache" });
      res.end(BLUEPRINT);
      return;
    }

    // A picture from an agent's reply. The address is the key (long, random, gone after a day), so it is
    // served under a public name too: a phone away from home fetches it there.
    if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "media") {
      const item = deps.mediaStore?.get(parts[2]!);
      if (!item) throw new HttpError(404, "not found");
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": item.mime,
        "content-length": item.bytes.length,
        "cache-control": "private, max-age=86400, immutable",
      });
      res.end(item.bytes);
      return;
    }

    // The stamp of the web files being served, so an open page can tell it has been replaced.
    if (method === "GET" && url.pathname === "/v1/web-version") return sendJson(res, 200, { version: webVersion });

    // The flasher: a page that puts the firmware on a new board over USB from the browser (Chrome or Edge, and
    // only over https or from localhost: the browser's rule for USB). It installs what is on this hub's own
    // shelf. Nothing here is secret (the firmware is public), so it is served to anyone who can reach Axis.
    if (method === "GET" && (url.pathname === "/flash" || parts[0] === "flash") && config.flasherDir) {
      // Without the slash the page's own files would be looked for one level up.
      if (url.pathname === "/flash") {
        res.writeHead(302, { ...SECURITY_HEADERS, location: "/flash/" });
        return void res.end();
      }
      const types = firmware.shelves().map((shelf) => shelf.type);
      const wanted = url.searchParams.get("type");
      const ready = (wanted ? [wanted] : types).map((t) => firmware.factory(t)).find((f) => f !== undefined);
      // Every type it can install, so the page can offer a choice of board when there is more than one.
      if (parts.length === 2 && parts[1] === "types.json") {
        return sendJson(
          res,
          200,
          types
            .map((t) => firmware.factory(t))
            .filter((f) => f !== undefined)
            .map((f) => ({ type: f.type, name: store.getMeta(`type_label:${f.type}`) || f.type, version: f.version, manifest: `manifest.json?type=${encodeURIComponent(f.type)}` })),
        );
      }
      if (parts.length === 2 && parts[1] === "manifest.json") {
        if (!ready) throw new HttpError(404, "there is no firmware with a factory image on this hub");
        return sendJson(res, 200, {
          name: store.getMeta(`type_label:${ready.type}`) || ready.type,
          version: ready.version,
          // The person is asked whether to wipe the board first: yes for one that ran something else.
          new_install_prompt_erase: true,
          new_install_improv_wait_time: 0,
          builds: [{ chipFamily: "ESP32-S3", parts: [{ path: `firmware/${encodeURIComponent(ready.type)}.bin`, offset: 0 }] }],
        });
      }
      if (parts.length === 3 && parts[1] === "firmware" && parts[2]!.endsWith(".bin")) {
        const found = firmware.factory(decodeURIComponent(parts[2]!.slice(0, -4)));
        if (!found) throw new HttpError(404, "there is no such firmware");
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "application/octet-stream", "content-length": found.size, "cache-control": "no-cache" });
        createReadStream(firmware.factoryPath(found.type, found.version)).pipe(res);
        return;
      }
      // The page and its installer: plain files, by name only.
      const name = parts.length === 1 ? "index.html" : parts.length === 2 ? parts[1]! : parts.length === 3 && parts[1] === "esp-web-tools" ? `esp-web-tools/${parts[2]}` : "";
      const type = CONTENT_TYPES[extname(name)];
      if (!type || !/^(?:esp-web-tools\/)?[\w-][\w.-]*$/.test(name)) throw new HttpError(404, "not found");
      let body: Buffer;
      try {
        body = readFileSync(join(config.flasherDir, name));
      } catch {
        throw new HttpError(404, name.startsWith("esp-web-tools/") ? "the installer is not in this build of Axis" : "not found");
      }
      res.writeHead(200, { ...SECURITY_HEADERS, "content-security-policy": PAGE_POLICY, "content-type": type, "content-length": body.length, "cache-control": "no-cache" });
      return void res.end(body);
    }

    // The pages themselves hold no secrets. Everything they do goes through
    // the same endpoints, with the same checks, as any other caller.
    if (method === "GET") {
      const file =
        url.pathname === "/" ? web.get("index.html")
        : url.pathname === "/admin" ? (isPublic(req) ? undefined : web.get("admin.html"))
        // The new admin page, beside the classic one while it is built (docs/admin-revamp): the same rule, local network only.
        : url.pathname === "/admin-next" ? (isPublic(req) ? undefined : web.get("admin-next.html"))
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

    // A computer fetching the desktop app Axis told it to update to, with its own token.
    if (method === "GET" && url.pathname === "/v1/desktop/app" && deps.desktopApp) {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const client = store.authenticate(String(req.headers["x-axis-client"] ?? ""), token);
      if (!client) throw new HttpError(401, "unknown client or wrong token");
      if (client.type === MACOS_DESKTOP_TYPE) throw new HttpError(404, "this hub keeps only the Windows desktop app; a Mac is updated by hand for now");
      if (client.type !== DESKTOP_TYPE) throw new HttpError(404, "the desktop app is for computers");
      const build = deps.desktopApp.build();
      if (!build) throw new HttpError(404, "the desktop app has not been built on this hub");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": build.size, "x-sha256": build.sha256, "x-version": build.version });
      createReadStream(build.file).pipe(res);
      return;
    }

    // A headset fetching the Quest app Axis told it to update to, with its own token.
    if (method === "GET" && url.pathname === "/v1/quest/app" && deps.questApp) {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const client = store.authenticate(String(req.headers["x-axis-client"] ?? ""), token);
      if (!client) throw new HttpError(401, "unknown client or wrong token");
      if (client.type !== QUEST_TYPE) throw new HttpError(404, "the Quest app is for Quest headsets");
      const build = deps.questApp.build();
      if (!build) throw new HttpError(404, "the Quest app has not been built on this hub");
      res.writeHead(200, {
        "content-type": "application/vnd.android.package-archive",
        "content-length": build.size,
        "cache-control": "no-store",
        "x-sha256": build.sha256,
        "x-version": build.version,
      });
      createReadStream(build.file).pipe(res);
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

    // The MCP door: an agent harness calling Axis's tools. One POST, one JSON-RPC message (or a batch), one JSON answer.
    if (url.pathname === "/mcp" && mcp && deps.tools) {
      // Under a public name it does not exist unless that was asked for, like the admin side.
      if (isPublic(req) && !config.mcpPublic) throw new HttpError(404, "not found");
      const address = addressOf(req);
      const locked = mcpFailures.get(address);
      if (locked && locked.count >= ADMIN_FAILURES) {
        if (now() < locked.until) throw new HttpError(429, "too many wrong tokens from this address, wait five minutes");
        mcpFailures.delete(address);
      }
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const holder = deps.tools.authenticate(token);
      if (!holder) {
        if (token) {
          const failed = mcpFailures.get(address) ?? { count: 0, until: 0 };
          failed.count += 1;
          failed.until = now() + ADMIN_LOCK_MS;
          mcpFailures.set(address, failed);
          if (failed.count === ADMIN_FAILURES) activity?.note("admin", "", `Ten wrong agent tokens from ${address}; that address is shut out for five minutes`, "warn");
          if (mcpFailures.size > 5000) mcpFailures.clear();
        }
        res.setHeader("www-authenticate", "Bearer");
        throw new HttpError(401, "missing or wrong agent token: make one on the VorteX Axis admin page and send it as a Bearer token");
      }
      mcpFailures.delete(address);
      // Axis sends nothing unasked, so there is no stream to open and no session to end.
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        throw new HttpError(405, "this MCP server answers POST only");
      }
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (error) {
        if (error instanceof HttpError && error.status === 413) throw error;
        return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "the request body is not valid JSON" } });
      }
      const answer = await mcp(body, `MCP: ${holder.name}`);
      if (answer === undefined) {
        res.writeHead(202, SECURITY_HEADERS);
        res.end();
        return;
      }
      return sendJson(res, 200, answer);
    }

    // A client with a volume control of its own, turning itself up or down. It can change nothing else, and only for itself.
    if (method === "POST" && url.pathname === "/v1/volume") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const client = store.authenticate(String(req.headers["x-axis-client"] ?? ""), token);
      if (!client) throw new HttpError(401, "unknown client or wrong token");
      const body = (await readJson(req)) as { volume?: unknown };
      if (typeof body.volume !== "number" || !Number.isInteger(body.volume) || body.volume < 0 || body.volume > 100) {
        throw new HttpError(400, "volume must be a whole number from 0 to 100");
      }
      const before = store.resolveSettings(client).volume;
      store.patchLayer("device", client.id, { volume: body.volume });
      hub.pushSettings((c) => c.id === client.id);
      if (before !== body.volume) activity?.note("settings", client.id, `${client.name}: volume set to ${body.volume} % on the device itself`);
      return sendJson(res, 200, { volume: body.volume });
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
        const gone = deps.delivery.takeMissed(client.id);
        return sendJson(res, 200, {
          asks: deps.delivery.openAsks(client.id),
          // `messages` is the plain list an older page expects; `received` and `missed` say when as well.
          messages: gone.messages.map((m) => m.text),
          received: gone.messages,
          missed: gone.asks,
        });
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
      // One kind of edge glow shown on a board for a few seconds, from the admin page's glow preview.
      if (method === "POST" && parts.length === 4 && parts[1] === "clients" && parts[3] === "glow") {
        const { client, session } = requireOnline(parts[2]!);
        const body = (await readJson(req)) as { kind?: unknown; corner?: unknown };
        const kinds = ["waiting", "question", "done", "timer", "find", "listening", "thinking", "speaking", "hands"];
        if (typeof body.kind !== "string" || !kinds.includes(body.kind)) throw new HttpError(400, `kind must be one of ${kinds.join(", ")}`);
        const corner = Number(body.corner);
        if (!Number.isInteger(corner) || corner < 12 || corner > 120) throw new HttpError(400, "corner must be a whole number from 12 to 120");
        // A round board has no corner to turn (no glowCorner setting) but has an edge glow all the same: it says its screen is round.
        const roundScreen = Boolean(session.readings?.screenRound);
        if (!roundScreen && !withBuiltIns(store.getSchema(client.type)).settings.some((s) => s.key === "glowCorner")) {
          throw new HttpError(400, `${client.name} has no edge glow`);
        }
        const ms = body.kind === "timer" ? 10_000 : 5_000;
        try {
          return sendJson(res, 200, { ...(await hub.command(session, "glow.show", { kind: body.kind, corner, ms }, 5000)), ms });
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
          const body = (await readJson(req)) as { name?: unknown; capabilitiesOff?: unknown };
          if (body.capabilitiesOff !== undefined) {
            setCapabilitiesOff(id, body.capabilitiesOff);
            if (body.name === undefined) return sendJson(res, 200, describeClient(id));
          }
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
      // The Windows desktop app (experimental), kept in the data folder by scripts/build-desktop.sh.
      // The Windows desktop app (experimental): built on this hub by scripts/build-desktop.sh, or the one the image came with.
      if (parts[1] === "desktop" && method === "GET") {
        const build = deps.desktopApp?.build();
        if (parts.length === 2) {
          if (!build) return sendJson(res, 200, { available: false });
          return sendJson(res, 200, { available: true, size: build.size, version: build.version, builtAt: build.builtAt ?? null });
        }
        if (parts.length === 3 && parts[2] === "app") {
          if (!build) throw new HttpError(404, "the desktop app has not been built on this hub");
          res.writeHead(200, {
            "content-type": "application/vnd.microsoft.portable-executable",
            "content-length": build.size,
            "content-disposition": 'attachment; filename="VortexAxisDesktop.exe"',
          });
          createReadStream(build.file).pipe(res);
          return;
        }
      }
      // The Quest panel client (experimental): built on this hub by scripts/build-quest-client.sh.
      if (parts[1] === "quest" && method === "GET" && parts.length === 2) {
        const build = deps.questApp?.build();
        if (!build) return sendJson(res, 200, { available: false });
        return sendJson(res, 200, { available: true, size: build.size, version: build.version, sha256: build.sha256, builtAt: build.builtAt ?? null });
      }
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
        // The factory image that goes with a build already uploaded, for the flasher page.
        if (method === "POST" && parts.length === 3 && url.searchParams.get("part") === "factory") {
          try {
            firmware.saveFactory(type, url.searchParams.get("version") ?? "", await readBytes(req, MAX_FIRMWARE_BYTES));
            return sendJson(res, 201, firmware.factory(type) ?? { type, version: url.searchParams.get("version") });
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, (error as Error).message);
          }
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
          throw new HttpError(400, "give an address such as https://axis.example.org or 192.168.1.20:8440");
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
        if (client.type === MACOS_DESKTOP_TYPE) throw new HttpError(409, `${client.name} is a Mac: its desktop app is updated by hand for now`);
        const app = client.type === DESKTOP_TYPE ? deps.desktopApp : client.type === QUEST_TYPE ? deps.questApp : undefined;
        if (app) {
          try {
            const done = await app.update(session);
            activity?.note("admin", client.id, `${client.name} told to update from ${done.from} to ${done.to}`);
            return sendJson(res, 202, { client: client.name, ...done });
          } catch (error) {
            throw new HttpError(409, `${client.name} did not update: ${(error as Error).message}`);
          }
        }
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
        write("snapshot", { at: now(), turns: deps.live.snapshot(), calls: deps.live.calls() });
        const stop = deps.live.subscribe((event) =>
          write(
            event.type,
            event.type === "turn" ? event.turn : event.type === "wake" ? event.wake : event.type === "tool" ? event.call : { at: now(), turns: event.turns, calls: event.calls },
          ),
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
      // Agents: the tools they have, and the tokens that let a harness in by MCP.
      if (parts[1] === "mcp" && deps.tools) {
        const access = deps.tools;
        if (method === "GET" && parts.length === 2) {
          return sendJson(res, 200, {
            path: "/mcp",
            public: config.mcpPublic,
            mirrorCards: config.mirrorCards,
            mirrorQuestions: config.mirrorQuestions,
            mirrorApprovals: config.mirrorApprovals,
            desktopBlocked: config.desktopBlocked,
            watch: deps.gateway.status().watch,
            publicHosts: config.publicHosts,
            tokens: access.tokens(),
            tools: access.list().map(({ name, description, enabled, parameters }) => ({ name, description, enabled, parameters })),
          });
        }
        // Tries a tool from the admin page: the same function, and the same on/off guard, an agent's call goes through.
        if (method === "POST" && parts.length === 4 && parts[2] === "tools" && parts[3] === "try" && deps.invoke) {
          const body = (await readJson(req)) as { name?: unknown; arguments?: unknown };
          const tool = access.list().find((t) => t.name === body.name);
          if (!tool) throw new HttpError(404, `there is no tool called "${String(body.name)}"`);
          const given = typeof body.arguments === "object" && body.arguments !== null && !Array.isArray(body.arguments) ? (body.arguments as Record<string, unknown>) : {};
          activity?.note("admin", "", `Tried ${tool.name} from the admin page`);
          const started = now();
          try {
            const result = await deps.invoke(tool.command, given, "Admin page");
            return sendJson(res, 200, { ok: true, ms: now() - started, result: result ?? null });
          } catch (error) {
            // What the tool refused is the answer the person asked for, as an agent would read it.
            return sendJson(res, 200, { ok: false, ms: now() - started, error: (error as Error).message });
          }
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "tokens") {
          const body = (await readJson(req)) as { name?: unknown };
          try {
            return sendJson(res, 201, access.createToken(typeof body.name === "string" ? body.name : ""));
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
        }
        if (method === "DELETE" && parts.length === 4 && parts[2] === "tokens") {
          if (!access.revokeToken(Number(parts[3]))) throw new HttpError(404, "no such token");
          return sendJson(res, 200, { revoked: Number(parts[3]) });
        }
        if (method === "PATCH" && parts.length === 3 && parts[2] === "tools") {
          const body = await readJson(req);
          try {
            access.set(body as Record<string, unknown>);
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
          return sendJson(res, 200, { tools: access.list().map(({ name, enabled }) => ({ name, enabled })) });
        }
      }
      // Makes a backup now and answers when it is done, with how it went.
      if (method === "POST" && parts.length === 2 && parts[1] === "backup" && deps.backup) {
        if (!deps.backup.status().configured) throw new HttpError(409, "no backup folder is set up: set AXIS_BACKUP_PATH in the hub's .env and start Axis again");
        const result = await deps.backup.run();
        if (!result.ok) throw new HttpError(502, `the backup failed: ${result.error}`);
        return sendJson(res, 200, deps.backup.status());
      }
      // A copy of the database to keep somewhere else: made now, as a backup is, whether or not a backup folder is set
      // up. It holds the same keys and token hashes as the hub itself, so it is only handed to the admin token.
      if (method === "GET" && parts.length === 3 && parts[1] === "backup" && parts[2] === "download") {
        if (config.dataDir === ":memory:") throw new HttpError(409, "there is no data folder to copy");
        const dir = mkdtempSync(join(tmpdir(), "axis-download-"));
        const file = join(dir, "axis.sqlite");
        try {
          await store.backupTo(file);
          res.writeHead(200, {
            "content-type": "application/vnd.sqlite3",
            "content-length": statSync(file).size,
            "content-disposition": `attachment; filename="axis-${new Date(now()).toISOString().slice(0, 10)}.sqlite"`,
          });
          await new Promise<void>((resolve) => createReadStream(file).on("close", resolve).pipe(res));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        activity?.note("admin", "", "A copy of the database was downloaded from the admin page");
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
      // A short activity on the phone, to check Home Assistant's blueprint passes them on.
      if (method === "POST" && parts.length === 3 && parts[1] === "integrations" && parts[2] === "live-test") {
        if (!deps.homeAssistant?.()?.status().connected) throw new HttpError(409, "Home Assistant's MQTT broker is not connected");
        if (!config.liveActivities) throw new HttpError(409, "live activities are switched off");
        return sendJson(res, 200, (await deps.liveActivities?.test()) ?? { sent: false, phones: [] });
      }
      if (method === "GET" && parts.length === 2 && parts[1] === "integrations") {
        const clients = store.listClients();
        const gw = gateway.status();
        return sendJson(res, 200, {
          homeAssistant: deps.homeAssistant?.()?.status() ?? null,
          liveActivities: deps.liveActivities ? { ...deps.liveActivities.status(), blueprint: "/ha/vortex_axis_live_activities.yaml" } : null,
          settings: publicHubSettings(config),
          notifications: {
            ready: Boolean(deps.push),
            clients: clients.filter((c) => deps.push?.has(c.id)).map((c) => ({ id: c.id, name: c.name, online: hub.isOnline(c.id), waiting: deps.delivery?.waitingFor(c.id) ?? 0 })),
            browsers: clients.filter((c) => c.type === "web").length,
          },
          publicAddress: { hosts: config.publicHosts, trustedProxies: config.trustedProxies },
          backup: deps.backup?.status() ?? null,
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
            // What the agent is to do when it is due, when the timer is one of those.
            ...(t.task ? { task: t.task, mayAct: t.mayAct === true } : {}),
          })),
          clients: hub.doing().map((c) => ({ ...c, client: nameOf(c.clientId) })),
          // Long work agents have reported on, as the screens show it.
          tasks: deps.progress?.list() ?? [],
          // Computers an agent is using right now (looking, clicking, typing), with the last thing it did.
          computers: deps.desktops?.inUse() ?? [],
          // The conversation the devices are heard in, when a person pointed them away from the usual one.
          attached: deps.attachment?.current() ?? null,
          // The same work once it is over, kept as long as the rest of the activity.
          tasksEnded: store.tasksEnded(30),
          // Whether Home Assistant says the person is away, which sends finished tasks to their phone.
          away: store.getMeta("away") === "1",
          // The words on each client's screen just now, for the sketch on its page. Never stored.
          screens: hub.showing(),
        });
      }
      if (method === "DELETE" && parts.length === 2 && parts[1] === "attached") {
        return sendJson(res, 200, { detached: deps.attachment?.detach() ?? false });
      }
      if (method === "DELETE" && parts.length === 3 && parts[1] === "tasks") {
        if (!deps.progress?.clear(parts[2]!)) throw new HttpError(404, "no such task");
        return sendJson(res, 200, { cleared: parts[2] });
      }
      if (method === "DELETE" && parts.length === 3 && parts[1] === "timers") {
        const gone = deps.timers?.cancel({ id: Number(parts[2]) }) ?? [];
        if (!gone.length) throw new HttpError(404, "no such timer");
        return sendJson(res, 200, { cancelled: gone[0]!.id });
      }
      if (method === "GET" && parts.length === 2 && parts[1] === "status") {
        return sendJson(res, 200, {
          version: deps.version ?? "",
          commit: deps.commit ?? "",
          // A different number altogether: how devices and Axis talk, not which release this is.
          protocol: PROTOCOL_VERSION,
          upstream: hub.upstreamStatus(),
          clientsOnline: [...hub.sessions()].length,
          clientsKnown: store.listClients().length,
          startedAt,
          uptimeMs: Date.now() - startedAt,
        });
      }
      // Whether the gateway still offers what Axis leans on. GET reads the last look; POST looks again.
      if (parts[1] === "selfcheck" && parts.length === 2 && deps.selfCheck) {
        if (method === "GET") return sendJson(res, 200, deps.selfCheck.report() ?? (await deps.selfCheck.run()));
        if (method === "POST") return sendJson(res, 200, await deps.selfCheck.run());
      }
      // Realtime voice: whether it can be used, which of the gateway's voices there are, and a try of one.
      if (parts[1] === "talk" && deps.talk) {
        const talk = deps.talk;
        if (method === "GET" && parts.length === 2) {
          const global = store.getLayer("global", "");
          const available = talk.available();
          let providers: Awaited<ReturnType<RealtimeTalk["providers"]>> = [];
          let error: string | undefined;
          if (available) {
            try {
              providers = await talk.providers();
            } catch (problem) {
              error = (problem as Error).message;
            }
          }
          return sendJson(res, 200, {
            available,
            providers,
            ...(error ? { error } : {}),
            mode: global.voiceMode === "realtime" ? "realtime" : "local",
            provider: typeof global.voiceProvider === "string" ? global.voiceProvider : "",
            // Devices that go their own way, whatever is set for all.
            overrides: store.listClients().flatMap((client) => {
              const own = store.getLayer("device", client.id).voiceMode;
              return typeof own === "string" ? [{ id: client.id, name: client.name, mode: own }] : [];
            }),
          });
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "test") {
          if (!talk.available()) throw new HttpError(409, "realtime voice needs an OpenClaw gateway as the agent, connected");
          const body = (await readJson(req)) as { provider?: unknown };
          return sendJson(res, 200, await talk.probe(typeof body?.provider === "string" && body.provider ? body.provider : undefined));
        }
      }
      if (parts[1] === "voices" && deps.voices) {
        const voices = deps.voices;
        const bad = (error: unknown): never => {
          throw error instanceof HttpError ? error : new HttpError(400, (error as Error).message);
        };
        // A recording from the admin page arrives as raw 16-bit mono PCM, its rate in the address.
        const recording = async () => {
          const rate = Number(url.searchParams.get("rate") ?? 16000);
          if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) throw new HttpError(400, "rate must be a sample rate from 8000 to 48000");
          const pcm = await readBytes(req, rate * 2 * 60);
          if (pcm.length < rate) throw new HttpError(400, "a recording needs at least a second of sound");
          return { pcm: pcm.subarray(0, pcm.length - (pcm.length % 2)), format: { encoding: "pcm_s16le" as const, sampleRate: rate, channels: 1 as const } };
        };
        if (method === "GET" && parts.length === 2) {
          const service = services.voiceprint;
          return sendJson(res, 200, {
            settings: voices.settings(),
            defaultGuestNote: DEFAULT_GUEST_NOTE,
            service: { url: loadRuntimeConfig(store, config).voiceprint.url, up: service ? await service.healthy() : false },
            voices: voices.voices().map((voice) => ({ ...voice, list: voices.samples(voice.id) })),
            recent: voices.recent().map((h) => ({ ...h, client: store.getClient(h.clientId)?.name ?? h.clientId })),
          });
        }
        if (method === "PATCH" && parts.length === 2) {
          let saved;
          try {
            saved = voices.saveSettings(await readJson(req));
          } catch (error) {
            bad(error);
          }
          activity?.note("admin", "", "Voice recognition settings saved");
          return sendJson(res, 200, saved);
        }
        if (method === "POST" && parts.length === 2) {
          const body = (await readJson(req)) as { name?: unknown };
          if (typeof body.name !== "string") throw new HttpError(400, "body must be { name }");
          try {
            return sendJson(res, 201, voices.addVoice(body.name));
          } catch (error) {
            bad(error);
          }
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "check") {
          const { pcm, format } = await recording();
          try {
            return sendJson(res, 200, await voices.check(pcm, format));
          } catch (error) {
            bad(error);
          }
        }
        if (method === "DELETE" && parts.length === 4 && parts[2] === "samples") {
          if (!voices.removeSample(Number(parts[3]))) throw new HttpError(404, "no such recording");
          return sendJson(res, 200, { ok: true });
        }
        const voiceId = Number(parts[2]);
        if (parts.length >= 3 && Number.isInteger(voiceId)) {
          if (method === "DELETE" && parts.length === 3) {
            if (!voices.removeVoice(voiceId)) throw new HttpError(404, "no such voice");
            activity?.note("admin", "", "A voice was forgotten");
            return sendJson(res, 200, { ok: true });
          }
          if (method === "POST" && parts.length === 4 && parts[3] === "samples") {
            try {
              if ((req.headers["content-type"] ?? "").startsWith("application/json")) {
                const body = (await readJson(req)) as { turnId?: unknown };
                if (typeof body.turnId !== "string") throw new HttpError(400, "body must be { turnId }");
                return sendJson(res, 201, voices.teachFromTurn(voiceId, body.turnId));
              }
              const { pcm, format } = await recording();
              return sendJson(res, 201, await voices.teach(voiceId, pcm, format));
            } catch (error) {
              bad(error);
            }
          }
        }
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
          // The settings Axis itself reads for every client, so a page can show them for everything before any device describes itself.
          if (method === "GET") return sendJson(res, 200, { values: store.getLayer("global", ""), builtIns: withBuiltIns(undefined, wakeIds()).settings });
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
