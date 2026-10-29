import { drain } from "./drain.js";

/** Why an agent's run is not getting on with the answer, when it says. */
export type RunState = "compacting" | "retrying";

/**
 * Where one turn goes when it is not the usual place: a guest's turn goes to a
 * conversation of its own, maybe another agent's, with a note of its own.
 */
export interface AgentRoute {
  /** For an OpenClaw gateway: the agent. Absent: the usual one. */
  agentId?: string | undefined;
  /** The conversation. Absent: the usual one. */
  sessionKey?: string | undefined;
  /** Added after the usual note or system prompt. */
  note?: string | undefined;
}

/** A file an agent attached to a reply, and the conversation it came from (to fetch it on its behalf). */
export interface AgentMedia {
  source: string;
  sessionKey?: string | undefined;
  agentId?: string | undefined;
}

export interface Agent {
  /**
   * Sends one message to the agent and yields its reply as text pieces. An agent that says which
   * tools it picks up on the way calls `onTool` with each one's name; most do not. One that says when
   * its run is held up calls `onState` with why (`compacting` its memory, `retrying` a provider that
   * failed), and with nothing when it is under way again. `route` sends this one turn somewhere else.
   * One whose runs can be told apart calls `onRun` with the run and its conversation once it has started.
   * One whose replies can attach files leaves them out of the text and calls `onMedia` with them at the end.
   */
  reply(
    message: string,
    signal?: AbortSignal,
    onTool?: (name: string) => void,
    onState?: (state: RunState | undefined) => void,
    route?: AgentRoute,
    onRun?: (run: { runId: string; sessionKey: string }) => void,
    onMedia?: (media: AgentMedia[]) => void,
  ): AsyncIterable<string>;
  /** For an agent whose replies can carry files: fetches one it named. */
  fetchMedia?(media: AgentMedia): Promise<{ bytes: Buffer; mime: string }>;
  /** For an agent with conversations: the one a turn with no route of its own goes to, and its agent. */
  target?(): Promise<{ sessionKey: string; agentId?: string | undefined } | undefined>;
  /** For an agent with conversations: whether one is in the middle of a run, so a new message would wait behind it. */
  activeRun?(sessionKey: string): Promise<{ active: boolean; title?: string | undefined }>;
  /** Stops a run. */
  abortRun?(run: { sessionKey: string; runId: string }): Promise<void>;
  healthy(): Promise<boolean>;
  /**
   * For an agent behind an OpenClaw gateway: does the work a realtime voice session has handed over, the
   * gateway's own way, which keeps it out of the conversation's visible turns. Yields the answer.
   */
  consult?(params: { sessionKey: string; relaySessionId: string; callId: string; args: unknown }, signal?: AbortSignal, onTool?: (name: string) => void, onState?: (state: RunState | undefined) => void): AsyncIterable<string>;
  /** For an agent with a prompt of its own: a note added to it for turns from Axis. */
  setNote?(note: string): void;
}

export interface ChatAgentOptions {
  /** Full URL of an OpenAI-style chat completions endpoint. */
  url: string;
  /** Model name. For an OpenClaw gateway this names the agent, for example "openclaw". */
  model: string;
  token?: string | undefined;
  /** Sent ahead of every message as the system message. Empty means none. */
  systemPrompt?: string | undefined;
  /**
   * Keeps every turn in one conversation. Sent as the OpenClaw session header
   * and as the OpenAI `user` field, so other backends can use it too.
   */
  sessionKey?: string | undefined;
}

