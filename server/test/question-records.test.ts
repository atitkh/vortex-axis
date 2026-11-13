import { describe, expect, it } from "vitest";
import type { TextToSpeech } from "../src/speech.js";
import { connect, ctx, newPairedClient, restart, useServer } from "./harness.js";

const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  synthesize: () =>
    (async function* () {
      yield Buffer.alloc(400, 1);
    })(),
  healthy: async () => true,
};
useServer(() => ({ tts }));

describe("questions kept as ask notifications", () => {
  it("an agent question shown on a device (Away off) is recorded with its answer", async () => {
    await restart({ mirrorQuestions: true }, { tts });
    const capabilities = ["screen", "speaker", "mic"] as const;
    const identity = await newPairedClient({ capabilities: [...capabilities], type: "board", name: "Desk" });
    const desk = await connect(identity, { capabilities: [...capabilities], type: "board" });
    await desk.next("status");
    const gateway = ctx.app.gateway as unknown as { eventListeners: Set<(event: string, payload: any) => void> };
    for (const listener of gateway.eventListeners)
      listener("question.requested", {
        id: "q-live",
        expiresAtMs: Date.now() + 60_000,
        questions: [{ questionId: "a", question: "Ship it today?", options: [{ label: "Yes" }, { label: "No" }] }],
      });
    // The question is spoken first; once heard, the choices show.
    const start = await desk.next("speak.start");
    await desk.next("speak.end", 0, (m) => m.turnId === start.turnId);
    desk.send({ t: "playback", turnId: start.turnId, state: "finished" });
    const ask = await desk.next("ask");
    desk.send({ t: "answer", askId: ask.askId, choice: "Yes" });
    await expect.poll(() => ctx.app.store.listNotifications({}).find((n) => n.body === "Ship it today?")?.status, { timeout: 5000 }).toBe("answered");
    expect(ctx.app.store.listNotifications({}).find((n) => n.body === "Ship it today?")).toMatchObject({ source: "ask", sourceName: "agent-ask", clientId: identity.clientId, answer: "Yes" });
  });
});
