/**
 * Looks at whether the OpenClaw gateway still offers everything Axis leans on.
 *
 * Much of what Axis shows comes from the gateway's own events and methods:
 * progress cards, questions, approvals, the tools an agent picks up, realtime
 * voice. None of that is a promise the gateway has made to Axis, so an update
 * there could take one away without a word, and the feature would simply go
 * quiet. This asks, each time the link comes up and whenever the admin page
 * wants to know: what the gateway says it offers, whether the scopes are
 * there, and, where it costs nothing, whether a call really answers.
 *
 * Only a feature that is switched on can be a problem. One that is off is
 * reported as off.
 */

/** The part of the gateway link this needs. */
export interface CheckSource {
  features(): { methods: string[]; events: string[] };
  scopes(): string[];
  call(method: string, params: unknown): Promise<any>;
}

export interface Check {
  id: string;
  /** What it is, in the words of the admin page. */
  label: string;
  state: "ok" | "off" | "problem" | "unknown";
  /** One sentence on how it stands, and what to do when that is not well. */
  detail: string;
}

export interface CheckReport {
  at: number;
  /** False when there is no gateway to ask: Axis has another agent, or the link is down. */
  asked: boolean;
  checks: Check[];
}

interface Need {
  id: string;
  label: string;
  /** Whether the feature is switched on. */
  on: () => boolean;
  methods?: string[];
  events?: string[];
  scopes?: string[];
  /** A call that changes nothing and proves the methods really answer. */
  probe?: () => Promise<unknown>;
}

export interface SelfCheckOptions {
  source: CheckSource;
  /** Whether the agent is an OpenClaw gateway that Axis is connected to. */
  connected: () => boolean;
  features: {
    cards: () => boolean;
    questions: () => boolean;
    approvals: () => boolean;
    realtime: () => boolean;
    toolIcons: () => boolean;
  };
  /** The session Axis talks in, for a question that reads and changes nothing. */
  sessionKey: () => string | undefined;
  log?: (line: string) => void;
  /** Told once for each thing that has just stopped working, and once when it works again. */
  onChange?: (check: Check, was: Check["state"] | undefined) => void;
  now?: () => number;
}

export class SelfCheck {
  private last: CheckReport | undefined;
  private readonly before = new Map<string, Check["state"]>();
  private readonly now: () => number;

  constructor(private readonly options: SelfCheckOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The last report, without asking again. */
  report(): CheckReport | undefined {
    return this.last;
  }

  private needs(): Need[] {
    const { source, features, sessionKey } = this.options;
    const key = sessionKey();
    return [
      {
        id: "turns",
        label: "Turns with the agent",
        on: () => true,
        methods: ["agent", "agents.list"],
        events: ["agent"],
        scopes: ["operator.write"],
        probe: () => source.call("agents.list", {}),
      },
      {
        id: "cards",
        label: "Progress cards as tasks",
        on: features.cards,
        methods: ["progressCard.get", "sessions.list"],
        events: ["progressCard.changed"],
        probe: async () => {
          await source.call("sessions.list", { limit: 1 });
          if (key) await source.call("progressCard.get", { sessionKey: key });
        },
      },
      {
        id: "questions",
        label: "Questions on devices",
        on: features.questions,
        methods: ["question.list", "question.resolve"],
        events: ["question.requested", "question.resolved"],
        scopes: ["operator.questions"],
        probe: () => source.call("question.list", {}),
      },
      {
        id: "approvals",
        label: "Approvals on devices",
        on: features.approvals,
        methods: ["exec.approval.resolve", "plugin.approval.resolve"],
        events: ["exec.approval.requested", "plugin.approval.requested"],
        scopes: ["operator.approvals"],
      },
      {
        id: "toolIcons",
        label: "Tool icons while thinking",
        on: features.toolIcons,
        // The tools ride on the `agent` event, for a link that declared `tool-events`. Only a real turn shows them.
        events: ["agent"],
      },
      {
        id: "realtime",
        label: "Realtime voice",
        on: features.realtime,
        methods: ["talk.session.create", "talk.session.appendAudio", "talk.session.submitToolResult", "talk.client.toolCall", "talk.catalog"],
        events: ["talk.event"],
        probe: () => source.call("talk.catalog", {}),
      },
    ];
  }

  /** Asks the gateway and says how each thing stands. Never throws. */
  async run(): Promise<CheckReport> {
    const { source } = this.options;
    if (!this.options.connected()) {
      this.last = { at: this.now(), asked: false, checks: [] };
      return this.last;
    }
    const offered = source.features();
    // A gateway that does not say what it offers cannot be read this way; the calls still can.
    const says = offered.methods.length > 0 || offered.events.length > 0;
    const scopes = source.scopes();
    const checks: Check[] = [];
    for (const need of this.needs()) {
      if (!need.on()) {
        checks.push({ id: need.id, label: need.label, state: "off", detail: "Switched off." });
        continue;
      }
      const missing = [
        ...(says ? (need.methods ?? []).filter((m) => !offered.methods.includes(m)).map((m) => `the method ${m}`) : []),
        ...(says ? (need.events ?? []).filter((e) => !offered.events.includes(e)).map((e) => `the event ${e}`) : []),
      ];
      // `operator.write` stands for reading and for talk; the others have to be there by name.
      const unscoped = (need.scopes ?? []).filter((scope) => !scopes.includes(scope));
      let failure: string | undefined;
      if (!missing.length && !unscoped.length && need.probe) {
        try {
          await need.probe();
        } catch (error) {
          failure = (error as Error).message;
        }
      }
      const check: Check = unscoped.length
        ? { id: need.id, label: need.label, state: "problem", detail: `The gateway has not granted Axis ${unscoped.join(" and ")}. Pair again with a setup code, on the OpenClaw page.` }
        : missing.length
          ? { id: need.id, label: need.label, state: "problem", detail: `This gateway no longer offers ${missing.join(", ")}. It was probably updated; Axis needs a look.` }
          : failure
            ? { id: need.id, label: need.label, state: "problem", detail: `The gateway offers it but would not answer: ${failure}` }
            : { id: need.id, label: need.label, state: says || need.probe ? "ok" : "unknown", detail: says ? (need.probe ? "Offered by the gateway, and it answers." : "Offered by the gateway. Only a real one shows it working.") : need.probe ? "It answers. This gateway does not list what it offers." : "This gateway does not list what it offers, so this cannot be told without a real one." };
      checks.push(check);
    }
    for (const check of checks) {
      const was = this.before.get(check.id);
      if (was !== check.state && (check.state === "problem" || was === "problem")) {
        this.options.log?.(`self-check: ${check.label}: ${check.state === "problem" ? check.detail : "working again"}`);
        this.options.onChange?.(check, was);
      }
      this.before.set(check.id, check.state);
    }
    this.last = { at: this.now(), asked: true, checks };
    return this.last;
  }
}
