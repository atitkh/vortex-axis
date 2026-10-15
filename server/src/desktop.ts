import type { Hub, Session } from "./hub.js";
import { riskyName, sendingWindow, submitKeys, submitText } from "./risky.js";
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

const ACTIONS = ["look", "find", "point", "hide", "click", "drag", "type", "keys", "open", "switch", "window", "desktop", "steps", "wait", "screenshot", "scroll", "clipboard", "paste"] as const;
/** Most characters one type carries: a command's values are at most 512 characters. */
export const MAX_TYPED = 500;
/** Most characters one paste carries (sent as the command's data, not a value). */
export const MAX_PASTED = 20_000;
/** Longest a wait for something to appear or go may take. */
const MAX_WAIT_S = 20;
/**
 * Longest a fixed pause (wait with ms) may be. Agents reached for the old 3 s after every open and click, which
 * was over half the time of a task; acting answers already say what is in front, and a wait for a name returns the
 * moment it appears.
 */
const MAX_FIXED_WAIT_MS = 1000;
/** Longest a drag may hold before it moves (a long press, for lists and home screens that need one). */
const MAX_HOLD_MS = 2000;
/** How long the person has to allow a risky action; no answer is a no. */
const CONFIRM_MS = 30_000;
type Action = (typeof ACTIONS)[number];

/** How long a computer gets to read its screen: reading a busy window's controls can take a while. */
const LOOK_TIMEOUT_MS = 15_000;
const POINT_TIMEOUT_MS = 5_000;
/** A click on a control that opens something can take a moment to come back; so can a long text. */
const ACT_TIMEOUT_MS = 15_000;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const whole = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined);

/** A computer an agent is using: since when, the last thing it did there and when. */
export interface InUse {
  clientId: string;
  computer: string;
  since: number;
  lastAt: number;
  last: string;
}

/** How long after its last call an agent still counts as using a computer. */
const IN_USE_MS = 8000;
/** A screen that did not take "desktop.busy" is asked again this many times before Axis leaves it until the next change. */
const MAX_DELIVERY_TRIES = 5;

export class Desktops {
  private readonly using = new Map<string, InUse & { timer?: NodeJS.Timeout }>();
  /** The screens told the agent is at a computer, so they are told again when it stops. */
  private readonly told = new Set<string>();
  /** Failed deliveries to a screen in a row, so a screen that never answers is not asked for ever. */
  private readonly failures = new Map<string, number>();
  private retry: NodeJS.Timeout | undefined;

  constructor(
    private readonly hub: Hub,
    private readonly store: Store,
    private readonly now: () => number = Date.now,
    /** How long a screen gets to take "desktop.busy", and how long before a failed one is tried again. */
    private readonly timing: { deliverMs?: number; retryMs?: number } = {},
    /** The admin's block list: parts of app and window names the tool may neither read nor touch. */
    private readonly blockList: () => string[] = () => [],
  ) {
    // A screen that comes back while an agent is at a computer is told straight away.
    hub.onConnect((session) => {
      this.told.delete(session.client.id);
      if (this.using.size) this.tellScreens();
    });
  }

  /** Reasons the computers are look-only just now (a scheduled task the person did not allow to act), newest last. */
  private readonly lookOnly: string[] = [];

