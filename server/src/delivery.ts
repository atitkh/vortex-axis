import { SpeechShare } from "./speech.js";
import { randomBytes } from "node:crypto";
import type { Hub, Session } from "./hub.js";
import type { PushService } from "./push.js";
import { SOURCE_CAP, type ClientRecord, type DeliveryRoute, type DeliveryState, type NotificationPriority, type NotificationSource, type NotificationStatus, type Store } from "./store.js";
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

/** What a caller knows about a message: an existing notification to update (`id`), or what to record on a new one. */
export interface DeliveryMeta {
  /** A notification already recorded: only its deliveries and status are updated, no new one is made. */
  id?: number;
  source?: NotificationSource;
  sourceName?: string;
  title?: string;
  priority?: NotificationPriority;
  reminderId?: number;
}

interface PendingAsk {
  clientId: string;
  question: string;
  token: string;
  choices: string[];
  notificationId: number;
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

/** No more than this many messages wait for one client, or are handed to one page; older ones are dropped first. */
const MAX_HELD = 5;

/** How far a notification has got; a later delivery never moves it back (one client heard it, another only had it kept). */
const RANK: Partial<Record<NotificationStatus, number>> = { pending: 0, dropped: 1, held: 2, delivered: 3, heard: 4 };

/**
 * Every message is recorded in the store's notifications table, with one delivery row per client it went to. What is
 * kept for a client that is away, what went to a closed browser and the questions it missed are read back from there,
 * so they survive a restart. Questions still open stay in memory: their answer can only come back to this process.
 */
export class Delivery {
  private readonly asks = new Map<string, PendingAsk>();
  /** Clients whose kept messages are being said right now, so a second connect does not say them twice. */
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: DeliveryOptions) {
    this.now = options.now ?? Date.now;
    options.hub.onConnect((session) => void this.flush(session));
    // What a device without a screen was kept while silent is said once it leaves silent.
    options.hub.onProfileChange((session, _profile, before) => {
      if (before === "silent") void this.flush(session);
    });
  }

  /** Run once after construction: questions that went out as notifications before a restart can no longer be answered, so they are missed. */
  startup(): void {
    const open = this.options.store.listNotifications({ source: "ask", limit: SOURCE_CAP }).filter((n) => n.status === "pending");
    for (const ask of open) this.askTimedOut(ask.id, ask.clientId);
  }

