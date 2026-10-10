import { drain } from "./drain.js";

export interface Agent {
  /** Sends one message to the agent and yields its reply as text pieces. */
  reply(message: string, signal?: AbortSignal): AsyncIterable<string>;
  healthy(): Promise<boolean>;
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
  "from is the device's name, location is where it is, and can lists what it has: mic (it heard the person speak), speaker (your reply is read aloud), screen (your reply is also shown as text). The person's words follow on the next line. Never read the bracketed line back or mention it.",
  "",
  "How to answer:",
  "- Keep it short: one to three sentences unless asked for more.",
  "- Write plain sentences the way you would say them. No markdown, lists, headings, emoji, code or web addresses, because every character is read aloud.",
  "- Spell out numbers, units and abbreviations the way they are spoken.",
  "- When the device has no speaker, the reply is only shown on a small screen, so keep it even shorter.",
  "- The words come from speech recognition and may contain mistakes. Go with the most likely meaning, and ask a short question when you cannot tell.",
  "- If you have tools whose names start with vortex_axis_ (the VorteX Axis MCP server), use them to act on the devices: speak on another one, ask a question with choices, set timers. Pass the device's name from the bracketed line as client.",
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
  "Reply the way you would speak: short, plain sentences, no markdown, lists or emoji. The words come from speech recognition and may contain mistakes.",
  "To act on the devices (speak elsewhere, ask with choices, timers, list or configure them), use the node named VorteX Axis; describe it to see its commands and their fields. With no target, a command goes to the device the user last spoke to.",
  "To stay silent, reply with exactly NO_REPLY.",
].join("\n");

/**
 * Talks to the agent through an OpenAI-style streaming chat endpoint. An
 * OpenClaw gateway serves one, and so do most local model servers, which keeps
 * the agent swappable.
 */
export class ChatCompletionsAgent implements Agent {
  constructor(private readonly options: ChatAgentOptions) {}

  private headers(): Record<string, string> {
    return {
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      ...(this.options.sessionKey ? { "x-openclaw-session-key": this.options.sessionKey } : {}),
    };
  }

  async *reply(message: string, signal?: AbortSignal): AsyncIterable<string> {
    const res = await fetch(this.options.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...this.headers() },
      body: JSON.stringify({
        model: this.options.model,
        stream: true,
        messages: [
          ...(this.options.systemPrompt ? [{ role: "system", content: this.options.systemPrompt }] : []),
          { role: "user", content: message },
        ],
        ...(this.options.sessionKey ? { user: this.options.sessionKey } : {}),
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
