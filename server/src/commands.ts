import type { Scalar } from "@vortex-axis/protocol";
import type { InvokeHandler, NodeTool } from "./gateway/client.js";
import type { Activity } from "./activity.js";
import type { Hub, Session } from "./hub.js";
import { withBuiltIns } from "./schema.js";
import type { Store, TimerRecord } from "./store.js";
import { MAX_TIMER_SECONDS, type Timers } from "./timers.js";

/**
 * Every command the node declares. The gateway makes a person approve the node
 * again whenever this list grows, so it is declared in full from the start,
 * including commands that are not built yet.
 */
export const NODE_COMMANDS = [
  "system.notify",
  "vortex.axis.say",
  "vortex.axis.ask",
  "vortex.axis.clients",
  "vortex.axis.config",
  "vortex.axis.sense",
  "vortex.axis.diag",
  "vortex.axis.timer",
  "vortex.axis.admin",
] as const;

const TARGET_PROPERTIES = {
  client: { type: "string", description: "Name or id of one client. Use vortex_axis_clients to see them." },
  room: { type: "string", description: "Room to reach, when no single client is meant." },
};

/** Tools published to agents. Only commands that work get a tool. */
export const NODE_TOOLS: NodeTool[] = [
  {
    name: "vortex_axis_say",
    command: "vortex.axis.say",
    description:
      "Speak a short message aloud, or show it, on one of the user's VorteX Axis devices. Use for timely " +
      "things the user should hear without looking at a screen. Keep it to one or two sentences, with no " +
      "formatting. With no client or room, it goes to the device the user last spoke to. The result says " +
      "whether the device confirmed it was heard; if heard is false, do not assume the user got the message.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "What to say." }, ...TARGET_PROPERTIES },
      required: ["text"],
    },
  },
  {
    name: "vortex_axis_ask",
    command: "vortex.axis.ask",
    description:
      "Ask the user a question out loud on one of their VorteX Axis devices and wait for the answer. The " +
      "question is spoken, then the device listens; on a screen the choices can also be tapped. Give up to " +
      "six short choices when you need one of a fixed set, and say them in the question if the user should " +
      "hear them. Give no choices for an open question. The result has answer (the choice picked, or null) " +
      "and said (the user's own words, when they spoke or typed). answer null with said set means they said " +
      "something that matched no choice: read said and decide. timedOut means nobody answered. With no " +
      "client or room, it goes to the device the user last spoke to.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, one sentence, no formatting." },
        choices: { type: "array", items: { type: "string" }, description: "Up to six short answers to offer. Omit for an open question." },
        timeoutSeconds: { type: "number", description: "How long to wait for an answer. 30 by default, 5 to 300." },
        ...TARGET_PROPERTIES,
      },
      required: ["question"],
    },
  },
  {
    name: "vortex_axis_timer",
    command: "vortex.axis.timer",
    description:
      "Set, list or cancel timers on the user's VorteX Axis devices. When a timer is due the device chimes " +
      "and says so by itself; you do not need to do anything then. action set needs seconds, and takes a " +
      "short label such as pasta. action list shows the timers running with the seconds left. action cancel " +
      "takes an id or a label, or all true. With no client or room, a new timer goes to the device the user " +
      "last spoke to.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "list", "cancel"], description: "What to do. list when omitted." },
        seconds: { type: "number", description: "Length of a new timer in seconds. 300 is five minutes." },
        label: { type: "string", description: "What the timer is for, a word or two. Also picks the timer to cancel." },
        id: { type: "number", description: "Id of the timer to cancel, from list." },
        all: { type: "boolean", description: "With cancel: cancel every timer, or every timer on the client given." },
        ...TARGET_PROPERTIES,
      },
    },
  },
  {
    name: "vortex_axis_admin",
    command: "vortex.axis.admin",
    description:
      "Look after the user's VorteX Axis devices. action actions lists what each device offers, such as " +
      "reboot, diag or chime. action run carries out one of those on a device and returns what it reported; " +
      "reboot restarts the device, so only do it when asked. action rename gives a device a new name. action " +
      "pairing_code makes a one-time code for adding a new device; give the code to the user, who enters it " +
      "on the new device. Removing a device is not offered here; the user does that on the admin page.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["actions", "run", "rename", "pairing_code"], description: "What to do. actions when omitted." },
        client: TARGET_PROPERTIES.client,
        run: { type: "string", description: "With action run: the name of the device action, for example reboot." },
        name: { type: "string", description: "With action rename: the new name, up to 60 characters." },
      },
    },
  },
  {
    name: "vortex_axis_clients",
    command: "vortex.axis.clients",
    description:
      "List the user's VorteX Axis devices: name, type, room, what each can do (mic, speaker, screen, " +
      "buttons, vibration, sensors) and whether it is online.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "vortex_axis_config",
    command: "vortex.axis.config",
    description:
      "Read or change a setting on one VorteX Axis device, such as volume or room. Give only the client " +
      "to read all its settings. Give key and value to change one.",
    parameters: {
      type: "object",
      properties: {
        client: TARGET_PROPERTIES.client,
        key: { type: "string", description: "Setting name, for example volume." },
        value: { description: "New value: text, number or true/false. null removes the device's own value." },
      },
      required: ["client"],
    },
  },
  {
    name: "vortex_axis_sense",
    command: "vortex.axis.sense",
    description: "Read the latest sensor readings a VorteX Axis device has reported, such as battery level.",
    parameters: { type: "object", properties: { client: TARGET_PROPERTIES.client } },
  },
  {
    name: "vortex_axis_diag",
    command: "vortex.axis.diag",
    description: "Check the health of the VorteX Axis hub: devices online, and whether speech services are up.",
    parameters: { type: "object", properties: {} },
  },
];

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 512)
  );
}

