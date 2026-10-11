import { describe, expect, it } from "vitest";
import { Progress } from "../src/progress.js";

describe("the task line", () => {
  it("tells the screens a finished task is gone, whoever notices first", async () => {
    let now = 1_000_000;
    const shown: Record<string, unknown>[] = [];
    const screen = { client: { capabilities: ["screen"], id: "c" } };
    const hub = {
      onConnect: () => undefined,
      sessions: () => [screen],
      quiet: () => false,
      command: async (_s: unknown, _name: string, params: Record<string, unknown>) => void shown.push(params),
    };
    const progress = new Progress(hub as never, { now: () => now });
    progress.update({ id: "t", title: "Backup", state: "done" });
    expect(shown.at(-1)).toMatchObject({ title: "Backup", state: "done" });

    // Long after it finished, something only looks at the list (the live activities do, every few seconds).
    now += 120_000;
    expect(progress.list()).toEqual([]);
    await Promise.resolve();
    expect(shown.at(-1)).toMatchObject({ title: "", state: "none", count: 0 });
  });
});