/**
 * What a plain chat endpoint is told when no prompt of the admin's own is set.
 * An OpenClaw agent has its own prompt and is never sent this.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are Vortex, a voice assistant. People talk to you through small devices around the home, and your reply is spoken aloud on the device they used.",
  "",
  "Every message starts with one line in square brackets that describes that device, for example:",
  "[from: Desk, type: waveshare-amoled-1.8, location: office, can: screen+speaker+mic]",
  "from is the device's name, location is where it is, and can lists what it has: mic (it heard the person speak), speaker (your reply is read aloud), screen (your reply is also shown as text), images or image-frames (it can show pictures: put one up with vortex_axis_show). The person's words follow on the next line. Never read the bracketed line back or mention it.",
  "",
  "How to answer:",
  "- Talk the way a person does out loud, not the way one writes. Lead with the answer, in one or two short sentences, and stop; offer more in a few words instead of saying it all.",
  "- Use contractions and everyday words. A small spoken touch now and then is welcome where it fits, like \"yep\", \"so\" or \"hmm\", but never open with praise or a filler such as \"Sure!\".",
  "- No markdown, lists, headings, emoji, code or web addresses, because every character is read aloud.",
  "- Spell out numbers, units and abbreviations the way they are spoken.",
  "- When the device has no speaker, the reply is only shown on a small screen, so keep it even shorter.",
  "- The words come from speech recognition and may contain mistakes. Go with the most likely meaning, and ask a short question when you cannot tell.",
  "- If you have tools whose names start with vortex_axis_ (the VorteX Axis MCP server), use them to act on the devices: speak on another one, show a picture, ask a question with choices, set timers. Pass the device's name from the bracketed line as client.",
  "- Without a tool for something (timers, controlling devices, looking things up), say plainly that you cannot do it instead of pretending.",
].join("\n");

/**
 * What an OpenClaw agent is told on top of its own prompt, when no note of the
 * admin's own is set. It only adds what the agent cannot know by itself: that
 * this turn is spoken, where it came from, and that Axis's tools reach the
 * devices. Keep it the same from turn to turn: OpenClaw starts a fresh model
 * process when the system prompt changes, so nothing that differs per turn
 * belongs here (that is what the bracketed line is for).
 */
export const DEFAULT_GATEWAY_NOTE = [
  "This turn comes through VorteX Axis, the user's voice hub. You are speaking as Vortex, their voice assistant: your reply is read aloud, and shown as text, on the device they just used.",
  "The message starts with one bracketed line describing that device: its name (from), where it is (location) and what it has (can). It is one of several devices. Do not read that line back.",
  "Talk the way a person does out loud, not the way one writes. Lead with the answer, in one or two short sentences, and stop; if there is more worth knowing, offer it in a few words instead of saying it all. Use contractions and everyday words. A small spoken touch now and then is welcome where it fits, like \"yep\", \"so\", \"hmm\" or \"right now\", but never open with praise or a filler such as \"Sure!\" or \"Great question\", and never read out a list. Say numbers, times and units as they are spoken, rounded unless exactness was asked for. No markdown, lists, headings or emoji.",
  "The words come from speech recognition and may contain mistakes: go with the likeliest meaning.",
  "To act on the devices (speak elsewhere, show a picture on a screen that has images or image-frames in can, ask with choices, timers, list or configure them), use the node named VorteX Axis; describe it to see its commands and their fields. With no target, a command goes to the device the user last spoke to.",
  "To stay silent, reply with exactly NO_REPLY.",
].join("\n");

/**
 * Talks to the agent through an OpenAI-style streaming chat endpoint. An
 * OpenClaw gateway serves one, and so do most local model servers, which keeps
 * the agent swappable.
 */
export class ChatCompletionsAgent implements Agent {
  constructor(private readonly options: ChatAgentOptions) {}

  private headers(sessionKey = this.options.sessionKey): Record<string, string> {
    return {
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      ...(sessionKey ? { "x-openclaw-session-key": sessionKey } : {}),
    };
  }

  async *reply(message: string, signal?: AbortSignal, _onTool?: unknown, _onState?: unknown, route?: AgentRoute): AsyncIterable<string> {
    const sessionKey = route?.sessionKey ?? this.options.sessionKey;
    const system = [this.options.systemPrompt, route?.note].filter(Boolean).join("\n\n");
    const res = await fetch(this.options.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...this.headers(sessionKey) },
      body: JSON.stringify({
        model: this.options.model,
        stream: true,
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: message }],
        ...(sessionKey ? { user: sessionKey } : {}),
      }),
      signal: signal ?? null,
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(`agent answered HTTP ${res.status}`);
    }

    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of drain(res.body)) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        const text = deltaText(data);
        if (text) yield text;
      }
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const url = new URL("/v1/models", this.options.url);
      const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(3000) });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  }
}

function deltaText(data: string): string {
  try {
    const event = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
    const content = event.choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}