  /**
   * Says something on a connected client. In the client's quiet hours it is shown without sound,
   * unless it is `urgent`; a client with no screen is then left alone. On the silent profile nothing is spoken, urgent
   * or not: it is shown, or kept until the client leaves silent when it has no screen.
   */
  async sayOn(session: Session, text: string, urgent = false, share?: SpeechShare, meta?: DeliveryMeta): Promise<Delivered> {
    const clientId = session.client.id;
    const id = this.record(text, urgent, meta, { clientId });
    const shown = session.client.capabilities.includes("screen");
    try {
      if (this.options.hub.profile(session.client).profile === "silent") {
        if (!shown) {
          const minutes = this.keep(session.client, id);
          return {
            client: session.client.name,
            heard: false,
            shown: false,
            held: true,
            note: `It is on the silent profile and has no screen: this is kept and said when it leaves silent within ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          };
        }
        await this.options.hub.say(session, text, { silent: true });
        this.delivered(id, clientId, "silent", "shown");
        return { client: session.client.name, heard: false, shown: true, note: "It is on the silent profile: shown on its screen as text, not spoken." };
      }
      if (!urgent && this.options.hub.quiet(session.client)) {
        if (!shown) {
          this.delivered(id, clientId, "silent", "dropped");
          return { client: session.client.name, heard: false, shown: false, note: "It is in its quiet hours and has no screen, so nothing was said. Mark it urgent to speak anyway." };
        }
        await this.options.hub.say(session, text, { silent: true });
        this.delivered(id, clientId, "silent", "shown");
        return { client: session.client.name, heard: false, shown: true, note: "It is in its quiet hours: shown on its screen, not spoken. Mark it urgent to speak anyway." };
      }
      const { heard } = await this.options.hub.say(session, text, share ? { share } : {});
      // "shown" here means put out without the client confirming it played to the end.
      this.delivered(id, clientId, "live", heard ? "heard" : "shown");
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
    } catch (error) {
      this.delivered(id, clientId, "live", "failed");
      throw error;
    }
  }

  /** Says something to one client, connected or not. */
  async sayTo(client: ClientRecord, text: string, urgent = false, meta?: DeliveryMeta): Promise<Delivered> {
    const session = this.options.hub.session(client.id);
    if (session) return this.sayOn(session, text, urgent, undefined, meta);

    const id = this.record(text, urgent, meta, { clientId: client.id });
    if (this.options.push?.has(client.id)) {
      let outcome: Awaited<ReturnType<PushService["notify"]>>;
      try {
        outcome = await this.options.push.notify(client.id, { title: "Vortex", body: text, tag: "say" });
      } catch (error) {
        this.delivered(id, client.id, "push", "failed");
        throw error;
      }
      if (outcome === "sent") {
        // Kept a while as well, so the page can show it when the notification is tapped.
        this.delivered(id, client.id, "push", "pushed", this.now() + this.options.holdMs);
        this.options.note?.(client.id, `Sent to ${client.name} as a notification (its page is closed)`);
        return { client: client.name, heard: false, shown: true, note: "Its page is closed, so this went to it as a notification. Nothing was spoken." };
      }
    }

    const minutes = this.keep(client, id);
    this.options.note?.(client.id, `${client.name} is offline: one message is kept for it for ${minutes} min`);
    return {
      client: client.name,
      heard: false,
      shown: false,
      held: true,
      note: `${client.name} is offline. This is kept and will be said if it comes back within ${minutes} minute${minutes === 1 ? "" : "s"}; after that it is dropped.`,
    };
  }

  /** Changes how long a message for a client that is away is kept. Messages already waiting keep the time they were given. */
  setHoldMs(holdMs: number): void {
    this.options.holdMs = holdMs;
  }

  /** Deletes notifications past their retention. A kept message whose time is up is no longer said, but stays on record until then. */
  prune(): void {
    this.options.store.sweepNotifications(this.now());
  }

  /** How many messages are waiting for a client, for the admin page. */
  waitingFor(clientId: string): number {
    return this.options.store.held(clientId, this.now()).length;
  }

  /** How many messages went to a client as notifications and have not been shown in its page yet, for the admin page. */
  notifiedFor(clientId: string): number {
    return this.pushedMessages(clientId, this.now()).length;
  }

  /** Records a new notification for a message, or takes the one the caller already has; returns its id. */
  private record(text: string, urgent: boolean, meta: DeliveryMeta | undefined, where: { clientId?: string; location?: string; everywhere?: boolean }): number {
    if (meta?.id !== undefined) return meta.id;
    return this.options.store.addNotification({
      source: meta?.source ?? "agent",
      sourceName: meta?.sourceName,
      title: meta?.title,
      body: text,
      priority: meta?.priority ?? (urgent ? "urgent" : "normal"),
      clientId: where.clientId,
      location: where.location,
      everywhere: where.everywhere ?? false,
      retain: false,
      reminderId: meta?.reminderId,
      status: "pending",
    }).id;
  }

  /** Records how a notification went to one client and moves the notification's status forward to match. */
  private delivered(id: number, clientId: string, route: DeliveryRoute, state: DeliveryState, until?: number): void {
    const at = this.now();
    this.options.store.setDelivery({ notificationId: id, clientId, route, state, at, until });
    const status: NotificationStatus | undefined =
      state === "heard" ? "heard" : state === "shown" || state === "pushed" ? "delivered" : state === "held" ? "held" : state === "dropped" ? "dropped" : undefined;
    if (!status) return;
    const current = this.options.store.getNotification(id);
    if (!current) return;
    const was = RANK[current.status];
    // An ask's own outcome (answered, timed out) is not overwritten by a delivery.
    if (was === undefined || was >= (RANK[status] ?? 0)) return;
    this.options.store.updateNotification(id, {
      status,
      ...(status === "delivered" || status === "heard" ? { deliveredAt: current.deliveredAt ?? at } : {}),
      ...(status === "heard" ? { heardAt: at } : {}),
    });
  }

  /** Keeps a message for `client` for the hold time; returns that time in minutes. */
  private keep(client: ClientRecord, id: number): number {
    this.delivered(id, client.id, "held", "held", this.now() + this.options.holdMs);
    return Math.max(1, Math.round(this.options.holdMs / 60_000));
  }

  /** What went to a closed browser as notifications and its page has not been given yet, oldest first. */
  private pushedMessages(clientId: string, now: number) {
    return this.options.store
      .pushedUntaken(clientId, now)
      .filter((n) => n.source !== "ask")
      .slice(-MAX_HELD);
  }

  /** Says what was kept for a client that has just connected (or has just left silent). */
  private async flush(session: Session): Promise<void> {
    const clientId = session.client.id;
    if (this.inFlight.has(clientId)) return;
    const waiting = this.options.store.held(clientId, this.now());
    if (!waiting.length) return;
    this.inFlight.add(clientId);
    try {
      // Give the client a moment to settle (settings, its own greeting) before it is spoken to.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      for (const message of waiting) {
        // Gone again mid-way: what is left stays kept for next time.
        if (!this.options.hub.session(clientId)) return;
        try {
          await this.sayOn(session, message.body, message.priority === "urgent", undefined, { id: message.id });
          this.options.note?.(clientId, `Said a kept message on ${session.client.name} now that it is back`);
        } catch (error) {
          this.options.note?.(clientId, `A kept message for ${session.client.name} could not be said: ${(error as Error).message}`, "warn");
        }
      }
    } finally {
      this.inFlight.delete(clientId);
    }
  }

  /**
   * Says one thing on several clients at once: every connected client that
   * can speak, in one location or everywhere. Browsers with their page closed
   * get it as a notification. Clients that are simply offline are left out.
   */
  async sayToAll(location: string | undefined, text: string, urgent = false, meta?: DeliveryMeta): Promise<{ clients: Delivered[]; heard: boolean }> {
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
    // One record for all of them, written before any is spoken to.
    const id = this.record(text, urgent, meta, { ...(place ? { location: location!.trim() } : {}), everywhere: !place });
    // Made once for all of them, so they start together.
    const share = new SpeechShare();
    const results = await Promise.all([
      ...speaking.map((session) =>
        this.sayOn(session, text, urgent, share, { id }).catch((error): Delivered => ({ client: session.client.name, heard: false, shown: false, note: (error as Error).message })),
      ),
      ...closed.map((client) => this.sayTo(client, text, urgent, { id })),
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
   * through `answer`. The question is recorded as an `ask` notification: pending, then answered or timed out.
   */
  async askByNotification(client: ClientRecord, question: string, choices: string[], timeoutMs: number, meta?: DeliveryMeta): Promise<AskResult> {
    const id = randomBytes(9).toString("base64url");
    const token = randomBytes(18).toString("base64url");
    const notificationId = this.options.store.addNotification({
      source: "ask",
      sourceName: meta?.sourceName,
      title: meta?.title,
      body: question,
      priority: meta?.priority ?? "normal",
      tag: `ask-${id}`,
      clientId: client.id,
      everywhere: false,
      retain: false,
      choices,
      status: "pending",
    }).id;
    let outcome: Awaited<ReturnType<PushService["notify"]>>;
    try {
      outcome = await this.options.push!.notify(
        client.id,
        { title: "Vortex asks", body: question, tag: `ask-${id}`, ask: { id, token, question, choices } },
        Math.ceil(timeoutMs / 1000),
      );
    } catch (error) {
      this.notSent(notificationId, client.id);
      throw error;
    }
    if (outcome !== "sent") {
      this.notSent(notificationId, client.id);
      throw new Error(`${client.name} is offline and the notification could not be sent`);
    }
    this.options.store.setDelivery({ notificationId, clientId: client.id, route: "push", state: "pushed", at: this.now(), until: this.now() + timeoutMs });
    this.options.note?.(client.id, `Asked ${client.name} a question as a notification (its page is closed)`);
    return new Promise<AskResult>((resolve) => {
      const timer = setTimeout(() => {
        this.asks.delete(id);
        // Kept, so the page can say what was asked while nobody was looking.
        this.askTimedOut(notificationId, client.id);
        resolve({ answer: null, timedOut: true });
      }, timeoutMs);
      timer.unref();
      this.asks.set(id, {
        clientId: client.id,
        question,
        token,
        choices,
        notificationId,
        settle: (result) => {
          clearTimeout(timer);
          this.asks.delete(id);
          this.options.store.updateNotification(notificationId, { status: "answered", answer: result.answer ?? undefined });
          resolve(result);
        },
      });
    });
  }

  /** Records the outcome of a question put to a connected client (the live ask), as an `ask` notification. Returns its id. */
  recordAsk(client: ClientRecord, question: string, choices: string[], result: AskResult, meta?: DeliveryMeta): number {
    const timedOut = Boolean(result.timedOut);
    const record = this.options.store.addNotification({
      source: "ask",
      sourceName: meta?.sourceName,
      title: meta?.title,
      body: question,
      priority: meta?.priority ?? "normal",
      clientId: client.id,
      everywhere: false,
      retain: false,
      choices,
      answer: result.answer ?? undefined,
      status: timedOut ? "timed_out" : "answered",
      ...(timedOut ? { expiresAt: null } : {}),
    });
    // Put to it while it was connected: not one a closed page should list as missed.
    this.options.store.setDelivery({ notificationId: record.id, clientId: client.id, route: "live", state: "shown", at: this.now() });
    return record.id;
  }

  /** A question that ran out of time (or was cut off by a restart): timed out, kept until dismissed, and missed by its client. */
  private askTimedOut(notificationId: number, clientId: string | undefined): void {
    this.options.store.updateNotification(notificationId, { status: "timed_out", expiresAt: undefined });
    if (clientId) this.options.store.setDelivery({ notificationId, clientId, route: "push", state: "missed", at: this.now() });
  }

  private notSent(notificationId: number, clientId: string): void {
    this.options.store.setDelivery({ notificationId, clientId, route: "push", state: "failed", at: this.now() });
    this.options.store.updateNotification(notificationId, { status: "dropped" });
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

  /**
   * What a client missed while its page was closed: the messages it was sent as notifications, and the
   * questions that ran out of time unanswered, each with when. Handing them over marks them taken (and read).
   */
  takeMissed(clientId: string): { messages: { text: string; at: number }[]; asks: { question: string; at: number }[] } {
    const now = this.now();
    const messages = this.pushedMessages(clientId, now);
    const asks = this.options.store.missedAsksUntaken(clientId, now).slice(-MAX_HELD);
    this.options.store.takeDeliveries(clientId, ["push"], now);
    return { messages: messages.map((m) => ({ text: m.body, at: m.createdAt })), asks: asks.map((a) => ({ question: a.body, at: a.createdAt })) };
  }

  /** An answer picked from a notification. False when the question is no longer open or the answer is not one of its choices. */
  answer(id: string, token: string, choice: string): boolean {
    const pending = this.asks.get(id);
    if (!pending || pending.token !== token || !pending.choices.includes(choice)) return false;
    pending.settle({ answer: choice, how: "tap" });
    return true;
  }
}
