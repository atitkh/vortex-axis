import type { Hub, Session } from "./hub.js";
import type { Store } from "./store.js";

/** Rows a board lists. */
const ITEMS = 5;
/** A line, cut so the board has little left to shorten. */
const LINE_CHARS = 48;
/** Changes within this long make one send. */
const DEBOUNCE_MS = 500;
/** The screens are checked this often, in case a change went unseen. */
const RECHECK_MS = 60_000;

export interface BoardInboxOptions {
  now?: () => number;
  /** Where a failure is written down (the activity log). */
  note?: (kind: string, subject: string, text: string, level?: "info" | "warn" | "bad") => void;
}

/** One plain line of a notification: its title, else its body, on one line, cut to LINE_CHARS. */
export function inboxLine(title: string | undefined, body: string | undefined): string {
  const text = (title?.trim() ? title : (body ?? "")).replace(/\s+/g, " ").trim();
  return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1).trimEnd()}…` : text;
}

/**
 * The unread notifications on the boards: a screen with touch is told how many are unread for it (addressed to it or to everyone)
 * and the newest few, as `inbox.show {count, items}`; items is "<id>\t<line>\n" a row. A tap on a row comes back as `inbox.act`.
 * Sends only when the count or the rows changed, and changes close together make one send.
 */
export class BoardInbox {
  private readonly now: () => number;
  private readonly sent = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private recheck: NodeJS.Timeout | undefined;

  constructor(
    private readonly hub: Hub,
    private readonly store: Store,
    private readonly options: BoardInboxOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    hub.onConnect((session) => this.tell(session));
    store.onNotificationsChanged(() => this.soon());
  }

  start(): void {
    this.recheck = setInterval(() => this.tell(), RECHECK_MS);
    this.recheck.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
    clearInterval(this.recheck);
    this.timer = undefined;
  }

  /** A tap on a row: mark it read or dismiss it, only if the client may see it. An unknown id does nothing. */
  act(session: Session, id: number, act: "read" | "dismiss"): void {
    const viewer = session.client.id;
    try {
      const changed = act === "read" ? this.store.markRead([id], this.now(), { viewer }) : this.store.dismissNotifications([id], this.now(), { viewer });
      if (changed > 0) this.options.note?.("inbox", viewer, `${act === "read" ? "Read" : "Dismissed"} notification ${id} on ${session.client.name}`);
    } catch (error) {
      this.options.note?.("inbox", viewer, `Inbox ${act} of ${id} on ${session.client.name} failed: ${(error as Error).message}`, "bad");
    }
  }

  private soon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tell();
    }, DEBOUNCE_MS);
    this.timer.unref();
  }

  /** Tells one screen, or every screen with touch, what is unread, if it differs from what it was last told. */
  tell(only?: Session): void {
    for (const session of only ? [only] : this.hub.sessions()) {
      const caps = session.client.capabilities;
      if (!caps.includes("screen") || !caps.includes("touch")) continue;
      const viewer = session.client.id;
      try {
        const count = this.store.unreadCount({ viewer, unread: true });
        const rows = this.store.listNotifications({ viewer, unread: true, limit: ITEMS });
        const fingerprint = `${count}:${rows.map((r) => r.id).join(",")}`;
        if (this.sent.get(viewer) === fingerprint) continue;
        this.sent.set(viewer, fingerprint);
        const items = rows.map((r) => `${r.id}\t${inboxLine(r.title, r.body)}\n`).join("");
        // A client that does not know the command says so or says nothing; either is fine.
        this.hub.command(session, "inbox.show", { count, items }, 3000).catch(() => undefined);
      } catch (error) {
        this.options.note?.("inbox", viewer, `Telling ${session.client.name} its unread notifications failed: ${(error as Error).message}`, "bad");
      }
    }
  }
}
