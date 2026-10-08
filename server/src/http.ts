import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PAIR_PATH, isPairRequest, type PairResponse, type ScalarMap } from "@vortex-axis/protocol";
import type { Config } from "./config.js";
import type { GatewayClient } from "./gateway/client.js";
import type { Hub } from "./hub.js";
import type { SettingsScope, Store } from "./store.js";

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

export interface HttpDeps {
  config: Config;
  store: Store;
  hub: Hub;
  gateway?: GatewayClient | undefined;
  now?: () => number;
}

/** Builds the request handler for pairing, health and the admin API. */
export function createHttpHandler(deps: HttpDeps) {
  const { config, store, hub, gateway } = deps;
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
      readings: session?.readings ?? {},
    };
  }

  async function patchSettings(req: IncomingMessage, scope: SettingsScope, scopeId: string) {
    const body = (await readJson(req)) as { values?: unknown };
    if (!isScalarMap(body.values)) {
      throw new HttpError(400, "body must be { values: { key: string | number | boolean | null } }");
    }
    if (scope === "device" && !store.getClient(scopeId)) throw new HttpError(404, "no such client");
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
        return sendJson(res, 200, { clients: store.listClients().map((client) => describeClient(client.id)) });
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
      if (parts[1] === "gateway") {
        if (!gateway) throw new HttpError(409, "the OpenClaw gateway link is off: another agent backend is configured");
        if (method === "GET" && parts.length === 2) return sendJson(res, 200, gateway.status());
        if (method === "PATCH" && parts.length === 2) {
          const body = (await readJson(req)) as { agentId?: unknown };
          if (body.agentId !== null && typeof body.agentId !== "string") {
            throw new HttpError(400, "body must be { agentId: string | null }");
          }
          gateway.setAgentId(body.agentId ?? undefined);
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
          try {
            return sendJson(res, 200, { agents: await gateway.listAgents(), selected: gateway.agentId() ?? null });
          } catch (error) {
            throw new HttpError(502, (error as Error).message);
          }
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
