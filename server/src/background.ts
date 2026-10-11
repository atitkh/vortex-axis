import { taskIdFor } from "./cards.js";
import type { Ending, Progress, Task } from "./progress.js";
import { SentenceSplitter } from "./sentences.js";

/**
 * Agent work that outlives the device's turn.
 *
 * A spoken or typed turn waits for the agent like a conversation does. When the
 * agent has said nothing new for a while (it is off searching, building,
 * reading), the device says it will report back and is free again; the run
 * itself goes on in OpenClaw. This keeps following it: it shows as a task on
 * the screens while it works, and what it finally says is said on the device
 * the person last used, the way anything an agent starts is. A run that fails
 * says so. Taking its task off the screens (by hand, or an agent clearing it
 * with the progress tool) stops the run.
 *
 * While a run holds a conversation, nothing else can be answered there:
 * OpenClaw queues a second message behind the run. turns.ts sends new turns to
 * a conversation of their own meanwhile and asks `runningIn` which runs these are.
 */

/** What a handed-over run is, as the turn knew it. */
export interface Handover {
  /** The device the question came from. */
  clientId: string;
  /** What was asked, to name the task by. */
  question: string;
  /** The conversation and run, when the agent said. Without them the run cannot be stopped. */
  sessionKey?: string | undefined;
  runId?: string | undefined;
  /** The rest of the agent's reply, from where the turn left off. */
  rest: AsyncIterator<string>;
  /** A read of `rest` already under way, to be picked up first. */
  pending?: Promise<IteratorResult<string>> | undefined;
}

/** A handed-over run, to be told what the agent picks up on the way. */
export interface Job {
  id: string;
  tool(kind: string): void;
}

export interface BackgroundOptions {
  progress: Progress;
  /** Says something an agent started on the device the person last used, or on `clientId` when nowhere else will do. */
  deliver: (clientId: string, text: string) => Promise<unknown>;
  /** Stops a run in OpenClaw. */
  abort?: ((run: { sessionKey: string; runId: string }) => Promise<unknown>) | undefined;
  /** Whether a reply means to say nothing (NO_REPLY). */
  isSilent: (text: string) => boolean;
  log?: (line: string) => void;
  now?: () => number;
}

/** What a tool kind looks like on the task line. */
const DOING: Record<string, string> = {
  search: "searching",
  web: "reading the web",
  home: "checking the home",
  calendar: "checking the calendar",
  list: "working on lists",
  files: "working with files",
  code: "running commands",
  timer: "setting a timer",
  message: "sending a message",
  memory: "looking through notes",
  image: "looking at images",
  tool: "working on it",
};

/** How much of a long answer is said; the rest is in the conversation. */
const SAY_SENTENCES = 3;
const SAY_CHARS = 360;

interface Running {
  job: Handover;
  title: string;
  taskId: string;
  /** Our own task on the screens, unless the agent keeps a progress card for this conversation, which shows instead. */
  ownTask: boolean;
  stopped: boolean;
}

export class Background {
  private readonly running = new Map<string, Running>();
  private count = 0;

  constructor(private readonly options: BackgroundOptions) {}

  /** The title of a run that holds this conversation, if Axis handed one over there. */
  runningIn(sessionKey: string): { title: string; taskId: string } | undefined {
    for (const r of this.running.values()) if (r.job.sessionKey === sessionKey && !r.stopped) return { title: r.title, taskId: r.taskId };
    return undefined;
  }

  list(): { id: string; title: string; clientId: string; sessionKey?: string | undefined }[] {
    return [...this.running.entries()].map(([id, r]) => ({ id, title: r.title, clientId: r.job.clientId, sessionKey: r.job.sessionKey }));
  }

