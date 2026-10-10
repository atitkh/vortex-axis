import type { AskResult } from "./ask.js";

/**
 * Puts what an OpenClaw agent is waiting on a person for in front of that
 * person, on a device: a question the agent asked (`question.requested`), or
 * an approval it needs before it may run a command or a tool
 * (`exec.approval.requested`, `plugin.approval.requested`). The gateway
 * announces these to operators that hold the scope; the answer goes back the
 * same way. Wherever else the gateway shows the same thing still works, and
 * whichever answer comes first is the answer: Axis takes its own question back
 * when the gateway says it is settled.
 *
 * An approval lets an agent do something, so it is held to more than a
 * question is. It is shown, never spoken. Only "allow once" is ever offered,
 * never a standing permission. And only a tap allows: something heard by a
 * microphone can refuse, but it cannot let a command run.
 */

/** The part of the gateway this needs: events in, and calls on the link that holds the scopes. */
export interface AskSource {
  onEvent(listener: (event: string, payload: any) => void): void;
  callWatch(method: string, params: unknown): Promise<any>;
}

/** How a question reaches a person. `app.ts` supplies the devices and the notifications. */
export interface AskRoute {
  /**
   * Puts the question to the person and resolves with what they did. Undefined
   * when there is nowhere to ask right now.
   */
  ask(input: { question: string; choices: string[]; timeoutMs: number; silent: boolean; signal: AbortSignal }): Promise<AskResult | undefined>;
}

export interface AgentAsksOptions {
  source: AskSource;
  route: AskRoute;
  questions: () => boolean;
  approvals: () => boolean;
  /** False while the gateway has not let Axis hear questions yet, so it is not asked what it would refuse. */
  listening?: () => boolean;
  /** Told when what a session waits on changes, so its task on the screens can say so. */
  onChange?: (sessionKey: string) => void;
  /** What Axis signs an answer with. */
  resolvedBy?: string;
  log?: (line: string) => void;
  note?: (text: string) => void;
  now?: () => number;
}

interface Waiting {
  kind: "question" | "exec" | "plugin";
  sessionKey?: string;
  /** A few words for the task line. */
  line: string;
  abort: AbortController;
}

/** A device shows a question for this long at most; the gateway may wait longer, elsewhere. */
const MAX_SHOWN_MS = 5 * 60_000;
const ALLOW = "Allow once";
const DENY = "Deny";

const short = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

export class AgentAsks {
  private readonly waiting = new Map<string, Waiting>();
  private readonly now: () => number;

  constructor(private readonly options: AgentAsksOptions) {
    this.now = options.now ?? Date.now;
    options.source.onEvent((event, payload) => {
      if (event === "question.requested") void this.question(payload);
      else if (event === "exec.approval.requested") void this.approval("exec", payload);
      else if (event === "plugin.approval.requested") void this.approval("plugin", payload);
      else if (event === "question.resolved" || event === "exec.approval.resolved" || event === "plugin.approval.resolved") this.settled(payload?.id);
      else if (event === "watch.connected") void this.catchUp();
    });
  }

  /** What a session is waiting on the person for, in a few words. Undefined when it is waiting on nothing. */
  waitingOn(sessionKey: string): string | undefined {
    for (const entry of this.waiting.values()) if (entry.sessionKey === sessionKey) return entry.line;
    return undefined;
  }

  /** Everything waiting, for the admin page. */
  list(): { id: string; kind: Waiting["kind"]; sessionKey: string | null; line: string }[] {
    return [...this.waiting].map(([id, w]) => ({ id, kind: w.kind, sessionKey: w.sessionKey ?? null, line: w.line }));
  }

  stop(): void {
    for (const entry of this.waiting.values()) entry.abort.abort();
    this.waiting.clear();
  }

  /** Questions asked while Axis was not listening are still waiting on the gateway. */
  private async catchUp(): Promise<void> {
    if (!this.options.questions() || this.options.listening?.() === false) return;
    try {
      const reply = await this.options.source.callWatch("question.list", {});
      for (const record of Array.isArray(reply?.questions) ? reply.questions : []) {
        if (record?.status === "pending") void this.question(record);
      }
    } catch (error) {
      this.options.log?.(`agent questions: could not list what is waiting: ${(error as Error).message}`);
    }
  }

  private begin(id: string, entry: Omit<Waiting, "abort">, expiresAtMs: unknown): Waiting | undefined {
    if (this.waiting.has(id)) return undefined;
    const waiting = { ...entry, abort: new AbortController() };
    this.waiting.set(id, waiting);
    // The gateway gives up on it at some point, and may not say so.
    const left = (Number(expiresAtMs) || this.now() + 15 * 60_000) - this.now();
    setTimeout(() => this.waiting.get(id) === waiting && this.settled(id), Math.max(1_000, Math.min(left, 60 * 60_000)) + 2_000).unref();
    if (entry.sessionKey) this.options.onChange?.(entry.sessionKey);
    return waiting;
  }

