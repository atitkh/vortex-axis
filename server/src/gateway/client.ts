import { randomUUID } from "node:crypto";
import type { Agent } from "../agent.js";
import type { Store } from "../store.js";
import { GatewayLink, type Credentials, type LinkOptions, type LinkState } from "./link.js";
import { DeviceIdentity, GatewayError, PLATFORM, decodeSetupCode, toSocketUrl, type Role } from "./wire.js";

/** A tool an agent can see, bound to one of this node's commands. */
export interface NodeTool {
  name: string;
  description: string;
  command: string;
  parameters: Record<string, unknown>;
}

export type InvokeHandler = (command: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface GatewayClientOptions {
  store: Store;
  /** Gateway address from the environment. Wins over the one in a setup code. */
  url?: string | undefined;
  /** Agent to talk to, from the environment. A value set through the admin API wins. */
  agentId?: string | undefined;
  /** Keeps every client in one conversation. */
  sessionKey: string;
  displayName: string;
  version: string;
  /** Commands the node declares. Declared in full at first pairing. */
  commands: string[];
  tools: NodeTool[];
  log: (line: string) => void;
  /** How long to wait for an agent to finish a reply. */
  replyTimeoutMs?: number;
  timing?: LinkOptions["timing"];
  onStateChange?: () => void;
}

const META = {
  identity: "gateway_identity",
  url: "gateway_url",
  bootstrap: "gateway_bootstrap",
  token: (role: Role) => `gateway_token_${role}`,
  agent: "gateway_agent_id",
};

/** Plugin id the node's tools are published under. */
const PLUGIN_ID = "vortex-axis";
const PRESENCE_INTERVAL_MS = 60_000;
const PROGRESS_INTERVAL_MS = 3_000;

/** A minimal async queue: producers push, one consumer iterates. */
class Channel<T> {
  private items: T[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  private failure: Error | undefined;

  push(item: T): void {
    this.items.push(item);
    this.waiter?.();
  }

  end(error?: Error): void {
    this.ended = true;
    this.failure = error;
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = undefined;
    }
  }
}

/**
 * Axis's presence on an OpenClaw gateway: one device identity holding two
 * links. The operator link sends turns to an agent. The node link lets agents
 * call Axis's commands.
 */
export class GatewayClient implements Agent, Credentials {
  private readonly store: Store;
  private readonly device: DeviceIdentity;
  private readonly operator: GatewayLink;
  private readonly node: GatewayLink;
  private readonly agentListeners = new Set<(payload: any) => void>();
  private readonly eventListeners = new Set<(event: string, payload: any) => void>();
  /** A second operator link, for what needs scopes the first was never given: see `watch`. */
  private watcher: GatewayLink | undefined;
  private watching: string[] = [];
  private readonly linkCommon: Pick<LinkOptions, "displayName" | "version" | "log" | "onState" | "timing">;
  private invokeHandler: InvokeHandler | undefined;
  private defaultAgentId: string | undefined;
  private presenceTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: GatewayClientOptions) {
    this.store = options.store;
    const saved = this.store.getMeta(META.identity);
    this.device = saved ? DeviceIdentity.restore(saved) : DeviceIdentity.generate();
    if (!saved) this.store.setMeta(META.identity, this.device.serialize());

    const common = {
      displayName: options.displayName,
      version: options.version.replace(/^v/, ""), // the gateway's device list adds its own "v"
      credentials: this,
      log: options.log,
      onState: () => options.onStateChange?.(),
      ...(options.timing ? { timing: options.timing } : {}),
    };
    this.linkCommon = { displayName: common.displayName, version: common.version, log: common.log, onState: common.onState, ...(options.timing ? { timing: options.timing } : {}) };
    this.operator = new GatewayLink({
      ...common,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps: [],
      onEvent: (event, payload) => {
        if (event === "agent") for (const listener of this.agentListeners) listener(payload);
        else for (const listener of this.eventListeners) listener(event, payload);
      },
      onConnected: () => {
        this.defaultAgentId = undefined;
        this.retireBootstrap();
        // The setup code is free now. A node token that came with this
        // handshake is used as it is. Without one, the node presents the code
        // itself and asks for its own role.
        if (!this.node.connected) this.node.retryNow(Boolean(this.deviceToken("node")));
      },
    });
    this.node = new GatewayLink({
      ...common,
      role: "node",
      scopes: [],
      caps: ["talk"],
      commands: options.commands,
      onEvent: (event, payload) => {
        if (event === "node.invoke.request") void this.onInvoke(payload);
      },
      onConnected: () => {
        this.retireBootstrap();
        void this.announceNode();
      },
    });
  }

  start(): void {
    this.operator.start();
    this.node.start();
    this.presenceTimer = setInterval(() => void this.sendPresence("background"), PRESENCE_INTERVAL_MS);
    this.presenceTimer.unref();
  }

  stop(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.operator.stop();
    this.node.stop();
    this.watcher?.stop();
  }

  /**
   * Listens for what the first operator link has no scope for: questions agents put to the person
   * (`operator.questions`) and approvals they wait on (`operator.approvals`). A scope the gateway has
   * not granted this device yet has to be approved there by a person, and until then the connection
   * that asks for it is refused. So the asking is done on a link of its own: turns and tool calls go on
   * over the first two whatever becomes of this one. It shares the operator's token and may store a
   * newer one the gateway hands it, but can never drop the token or spend a setup code.
   */
  watch(scopes: string[]): void {
    const wanted = [...new Set(scopes)].sort();
    if (wanted.join() === this.watching.join()) return;
    this.watching = wanted;
    this.watcher?.stop();
    this.watcher = undefined;
    if (!wanted.length) return void this.options.onStateChange?.();
    const outer = this;
    const credentials: Credentials = {
      url: () => outer.url(),
      identity: () => outer.device,
      deviceToken: () => outer.deviceToken("operator"),
      bootstrapToken: () => undefined,
      mayRedeem: () => false,
      bootstrapRejected: () => undefined,
      storeTokens: (_from, tokens) => {
        if (tokens.operator) outer.storeTokens("operator", { operator: tokens.operator });
      },
      dropDeviceToken: () => undefined,
    };
    this.watcher = new GatewayLink({
      ...this.linkCommon,
      credentials,
      role: "operator",
      scopes: ["operator.read", ...wanted],
      caps: [],
      // Only what this link is for: the first link already hears the rest.
      onEvent: (event, payload) => {
        if (!/^(question|exec\.approval|plugin\.approval)\./.test(event)) return;
        for (const listener of this.eventListeners) listener(event, payload);
      },
      onConnected: () => {
        for (const listener of this.eventListeners) listener("watch.connected", {});
      },
    });
    this.watcher.start();
  }

  /** Asks the gateway something over the watching link. */
  callWatch(method: string, params: unknown): Promise<any> {
    if (!this.watcher?.connected) return Promise.reject(new Error("the gateway has not let Axis listen for this yet"));
    return this.watcher.request(method, params);
  }

  /** Sets what runs when an agent calls one of the node's commands. */
  onInvokeCommand(handler: InvokeHandler): void {
    this.invokeHandler = handler;
  }

  // --- credentials ----------------------------------------------------------

  url(): string | undefined {
    // An address saved at runtime wins over the one from the environment.
    const raw = this.store.getMeta(META.url) ?? this.options.url;
    try {
      return raw ? toSocketUrl(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  identity(): DeviceIdentity {
    return this.device;
  }

  deviceToken(role: Role): string | undefined {
    return this.store.getMeta(META.token(role));
  }

  bootstrapToken(): string | undefined {
    return this.store.getMeta(META.bootstrap);
  }

  storeTokens(from: Role, tokens: Partial<Record<Role, string>>): void {
    for (const role of ["operator", "node"] as const) {
      const token = tokens[role];
      if (!token || token === this.deviceToken(role)) continue;
      this.store.setMeta(META.token(role), token);
      // An operator link waiting out a refusal has a real token now. (The node
      // link is started by the operator link once that one is connected.)
      if (role === "operator" && from === "node" && !this.operator.connected) this.operator.retryNow(true);
    }
  }

  dropDeviceToken(role: Role): void {
    this.store.setMeta(META.token(role), undefined);
  }

  /** The operator link pairs first. The node link follows once that is through. */
  mayRedeem(role: Role): boolean {
    return role === "operator" || this.operator.connected;
  }

  bootstrapRejected(role: Role): void {
    this.store.setMeta(META.bootstrap, undefined);
    // The node link may be standing by for this code. Let it see that it is gone.
    if (role === "operator") setImmediate(() => this.node.retryNow());
  }

  /** Each role redeems the setup code for its own token, so keep it until both have one. */
  private retireBootstrap(): void {
    if (this.operator.connected && this.node.connected && this.bootstrapToken()) {
      this.store.setMeta(META.bootstrap, undefined);
    }
  }

  // --- pairing and status ---------------------------------------------------

  /**
   * Takes a setup code from `openclaw qr --setup-code-only` and starts pairing.
   * A person still has to approve the device on the gateway afterwards.
   */
  applySetupCode(code: string, url?: string): { url: string } {
    const decoded = decodeSetupCode(code);
    // The address in the code is a convenience and is often a name this host
    // cannot resolve. An address given by hand or by the environment wins.
    const chosen = url ?? this.store.getMeta(META.url) ?? this.options.url ?? decoded.urls[0];
    if (!chosen) throw new Error("the setup code has no gateway address; pass one with it");
    const socketUrl = toSocketUrl(chosen);
    this.store.setMeta(META.url, chosen);
    this.store.setMeta(META.bootstrap, decoded.bootstrapToken);
    this.operator.retryNow();
    this.node.retryNow();
    return { url: socketUrl };
  }

  retryNow(): void {
    this.operator.retryNow();
    this.node.retryNow();
  }

  /** Changes the gateway address and reconnects. Undefined goes back to the environment's. */
  setUrl(url: string | undefined): void {
    if (url) toSocketUrl(url); // throws on an address that cannot be used
    this.store.setMeta(META.url, url || undefined);
    this.retryNow();
  }

  /** The agent every turn goes to. Undefined means the gateway's default agent. */
  agentId(): string | undefined {
    return this.store.getMeta(META.agent) ?? this.options.agentId;
  }

  /** Added to the agent's own system prompt on every turn. Empty sends nothing. */
  private note = "";
  private noteRefused = false;
  setNote(note: string): void {
    this.note = note;
  }

  setAgentId(agentId: string | undefined): void {
    this.store.setMeta(META.agent, agentId || undefined);
  }

  status() {
    const link = (l: GatewayLink): { state: LinkState; error: string | undefined } => ({
      state: l.state,
      error: l.lastError,
    });
    return {
      url: this.url(),
      deviceId: this.device.deviceId,
      agentId: this.agentId() ?? null,
      sessionKey: this.options.sessionKey,
      setupCodePending: Boolean(this.bootstrapToken()),
      /** Commands the node declares, which the gateway has to allow. */
      commands: this.options.commands,
      operator: link(this.operator),
      node: link(this.node),
      /** The link that listens for questions and approvals, when either is switched on. */
      watch: this.watcher ? { ...link(this.watcher), scopes: this.watching } : null,
    };
  }

  // --- agent turns (operator link) -----------------------------------------

  /** Hears what the gateway tells an operator besides the replies to Axis's own turns. */
  onEvent(listener: (event: string, payload: any) => void): void {
    this.eventListeners.add(listener);
  }

  /** Asks the gateway something over the operator link. */
  call(method: string, params: unknown): Promise<any> {
    return this.operator.request(method, params);
  }

  async healthy(): Promise<boolean> {
    return this.operator.connected;
  }

  /** Lists the agents the gateway offers, for picking one by name. */
  async listAgents(): Promise<{ id: string; default: boolean }[]> {
    const reply = await this.operator.request("agents.list", {});
    const list: any[] = Array.isArray(reply) ? reply : Array.isArray(reply?.agents) ? reply.agents : [];
    const defaultId = typeof reply?.defaultId === "string" ? reply.defaultId : undefined;
    return list
      .map((a) => ({ id: String(a?.id ?? a?.agentId ?? ""), default: Boolean(a?.default) || a?.id === defaultId }))
      .filter((a) => a.id);
  }

  private async resolveAgentId(): Promise<string | undefined> {
    const chosen = this.agentId();
    if (chosen) return chosen;
    if (!this.defaultAgentId) {
      const agents = await this.listAgents().catch(() => []);
      this.defaultAgentId = (agents.find((a) => a.default) ?? agents[0])?.id;
    }
    return this.defaultAgentId;
  }

  async *reply(message: string, signal?: AbortSignal): AsyncIterable<string> {
    if (!this.operator.connected) throw new Error("not connected to OpenClaw");
    const agentId = await this.resolveAgentId();
    const channel = new Channel<string>();
    let runId: string | undefined;
    let sent = "";
    const early: any[] = [];

    const handle = (payload: any) => {
      // An acknowledgement without a run id leaves nothing to match on.
      if (runId && payload?.runId !== runId) return;
      const data = payload?.data ?? {};
      if (payload.stream === "assistant" && typeof data.text === "string") {
        // The text is the whole reply so far. Pass on only what is new.
        if (data.text.startsWith(sent)) {
          const delta = data.text.slice(sent.length);
          sent = data.text;
          if (delta) channel.push(delta);
        }
      } else if (payload.stream === "lifecycle" && data.phase === "end") {
        const final = typeof data.terminalReply?.text === "string" ? data.terminalReply.text : "";
        if (final.startsWith(sent) && final.length > sent.length) channel.push(final.slice(sent.length));
        channel.end();
      } else if (payload.stream === "lifecycle" && data.phase === "error") {
        channel.end(new Error(typeof data.error === "string" ? data.error : "the agent run failed"));
      }
    };
    // Events can arrive before the request is acknowledged with its run id.
    const listener = (payload: any) => (runId === undefined ? early.push(payload) : handle(payload));
    this.agentListeners.add(listener);

    const timeout = setTimeout(
      () => channel.end(new Error("the agent accepted the turn but did not finish in time")),
      this.options.replyTimeoutMs ?? 120_000,
    );
    const onAbort = () => channel.end();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      // A stable session key needs an explicit agent: with several agents the
      // gateway refuses a key that no agent owns.
      const send = (withNote: boolean) =>
        this.operator.request(
          "agent",
          {
            message,
            idempotencyKey: `axis-${randomUUID()}`,
            ...(agentId ? { agentId, sessionKey: this.options.sessionKey } : {}),
            ...(withNote ? { extraSystemPrompt: this.note } : {}),
          },
          20_000,
        );
      let ack;
      try {
        ack = await send(Boolean(this.note) && !this.noteRefused);
      } catch (error) {
        // A gateway too old to know the note refuses the whole request. Leave the note out from then on.
        if (!this.note || this.noteRefused || !/extraSystemPrompt|unexpected|additional propert/i.test((error as Error).message)) throw error;
        this.noteRefused = true;
        this.options.log("the gateway refused the note to the agent; turns go without it");
        ack = await send(false);
      }
      runId = typeof ack?.runId === "string" ? ack.runId : "";
      for (const payload of early.splice(0)) handle(payload);
      yield* channel;
    } catch (error) {
      if (error instanceof GatewayError) throw new Error(`OpenClaw refused the turn: ${error.message}`);
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      this.agentListeners.delete(listener);
    }
  }

  // --- commands from agents (node link) -------------------------------------

  /** Agents only see a command once the node publishes a tool bound to it. */
  private async announceNode(): Promise<void> {
    try {
      await this.node.request("node.pluginTools.update", {
        tools: this.options.tools.map((tool) => ({ pluginId: PLUGIN_ID, ...tool })),
      });
    } catch (error) {
      this.options.log(`could not publish node tools: ${(error as Error).message}`);
    }
    await this.sendPresence("connect");
  }

  /** Without this the gateway lists the node as offline even while connected. */
  private async sendPresence(trigger: string): Promise<void> {
    if (!this.node.connected) return;
    await this.node
      .request("node.event", {
        event: "node.presence.alive",
        payload: {
          trigger,
          sentAtMs: Date.now(),
          displayName: this.options.displayName,
          version: this.options.version.replace(/^v/, ""),
          platform: PLATFORM,
        },
      })
      .catch(() => {});
  }

  private async onInvoke(payload: any): Promise<void> {
    const id = String(payload?.id ?? "");
    const nodeId = String(payload?.nodeId ?? "");
    const command = String(payload?.command ?? "");
    if (!id) return;

    // The parameters arrive as a JSON string, not an object.
    let params: Record<string, unknown> = {};
    try {
      const parsed = payload?.paramsJSON ? JSON.parse(String(payload.paramsJSON)) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed;
    } catch {
      params = {};
    }

    // A command may wait behind a live conversation. Progress frames keep the
    // caller from giving up while Axis is plainly working.
    let seq = 0;
    const progress = setInterval(() => {
      void this.node
        .request("node.invoke.progress", { invokeId: id, nodeId, seq: seq++, chunk: "working" })
        .catch(() => {});
    }, PROGRESS_INTERVAL_MS);

    let result: Record<string, unknown>;
    try {
      if (!this.invokeHandler) throw new Error("Axis is not ready to take commands");
      const reply = await this.invokeHandler(command, params);
      result = { id, nodeId, ok: true, payload: reply };
    } catch (error) {
      result = { id, nodeId, ok: false, error: { code: "refused", message: (error as Error).message } };
    } finally {
      clearInterval(progress);
    }
    await this.node.request("node.invoke.result", result).catch((error) => {
      this.options.log(`could not return the result of ${command}: ${(error as Error).message}`);
    });
  }
}