  /** Takes over a run the device stopped waiting for. */
  start(job: Handover): Job {
    const id = `bg-${++this.count}`;
    const title = titleFrom(job.question);
    const cardId = job.sessionKey ? taskIdFor(job.sessionKey) : undefined;
    const ownTask = !this.options.progress.list().some((t) => t.id === cardId && t.state !== "done");
    const r: Running = { job, title, taskId: ownTask ? id : (cardId ?? id), ownTask, stopped: false };
    this.running.set(id, r);
    if (ownTask) this.show(r, "working on it");
    this.options.log?.(`handed over a long agent run as ${id}: ${title}`);
    void this.follow(id, r);
    return {
      id,
      tool: (kind) => {
        if (!r.stopped) this.show(r, DOING[kind] ?? "working on it");
      },
    };
  }

  /** Told whenever a task leaves the screens: one of ours taken off by hand stops its run. */
  ended(task: Task, ending: Ending): void {
    if (ending !== "cleared") return;
    for (const [id, r] of this.running) {
      if (r.taskId !== task.id || r.stopped) continue;
      r.stopped = true;
      this.options.log?.(`stopping ${id}: its task was taken off the screens`);
      if (this.options.abort && r.job.sessionKey && r.job.runId) {
        this.options.abort({ sessionKey: r.job.sessionKey, runId: r.job.runId }).catch((error) => this.options.log?.(`could not stop ${id}: ${(error as Error).message}`));
      }
    }
  }

  private show(r: Running, note: string): void {
    // When the agent keeps a progress card of its own for this conversation, that is the task on the screens.
    const cardId = r.job.sessionKey ? taskIdFor(r.job.sessionKey) : undefined;
    if (cardId && this.options.progress.list().some((t) => t.id === cardId && t.state !== "done")) {
      if (r.ownTask) {
        r.ownTask = false;
        this.options.progress.clear(r.taskId);
        r.taskId = cardId;
      }
      return;
    }
    if (!r.ownTask) return;
    try {
      this.options.progress.update({ id: r.taskId, title: r.title, note });
    } catch {
      // A task that cannot be shown is no reason to stop following the run.
    }
  }

  private async follow(id: string, r: Running): Promise<void> {
    let text = "";
    let failure: Error | undefined;
    try {
      let next = r.job.pending ?? r.job.rest.next();
      for (;;) {
        const step = await next;
        if (step.done) break;
        text += step.value;
        next = r.job.rest.next();
      }
    } catch (error) {
      failure = error as Error;
    }
    this.running.delete(id);
    if (r.stopped) {
      this.options.log?.(`${id} stopped`);
      return;
    }
    const finish = () => {
      if (r.ownTask && this.options.progress.list().some((t) => t.id === r.taskId)) {
        try {
          this.options.progress.update({ id: r.taskId, title: r.title, note: "", state: "done" });
        } catch {
          // Shown or not, the answer still goes out.
        }
      }
    };
    if (failure) {
      this.options.log?.(`${id} failed: ${failure.message}`);
      if (r.ownTask) this.options.progress.clear(r.taskId);
      await this.say(r, `That task didn't finish: ${failure.message.replace(/[.\s]+$/, "")}.`);
      return;
    }
    finish();
    if (this.options.isSilent(text)) return;
    await this.say(r, `About ${r.title}: ${spoken(text)}`);
  }

  private async say(r: Running, text: string): Promise<void> {
    try {
      await this.options.deliver(r.job.clientId, text);
    } catch (error) {
      this.options.log?.(`could not say how a long run ended: ${(error as Error).message}`);
    }
  }
}

/** A few words for what was asked, to name its task by. */
export function titleFrom(question: string): string {
  const plain = question.replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "");
  if (plain.length <= 40) return plain || "a long task";
  const cut = plain.slice(0, 40);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24))}…`;
}

/** The first few sentences of an answer; the rest is in the conversation. */
export function spoken(answer: string): string {
  const splitter = new SentenceSplitter();
  const pieces = [...splitter.pushPieces(answer.trim())];
  const rest = splitter.flushPiece();
  if (rest) pieces.push(rest);
  let said = "";
  let count = 0;
  for (const piece of pieces) {
    if (count >= SAY_SENTENCES || (said && said.length + piece.text.length > SAY_CHARS)) {
      return `${said.trim()} The rest is in the chat.`;
    }
    said += `${piece.text} `;
    count++;
  }
  return said.trim();
}