  /** The gateway says it is settled, by an answer here or anywhere else. */
  private settled(id: unknown): void {
    if (typeof id !== "string") return;
    const entry = this.waiting.get(id);
    if (!entry) return;
    this.waiting.delete(id);
    entry.abort.abort();
    if (entry.sessionKey) this.options.onChange?.(entry.sessionKey);
  }

  private async question(record: any): Promise<void> {
    if (!this.options.questions() || typeof record?.id !== "string" || !Array.isArray(record.questions)) return;
    const questions: any[] = record.questions;
    // A secret is typed where it cannot be overheard, and a pick of several has no place on a small screen.
    if (!questions.length || questions.some((q) => q?.isSecret || q?.secretStore || q?.multiSelect)) return;
    const first = String(questions[0]?.question ?? "").trim();
    const entry = this.begin(record.id, {
      kind: "question",
      ...(typeof record.sessionKey === "string" ? { sessionKey: record.sessionKey } : {}),
      line: short(first, 80),
    }, record.expiresAtMs);
    if (!entry) return;

    const answers: Record<string, string[]> = {};
    try {
      for (const q of questions) {
        const text = String(q?.question ?? "").trim();
        const id = String(q?.questionId ?? q?.id ?? "");
        const choices: string[] = (Array.isArray(q?.options) ? q.options : []).map((o: any) => String(o?.label ?? "").slice(0, 64)).filter(Boolean);
        if (!text || !id) return;
        const left = Math.min(MAX_SHOWN_MS, (Number(record.expiresAtMs) || this.now() + MAX_SHOWN_MS) - this.now());
        if (left < 5_000) return;
        const result = await this.options.route.ask({ question: text.slice(0, 500), choices, timeoutMs: left, silent: false, signal: entry.abort.signal });
        if (entry.abort.signal.aborted || !result) return;
        // A choice as it was offered; or the person's own words where the question takes them.
        const answer = result.answer ?? (result.said && (!choices.length || q?.isOther) ? result.said.trim() : undefined);
        if (!answer) return;
        answers[id] = [answer];
      }
      await this.options.source.callWatch("question.resolve", { id: record.id, answers: { answers }, resolvedBy: this.options.resolvedBy ?? "VorteX Axis" });
      this.options.note?.(`Answered an agent's question on a device: "${short(first, 60)}"`);
    } catch (error) {
      this.options.log?.(`agent questions: ${(error as Error).message}`);
    } finally {
      // Unanswered here, it is still waiting on the gateway: the task line goes on saying so until the gateway settles it.
      entry.abort.abort();
    }
  }

  private async approval(kind: "exec" | "plugin", payload: any): Promise<void> {
    if (!this.options.approvals() || typeof payload?.id !== "string") return;
    const request = payload.request ?? payload;
    const allowed: unknown = request?.allowedDecisions;
    // Something that may only be allowed for good is not Axis's to allow.
    if (Array.isArray(allowed) && !(allowed.includes("allow-once") && allowed.includes("deny"))) return;
    const what =
      kind === "exec"
        ? String(request?.commandPreview ?? request?.command ?? request?.commandText ?? "a command")
        : String(request?.title ?? request?.toolName ?? "a tool");
    const detail = kind === "plugin" && typeof request?.description === "string" ? `: ${request.description}` : "";
    const entry = this.begin(payload.id, {
      kind,
      ...(typeof request?.sessionKey === "string" ? { sessionKey: request.sessionKey } : {}),
      line: short(`approve: ${what}`, 80),
    }, payload.expiresAtMs);
    if (!entry) return;
    try {
      const left = Math.min(MAX_SHOWN_MS, (Number(payload.expiresAtMs) || this.now() + MAX_SHOWN_MS) - this.now());
      if (left < 5_000) return;
      const question = short(`${kind === "exec" ? "Run this command?" : "Allow this?"} ${what}${detail}`.replace(/\s+/g, " "), 500);
      const result = await this.options.route.ask({ question, choices: [ALLOW, DENY], timeoutMs: left, silent: true, signal: entry.abort.signal });
      if (entry.abort.signal.aborted || !result?.answer) return;
      // Only a finger allows. A voice may refuse.
      if (result.answer === ALLOW && result.how !== "tap") return;
      const decision = result.answer === ALLOW ? "allow-once" : "deny";
      await this.options.source.callWatch(`${kind}.approval.resolve`, { id: payload.id, decision });
      this.options.note?.(`${decision === "deny" ? "Refused" : "Allowed once"} on a device: ${short(what, 80)}`);
    } catch (error) {
      this.options.log?.(`agent approvals: ${(error as Error).message}`);
    } finally {
      entry.abort.abort();
    }
  }
}
