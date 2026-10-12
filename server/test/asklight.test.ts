import { describe, expect, it } from "vitest";
import { AskLight } from "../src/asklight.js";

describe("the question light", () => {
  it("tells each screen how many questions wait where it is not showing them, only when that changes", () => {
    const told: { id: string; elsewhere: unknown }[] = [];
    const desk = { client: { id: "desk", capabilities: ["screen", "mic"] } };
    const kitchen = { client: { id: "kitchen", capabilities: ["screen"] } };
    const speaker = { client: { id: "speaker", capabilities: ["speaker"] } };
    let asking: string[] = [];
    let unshown = 0;
    const askListeners: (() => void)[] = [];
    const connectListeners: ((s: unknown) => void)[] = [];
    const hub = {
      onConnect: (listener: (s: unknown) => void) => connectListeners.push(listener),
      onAsksChange: (listener: () => void) => askListeners.push(listener),
      askingClients: () => asking,
      sessions: () => [desk, kitchen, speaker],
      command: async (session: typeof desk, _name: string, params: Record<string, unknown>) =>
        void told.push({ id: session.client.id, elsewhere: params.elsewhere }),
    };
    const light = new AskLight(hub as never, () => unshown);

    // A question opens on the desk: only the kitchen hears of it; the speaker has no screen.
    asking = ["desk"];
    askListeners.forEach((l) => l());
    expect(told).toEqual([{ id: "kitchen", elsewhere: 1 }]);

    // The desk gives up on it but the agent still waits: now it waits on no device, so both glow.
    asking = [];
    unshown = 1;
    light.refresh();
    expect(told.slice(1)).toEqual([{ id: "desk", elsewhere: 1 }]);

    // Settled: both told it is over.
    unshown = 0;
    light.refresh();
    expect(told.slice(2)).toEqual([
      { id: "desk", elsewhere: 0 },
      { id: "kitchen", elsewhere: 0 },
    ]);

    // A screen that connects while something waits is told at once.
    asking = ["desk"];
    told.length = 0;
    connectListeners.forEach((l) => l(kitchen));
    expect(told).toEqual([{ id: "kitchen", elsewhere: 1 }]);
  });
});
