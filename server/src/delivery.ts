import { randomBytes } from "node:crypto";
import type { Hub, Session } from "./hub.js";
import type { PushService } from "./push.js";
import type { ClientRecord, Store } from "./store.js";
import type { AskResult } from "./ask.js";

/**
 * Gets something an agent wants said to a client by whatever route the client
 * has at that moment:
 *
 * - connected: spoken (and shown) there, as always;
 * - a browser client whose page is closed but which allowed notifications: a
 *   notification through its browser;
 * - otherwise held for a while and said if the client comes back in time.
 *
 * It also sends one message to several clients at once, and puts a question
 * with choices to a closed browser as a notification.
 */

export interface Delivered {
  client: string;
  /** The client confirmed the audio played to the end. */
  heard: boolean;
  /** The words were put in front of the person as text. */
  shown: boolean;
  /** Not delivered yet: kept, and said if the client connects in time. */
  held?: boolean;
  note?: string;
  [key: string]: unknown;
}

interface Held {
  text: string;
  urgent: boolean;
  until: number;
}

interface PendingAsk {
  clientId: string;
  question: string;
  token: string;
  choices: string[];
  settle: (result: AskResult) => void;
}

export interface DeliveryOptions {
  hub: Hub;
  store: Store;
  push?: PushService | undefined;
  /** How long a message for a client that is away is kept. */
  holdMs: number;
  note?: (clientId: string, text: string, level?: "info" | "warn") => void;
  now?: () => number;
}

/** No more than this many messages wait for one client; older ones are dropped first. */
const MAX_HELD = 5;

export class Delivery {
  private readonly held = new Map<string, Held[]>();
  private readonly asks = new Map<string, PendingAsk>();
  private readonly now: () => number;

  constructor(private readonly options: DeliveryOptions) {
    this.now = options.now ?? Date.now;
    options.hub.onConnect((session) => void this.flush(session));
  }

  /**
   * Says something on a connected client. In the client's quiet hours it is shown without sound,
   * unless it is `urgent`; a client with no screen is then left alone.
   */
  async sayOn(session: Session, text: string, urgent = false): Promise<Delivered> {
    const shown = session.client.capabilities.includes("screen");
    if (!urgent && this.options.hub.quiet(session.client)) {
      if (!shown) {
        return { client: session.client.name, heard: false, shown: false, note: "It is in its quiet hours and has no screen, so nothing was said. Mark it urgent to speak anyway." };
      }
      await this.options.hub.say(session, text, { silent: true });
      return { client: session.client.name, heard: false, shown: true, note: "It is in its quiet hours: shown on its screen, not spoken. Mark it urgent to speak anyway." };
    }
    const { heard } = await this.options.hub.say(session, text);
    return {
      client: session.client.name,
      heard,
      shown,
      // "heard" is the client's own confirmation that the audio played to the
      // end. Without it the agent must not assume the person heard anything.
      ...(heard
        ? {}
        : { note: shown ? "Not confirmed as heard. The text was shown on the client's screen." : "Not confirmed as heard, and this client has no screen." }),
    };
  }

  /** Says something to one client, connected or not. */
  async sayTo(client: ClientRecord, text: string, urgent = false): Promise<Delivered> {
    const session = this.options.hub.session(client.id);
    if (session) return this.sayOn(session, text, urgent);

    if (this.options.push?.has(client.id)) {
      const outcome = await this.options.push.notify(client.id, { title: "Vortex", body: text, tag: "say" });
      if (outcome === "sent") {
        this.options.note?.(client.id, `Sent to ${client.name} as a notification (its page is closed)`);
        return { client: client.name, heard: false, shown: true, note: "Its page is closed, so this went to it as a notification. Nothing was spoken." };
      }
    }

    const waiting = (this.held.get(client.id) ?? []).filter((h) => h.until > this.now());
    waiting.push({ text, urgent, until: this.now() + this.options.holdMs });
    this.held.set(client.id, waiting.slice(-MAX_HELD));
    const minutes = Math.max(1, Math.round(this.options.holdMs / 60_000));
    this.options.note?.(client.id, `${client.name} is offline: one message is kept for it for ${minutes} min`);
    return {
      client: client.name,
      heard: false,
      shown: false,
      held: true,
      note: `${client.name} is offline. This is kept and will be said if it comes back within ${minutes} minute${minutes === 1 ? "" : "s"}; after that it is dropped.`,
    };
  }

  /** How many messages are waiting for a client, for the admin page. */
  waitingFor(clientId: string): number {
    return (this.held.get(clientId) ?? []).filter((h) => h.until > this.now()).length;
  }

