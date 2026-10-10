import type { Activity } from "./activity.js";
import { NODE_TOOLS } from "./commands.js";
import type { InvokeHandler } from "./gateway/client.js";
import { hashSecret, newToken } from "./secrets.js";
import type { AgentTokenRecord, Store } from "./store.js";

/**
 * Who may use Axis's tools, and which tools there are to use, whichever way an
 * agent comes in: through the OpenClaw node or through MCP.
 *
 * The tools themselves are one list (`NODE_TOOLS` in `commands.ts`) carried
 * out by one function. This adds the two things an admin decides: which of
 * them are switched on, for every agent alike, and which agents hold a token
 * for the MCP door. A token is all-or-nothing, like the node: Axis has no
 * levels of agent.
 */

const META_OFF = "tools_off";
/** `nodes notify` on the gateway arrives as this command, and is the say tool by another name. */
const SAME_AS: Record<string, string> = { "system.notify": "vortex.axis.say" };

export class ToolAccess {
  constructor(
    private readonly store: Store,
    private readonly activity?: Activity,
  ) {}

  private off(): Set<string> {
    try {
      return new Set(JSON.parse(this.store.getMeta(META_OFF) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  }

  /** Every tool, with whether it is switched on. */
  list() {
    const off = this.off();
    return NODE_TOOLS.map((tool) => ({ ...tool, enabled: !off.has(tool.name) }));
  }

  /** The tools an agent is offered. */
  enabled() {
    return this.list().filter((tool) => tool.enabled);
  }

  /** Switches tools on or off by name. Unknown names are refused. */
  set(changes: Record<string, unknown>): void {
    const off = this.off();
    const said: string[] = [];
    for (const [name, on] of Object.entries(changes)) {
      if (!NODE_TOOLS.some((tool) => tool.name === name)) throw new Error(`there is no tool called "${name}"`);
      if (typeof on !== "boolean") throw new Error(`${name} must be true or false`);
      if (on === !off.has(name)) continue;
      if (on) off.delete(name);
      else off.add(name);
      said.push(`${name} ${on ? "on" : "off"}`);
    }
    this.store.setMeta(META_OFF, off.size ? JSON.stringify([...off]) : undefined);
    if (said.length) this.activity?.note("admin", "", `Agent tools: ${said.join(", ")}`);
  }

  /**
   * Wraps the function that carries out commands so that one whose tool is
   * switched off is refused, by whichever door it came.
   */
  guard(handler: InvokeHandler): InvokeHandler {
    return async (command, params) => {
      const tool = NODE_TOOLS.find((t) => t.command === (SAME_AS[command] ?? command));
      if (tool && this.off().has(tool.name)) {
        throw new Error(`${tool.name} is switched off on the VorteX Axis admin page`);
      }
      return handler(command, params);
    };
  }

  // --- tokens for the MCP door ------------------------------------------------

  /** Makes a token for an agent. The token itself is returned this once and kept only as a hash. */
  createToken(name: string): { id: number; name: string; token: string } {
    const label = name.trim().slice(0, 60);
    if (!label) throw new Error("give the token a name, such as the harness that will use it");
    const token = `axis_${newToken()}`;
    const id = this.store.addAgentToken(label, hashSecret(token));
    this.activity?.note("admin", "", `Agent token "${label}" made`);
    return { id, name: label, token };
  }

  tokens(): AgentTokenRecord[] {
    return this.store.listAgentTokens();
  }

  revokeToken(id: number): boolean {
    const token = this.store.listAgentTokens().find((t) => t.id === id);
    if (!token || !this.store.removeAgentToken(id)) return false;
    this.activity?.note("admin", "", `Agent token "${token.name}" revoked`, "warn");
    return true;
  }

  /** The token's record when it is one of ours. Notes that it was used, at most once a minute. */
  authenticate(token: string): AgentTokenRecord | undefined {
    if (!token) return undefined;
    const record = this.store.findAgentToken(hashSecret(token));
    if (record && Date.now() - (record.lastUsedAt ?? 0) > 60_000) this.store.touchAgentToken(record.id);
    return record;
  }
}
