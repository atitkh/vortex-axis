import { createHash } from "node:crypto";
import type { Progress } from "./progress.js";

/**
 * Shows the work of an OpenClaw gateway's sessions with no tool call: an agent
 * there keeps a "progress card", a list of steps each pending, in progress or
 * completed, and the gateway tells its operators whenever one changes. Axis
 * reads the card and reports it to `Progress` as it would a call to the
 * progress tool, so the screens show it the same way.
 *
 * A card has no state of its own beyond its steps. With every step completed
 * the task is done. With steps left and nobody at work in the session (the
 * agent's turn is over), it is waiting for the person. Scheduled jobs are left
 * out: nobody is watching for them.
 */

/** The part of the gateway link this needs. */
export interface CardSource {
  onEvent(listener: (event: string, payload: any) => void): void;
  call(method: string, params: unknown): Promise<any>;
}

interface SessionInfo {
  title: string;
  scheduled: boolean;
  active: boolean;
}

interface Mirrored {
  sessionKey: string;
  /** What was last reported, so the same card is not told twice. */
  told: string;
  finished: boolean;
}

export interface CardMirrorOptions {
  source: CardSource;
  progress: Pick<Progress, "update" | "clear" | "touch">;
  enabled: () => boolean;
  /** What a session is waiting on the person for, if anything: a question or an approval, in a few words. */
  waitingOn?: (sessionKey: string) => string | undefined;
  log?: (line: string) => void;
  /** How often sessions with a task on show are asked whether anybody is still at work. */
  pollMs?: number;
  /** How long after a card changes it is read, so a burst of changes is read once. */
  settleMs?: number;
}

/** A short, steady name for a session's task. */
export function taskIdFor(sessionKey: string): string {
  return `oc-${createHash("sha256").update(sessionKey).digest("hex").slice(0, 10)}`;
}

/** What to call a session's work: where the person talks to it, as they know it. */
export function titleFor(session: any): string {
  const origin = typeof session?.origin?.label === "string" ? session.origin.label.replace(/\s+(channel|user|group|thread)\s+id:.*$/i, "") : "";
  const name = [origin, session?.label, session?.groupChannel, session?.displayName].find((value) => typeof value === "string" && value.trim());
  return (name ? String(name) : "Agent").trim().replace(/^#/, "").slice(0, 40) || "Agent";
}

export class CardMirror {
  private readonly shown = new Map<string, Mirrored>();
  private readonly waiting = new Map<string, NodeJS.Timeout>();
  private sessions = new Map<string, SessionInfo>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: CardMirrorOptions) {
    options.source.onEvent((event, payload) => {
      if (event !== "progressCard.changed" || typeof payload?.sessionKey !== "string") return;
      this.changed(payload.sessionKey);
    });
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? 10_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const timer of this.waiting.values()) clearTimeout(timer);
    this.waiting.clear();
  }

  /** Takes every mirrored task off the screens, for when mirroring is switched off. */
  drop(): void {
    for (const id of this.shown.keys()) this.options.progress.clear(id);
    this.shown.clear();
  }

  /** Looks at a session's card again: what it waits on has changed. */
  refresh(sessionKey: string): void {
    if (this.shown.has(taskIdFor(sessionKey))) this.changed(sessionKey);
  }

  private changed(sessionKey: string): void {
    if (!this.options.enabled()) return;
    clearTimeout(this.waiting.get(sessionKey));
    const timer = setTimeout(() => {
      this.waiting.delete(sessionKey);
      void this.read(sessionKey, true);
    }, this.options.settleMs ?? 300);
    timer.unref();
    this.waiting.set(sessionKey, timer);
  }

  /** Reads one session's card and reports it. `fresh` asks the gateway about the session again first. */
  private async read(sessionKey: string, fresh: boolean): Promise<void> {
    const id = taskIdFor(sessionKey);
    try {
      const reply = await this.options.source.call("progressCard.get", { sessionKey });
      const steps: { step: string; status: string }[] = Array.isArray(reply?.card?.steps) ? reply.card.steps : [];
      if (!steps.length) {
        // The card is gone, or is a note with no steps: nothing to count.
        if (this.shown.delete(id)) this.options.progress.clear(id);
        return;
      }
      if (fresh || !this.sessions.has(sessionKey)) await this.learn();
      const session = this.sessions.get(sessionKey);
      if (session?.scheduled) return;

      const done = steps.every((s) => s.status === "completed");
      const current = steps.find((s) => s.status === "in_progress") ?? steps.find((s) => s.status === "pending");
      // Steps left and the agent's turn over: it stopped to ask, or it was stopped. Either way it is the person's move.
      // A question or an approval it is waiting on says so itself, and says what.
      const asking = done ? undefined : this.options.waitingOn?.(sessionKey);
      const state = done ? "done" : asking || (session && !session.active) ? "blocked" : "running";
      const told = JSON.stringify([steps, state, session?.title, asking]);
      const before = this.shown.get(id);
      if (before?.told === told) return;
      // A card left finished from an earlier piece of work is not news when Axis first hears of it.
      if (done && !before) return;
      this.shown.set(id, { sessionKey, told, finished: done });
      this.options.progress.update({
        id,
        title: session?.title ?? "Agent",
        note: done ? "" : (asking ?? current?.step ?? "").slice(0, 80),
        steps: steps.slice(0, 12),
        state,
      });
    } catch (error) {
      this.options.log?.(`progress cards: could not read the card of ${sessionKey}: ${(error as Error).message}`);
    }
  }

  /** Asks the gateway what its sessions are called, which are scheduled jobs, and where an agent is at work. */
  private async learn(): Promise<void> {
    const reply = await this.options.source.call("sessions.list", { limit: 200 });
    const list: any[] = Array.isArray(reply?.sessions) ? reply.sessions : [];
    this.sessions = new Map(
      list
        .filter((s) => typeof s?.key === "string")
        .map((s): [string, SessionInfo] => [
          s.key as string,
          { title: titleFor(s), scheduled: s.classification === "cron" || s.isBackground === true, active: s.hasActiveRun === true },
        ]),
    );
  }

  /** A task on show follows its session: still at work, stopped with steps left, or at work again. */
  private async poll(): Promise<void> {
    if (!this.options.enabled()) {
      if (this.shown.size) this.drop();
      return;
    }
    const open = [...this.shown.entries()].filter(([, m]) => !m.finished);
    if (!open.length) {
      for (const [id, m] of this.shown) if (m.finished) this.shown.delete(id);
      return;
    }
    try {
      await this.learn();
    } catch (error) {
      return void this.options.log?.(`progress cards: could not list the sessions: ${(error as Error).message}`);
    }
    for (const [id, m] of open) {
      if (this.sessions.get(m.sessionKey)?.active) this.options.progress.touch(id);
      await this.read(m.sessionKey, false);
    }
  }
}