  /** Says what was kept for a client that has just connected. */
  private async flush(session: Session): Promise<void> {
    const waiting = (this.held.get(session.client.id) ?? []).filter((h) => h.until > this.now());
    this.held.delete(session.client.id);
    if (!waiting.length) return;
    // Give the client a moment to settle (settings, its own greeting) before it is spoken to.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const message of waiting) {
      if (!this.options.hub.session(session.client.id)) {
        // Gone again mid-way: keep what is left for next time.
        this.held.set(session.client.id, waiting.slice(waiting.indexOf(message)));
        return;
      }
      try {
        await this.sayOn(session, message.text, message.urgent);
        this.options.note?.(session.client.id, `Said a kept message on ${session.client.name} now that it is back`);
      } catch (error) {
        this.options.note?.(session.client.id, `A kept message for ${session.client.name} could not be said: ${(error as Error).message}`, "warn");
      }
    }
  }

  /**
   * Says one thing on several clients at once: every connected client that
   * can speak, in one location or everywhere. Browsers with their page closed
   * get it as a notification. Clients that are simply offline are left out.
   */
  async sayToAll(location: string | undefined, text: string, urgent = false): Promise<{ clients: Delivered[]; heard: boolean }> {
    const place = location?.trim().toLowerCase();
    const at = (client: ClientRecord) => String(this.options.store.resolveSettings(client).location ?? "").trim().toLowerCase();
    const inScope = (client: ClientRecord) => !place || at(client) === place;

    const speaking = [...this.options.hub.sessions()].filter((s) => s.client.capabilities.includes("speaker") && inScope(s.client));
    const closed = this.options.store
      .listClients()
      .filter((c) => !this.options.hub.session(c.id) && this.options.push?.has(c.id) && inScope(c));
    if (!speaking.length && !closed.length) {
      throw new Error(place ? `no client that can speak is online in "${location}"` : "no client that can speak is online");
    }
    const results = await Promise.all([
      ...speaking.map((session) =>
        this.sayOn(session, text, urgent).catch((error): Delivered => ({ client: session.client.name, heard: false, shown: false, note: (error as Error).message })),
      ),
      ...closed.map((client) => this.sayTo(client, text, urgent)),
    ]);
    return { clients: results, heard: results.some((r) => r.heard) };
  }

  /** True when a question can be put to this client as a notification: it is away, has choices to offer, and allowed notifications. */
  canAskByNotification(client: ClientRecord, choices: string[]): boolean {
    return !this.options.hub.session(client.id) && choices.length > 0 && Boolean(this.options.push?.has(client.id));
  }

  /**
   * Puts a question with choices to a browser whose page is closed. The
   * notification carries the choices; picking one (on the notification where
   * the system allows buttons, otherwise on the page it opens) comes back
   * through `answer`.
   */
  async askByNotification(client: ClientRecord, question: string, choices: string[], timeoutMs: number): Promise<AskResult> {
    const id = randomBytes(9).toString("base64url");
    const token = randomBytes(18).toString("base64url");
    const outcome = await this.options.push!.notify(
      client.id,
      { title: "Vortex asks", body: question, tag: `ask-${id}`, ask: { id, token, question, choices } },
      Math.ceil(timeoutMs / 1000),
    );
    if (outcome !== "sent") throw new Error(`${client.name} is offline and the notification could not be sent`);
    this.options.note?.(client.id, `Asked ${client.name} a question as a notification (its page is closed)`);
    return new Promise<AskResult>((resolve) => {
      const timer = setTimeout(() => {
        this.asks.delete(id);
        resolve({ answer: null, timedOut: true });
      }, timeoutMs);
      timer.unref();
      this.asks.set(id, {
        clientId: client.id,
        question,
        token,
        choices,
        settle: (result) => {
          clearTimeout(timer);
          this.asks.delete(id);
          resolve(result);
        },
      });
    });
  }

  /**
   * Questions sent to a client as notifications and still waiting. A page that has just been opened
   * asks for these, because a phone does not reliably hand the page the notification that opened it.
   */
  openAsks(clientId: string): { id: string; token: string; question: string; choices: string[] }[] {
    return [...this.asks]
      .filter(([, ask]) => ask.clientId === clientId)
      .map(([id, ask]) => ({ id, token: ask.token, question: ask.question, choices: ask.choices }));
  }

  /** An answer picked from a notification. False when the question is no longer open or the answer is not one of its choices. */
  answer(id: string, token: string, choice: string): boolean {
    const pending = this.asks.get(id);
    if (!pending || pending.token !== token || !pending.choices.includes(choice)) return false;
    pending.settle({ answer: choice, how: "tap" });
    return true;
  }
}