  /**
   * Makes every computer look-only until the returned function is called: clicking, typing and the rest are
   * refused, looking goes on. For a task that runs with nobody watching and was not allowed to act. Axis
   * cannot tell which agent call belongs to which turn, so it is all calls while the task runs.
   */
  holdLookOnly(reason: string): () => void {
    this.lookOnly.push(reason);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const at = this.lookOnly.lastIndexOf(reason);
      if (at >= 0) this.lookOnly.splice(at, 1);
    };
  }

  /** Per computer, what its last answers showed: the window in front and the names of the elements by id. */
  private readonly seen = new Map<string, Seen>();

  /** The computers an agent is using right now, for the admin page. */
  inUse(): InUse[] {
    return [...this.using.values()].map(({ timer: _timer, ...use }) => use);
  }

  /** Notes a call on a computer: it is in use until IN_USE_MS after the last one. */
  private touch(session: Session, action: string, params: Record<string, unknown>): void {
    const at = this.now();
    const id = session.client.id;
    const was = this.using.get(id);
    const use = was ?? { clientId: id, computer: session.client.name, since: at, lastAt: at, last: "" };
    use.lastAt = at;
    use.last = describe(action, params);
    if (use.timer) clearTimeout(use.timer);
    use.timer = setTimeout(() => {
      this.using.delete(id);
      this.tellScreens();
    }, IN_USE_MS);
    use.timer.unref();
    this.using.set(id, use);
    if (!was) this.tellScreens();
  }

  /**
   * Tells the screens near a computer in use (its location; every screen when it has none) to glow, and
   * those that were told to stop once no agent is at a computer near them.
   */
  private tellScreens(): void {
    const places = [...this.using.values()].map((use) => {
      const session = this.hub.session(use.clientId);
      return session ? String(this.hub.settings(session).location ?? "").toLowerCase() : "";
    });
    for (const session of this.hub.sessions()) {
      if (!session.client.capabilities.includes("screen") || session.client.capabilities.includes("desktop")) continue;
      const here = String(this.hub.settings(session).location ?? "").toLowerCase();
      const on = places.some((place) => !place || place === here);
      if (on === this.told.has(session.client.id)) continue;
      if (on) this.told.add(session.client.id);
      else this.told.delete(session.client.id);
      const computer = on ? this.inUse()[0]?.computer ?? "" : "";
      const id = session.client.id;
      // A client that does not know the command says so (an answer, not a failure); nothing to do about that.
      this.hub
        .command(session, "desktop.busy", { on: on ? 1 : 0, computer }, this.timing.deliverMs ?? 3000)
        .then(() => this.failures.delete(id))
        .catch(() => {
          // The screen did not take it (busy with a conversation, or its link blinked). It must not be left glowing,
          // or left without, for good: forget that it was told, unless something newer has been sent since, and try again.
          if (this.told.has(id) !== on) return;
          if (on) this.told.delete(id);
          else this.told.add(id);
          const n = (this.failures.get(id) ?? 0) + 1;
          this.failures.set(id, n);
          if (n <= MAX_DELIVERY_TRIES) this.tellAgainSoon();
        });
    }
  }

  private tellAgainSoon(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.tellScreens();
    }, this.timing.retryMs ?? 3000);
    this.retry.unref();
  }

  /** The computers online. */
  online(): Session[] {
    return [...this.hub.sessions()].filter((s) => s.client.capabilities.includes("desktop"));
  }

  /**
   * The computer a call means: the one named; else the only one online; else the one in the location
   * of the device named (when that is not a computer) or of the device last spoken to.
   */
  pick(named: string | undefined, location: string | undefined): Session {
    if (named) {
      const client = this.store.findClient(named);
      if (!client) throw new Error(`there is no client called "${named}"`);
      const session = this.hub.session(client.id);
      const computer = session ? session.client.capabilities.includes("desktop") : client.capabilities.includes("desktop");
      if (computer) {
        if (!session) throw new Error(`${client.name} is offline`);
        return session;
      }
      // Agents pass the device the person spoke from (a board, a browser): that names a place, not a computer.
      location ??= session ? String(this.hub.settings(session).location ?? "") || undefined : undefined;
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
    this.touch(session, action, params);
    try {
      return await this.carryOut(session, action, params);
    } finally {
      // A long call (steps, a wait) counts from its end, not its start.
      if (this.using.has(session.client.id)) this.touch(session, action, params);
    }
  }

  private async carryOut(session: Session, action: Action, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const computer = session.client.name;
    const blocked = this.blockList();
    // The computer refuses to read or act on a blocked window itself (it knows which is in front); Axis
    // refuses what it can tell from the call, and keeps a blocked window's contents out of any answer.
    const block = blocked.length ? { blocked: blocked.join("|") } : {};
    const named = [text(params.app), text(params.url), text(params.window)].find((n) => n && blockedBy(blocked, n));
    if (named) throw new Error(`${named} is blocked by the user: the desktop tool may not read or touch it. Tell the person; do not try another way`);

    if (action === "look") {
      const scope = text(params.scope) ?? "window";
      if (!["window", "mouse", "screen"].includes(scope)) throw new Error("scope must be window, mouse or screen");
      const outcome = await this.hub.command(session, "desktop.look", { scope, ocr: params.ocr === true, ...block }, LOOK_TIMEOUT_MS);
      if (!outcome.ok) throw new Error(outcome.error || `${computer} could not read its screen, and did not say why`);
      return { computer, ...this.read(session, outcome.data, blocked, true) };
    }

    if (action === "screenshot") {
      const allowed = this.hub.settings(session).allowScreenshot;
      if (!(allowed === 1 || allowed === true || allowed === "1")) {
        throw new Error(`screenshots are switched off for ${computer}; the person can switch them on on the VorteX Axis admin page. Use look or find instead`);
      }
      const scope = text(params.scope) ?? "window";
      if (!["window", "screen"].includes(scope)) throw new Error("screenshot scope must be window or screen");
      const detail = text(params.detail) ?? "normal";
      if (!["low", "normal", "high"].includes(detail)) throw new Error("detail must be low, normal or high");
      const args: Record<string, string | number> = { scope, detail, ...block };
      const id = whole(params.id);
      if (id !== undefined) args.id = id;
      const outcome = await this.hub.command(session, "desktop.screenshot", args, LOOK_TIMEOUT_MS);
      if (!outcome.ok) throw new Error(outcome.error || `${computer} could not take a picture, and did not say why`);
      const data = this.read(session, outcome.data, blocked, true);
      const image = data.image as { data?: unknown; mimeType?: unknown } | undefined;
      if (typeof image?.data !== "string" || typeof image.mimeType !== "string") throw new Error(`${computer} sent no picture`);
      // `image` is lifted out by the MCP door into an image block; the rest is the text beside it.
      return { computer, ...data };
    }

    if (action === "hide") {
      const outcome = await this.hub.command(session, "desktop.hide", {}, POINT_TIMEOUT_MS);
      if (!outcome.ok) throw new Error(outcome.error || `${computer} did not hide its pointer`);
      return { computer, hidden: true };
    }

    if (CHANGES.has(action)) this.mayChange(session);
    let allowed: string | undefined;

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
          const off = [text(one.app), text(one.url), text(one.window)].find((n) => n && blockedBy(blocked, n));
          if (off) throw new Error(`${off} is blocked by the user: the desktop tool may not read or touch it`);
          const step: Record<string, string | number> & { action: Action } = { action: kind, ...argsFor(kind, one) };
          return step;
        } catch (error) {
          throw new Error(`step ${i + 1} (${kind}): ${(error as Error).message}`);
        }
      });
      // One question for the whole list, naming the first risky step; the window an open or switch brings is the one after it.
      let window = this.seen.get(session.client.id)?.window;
      const risks: string[] = [];
      for (const step of steps) {
        const risk = this.riskOf(session, step.action, step, window);
        if (risk) risks.push(risk);
        if (step.action === "open" || step.action === "switch") window = String(step.app ?? step.url ?? step.window ?? "");
      }
      if (risks.length) allowed = await this.confirm(session, risks[0]! + (risks.length > 1 ? ` (and ${risks.length - 1} more risky step${risks.length > 2 ? "s" : ""})` : ""));
      const outcome = await this.hub.command(session, "desktop.steps", { ...block }, STEPS_TIMEOUT_MS, { steps });
      const data = this.read(session, outcome.data, blocked, false);
      // A step that failed is reported with the ones before it, not as an error: the agent needs to know what happened.
      if (!outcome.ok && !Array.isArray(data.steps)) throw new Error(outcome.error || `${computer} could not run the steps`);
      return { computer, ...data, ...(allowed ? { confirmed: allowed } : {}) };
    }

    if (action === "clipboard") {
      const outcome = await this.hub.command(session, "desktop.clipboard", {}, POINT_TIMEOUT_MS);
      if (!outcome.ok) throw new Error(outcome.error || `${computer} could not read its clipboard`);
      return { computer, ...(typeof outcome.data === "object" && outcome.data !== null ? (outcome.data as Record<string, unknown>) : {}) };
    }
    const args = argsFor(action, params);
    if (CHANGES.has(action)) {
      const risk = this.riskOf(session, action, args, this.seen.get(session.client.id)?.window);
      if (risk) allowed = await this.confirm(session, risk);
    }
    // A paste's text can be long: it travels as the command's data, not as one of its (short) values.
    let extra: unknown;
    if (action === "paste") {
      extra = { text: args.text };
      delete args.text;
    }
    const timeout = action === "find" ? LOOK_TIMEOUT_MS : action === "wait" && typeof args.seconds === "number" ? (args.seconds + 5) * 1000 : ACT_TIMEOUT_MS;
    const outcome = await this.hub.command(session, `desktop.${action}`, { ...args, ...block }, timeout, extra);
    if (!outcome.ok) throw new Error(outcome.error || `${computer} could not ${action === "keys" ? "press that" : action}`);
    const data = this.read(session, outcome.data, blocked, action === "find");
    if (action === "point") return { computer, pointed: true, ...(outcome.payload ?? {}) };
    const result: Record<string, unknown> = { computer, done: action, ...this.read(session, outcome.payload, blocked, false), ...data, ...(allowed ? { confirmed: allowed } : {}) };
    // A pause by number is almost never what an agent needs: tell it, in the answer it is reading.
    if (action === "wait" && typeof args.ms === "number") {
      result.hint = `paused ${args.ms} ms (at most ${MAX_FIXED_WAIT_MS}). Not needed after open or click: their answers say what is in front. To wait for something, use wait with name or window (returns when it appears), or find`;
    }
    return result;
  }

  /**
   * An answer from the computer, noted for the next risky check (the window in front, element names by id) and kept
   * clear of blocked windows: a read of one is refused, a window list names it only as blocked, `after` says no more.
   */
  private read(session: Session, raw: unknown, blocked: string[], reading: boolean): Record<string, unknown> {
    const data = typeof raw === "object" && raw !== null ? { ...(raw as Record<string, unknown>) } : {};
    const after = typeof data.after === "object" && data.after !== null ? (data.after as Record<string, unknown>) : undefined;
    const front = windowName(data.window) ?? windowName(after?.window);
    const hit = front !== undefined ? blockedBy(blocked, front) : undefined;
    if (hit) {
      this.seen.delete(session.client.id);
      if (reading) throw new Error(`the window in front is blocked by the user (it matches "${hit}"): its contents are not read. Tell the person; do not try another way`);
      if (data.window !== undefined) data.window = "blocked by the user";
      if (after) data.after = { window: "blocked by the user" };
      return data;
    }
    if (Array.isArray(data.windows)) data.windows = data.windows.map((w) => (blockedBy(blocked, windowName(w) ?? "") ? "blocked by the user" : w));
    const lines = Array.isArray(data.elements) ? data.elements : Array.isArray(data.matches) ? data.matches : undefined;
    if (front !== undefined || lines) {
      const was = this.seen.get(session.client.id);
      const seen: Seen = { window: front ?? was?.window, elements: lines ? new Map() : was?.elements ?? new Map() };
      for (const line of lines ?? []) {
        const element = elementOf(line);
        if (element) seen.elements.set(element.id, element);
      }
      this.seen.set(session.client.id, seen);
    }
    return data;
  }

  /** Why an action needs the person's yes first, in words for the question, or undefined. */
  private riskOf(session: Session, action: Action, args: Record<string, unknown>, window: string | undefined): string | undefined {
    const elements = this.seen.get(session.client.id)?.elements;
    const nameAt = (name: unknown, id: unknown, x: unknown, y: unknown) =>
      text(name) ?? (typeof id === "number" ? elements?.get(id)?.name : typeof x === "number" && typeof y === "number" ? elementAt(elements, x, y)?.name : undefined);
    const where = window ? ` in ${window.slice(0, 60)}` : "";
    if (action === "click" || action === "drag") {
      const from = nameAt(args.name, args.id, args.x, args.y);
      const to = action === "drag" ? nameAt(args.toName, args.toId, args.toX, args.toY) : undefined;
      const risky = [from, to].find((n) => riskyName(n));
      if (risky) return `${action === "drag" ? `drag "${from ?? "something"}" to "${to ?? "a spot"}"` : `click "${risky.slice(0, 60)}"`}${where}`;
      return undefined;
    }
    if (!sendingWindow(window)) return undefined;
    if (action === "keys" && submitKeys(text(args.keys))) return `press ${text(args.keys)}${where}`;
    if ((action === "type" || action === "paste") && submitText(typeof args.text === "string" ? args.text : undefined)) return `${action} text that ends a line (which sends it)${where}`;
    return undefined;
  }

  /**
   * Asks the person whether an agent may do something risky, on the computer when it can ask (the person is at
   * it), else on a device near it. Resolves with what to report when allowed, once; throws when not. Off with the
   * computer's confirmRisky switch.
   */
  private async confirm(session: Session, what: string): Promise<string | undefined> {
    const settings = this.hub.settings(session);
    const on = settings.confirmRisky;
    if (on === 0 || on === false || on === "0") return undefined;
    const computer = session.client.name;
    const caps = session.client.capabilities;
    let asked: Session;
    try {
      asked = caps.includes("mic") || caps.includes("screen") ? session : this.hub.pickOutput({ location: text(settings.location) });
    } catch {
      try {
        asked = this.hub.pickOutput({});
      } catch (error) {
        throw new Error(`to ${what} the person must allow it first, and no device can ask them (${(error as Error).message}). Tell them what you would do`);
      }
    }
    const answer = await this.hub.ask(asked, `May the agent ${what} on ${computer}?`, ["Allow", "Deny"], CONFIRM_MS);
    if (answer.answer !== "Allow") {
      throw new Error(`the user declined: ${what} was not done${answer.timedOut ? " (no answer in 30 seconds counts as no)" : ""}. Do not try it another way; ask them what they want`);
    }
    return `the person allowed: ${what}`;
  }

  /** Clicking, typing and everything else that changes the screen: refused here when switched off for the computer. */
  private mayChange(session: Session): void {
    const held = this.lookOnly.at(-1);
    if (held) throw new Error(`not now: ${held}. Looking is allowed (look, find, screenshot if it is on); tell the person what you found and what you would do, and let them ask for it`);
    const allowed = this.hub.settings(session).allowInput;
    if (allowed === 0 || allowed === false || allowed === "0") {
      throw new Error(`clicking and typing are switched off for ${session.client.name} on the VorteX Axis admin page`);
    }
  }
}

