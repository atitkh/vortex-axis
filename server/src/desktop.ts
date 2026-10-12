import type { Hub, Session } from "./hub.js";
import type { Store } from "./store.js";

/**
 * Computers as Axis clients (experimental). A desktop app on a computer pairs like any device and
 * offers the `desktop` capability: Axis can ask it what is on the screen and have it point at
 * something there, with a cursor of its own and a few words beside it. The agent decides what to
 * look at and where to point; this only finds the computer and carries the call there and the
 * answer back.
 *
 * The app answers `desktop.look` with the elements it can read on the screen, each with an id, and
 * `desktop.point` with where it pointed. Ids hold until the next look.
 */

const ACTIONS = ["look", "point", "hide", "click", "type", "keys"] as const;
/** Most characters one type carries: a command's values are at most 512 characters. */
export const MAX_TYPED = 500;
type Action = (typeof ACTIONS)[number];

/** How long a computer gets to read its screen: reading a busy window's controls can take a while. */
const LOOK_TIMEOUT_MS = 15_000;
const POINT_TIMEOUT_MS = 5_000;
/** A click on a control that opens something can take a moment to come back; so can a long text. */
const ACT_TIMEOUT_MS = 15_000;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const whole = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined);

export class Desktops {
  constructor(
    private readonly hub: Hub,
    private readonly store: Store,
  ) {}

  /** The computers online. */
  online(): Session[] {
    return [...this.hub.sessions()].filter((s) => s.client.capabilities.includes("desktop"));
  }

  /**
   * The computer a call means: the one named; else the only one online; else the one in the
   * location of the device last spoken to.
   */
  pick(named: string | undefined, location: string | undefined): Session {
    if (named) {
      const client = this.store.findClient(named);
      if (!client) throw new Error(`there is no client called "${named}"`);
      const session = this.hub.session(client.id);
      if (!session) throw new Error(`${client.name} is offline`);
      if (!session.client.capabilities.includes("desktop")) throw new Error(`${client.name} is not a computer`);
      return session;
    }
    const all = this.online();
    if (!all.length) throw new Error("no computer is connected to VorteX Axis (the desktop app is not running, or not paired)");
    if (all.length === 1) return all[0]!;
    const place = (location ?? this.lastLocation())?.toLowerCase();
    const there = place ? all.filter((s) => String(this.hub.settings(s).location ?? "").toLowerCase() === place) : [];
    if (there.length === 1) return there[0]!;
    throw new Error(`several computers are connected (${all.map((s) => s.client.name).join(", ")}): say which with client`);
  }

  /** Where the person was last heard, if anywhere. */
  private lastLocation(): string | undefined {
    try {
      const session = this.hub.pickOutput({});
      return text(this.hub.settings(session).location);
    } catch {
      return undefined;
    }
  }

  /** Carries out one call of the desktop tool. */
  async run(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = (text(params.action) ?? "look") as Action;
    if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
    const session = this.pick(text(params.client), text(params.location));
    const computer = session.client.name;

    if (action === "look") {
      const scope = text(params.scope) ?? "window";
      if (!["window", "mouse", "screen"].includes(scope)) throw new Error("scope must be window, mouse or screen");
      const outcome = await this.hub.command(session, "desktop.look", { scope, ocr: params.ocr === true }, LOOK_TIMEOUT_MS);
      if (!outcome.ok) throw new Error(outcome.error || `${computer} could not read its screen, and did not say why`);
      return { computer, ...(typeof outcome.data === "object" && outcome.data !== null ? (outcome.data as Record<string, unknown>) : {}) };
    }

    if (action === "click" || action === "type" || action === "keys") return this.act(session, action, params);

    if (action === "hide") {
      const outcome = await this.hub.command(session, "desktop.hide", {}, POINT_TIMEOUT_MS);
      if (!outcome.ok) throw new Error(outcome.error || `${computer} did not hide its pointer`);
      return { computer, hidden: true };
    }

    // point: at an element from the last look, or at a place on the screen.
    const id = whole(params.id);
    const x = whole(params.x), y = whole(params.y);
    if (id === undefined && (x === undefined || y === undefined)) throw new Error("point needs an id from the last look, or x and y");
    const say = text(params.text)?.slice(0, 200);
    const args: Record<string, string | number> = id !== undefined ? { id } : { x: x!, y: y! };
    if (say) args.text = say;
    const seconds = whole(params.seconds);
    if (seconds !== undefined) args.seconds = Math.min(60, Math.max(1, seconds));
    const outcome = await this.hub.command(session, "desktop.point", args, POINT_TIMEOUT_MS);
    if (!outcome.ok) throw new Error(outcome.error || `${computer} could not point there`);
    return { computer, pointed: true, ...(outcome.payload ?? {}) };
  }

  /** Clicking, typing and keys: refused here when switched off for the computer, and held to the app's own limits there. */
  private async act(session: Session, action: "click" | "type" | "keys", params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const computer = session.client.name;
    const allowed = this.hub.settings(session).allowInput;
    if (allowed === 0 || allowed === false || allowed === "0") throw new Error(`clicking and typing are switched off for ${computer} on the VorteX Axis admin page`);
    const args: Record<string, string | number> = {};
    const id = whole(params.id);
    if (id !== undefined) args.id = id;
    if (action === "click") {
      const x = whole(params.x), y = whole(params.y);
      if (id === undefined && (x === undefined || y === undefined)) throw new Error("click needs an id from the last look, or x and y");
      if (id === undefined) Object.assign(args, { x: x!, y: y! });
      const button = text(params.button) ?? "left";
      if (!["left", "right", "double"].includes(button)) throw new Error("button must be left, right or double");
      args.button = button;
    } else if (action === "type") {
      const words = typeof params.text === "string" ? params.text : "";
      if (!words) throw new Error("type needs text");
      if (words.length > MAX_TYPED) throw new Error(`type takes at most ${MAX_TYPED} characters at a time; send the rest in another call`);
      args.text = words;
    } else {
      const keys = text(params.keys);
      if (!keys) throw new Error("keys needs a combination, such as enter or ctrl+s");
      args.keys = keys.slice(0, 64);
    }
    const outcome = await this.hub.command(session, `desktop.${action}`, args, ACT_TIMEOUT_MS);
    if (!outcome.ok) throw new Error(outcome.error || `${computer} could not ${action === "keys" ? "press that" : action}`);
    return { computer, done: action, ...(outcome.payload ?? {}) };
  }
}
