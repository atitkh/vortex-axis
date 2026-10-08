import type { Scalar } from "@vortex-axis/protocol";
import type { InvokeHandler, NodeTool } from "./gateway/client.js";
import type { Hub, Session } from "./hub.js";
import type { Store } from "./store.js";

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
  version: string;
  startedAt: number;
}

/** Builds the function that carries out a command an agent sent to the node. */
export function createInvokeHandler(deps: CommandDeps): InvokeHandler {
  const { hub, store } = deps;

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

      case "vortex.axis.ask":
      case "vortex.axis.timer":
      case "vortex.axis.admin":
        throw new Error(`${command} is not built yet`);

      default:
        throw new Error(`unknown command ${command}`);
    }
  };
}
