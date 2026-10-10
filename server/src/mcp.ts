import type { InvokeHandler } from "./gateway/client.js";
import type { ToolAccess } from "./tools.js";

/**
 * Axis as an MCP server: the same tools the OpenClaw node offers, for any
 * agent harness that speaks the Model Context Protocol. It is a second door
 * onto `commands.ts`, not a second set of tools: `tools/list` reads the same
 * list and `tools/call` goes to the same function.
 *
 * The transport is MCP's "streamable HTTP" in its plainest form: each request
 * is one POST carrying one JSON-RPC message (or a batch), answered with JSON.
 * Axis keeps no session and sends nothing unasked, so there is no event
 * stream to open. The harness makes this connection itself; the turns Axis
 * sends an agent travel separately and carry no tools.
 */

/** Protocol revisions this speaks. The newest is offered to a client that asks for one it does not know. */
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** What an agent is told on connecting: MCP's own place for "how to use this server". */
export const MCP_INSTRUCTIONS = [
  "VorteX Axis is the user's voice hub: a few small devices around them (desk boards with a screen, speaker and microphone; browsers; a phone). These tools act on those devices.",
  "A turn that came from one of the devices starts with a bracketed line naming it (from), where it is (location) and what it has (can). Pass that name as `client` to act on the device the user is at. With no client or location, a tool goes to the device the user last spoke to.",
  "vortex_axis_say speaks a short message; its result says whether the device confirmed it was heard. vortex_axis_ask puts a question and waits for the answer. vortex_axis_timer sets, lists and cancels timers. vortex_axis_clients lists the devices.",
  "Anything spoken should sound spoken: one or two plain sentences, no markdown, lists or emoji.",
].join("\n");

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export interface McpDeps {
  tools: ToolAccess;
  /** Carries out a command, already guarded against tools that are switched off. */
  invoke: InvokeHandler;
  version: string;
}

/**
 * Answers one JSON-RPC message. Returns nothing for a notification, which has
 * no answer.
 */
export function createMcpHandler(deps: McpDeps) {
  async function one(message: RpcMessage): Promise<object | undefined> {
    if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return failure((message as RpcMessage | null)?.id, -32600, "not a JSON-RPC 2.0 request");
    }
    const { id, method } = message;
    const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as Record<string, unknown>;
    // A message with no id is a notification: it is taken in and never answered.
    if (id === undefined) return undefined;
    const ok = (result: object) => ({ jsonrpc: "2.0", id, result });

    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "vortex-axis", title: "VorteX Axis", version: deps.version },
          instructions: MCP_INSTRUCTIONS,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: deps.tools.enabled().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
        });
      case "tools/call": {
        const tool = deps.tools.list().find((t) => t.name === params.name);
        if (!tool) return failure(id, -32602, `there is no tool called "${String(params.name)}"`);
        const given = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        try {
          const result = await deps.invoke(tool.command, given);
          return ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
        } catch (error) {
          // A tool that could not do what was asked is a result the agent should read, not a protocol error.
          return ok({ content: [{ type: "text", text: (error as Error).message }], isError: true });
        }
      }
      // Asked by some clients as a matter of course; there are none of either.
      case "resources/list":
        return ok({ resources: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      default:
        return failure(id, -32601, `method not found: ${method}`);
    }
  }

  /** Takes the parsed body of a POST: one message or a batch. `undefined` means there is nothing to send back. */
  return async function handle(body: unknown): Promise<object | object[] | undefined> {
    if (Array.isArray(body)) {
      if (!body.length) return failure(null, -32600, "an empty batch");
      const answers = (await Promise.all(body.map((message) => one(message as RpcMessage)))).filter((a): a is object => a !== undefined);
      return answers.length ? answers : undefined;
    }
    return one(body as RpcMessage);
  };
}