/** What the last answers from a computer showed, for telling whether an action is risky. */
interface Seen {
  window: string | undefined;
  elements: Map<number, SeenElement>;
}
interface SeenElement {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The block list's entry a name matches (any case, any part), or undefined. */
export function blockedBy(blocked: string[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return blocked.find((entry) => lower.includes(entry));
}

/** A window as an answer gives it: a line ("Inbox - Mail (outlook) 0,0 1200x800") or an object with a title. */
function windowName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const w = value as Record<string, unknown>;
    return [w.title, w.name, w.app, w.process].filter((v) => typeof v === "string").join(" ") || undefined;
  }
  return undefined;
}

/** One element from a look or find: a line "id kind x,y wxh name [= value] [*focus]", or an object. */
function elementOf(value: unknown): SeenElement | undefined {
  if (typeof value === "string") {
    const m = /^(\d+) \S+ (-?\d+),(-?\d+) (\d+)x(\d+) ?(.*)$/.exec(value);
    if (!m) return undefined;
    const name = m[6]!.split(" = ")[0]!.replace(/( \*\w+.*)$/, "");
    return { id: Number(m[1]), x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]), name };
  }
  if (typeof value === "object" && value !== null) {
    const e = value as Record<string, unknown>;
    if (typeof e.id !== "number") return undefined;
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    return { id: e.id, name: typeof e.name === "string" ? e.name : "", x: n(e.x), y: n(e.y), w: n(e.w), h: n(e.h) };
  }
  return undefined;
}

