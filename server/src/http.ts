import type { Timers } from "./timers.js";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PAIR_PATH, isPairRequest, type PairResponse, type Scalar, type ScalarMap } from "@vortex-axis/protocol";
import type { Activity } from "./activity.js";
import type { Config } from "./config.js";
import type { GatewayClient } from "./gateway/client.js";
import { FirmwareStore, MAX_FIRMWARE_BYTES } from "./firmware.js";
import type { Hub } from "./hub.js";
import { withBuiltIns, settingProblem, type ClientSchema } from "./schema.js";
import type { SettingsScope, Store } from "./store.js";
import type { Services } from "./turns.js";
import { loadRuntimeConfig, publicRuntimeConfig, saveRuntimeConfig, testServices } from "./upstream.js";

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
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

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
  return files;
}

export interface HttpDeps {
  config: Config;
  store: Store;
  hub: Hub;
  /** Turns, connections and changes, for the activity and overview pages. */
  activity?: Activity;
  /** When this process started, for uptime. */
  startedAt?: number;
  version?: string;
  gateway: GatewayClient;
  services: Services;
  /** Timers agents set, shown and cancelled on the admin page. */
  timers?: Timers;
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
      out[client.type] = { ...withBuiltIns(store.getSchema(client.type)), ...(label ? { label } : {}) };
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
    const schema = withBuiltIns(store.getSchema(type));
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

    // The pages themselves hold no secrets. Everything they do goes through
    // the same endpoints, with the same checks, as any other caller.
    if (method === "GET") {
      const file =
        url.pathname === "/" ? web.get("index.html")
        : url.pathname === "/admin" ? (isPublic(req) ? undefined : web.get("admin.html"))
        : parts.length === 2 && parts[0] === "web" ? web.get(parts[1]!)
        : undefined;
      if (file) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "content-security-policy": PAGE_POLICY,
          "content-type": file.type,
          "content-length": file.body.length,
          "cache-control": "no-cache",
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
      createReadStream(firmware.path(info.type)).pipe(res);
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
      // Firmware: one build kept per client type, sent to devices over Wi-Fi.
      if (parts[1] === "firmware") {
        if (method === "GET" && parts.length === 2) return sendJson(res, 200, { firmware: firmware.list() });
        if (method === "POST" && parts.length === 3) {
          try {
            const info = firmware.save(parts[2]!, url.searchParams.get("version") ?? "", await readBytes(req, MAX_FIRMWARE_BYTES));
            activity?.note("admin", "", `Firmware ${info.version} uploaded for ${info.type}`);
            return sendJson(res, 201, info);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, (error as Error).message);
          }
        }
        if (method === "DELETE" && parts.length === 3) {
          if (!firmware.remove(parts[2]!)) throw new HttpError(404, "there is no firmware for that client type");
          return sendJson(res, 200, { removed: parts[2] });
        }
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
