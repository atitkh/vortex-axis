import { timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PAIR_PATH, isPairRequest, type PairResponse, type Scalar, type ScalarMap } from "@vortex-axis/protocol";
import type { Config } from "./config.js";
import type { GatewayClient } from "./gateway/client.js";
import type { Hub } from "./hub.js";
import { withBuiltIns, settingProblem, type ClientSchema } from "./schema.js";
import type { SettingsScope, Store } from "./store.js";
import type { Services } from "./turns.js";
import { loadRuntimeConfig, publicRuntimeConfig, saveRuntimeConfig, testServices } from "./upstream.js";

const MAX_BODY_BYTES = 64 * 1024;
const PAIR_ATTEMPTS_PER_MINUTE = 10;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
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
  version?: string;
  gateway: GatewayClient;
  services: Services;
  /** Rebuilds the upstream clients after the saved settings changed. */
  reloadServices: () => void;
  now?: () => number;
}

/** Builds the request handler for pairing, health and the admin API. */
export function createHttpHandler(deps: HttpDeps) {
  const { config, store, hub, gateway, services } = deps;
  const web = loadWebFiles(config.webDir);
  const now = deps.now ?? Date.now;
  const pairAttempts = new Map<string, number[]>();

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

  function requireAdmin(req: IncomingMessage): void {
    if (!config.adminToken) throw new HttpError(503, "admin API is disabled: AXIS_ADMIN_TOKEN is not set");
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    const expected = Buffer.from(config.adminToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(401, "missing or wrong admin token");
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
  function typeSchemas(): Record<string, ClientSchema> {
    const out: Record<string, ClientSchema> = {};
    for (const client of store.listClients()) out[client.type] ??= withBuiltIns(store.getSchema(client.type));
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
    const version = store.patchLayer(scope, scopeId, body.values);
    hub.pushSettings();
    return { version, values: store.getLayer(scope, scopeId) };
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
        : url.pathname === "/admin" ? web.get("admin.html")
        : parts.length === 2 && parts[0] === "web" ? web.get(parts[1]!)
        : undefined;
      if (file) {
        res.writeHead(200, { "content-type": file.type, "content-length": file.body.length, "cache-control": "no-cache" });
        res.end(file.body);
        return;
      }
    }

    if (method === "POST" && url.pathname === PAIR_PATH) {
      if (!allowPairAttempt(req.socket.remoteAddress ?? "unknown")) {
        throw new HttpError(429, "too many pairing attempts, wait a minute");
      }
      const body = await readJson(req);
      if (!isPairRequest(body)) throw new HttpError(400, "invalid pairing request");
      const paired = store.pair(body);
      if (!paired) throw new HttpError(403, "pairing code is wrong, expired or already used");
      const reply: PairResponse = { clientId: paired.client.id, token: paired.token, name: paired.client.name };
      return sendJson(res, 200, reply);
    }

    if (parts[0] === "admin") {
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
        if (method === "DELETE") {
          if (!store.removeClient(id)) throw new HttpError(404, "no such client");
          hub.disconnect(id);
          return sendJson(res, 200, { removed: id });
        }
      }
      if (method === "GET" && parts.length === 2 && parts[1] === "status") {
        return sendJson(res, 200, {
          version: deps.version ?? "",
          upstream: hub.upstreamStatus(),
          clientsOnline: [...hub.sessions()].length,
          clientsKnown: store.listClients().length,
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
          if (body.agentId !== undefined) gateway.setAgentId((body.agentId as string | null) ?? undefined);
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
