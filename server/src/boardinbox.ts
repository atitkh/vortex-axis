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
 * and the newest few, as `inbox.show {count, items}` (`open: 1` added when the person asked to see the list); items is "<id>\t<line>\n" a row. A tap on a row comes back as `inbox.act`.
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

  /**
   * Tells one screen, or every screen with touch, what is unread, if it differs from what it was last told.
   * With `open` (one screen only) it is told whatever it was told before, once, with `open: 1`: the board then lists the rows as
   * if its dot had been tapped. Returns the unread count of the last screen told or looked at.
   */
  tell(only?: Session, open = false): number {
    let unread = 0;
    for (const session of only ? [only] : this.hub.sessions()) {
      if (!onBoard(session)) continue;
      const viewer = session.client.id;
      try {
        const count = this.store.unreadCount({ viewer, unread: true });
        const rows = this.store.listNotifications({ viewer, unread: true, limit: ITEMS });
        unread = count;
        const opens = open && only !== undefined;
        const fingerprint = `${count}:${rows.map((r) => r.id).join(",")}`;
        if (!opens && this.sent.get(viewer) === fingerprint) continue;
        this.sent.set(viewer, fingerprint);
        const items = rows.map((r) => `${r.id}\t${inboxLine(r.title, r.body)}\n`).join("");
        // A client that does not know the command says so or says nothing; either is fine.
        this.hub.command(session, "inbox.show", opens ? { count, items, open: 1 } : { count, items }, 3000).catch(() => undefined);
      } catch (error) {
        this.options.note?.("inbox", viewer, `Telling ${session.client.name} its unread notifications failed: ${(error as Error).message}`, "bad");
      }
    }
    return unread;
  }

  /**
   * Opens the unread list on one board's screen, for "show me the inbox": the board named or in the place named, else the one the
   * person last spoke to if it is a board, else the first board online. The rows are the stored ones; the caller gives no text.
   */
  show(target: { client?: string | undefined; location?: string | undefined } = {}): { opened: boolean; board?: string; unread?: number; reason?: string } {
    let session: Session | undefined;
    if (target.client || target.location) {
      session = this.hub.pickOutput(target);
      if (!onBoard(session)) throw new Error(`${session.client.name} has no screen with touch to list the inbox on`);
    } else {
      try {
        const picked = this.hub.pickOutput({});
        if (onBoard(picked)) session = picked;
      } catch {
        // Nothing that speaks or shows text is online; a board may still be.
      }
      if (!session) for (const s of this.hub.sessions()) if (onBoard(s)) { session = s; break; }
      if (!session) return { opened: false, reason: "no board with a screen is online" };
    }
    const board = session.client.name;
    const unread = this.store.unreadCount({ viewer: session.client.id, unread: true });
    if (unread === 0) return { opened: false, board, unread, reason: `nothing is unread for ${board}` };
    this.tell(session, true);
    this.options.note?.("inbox", session.client.id, `The inbox list was opened on ${board}`);
    return { opened: true, board, unread };
  }
}

/** A board that shows the inbox: a screen with touch. */
function onBoard(session: Session): boolean {
  const caps = session.client.capabilities;
  return caps.includes("screen") && caps.includes("touch");
}
