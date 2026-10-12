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

const ACTIONS = ["look", "find", "point", "hide", "click", "type", "keys", "open", "switch", "window", "desktop", "steps", "wait"] as const;
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

    if (action === "hide") {
      const outcome = await this.hub.command(session, "desktop.hide", {}, POINT_TIMEOUT_MS);
      if (!outcome.ok) throw new Error(outcome.error || `${computer} did not hide its pointer`);
      return { computer, hidden: true };
    }

    if (CHANGES.has(action)) this.mayChange(session);

    if (action === "steps") {
      const list = Array.isArray(params.steps) ? params.steps : undefined;
      if (!list?.length) throw new Error("steps needs a list of steps, such as [{action: \"click\", name: \"Search\"}, {action: \"type\", text: \"hello\"}]");
      if (list.length > MAX_STEPS) throw new Error(`at most ${MAX_STEPS} steps in one call`);
      const steps = list.map((step, i) => {
        if (typeof step !== "object" || step === null || Array.isArray(step)) throw new Error(`step ${i + 1} is not an object`);
        const one = step as Record<string, unknown>;
        const kind = text(one.action) as Action | undefined;
        if (!kind || !STEP_ACTIONS.has(kind)) throw new Error(`step ${i + 1}: action must be one of ${[...STEP_ACTIONS].join(", ")}`);
        try {
          return { action: kind, ...argsFor(kind, one) };
        } catch (error) {
          throw new Error(`step ${i + 1} (${kind}): ${(error as Error).message}`);
        }
      });
      const outcome = await this.hub.command(session, "desktop.steps", {}, STEPS_TIMEOUT_MS, { steps });
      const data = typeof outcome.data === "object" && outcome.data !== null ? (outcome.data as Record<string, unknown>) : {};
      // A step that failed is reported with the ones before it, not as an error: the agent needs to know what happened.
      if (!outcome.ok && !Array.isArray(data.steps)) throw new Error(outcome.error || `${computer} could not run the steps`);
      return { computer, ...data };
    }

    const outcome = await this.hub.command(session, `desktop.${action}`, argsFor(action, params), action === "find" ? LOOK_TIMEOUT_MS : ACT_TIMEOUT_MS);
    if (!outcome.ok) throw new Error(outcome.error || `${computer} could not ${action === "keys" ? "press that" : action}`);
    const data = typeof outcome.data === "object" && outcome.data !== null ? (outcome.data as Record<string, unknown>) : {};
    if (action === "point") return { computer, pointed: true, ...(outcome.payload ?? {}) };
    return { computer, done: action, ...(outcome.payload ?? {}), ...data };
  }

  /** Clicking, typing and everything else that changes the screen: refused here when switched off for the computer. */
  private mayChange(session: Session): void {
    const allowed = this.hub.settings(session).allowInput;
    if (allowed === 0 || allowed === false || allowed === "0") {
      throw new Error(`clicking and typing are switched off for ${session.client.name} on the VorteX Axis admin page`);
    }
  }
}

/** Actions that change what is on the screen, held by the computer's allowInput switch. */
const CHANGES = new Set<Action>(["click", "type", "keys", "open", "switch", "window", "desktop", "steps"]);
/** What a step in `steps` may be. */
const STEP_ACTIONS = new Set<Action>(["click", "type", "keys", "open", "switch", "window", "desktop", "wait", "point", "find"]);
const MAX_STEPS = 10;
const STEPS_TIMEOUT_MS = 60_000;

/** The command arguments for one action, checked. Throws on anything the computer would refuse anyway. */
function argsFor(action: Action, params: Record<string, unknown>): Record<string, string | number> {
  const args: Record<string, string | number> = {};
  const id = whole(params.id);
  const name = text(params.name)?.slice(0, 200);
  const kind = text(params.kind)?.slice(0, 32);
  const target = () => {
    if (id !== undefined) args.id = id;
    else if (name) {
      args.name = name;
      if (kind) args.kind = kind;
    }
  };
  switch (action) {
    case "point":
    case "click": {
      target();
      const x = whole(params.x), y = whole(params.y);
      if (args.id === undefined && args.name === undefined) {
        if (x === undefined || y === undefined) throw new Error(`${action} needs an id from the last look, a name, or x and y`);
        Object.assign(args, { x, y });
      }
      if (action === "click") {
        const button = text(params.button) ?? "left";
        if (!["left", "right", "double"].includes(button)) throw new Error("button must be left, right or double");
        args.button = button;
      } else {
        const say = text(params.text)?.slice(0, 200);
        if (say) args.text = say;
        const seconds = whole(params.seconds);
        if (seconds !== undefined) args.seconds = Math.min(60, Math.max(1, seconds));
      }
      return args;
    }
    case "type": {
      const words = typeof params.text === "string" ? params.text : "";
      if (!words) throw new Error("type needs text");
      if (words.length > MAX_TYPED) throw new Error(`type takes at most ${MAX_TYPED} characters at a time; send the rest in another call`);
      args.text = words;
      // `into` names the field; `name` is accepted for it too.
      const into = text(params.into)?.slice(0, 200) ?? name;
      if (id !== undefined) args.id = id;
      else if (into) {
        args.name = into;
        if (kind) args.kind = kind;
      }
      return args;
    }
    case "keys": {
      const keys = text(params.keys);
      if (!keys) throw new Error("keys needs a combination, such as enter or ctrl+s");
      args.keys = keys.slice(0, 64);
      return args;
    }
    case "find": {
      if (!name) throw new Error("find needs a name to look for");
      args.name = name;
      if (kind) args.kind = kind;
      return args;
    }
    case "open": {
      const app = text(params.app)?.slice(0, 120);
      const url = text(params.url)?.slice(0, 500);
      if (!app === !url) throw new Error("open needs app (a Start-menu name) or url, one of them");
      if (url) {
        if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
        args.url = url;
      } else args.app = app!;
      return args;
    }
    case "switch": {
      const to = text(params.window)?.slice(0, 200) ?? text(params.app)?.slice(0, 200) ?? name;
      if (!to) throw new Error("switch needs window: an app or a window title, such as Discord");
      args.window = to;
      return args;
    }
    case "window": {
      const op = text(params.do);
      if (!op || !["minimize", "maximize", "restore", "move"].includes(op)) throw new Error("window needs do: minimize, maximize, restore or move");
      args.do = op;
      const which = text(params.window)?.slice(0, 200);
      if (which) args.window = which;
      if (op === "move") {
        const display = whole(params.display);
        if (display === undefined || display < 1) throw new Error("move needs display: 1 for the first in the look's monitors, 2 for the next");
        args.display = display;
      }
      return args;
    }
    case "desktop": {
      const go = text(params.go);
      if (!go || !["next", "previous"].includes(go)) throw new Error("desktop needs go: next or previous");
      args.go = go;
      return args;
    }
    case "wait": {
      const ms = whole(params.ms) ?? 500;
      args.ms = Math.min(3000, Math.max(50, ms));
      return args;
    }
    default:
      throw new Error(`${action} cannot be a step`);
  }
}