export interface CommandDeps {
  hub: Hub;
  store: Store;
  timers: Timers;
  activity?: Activity | undefined;
  /** How long a pairing code made for an agent stays good. */
  pairingCodeTtlMs: number;
  version: string;
  startedAt: number;
  now?: () => number;
}

/** Builds the function that carries out a command an agent sent to the node. */
export function createInvokeHandler(deps: CommandDeps): InvokeHandler {
  const { hub, store, timers } = deps;
  const now = deps.now ?? Date.now;

  const timerView = (timer: TimerRecord) => ({
    id: timer.id,
    label: timer.label || null,
    client: store.getClient(timer.clientId)?.name ?? timer.clientId,
    setForSeconds: timer.seconds,
    secondsLeft: Math.max(0, Math.round((timer.dueAt - now()) / 1000)),
  });

  const describe = (session: Session | undefined, clientId: string) => {
    const client = session?.client ?? store.getClient(clientId)!;
    const settings = store.resolveSettings(client);
    return {
      id: client.id,
      name: client.name,
      type: client.type,
      room: typeof settings.room === "string" ? settings.room : null,
      can: client.capabilities,
      online: Boolean(session),
    };
  };

  const clientNamed = (name: string) => {
    const client = store.findClient(name);
    if (!client) throw new Error(`there is no client called "${name}"`);
    return client;
  };

  return async (command, params) => {
    switch (command) {
      case "vortex.axis.say":
      case "system.notify": {
        // system.notify carries a title and a body; say them as one message.
        const words =
          command === "vortex.axis.say"
            ? text(params.text)
            : [text(params.title), text(params.body)].filter(Boolean).join(". ") || undefined;
        if (!words) throw new Error("there is nothing to say: text is empty");
        const session = hub.pickOutput({ client: text(params.client), room: text(params.room) });
        const { heard } = await hub.say(session, words);
        const shown = session.client.capabilities.includes("screen");
        // "heard" is the client's own confirmation that the audio played to the
        // end. Without it the agent must not assume the person heard anything.
        return {
          client: session.client.name,
          heard,
          shown,
          ...(heard
            ? {}
            : { note: shown ? "Not confirmed as heard. The text was shown on the client's screen." : "Not confirmed as heard, and this client has no screen." }),
        };
      }

      case "vortex.axis.clients":
        return {
          clients: store.listClients().map((client) => describe(hub.session(client.id), client.id)),
        };

      case "vortex.axis.config": {
        const name = text(params.client);
        if (!name) throw new Error("say which client");
        const client = clientNamed(name);
        const key = text(params.key);
        if (key !== undefined && "value" in params) {
          if (!isScalar(params.value)) throw new Error("value must be text, a number, true/false or null");
          store.patchLayer("device", client.id, { [key]: params.value });
          hub.pushSettings();
        }
        return { client: client.name, settings: store.resolveSettings(client) };
      }

      case "vortex.axis.sense": {
        const name = text(params.client);
        const sessions = name ? [hub.session(clientNamed(name).id)] : [...hub.sessions()];
        return {
          readings: sessions
            .filter((s): s is Session => Boolean(s))
            .map((s) => ({ client: s.client.name, readings: s.readings })),
        };
      }

      case "vortex.axis.diag":
        return {
          version: deps.version,
          uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
          clientsOnline: [...hub.sessions()].length,
          clientsKnown: store.listClients().length,
          upstream: hub.upstreamStatus(),
        };

      case "vortex.axis.ask": {
        const question = text(params.question);
        if (!question) throw new Error("there is nothing to ask: question is empty");
        if (params.choices !== undefined && !Array.isArray(params.choices)) throw new Error("choices must be a list of short texts");
        const choices = [...new Set(((params.choices as unknown[] | undefined) ?? []).map(text))].filter(
          (c): c is string => Boolean(c),
        );
        if (choices.length > 6) throw new Error("at most six choices");
        if (choices.some((c) => c.length > 64)) throw new Error("a choice is at most 64 characters");
        const seconds = typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds) ? params.timeoutSeconds : 30;
        const session = hub.pickOutput({ client: text(params.client), room: text(params.room) });
        const caps = session.client.capabilities;
        // An answer has to come back somehow: by voice, or by picking a choice on a screen.
        if (!caps.includes("mic") && !(choices.length && caps.includes("screen"))) {
          throw new Error(
            `${session.client.name} has no microphone${choices.length ? " and no screen" : ", so it can only answer a question with choices"}`,
          );
        }
        const result = await hub.ask(session, question.slice(0, 500), choices, Math.round(Math.min(300, Math.max(5, seconds)) * 1000));
        return {
          client: session.client.name,
          ...result,
          ...(result.timedOut
            ? { note: "Nobody answered in time." }
            : result.answer === null && result.said && choices.length
              ? { note: "What was said matched none of the choices." }
              : result.answer === null && !result.said
                ? { note: "The question ended without an answer." }
                : {}),
        };
      }

      case "vortex.axis.timer": {
        const action = text(params.action) ?? "list";
        const name = text(params.client);
        const room = text(params.room);
        if (action === "set") {
          const seconds = typeof params.seconds === "number" ? Math.round(params.seconds) : NaN;
          if (!Number.isFinite(seconds) || seconds < 1) throw new Error("say how long: seconds must be 1 or more");
          if (seconds > MAX_TIMER_SECONDS) throw new Error("a timer can be at most seven days");
          const session = hub.pickOutput({ client: name, room });
          return { set: timerView(timers.set(session, seconds, text(params.label) ?? "")) };
        }
        const clientId = name ? clientNamed(name).id : undefined;
        if (action === "list") return { timers: timers.list(clientId).map(timerView) };
        if (action === "cancel") {
          const id = typeof params.id === "number" ? params.id : undefined;
          const label = text(params.label);
          const all = params.all === true;
          if (id === undefined && label === undefined && !all) throw new Error("say which timer: give id, label, or all true");
          const gone = timers.cancel({ id, label, clientId, all });
          return { cancelled: gone.map(timerView), left: timers.list().length };
        }
        throw new Error(`timer action must be set, list or cancel, not "${action}"`);
      }

      case "vortex.axis.admin": {
        const action = text(params.action) ?? "actions";
        const name = text(params.client);
        if (action === "actions") {
          const clients = name ? [clientNamed(name)] : store.listClients();
          return {
            clients: clients.map((client) => ({
              client: client.name,
              online: hub.isOnline(client.id),
              actions: withBuiltIns(store.getSchema(client.type)).actions.map((a) => ({
                name: a.name,
                label: a.label,
                ...(a.help ? { help: a.help } : {}),
              })),
            })),
          };
        }
        if (action === "pairing_code") {
          const { code, expiresAt } = store.createPairingCode(deps.pairingCodeTtlMs);
          deps.activity?.note("admin", "", "Pairing code made for an agent");
          return {
            code,
            expiresInMinutes: Math.round((expiresAt - now()) / 60_000),
            note: "One use. The user enters it on the new device's setup page, with the address of Axis.",
          };
        }
        if (!name) throw new Error("say which client");
        const client = clientNamed(name);
        if (action === "rename") {
          const wanted = text(params.name);
          if (!wanted || wanted.length > 60) throw new Error("name must be 1 to 60 characters");
          const renamed = store.renameClient(client.id, wanted);
          if (renamed === "taken") throw new Error(`another client is already called ${wanted}`);
          if (!renamed) throw new Error(`there is no client called "${name}"`);
          const session = hub.session(client.id);
          if (session) session.client = renamed;
          deps.activity?.note("admin", client.id, `Renamed to ${renamed.name} by an agent`);
          return { client: renamed.name, was: client.name };
        }
        if (action === "run") {
          const run = text(params.run);
          if (!run) throw new Error("say which action to run");
          const offered = withBuiltIns(store.getSchema(client.type)).actions;
          if (!offered.some((a) => a.name === run)) {
            throw new Error(`${client.name} does not offer "${run}". It offers: ${offered.map((a) => a.name).join(", ") || "nothing"}`);
          }
          const session = hub.session(client.id);
          if (!session) throw new Error(`${client.name} is offline`);
          const outcome = await hub.command(session, run);
          deps.activity?.note("admin", client.id, `Agent ran "${run}" on ${client.name}`);
          if (!outcome.ok) throw new Error(outcome.error ?? `${client.name} refused "${run}"`);
          return { client: client.name, ran: run, ...(outcome.payload ? { result: outcome.payload } : {}) };
        }
        throw new Error(`admin action must be actions, run, rename or pairing_code, not "${action}"`);
      }

      default:
        throw new Error(`unknown command ${command}`);
    }
  };
}
