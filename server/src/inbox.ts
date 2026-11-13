import type { NotificationRecord, NotificationSource } from "./store.js";

export const INBOX_SOURCES: readonly NotificationSource[] = ["agent", "reminder", "ask", "system", "webhook"];

/** A notification as the inbox shows it. Never carries the url, answer token or any secret. Title and body are text from outside. */
export function inboxItem(n: NotificationRecord, now: number, bodyMax = 2000, devices?: { name: string; route: string; state: string }[]): Record<string, unknown> {
  return {
    id: n.id,
    source: n.source,
    from: n.sourceName ?? n.source,
    ...(n.title !== undefined ? { title: n.title } : {}),
    body: n.body.length > bodyMax ? `${n.body.slice(0, bodyMax)}…` : n.body,
    priority: n.priority,
    status: n.status,
    unread: n.readAt === undefined,
    createdAt: new Date(n.createdAt).toISOString(),
    age: ageOf(now - n.createdAt),
    ...(devices?.length ? { devices } : {}),
  };
}

function ageOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Reads the ids / all part of an inbox request body. */
export function inboxIds(body: { ids?: unknown; all?: unknown }): number[] | "all" {
  if (body.all === true) return "all";
  if (Array.isArray(body.ids) && body.ids.length > 0 && body.ids.length <= 500 && body.ids.every((i) => Number.isInteger(i) && (i as number) > 0)) return body.ids as number[];
  throw new Error("say which notifications: ids (a list of numbers) or all true");
}

/** Parses the list filters shared by the admin and phone routes. */
export function inboxQuery(get: (key: string) => string | null): { source?: NotificationSource; sourceName?: string; unread?: boolean; before?: number; limit: number } {
  const source = get("source");
  if (source && !INBOX_SOURCES.includes(source as NotificationSource)) throw new Error(`source must be one of ${INBOX_SOURCES.join(", ")}`);
  const before = Number(get("before"));
  const limit = Number(get("limit"));
  return {
    ...(source ? { source: source as NotificationSource } : {}),
    ...(get("name") ? { sourceName: get("name") as string } : {}),
    ...(get("unread") === "1" ? { unread: true } : {}),
    ...(Number.isInteger(before) && before > 0 ? { before } : {}),
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50,
  };
}
