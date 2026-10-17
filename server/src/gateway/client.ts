import { randomUUID } from "node:crypto";
import type { Agent, AgentMedia, AgentRoute, RunState } from "../agent.js";
import { MediaLines, type MediaRef } from "../media.js";
import type { Store } from "../store.js";
import { GatewayLink, type Credentials, type LinkOptions, type LinkState } from "./link.js";
import { DeviceIdentity, GatewayError, PLATFORM, decodeSetupCode, toSocketUrl, type Role } from "./wire.js";

/** A tool an agent can see, bound to one of this node's commands. */
export interface NodeTool {
  name: string;
  description: string;
  command: string;
  parameters: Record<string, unknown>;
  /**
   * Offered through MCP only, never published on the node: its command is not in the node's declared
   * list, which cannot grow without a person approving the node again. No tool is MCP-only now (the
   * desktop tool was, until 0.46.1); the switch stays for the next one.
   */
  mcpOnly?: boolean;
  /** Off until an admin switches it on. */
  experimental?: boolean;
}

/** `via` says who called, for the Live page: "OpenClaw" when it is left out, since the node's door came first. */
export type InvokeHandler = (command: string, params: Record<string, unknown>, via?: string) => Promise<Record<string, unknown>>;

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
  /** The operator scopes the gateway has granted, when they are more than the two Axis starts with. */
  scopes: "gateway_operator_scopes",
};