/** The smallest element of a look at a point. */
function elementAt(elements: Seen["elements"] | undefined, x: number, y: number): SeenElement | undefined {
  let best: SeenElement | undefined;
  for (const e of elements?.values() ?? []) {
    if (x < e.x || y < e.y || x >= e.x + e.w || y >= e.y + e.h) continue;
    if (!best || e.w * e.h < best.w * best.h) best = e;
  }
  return best;
}

/** A few words on what an agent just did on a computer, for the admin page. */
function describe(action: string, params: Record<string, unknown>): string {
  const what = text(params.name) ?? text(params.into) ?? text(params.app) ?? text(params.url) ?? text(params.window) ?? text(params.keys) ?? text(params.go);
  const said = action === "steps" && Array.isArray(params.steps) ? `${params.steps.length} steps` : what ? `${action} ${what}` : action;
  return said.length > 80 ? `${said.slice(0, 79)}…` : said;
}

/** Actions that change what is on the screen, held by the computer's allowInput switch. */
const CHANGES = new Set<Action>(["click", "drag", "type", "keys", "open", "switch", "window", "desktop", "steps", "scroll", "paste"]);
/** What a step in `steps` may be. */
const STEP_ACTIONS = new Set<Action>(["click", "drag", "type", "keys", "open", "switch", "window", "desktop", "wait", "point", "find", "scroll", "paste"]);
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
    case "drag": {
      // From: id, name or x,y as for click. To: toId, toName or toX,toY.
      target();
      const x = whole(params.x), y = whole(params.y);
      if (args.id === undefined && args.name === undefined) {
        if (x === undefined || y === undefined) throw new Error("drag needs where from: an id from the last look, a name, or x and y");
        Object.assign(args, { x, y });
      }
      const toId = whole(params.toId);
      const toName = text(params.toName)?.slice(0, 200);
      const toX = whole(params.toX), toY = whole(params.toY);
      if (toId !== undefined) args.toId = toId;
      else if (toName) args.toName = toName;
      else if (toX !== undefined && toY !== undefined) Object.assign(args, { toX, toY });
      else throw new Error("drag needs where to: toId from the last look, toName, or toX and toY");
      const hold = params.holdMs === undefined ? undefined : whole(params.holdMs);
      if (params.holdMs !== undefined && (hold === undefined || hold < 0 || hold > MAX_HOLD_MS)) throw new Error(`holdMs must be 0 to ${MAX_HOLD_MS}: how long to press before moving`);
      if (hold) args.holdMs = hold;
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
      // Until something is there (or gone): a name in the window in front, or a window. Else a fixed pause.
      const which = text(params.window)?.slice(0, 200);
      if (name || which) {
        if (name) {
          args.name = name;
          if (kind) args.kind = kind;
        } else args.window = which!;
        if (params.gone === true) args.gone = 1;
        args.seconds = Math.min(MAX_WAIT_S, Math.max(1, whole(params.seconds) ?? 10));
        return args;
      }
      const ms = whole(params.ms) ?? 500;
      args.ms = Math.min(MAX_FIXED_WAIT_MS, Math.max(50, ms));
      return args;
    }
    case "scroll": {
      const go = text(params.go) ?? "down";
      if (!["up", "down", "left", "right", "top", "bottom"].includes(go)) throw new Error("scroll needs go: up, down, left, right, top or bottom");
      args.go = go;
      args.pages = Math.min(10, Math.max(1, whole(params.pages) ?? 1));
      target();
      return args;
    }
    case "paste": {
      const words = typeof params.text === "string" ? params.text : "";
      if (!words) throw new Error("paste needs text");
      if (words.length > MAX_PASTED) throw new Error(`paste takes at most ${MAX_PASTED} characters`);
      args.text = words;
      const into = text(params.into)?.slice(0, 200) ?? name;
      if (id !== undefined) args.id = id;
      else if (into) {
        args.name = into;
        if (kind) args.kind = kind;
      }
      return args;
    }
    default:
      throw new Error(`${action} cannot be a step`);
  }
}
