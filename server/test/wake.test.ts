import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeArbiter, chooseWake, type WakeReport } from "../src/wake.js";

const r = (clientId: string, score: number, level: number): WakeReport => ({ clientId, wakeId: `w-${clientId}`, score, level });

describe("chooseWake", () => {
  it("with margin 0 picks the best score, loudness only breaking ties (the old rule)", () => {
    const reports = [r("far", 0.95, 0.02), r("near", 0.94, 0.9), r("mid", 0.95, 0.05)];
    const { winner, decision } = chooseWake(reports, 0);
    expect(winner.clientId).toBe("mid");
    expect(decision.byLoudness).toBe(false);
  });

  it("lets the loudest of the close scores win", () => {
    const { winner, decision } = chooseWake([r("a", 0.95, 0.02), r("b", 0.92, 0.04), r("c", 0.93, 0.06)], 0.1);
    expect(winner.clientId).toBe("c");
    expect(decision).toEqual({ candidates: 3, margin: 0.1, byLoudness: true });
  });

  it("never lets a far worse score win, however loud", () => {
    const { winner, decision } = chooseWake([r("sure", 0.95, 0.1), r("loud", 0.8, 1)], 0.1);
    expect(winner.clientId).toBe("sure");
    expect(decision).toMatchObject({ candidates: 1, byLoudness: false });
  });

  it("keeps a score exactly at the margin", () => {
    expect(chooseWake([r("a", 0.95, 0.1), r("b", 0.85, 0.5)], 0.1).winner.clientId).toBe("b");
  });

  it("takes a single report", () => {
    expect(chooseWake([r("only", 0.6, 0)], 0.1)).toEqual({ winner: r("only", 0.6, 0), decision: { candidates: 1, margin: 0.1, byLoudness: false } });
  });

  it("breaks an equal loudness on score, and a full tie by order", () => {
    expect(chooseWake([r("a", 0.9, 0.5), r("b", 0.95, 0.5)], 0.1).winner.clientId).toBe("b");
    expect(chooseWake([r("a", 0.9, 0.5), r("b", 0.9, 0.5)], 0.1).winner.clientId).toBe("a");
  });

  it("clamps the margin to 0..0.5", () => {
    expect(chooseWake([r("a", 0.95, 0), r("b", 0.3, 1)], 5).decision.margin).toBe(0.5);
    expect(chooseWake([r("a", 0.95, 0), r("b", 0.94, 1)], -1).winner.clientId).toBe("a");
  });
});

describe("WakeArbiter", () => {
  afterEach(() => vi.useRealTimers());

  it("reads the margin when the window closes and reports how it decided", () => {
    vi.useFakeTimers();
    let margin = 0;
    const granted: string[] = [];
    const contested = vi.fn();
    const arbiter = new WakeArbiter({
      windowMs: 200,
      listeners: () => 2,
      margin: () => margin,
      decide: (report, ok) => ok && granted.push(report.clientId),
      contested,
    });
    arbiter.report(r("far", 0.95, 0.02));
    arbiter.report(r("near", 0.93, 0.3));
    margin = 0.1;
    vi.advanceTimersByTime(200);
    expect(granted).toEqual(["near"]);
    expect(contested.mock.calls[0]![2]).toEqual({ candidates: 2, margin: 0.1, byLoudness: true });
    expect(arbiter.consume("near", "w-near")).toBe(true);
    arbiter.stop();
  });

  it("without a margin behaves as before", () => {
    vi.useFakeTimers();
    const granted: string[] = [];
    const arbiter = new WakeArbiter({ windowMs: 200, listeners: () => 2, decide: (report, ok) => ok && granted.push(report.clientId) });
    arbiter.report(r("far", 0.95, 0.02));
    arbiter.report(r("near", 0.93, 0.3));
    vi.advanceTimersByTime(200);
    expect(granted).toEqual(["far"]);
    arbiter.stop();
  });
});