const BASE_SCOPES = ["operator.read", "operator.write"] as const;

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
  /** Says which conversation turns go to when it is not Axis's own: a full session key, or nothing. */
  private elsewhere: (() => string | undefined) | undefined;
  /** Scopes wanted beyond the two Axis starts with, and the set a setup code now being redeemed asks for: see `watch`. */
  private wanted: string[] = [];
  private asking: string[] | undefined;
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
      scopes: this.granted(),
      // So the gateway says which tools an agent picks up during a turn Axis started.
      caps: ["tool-events"],
      // A wider set the gateway will not honour after all must not cost the turns their link.
      onRefused: (code) => {
        if (code !== "AUTH_SCOPE_MISMATCH" || this.granted().length === BASE_SCOPES.length) return;
        options.log("gateway refused the wider scopes; going back to the ones Axis had");
        this.asking = undefined;
        this.store.setMeta(META.scopes, undefined);
        this.operator.setScopes([...BASE_SCOPES]);
      },
      onEvent: (event, payload) => {
        if (event === "agent") for (const listener of this.agentListeners) listener(payload);
        else for (const listener of this.eventListeners) listener(event, payload);
      },
      onConnected: () => {
        // A pairing that asked for more has been approved with it.
        if (this.asking) {
          this.store.setMeta(META.scopes, JSON.stringify(this.asking));
          options.log(`gateway granted ${this.asking.join(", ")}`);
          this.asking = undefined;
        }
        this.defaultAgentId = undefined;
        this.retireBootstrap();
        // The setup code is free now. A node token that came with this
        // handshake is used as it is. Without one, the node presents the code
        // itself and asks for its own role.
        if (!this.node.connected) this.node.retryNow(Boolean(this.deviceToken("node")));
        // Whatever was asked while Axis was not listening is still waiting there.
        for (const listener of this.eventListeners) listener("watch.connected", {});
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
  }

  /** The scopes the gateway has granted this device's operator role, as far as Axis knows. */
  private granted(): string[] {
    try {
      const saved = JSON.parse(this.store.getMeta(META.scopes) ?? "null");
      if (Array.isArray(saved) && saved.every((scope) => typeof scope === "string") && saved.length) return saved;
    } catch {
      // Unreadable is the same as never saved.
    }
    return [...BASE_SCOPES];
  }

  /**
   * Says which scopes Axis needs beyond its own turns: `operator.questions` to hear the questions
   * agents put to the person, `operator.approvals` for the approvals they wait on.
   *
   * The gateway grants a device its scopes when a person approves its pairing, and a token for a
   * narrower set is refused outright when more is asked with it (`AUTH_SCOPE_MISMATCH`, seen on the
   * real gateway; so is a connection with no credential at all). The one way to more is the way in:
   * a setup code. So nothing changes on the links here. The wider set is asked for the next time a
   * setup code is applied, and granted when that pairing is approved; until then the status says
   * which scopes are missing. Should the gateway refuse the wider set after all, the operator link
   * goes back to what it had.
   */
  watch(scopes: string[]): void {
    const before = this.wanted.join();
    this.wanted = [...new Set(scopes)].sort();
    if (before !== this.wanted.join()) this.options.onStateChange?.();
  }

  /** Asks the gateway something that needs one of the scopes `watch` asked for. */
  callWatch(method: string, params: unknown): Promise<any> {
    return this.operator.request(method, params);
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
    // Pairing again is the moment to ask for the scopes that are wanted and not yet held.
    const wider = [...new Set([...BASE_SCOPES, ...this.wanted])].sort();
    this.asking = wider.length > BASE_SCOPES.length ? wider : undefined;
    if (!this.asking) this.store.setMeta(META.scopes, undefined);
    this.operator.setScopes(wider);
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
      /** Scopes beyond its own turns: the ones Axis wants, and how the request for those it lacks stands. */
      watch: this.wanted.length
        ? {
            scopes: this.wanted,
            missing: this.wanted.filter((scope) => !this.granted().includes(scope)),
            state: this.operator.state,
          }
        : null,
    };
  }

  // --- agent turns (operator link) -----------------------------------------

  /** Has turns go to another conversation while `where` names one (see attach.ts). */
  setElsewhere(where: () => string | undefined): void {
    this.elsewhere = where;
  }

  /** What the gateway said it offers when the operator link last connected. */
  features(): { methods: string[]; events: string[] } {
    return this.operator.features;
  }

  /** The operator scopes the gateway has granted Axis, as far as it knows. */
  scopes(): string[] {
    return this.granted();
  }

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

  async *reply(
    message: string,
    signal?: AbortSignal,
    onTool?: (name: string) => void,
    onState?: (state: RunState | undefined) => void,
    route?: AgentRoute,
    onRun?: (run: { runId: string; sessionKey: string }) => void,
    onMedia?: (media: AgentMedia[]) => void,
  ): AsyncIterable<string> {
    if (!this.operator.connected) throw new Error("not connected to OpenClaw");
    const agentId = route?.agentId ?? (await this.resolveAgentId());
    // Pointed at another conversation, the turn goes there by its full key, which names its agent too.
    // A turn with a route of its own (a guest's) never follows that pointer.
    const other = route ? undefined : this.elsewhere?.();
    const sessionKey = route?.sessionKey ?? this.options.sessionKey;
    const target = other ? { sessionKey: other, ...(/^agent:([^:]+):/.exec(other)?.[1] ? { agentId: /^agent:([^:]+):/.exec(other)![1] } : {}) } : agentId ? { agentId, sessionKey } : {};
    const note = [this.note, route?.note].filter(Boolean).join("\n\n");
    // The conversation's whole key, as the gateway names it, so the run can be stopped or asked about later.
    const aimed = target as { sessionKey?: string; agentId?: string };
    const fullKey = aimed.sessionKey && aimed.agentId && !aimed.sessionKey.startsWith("agent:") ? `agent:${aimed.agentId}:${aimed.sessionKey}` : aimed.sessionKey;
    yield* this.follow(async () => {
      // A stable session key needs an explicit agent: with several agents the
      // gateway refuses a key that no agent owns.
      const send = (withNote: boolean) =>
        this.operator.request(
          "agent",
          {
            message,
            idempotencyKey: `axis-${randomUUID()}`,
            ...target,
            ...(withNote ? { extraSystemPrompt: note } : {}),
          },
          20_000,
        );
      let ack;
      try {
        ack = await send(Boolean(note) && !this.noteRefused);
      } catch (error) {
        // A gateway too old to know the note refuses the whole request. Leave the note out from then on.
        if (!note || this.noteRefused || !/extraSystemPrompt|unexpected|additional propert/i.test((error as Error).message)) throw error;
        this.noteRefused = true;
        this.options.log("the gateway refused the note to the agent; turns go without it");
        ack = await send(false);
      }
      return ack;
    }, signal, onTool, onState, (runId) => {
      if (fullKey) onRun?.({ runId, sessionKey: fullKey });
    }, (found) => {
      // Fetched later, by whoever shows it, from the gateway on the conversation's behalf.
      const agentOf = fullKey ? /^agent:([^:]+):/.exec(fullKey)?.[1] : undefined;
      onMedia?.(found.map((m) => ({ ...m, sessionKey: fullKey, agentId: agentOf ?? aimed.agentId })));
    });
  }

  /**
   * Fetches a file an agent attached to a reply: an https address directly, anything else (a path on the
   * gateway's machine) through the gateway's assistant-media route, which checks that the conversation may
   * read it and hands out a short-lived ticket for the bytes.
   */
  async fetchMedia(media: AgentMedia, maxBytes = 10 * 1024 * 1024): Promise<{ bytes: Buffer; mime: string }> {
    const read = async (res: Response) => {
      if (!res.ok) throw new Error(`the file could not be fetched (HTTP ${res.status})`);
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > maxBytes) throw new Error("the file is too large");
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error("the file is too large");
      return { bytes, mime: (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() };
    };
    if (/^https:\/\//i.test(media.source)) return read(await fetch(media.source, { signal: AbortSignal.timeout(20_000) }));
    const socket = this.url();
    const token = this.deviceToken("operator");
    if (!socket || !token) throw new Error("not paired with OpenClaw");
    const base = socket.replace(/^ws/i, "http").replace(/\/+$/, "");
    const scope = { source: media.source, ...(media.sessionKey ? { sessionKey: media.sessionKey } : {}), ...(media.agentId ? { agentId: media.agentId } : {}) };
    const meta = await fetch(`${base}/__openclaw__/assistant-media?${new URLSearchParams({ meta: "1", ...scope })}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const info = (await meta.json().catch(() => ({}))) as { available?: boolean; mediaTicket?: string; mimeType?: string };
    if (!meta.ok || !info.available || !info.mediaTicket) throw new Error(`OpenClaw would not hand over the file (HTTP ${meta.status})`);
    const file = await read(await fetch(`${base}/__openclaw__/assistant-media?${new URLSearchParams({ ...scope, mediaTicket: info.mediaTicket })}`, { signal: AbortSignal.timeout(20_000) }));
    return { bytes: file.bytes, mime: file.mime || info.mimeType || "" };
  }

  /** Where a turn with no route of its own goes: the attached conversation, or Axis's own. */
  async target(): Promise<{ sessionKey: string; agentId?: string | undefined } | undefined> {
    const other = this.elsewhere?.();
    if (other) return { sessionKey: other, agentId: /^agent:([^:]+):/.exec(other)?.[1] };
    const agentId = await this.resolveAgentId();
    return agentId ? { sessionKey: `agent:${agentId}:${this.options.sessionKey}`, agentId } : undefined;
  }

  /** Whether a conversation has a run going, which a new message would have to wait behind. */
  async activeRun(sessionKey: string): Promise<{ active: boolean; title?: string | undefined }> {
    const reply = await this.operator.request("sessions.list", { search: sessionKey.split(":").pop(), limit: 20 }, 2_000);
    const list: any[] = Array.isArray(reply?.sessions) ? reply.sessions : [];
    const session = list.find((s) => s?.key === sessionKey);
    if (!session) return { active: false };
    const title = typeof session.displayName === "string" && session.displayName ? session.displayName : typeof session.label === "string" ? session.label : undefined;
    return { active: session.hasActiveRun === true, title };
  }

  /** Stops one run. */
  async abortRun(run: { sessionKey: string; runId: string }): Promise<void> {
    await this.operator.request("chat.abort", { sessionKey: run.sessionKey, runId: run.runId });
  }

  /**
   * Has the gateway run an agent consult for a realtime Talk relay session (`talk.client.toolCall`), and
   * yields the agent's answer. The gateway keeps such a consult out of the conversation's visible turns:
   * what was said and what was answered are already there as the voice's own transcript.
   */
  consult(params: { sessionKey: string; relaySessionId: string; callId: string; args: unknown }, signal?: AbortSignal, onTool?: (name: string) => void, onState?: (state: RunState | undefined) => void): AsyncIterable<string> {
    return this.follow(() => this.operator.request("talk.client.toolCall", { ...params, name: "openclaw_agent_consult" }, 20_000), signal, onTool, onState);
  }

  /** Starts an agent run with `start`, which resolves with the gateway's acknowledgement, and yields what the run says. */
  private async *follow(start: () => Promise<any>, signal?: AbortSignal, onTool?: (name: string) => void, onState?: (state: RunState | undefined) => void, onRun?: (runId: string) => void, onMedia?: (media: MediaRef[]) => void): AsyncIterable<string> {
    const channel = new Channel<string>();
    let runId: string | undefined;
    let sent = "";
    // Lines that attach a file (MEDIA:...) are taken out here, so they are never spoken or shown as text.
    const lines = new MediaLines();
    const pass = (text: string) => {
      const kept = lines.push(text);
      if (kept) channel.push(kept);
    };
    const finish = () => {
      const rest = lines.flush();
      if (rest) channel.push(rest);
      if (lines.found.length) onMedia?.(lines.found);
      channel.end();
    };
    const early: any[] = [];

    const handle = (payload: any) => {
      // An acknowledgement without a run id leaves nothing to match on.
      if (runId && payload?.runId !== runId) return;
      const data = payload?.data ?? {};
      // A run that is held up says so on streams of their own; anything else it says means it is under way again.
      if (payload.stream === "compaction") {
        this.options.log(`agent run is ${data.phase === "start" ? "compacting its memory" : "done compacting"}`);
        return onState?.(data.phase === "start" ? "compacting" : undefined);
      }
      if (payload.stream === "run_status") {
        if (data.phase === "retrying") {
          this.options.log("agent run is retrying its provider");
          onState?.("retrying");
        }
        return;
      }
      if (payload.stream === "assistant" || payload.stream === "tool") onState?.(undefined);
      if (payload.stream === "assistant" && typeof data.text === "string") {
        // The text is the whole reply so far. Pass on only what is new.
        if (data.text.startsWith(sent)) {
          const delta = data.text.slice(sent.length);
          sent = data.text;
          if (delta) pass(delta);
        }
      } else if (payload.stream === "tool" && data.phase === "start" && typeof data.name === "string" && !data.hideFromChannelProgress) {
        // The gateway sends these to a link that declared `tool-events`, for the runs that link started.
        this.options.log(`agent picked up ${data.name}`);
        onTool?.(data.name);
      } else if (payload.stream === "lifecycle" && data.phase === "end") {
        const final = typeof data.terminalReply?.text === "string" ? data.terminalReply.text : "";
        if (final.startsWith(sent) && final.length > sent.length) pass(final.slice(sent.length));
        finish();
      } else if (payload.stream === "lifecycle" && data.phase === "error") {
        channel.end(new Error(typeof data.error === "string" ? data.error : "the agent run failed"));
      }
    };
    // Events can arrive before the request is acknowledged with its run id.
    const listener = (payload: any) => (runId === undefined ? early.push(payload) : handle(payload));
    this.agentListeners.add(listener);

    const timeout = setTimeout(
      () => channel.end(new Error("the agent accepted the turn but did not finish in time")),
      // A long run is handed over by the turn (see background.ts) and followed here until it ends, within reason.
      this.options.replyTimeoutMs ?? 30 * 60_000,
    );
    const onAbort = () => channel.end();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const ack = await start();
      runId = typeof ack?.runId === "string" ? ack.runId : "";
      if (runId) onRun?.(runId);
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
