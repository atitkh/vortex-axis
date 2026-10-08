import { drain } from "./drain.js";

export interface Agent {
  /** Sends one message to the agent and yields its reply as text pieces. */
  reply(message: string, signal?: AbortSignal): AsyncIterable<string>;
  healthy(): Promise<boolean>;
}

export interface ChatAgentOptions {
  /** Full URL of an OpenAI-style chat completions endpoint. */
  url: string;
  /** Model name. For an OpenClaw gateway this names the agent, for example "openclaw". */
  model: string;
  token?: string | undefined;
  /**
   * Keeps every turn in one conversation. Sent as the OpenClaw session header
   * and as the OpenAI `user` field, so other backends can use it too.
   */
  sessionKey?: string | undefined;
}

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
        messages: [{ role: "user", content: message }],
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
