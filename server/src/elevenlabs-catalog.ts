import { createHash } from "node:crypto";
import { ELEVENLABS_BASE, ELEVENLABS_KEY_ENV, resolveApiKey } from "./speech.js";

export type CatalogService = "stt" | "tts";

export interface CatalogVoice {
  id: string;
  name: string;
  category: string;
  previewUrl: string;
}
export interface CatalogModel {
  id: string;
  name: string;
}
export interface Catalog {
  voices: CatalogVoice[];
  models: CatalogModel[];
  /** Where the speech-to-text models came from: the account's model list, or the built-in fallback. */
  modelSource: "api" | "static";
}

/** An error for the admin route: `status` is what Axis answers, `upstream` what ElevenLabs said (if it did). */
export class CatalogError extends Error {
  constructor(
    readonly status: number,
    readonly code: "no-key" | "bad-key" | "rate-limited" | "upstream" | "unreachable",
    message: string,
    readonly upstream?: number,
  ) {
    super(message);
  }
}

const MAX_VOICES = 200;
const PAGE_SIZE = 100;
const CACHE_MS = 60_000;
const TIMEOUT_MS = 10_000;
/** The models list does not expose speech recognition models, so this is the fallback. */
const STATIC_STT_MODELS: CatalogModel[] = [{ id: "scribe_v2", name: "Scribe v2" }];

const cache = new Map<string, { at: number; value: Catalog }>();

/** Test hook. */
export function clearCatalogCache(): void {
  cache.clear();
}

async function getJson(base: string, path: string, key: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new CatalogError(502, "unreachable", "ElevenLabs could not be reached");
  }
  if (!res.ok) {
    await res.body?.cancel();
    const s = res.status;
    if (s === 401 || s === 403) throw new CatalogError(424, "bad-key", `ElevenLabs refused the API key (HTTP ${s})`, s);
    if (s === 429) throw new CatalogError(429, "rate-limited", "ElevenLabs is rate limiting requests (HTTP 429)", s);
    throw new CatalogError(502, "upstream", `ElevenLabs answered HTTP ${s}`, s);
  }
  try {
    return await res.json();
  } catch {
    throw new CatalogError(502, "upstream", "ElevenLabs sent an unreadable answer", res.status);
  }
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** Voices from the current `GET /v2/voices` search, page by page up to MAX_VOICES. */
async function fetchVoices(base: string, key: string): Promise<CatalogVoice[]> {
  const out: CatalogVoice[] = [];
  let token = "";
  while (out.length < MAX_VOICES) {
    const query = `?page_size=${PAGE_SIZE}&include_total_count=false&sort=name&sort_direction=asc${token ? `&next_page_token=${encodeURIComponent(token)}` : ""}`;
    const body = (await getJson(base, `/v2/voices${query}`, key)) as {
      voices?: unknown;
      has_more?: unknown;
      next_page_token?: unknown;
    };
    for (const v of Array.isArray(body.voices) ? (body.voices as Record<string, unknown>[]) : []) {
      const id = text(v.voice_id);
      if (id) out.push({ id, name: text(v.name) || id, category: text(v.category), previewUrl: text(v.preview_url) });
    }
    token = text(body.next_page_token);
    if (body.has_more !== true || !token) break;
  }
  return out.slice(0, MAX_VOICES);
}

/** Models from `GET /v1/models`: text-to-speech ones for tts, only `scribe*` for stt (static list if none). */
async function fetchModels(base: string, key: string, service: CatalogService): Promise<Pick<Catalog, "models" | "modelSource">> {
  const body = await getJson(base, "/v1/models", key);
  const all = (Array.isArray(body) ? (body as Record<string, unknown>[]) : []).flatMap((m) => {
    const id = text(m.model_id);
    return id ? [{ id, name: text(m.name) || id, tts: m.can_do_text_to_speech === true }] : [];
  });
  if (service === "tts") {
    return { models: all.filter((m) => m.tts).map(({ id, name }) => ({ id, name })), modelSource: "api" };
  }
  const scribe = all.filter((m) => m.id.startsWith("scribe")).map(({ id, name }) => ({ id, name }));
  return scribe.length ? { models: scribe, modelSource: "api" } : { models: STATIC_STT_MODELS, modelSource: "static" };
}

/**
 * Voices (tts only) and models for the chosen service, using the key resolved for it. The key is
 * read here and sent only to ElevenLabs; it is never returned or put in an error. Cached 60 s per
 * service, base and key (the key only as a hash), unless `refresh`.
 */
export async function loadCatalog(
  service: CatalogService,
  entry: { url?: string | undefined; apiKey?: string | undefined },
  refresh = false,
): Promise<Catalog> {
  const { key, info } = resolveApiKey(entry.apiKey, ELEVENLABS_KEY_ENV);
  if (!key) throw new CatalogError(400, "no-key", "no ElevenLabs API key is configured (save one, or set ELEVENLABS_API_KEY)");
  const base = (entry.url?.trim() || ELEVENLABS_BASE).replace(/\/+$/, "");
  const id = `${service}|${base}|${info.source}:${info.env ?? ""}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  const hit = cache.get(id);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const [voices, models] = await Promise.all([
    service === "tts" ? fetchVoices(base, key) : Promise.resolve([]),
    fetchModels(base, key, service),
  ]);
  const value: Catalog = { voices, ...models };
  cache.set(id, { at: Date.now(), value });
  if (cache.size > 50) cache.delete(cache.keys().next().value as string);
  return value;
}
