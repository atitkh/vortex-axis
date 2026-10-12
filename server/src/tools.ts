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
/** Experimental tools an admin has switched on; they are off otherwise. */
const META_ON = "tools_on";
/** `nodes notify` on the gateway arrives as this command, and is the say tool by another name. */
const SAME_AS: Record<string, string> = { "system.notify": "vortex.axis.say" };

export class ToolAccess {
  constructor(
    private readonly store: Store,
    private readonly activity?: Activity,
  ) {}

  private read(key: string): Set<string> {
    try {
      return new Set(JSON.parse(this.store.getMeta(key) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  }

  /** Switched off by an admin, and experimental tools not switched on. */
  private off(): Set<string> {
    const off = this.read(META_OFF);
    const on = this.read(META_ON);
    for (const tool of NODE_TOOLS) if (tool.experimental && !on.has(tool.name)) off.add(tool.name);
    return off;
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
    const current = this.off();
    const off = this.read(META_OFF);
    const turnedOn = this.read(META_ON);
    const said: string[] = [];
    for (const [name, on] of Object.entries(changes)) {
      const tool = NODE_TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`there is no tool called "${name}"`);
      if (typeof on !== "boolean") throw new Error(`${name} must be true or false`);
      if (on === !current.has(name)) continue;
      if (on) {
        off.delete(name);
        if (tool.experimental) turnedOn.add(name);
      } else {
        off.add(name);
        turnedOn.delete(name);
      }
      said.push(`${name} ${on ? "on" : "off"}`);
    }
    this.store.setMeta(META_OFF, off.size ? JSON.stringify([...off]) : undefined);
    this.store.setMeta(META_ON, turnedOn.size ? JSON.stringify([...turnedOn]) : undefined);
    if (said.length) this.activity?.note("admin", "", `Agent tools: ${said.join(", ")}`);
  }

  /**
   * Wraps the function that carries out commands so that one whose tool is
   * switched off is refused, by whichever door it came.
   */
  guard(handler: InvokeHandler): InvokeHandler {
    return async (command, params, via) => {
      const tool = NODE_TOOLS.find((t) => t.command === (SAME_AS[command] ?? command));
      if (tool && this.off().has(tool.name)) {
        throw new Error(`${tool.name} is switched off on the VorteX Axis admin page`);
      }
      return handler(command, params, via);
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
