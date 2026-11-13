import type { IncomingHttpHeaders } from "node:http";

/** The payload formats a hook source may be set to. */
export const HOOK_FORMATS = ["generic", "gitea", "github", "kuma", "ha"] as const;
export type HookFormat = (typeof HOOK_FORMATS)[number];

/**
 * What a mapper hands back: a generic-shaped object (the caller cleans every string exactly as it does for a generic payload),
 * an event that is only worth a quiet line, or an error for a payload that is not what the format promises.
 */
export type PresetResult = { data: Record<string, unknown> } | { ignore: string } | { error: string };

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const head = (headers: IncomingHttpHeaders, name: string): string => {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};
const httpUrl = (v: unknown): string | undefined => {
  const s = str(v);
  return /^https?:\/\/[^\s]+$/i.test(s) && s.length <= 500 ? s : undefined;
};

/** Maps one payload by format. Pure: no clock, no network. Generic is not handled here. */
export function mapPreset(format: string, headers: IncomingHttpHeaders, json: unknown): PresetResult {
  const d = obj(json);
  switch (format) {
    case "gitea":
    case "github":
      return forge(format, headers, d);
    case "kuma":
      return kuma(d);
    case "ha":
      return ha(d);
    default:
      return { error: `format ${format} has no preset` };
  }
}

function forge(format: "gitea" | "github", headers: IncomingHttpHeaders, d: Obj): PresetResult {
  const name = format === "gitea" ? "gitea" : "github";
  const event = head(headers, `x-${name}-event`);
  if (!/^[a-z_]{1,40}$/.test(event)) return { error: `no ${name} event header` };
  const delivery = head(headers, `x-${name}-delivery`);
  const dedupe = /^[A-Za-z0-9._:-]{1,100}$/.test(delivery) ? delivery : undefined;
  const repo = str(obj(d.repository).full_name) || str(obj(d.repository).name) || name;
  const action = str(d.action);
  const sender = str(obj(d.sender).login);
  const mk = (short: string, body: string, url: unknown, priority: "normal" | "urgent" = "normal"): PresetResult => ({
    data: { title: cut(`${repo}: ${short}`, 100), body: cut(body, 200), priority, tag: `${name}-${event}`, ...(dedupe ? { dedupe } : {}), ...(httpUrl(url) ? { url: httpUrl(url) } : {}) },
  });
  if (event === "pull_request") {
    const pr = obj(d.pull_request);
    const title = str(pr.title);
    if (action === "opened") return mk(`pull request opened`, `${sender ? `${sender}: ` : ""}${title}`, pr.html_url);
    if (action === "closed" && pr.merged === true) return mk(`pull request merged`, title, pr.html_url);
    return { ignore: event };
  }
  if (event === "issues") {
    if (action !== "opened") return { ignore: event };
    const issue = obj(d.issue);
    return mk(`issue opened`, `${sender ? `${sender}: ` : ""}${str(issue.title)}`, issue.html_url);
  }
  if (event === "release") {
    if (action !== "published") return { ignore: event };
    const rel = obj(d.release);
    return mk(`release ${str(rel.tag_name)}`.trim(), str(rel.name) || str(rel.tag_name), rel.html_url);
  }
  if (event === "workflow_run" || event === "workflow_job" || event === "check_suite") {
    const run = obj(d[event]);
    const done = event === "check_suite" ? action === "completed" || str(run.status) === "completed" : action === "completed";
    const conclusion = str(run.conclusion);
    if (!done || !["failure", "timed_out", "cancelled_failure", "startup_failure"].includes(conclusion)) return { ignore: event };
    const what = str(run.name) || str(run.workflow_name) || event;
    return mk(`${what} failed`, `${event} ${conclusion}${str(run.head_branch) ? ` on ${str(run.head_branch)}` : ""}`, run.html_url);
  }
  // push, create, delete, star, watch, fork, ping and everything else: a quiet line only.
  return { ignore: event };
}

function kuma(d: Obj): PresetResult {
  const hb = obj(d.heartbeat);
  const monitor = obj(d.monitor);
  const name = str(monitor.name) || str(d.msg).split(" ")[0] || "monitor";
  if (hb.status === undefined) return { ignore: "ping" };
  const status = Number(hb.status);
  const time = str(hb.time);
  const dedupe = `${str(monitor.id) || name}-${time}`.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120);
  const url = httpUrl(monitor.url);
  if (status === 0) {
    return { data: { title: cut(`${name} is down`, 100), body: cut(str(hb.msg) || str(d.msg) || "no answer", 200), priority: "urgent", tag: "kuma-down", dedupe, ...(url ? { url } : {}) } };
  }
  if (status === 1) {
    return { data: { title: cut(`${name} is back up`, 100), body: cut(str(hb.msg) || str(d.msg), 200), priority: "normal", tag: "kuma-up", dedupe, ...(url ? { url } : {}) } };
  }
  return { ignore: "heartbeat" };
}

function ha(d: Obj): PresetResult {
  const message = str(d.message) || str(d.body);
  if (!message.trim()) return { error: "say something: message" };
  const out: Obj = { body: cut(message, 500) };
  if (d.title !== undefined) out.title = d.title;
  if (d.priority !== undefined) out.priority = d.priority;
  if (d.tag !== undefined) out.tag = d.tag;
  if (d.dedupe !== undefined) out.dedupe = d.dedupe;
  if (d.url !== undefined) out.url = d.url;
  return { data: out };
}
