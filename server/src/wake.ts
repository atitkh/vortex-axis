export interface WakeReport {
  clientId: string;
  wakeId: string;
  /** Detection confidence, 0 to 1. */
  score: number;
  /** Loudness over the device's own room noise, 0 to 1. Among scores close to the best, the loudest wins. */
  level: number;
}

/** How a contested wake word was settled. */
export interface WakeDecision {
  /** Reports whose score was within the margin of the best. */
  candidates: number;
  /** The margin used, 0 to 0.5. */
  margin: number;
  /** True when loudness chose a device other than the best-scoring one. */
  byLoudness: boolean;
}

export interface WakeArbiterOptions {
  /** How long to wait for other clients to report the same wake word. */
  windowMs: number;
  /** How many clients could have heard it. With one or none there is nothing to arbitrate. */
  listeners: () => number;
  /** Called once per report with the outcome. */
  decide: (report: WakeReport, granted: boolean) => void;
  /**
   * How far below the best score (0 to 0.5) a report may be and still win by being louder.
   * Read at each decision. 0, or none given, picks the best score with loudness breaking ties.
   */
  margin?: () => number;
  /** Called once when more than one client reported the same wake word, with all of them and the one chosen. */
  contested?: (reports: WakeReport[], winner: WakeReport, decision: WakeDecision) => void;
}

/** Best score first, then louder. */
const better = (a: WakeReport, b: WakeReport) => a.score > b.score || (a.score === b.score && a.level > b.level);
/** Louder first, then better score. */
const louder = (a: WakeReport, b: WakeReport) => a.level > b.level || (a.level === b.level && a.score > b.score);

/**
 * The one to answer: every report scoring within `margin` of the best is a
 * candidate, and the loudest candidate wins (ties by score). A device farther
 * away can score a little higher on the wake word yet hear what follows worse;
 * the nearest one hears it loudest. Reports further below can never win.
 */
export function chooseWake(reports: WakeReport[], margin: number): { winner: WakeReport; decision: WakeDecision } {
  const best = reports.reduce((b, r) => (better(r, b) ? r : b));
  const m = Math.min(0.5, Math.max(0, Number.isFinite(margin) ? margin : 0));
  // A little slack so a margin of 0.10 keeps a score exactly 10 points down despite floating point.
  const candidates = reports.filter((r) => r.score >= best.score - m - 1e-9);
  const winner = m > 0 ? candidates.reduce((w, r) => (louder(r, w) ? r : w)) : best;
  return { winner, decision: { candidates: candidates.length, margin: m, byLoudness: winner.score < best.score } };
}

/**
 * Picks one client when several hear the wake word at once. The first report
 * opens a short window; when it closes, one client is granted (`chooseWake`)
 * and the rest are told to stand down.
 */
export class WakeArbiter {
  private reports: WakeReport[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly granted = new Map<string, string>();

  constructor(private readonly options: WakeArbiterOptions) {}

  report(report: WakeReport): void {
    if (!this.timer && this.options.listeners() <= 1) {
      this.settle([report]);
      return;
    }
    // A client reporting twice in one window replaces its earlier report.
    const earlier = this.reports.findIndex((r) => r.clientId === report.clientId);
    if (earlier >= 0) {
      this.options.decide(this.reports[earlier]!, false);
      this.reports.splice(earlier, 1);
    }
    this.reports.push(report);
    this.timer ??= setTimeout(() => this.close(), this.options.windowMs);
  }

  /** True when this client holds a grant for this wake. Spends the grant. */
  consume(clientId: string, wakeId: string): boolean {
    if (this.granted.get(clientId) !== wakeId) return false;
    this.granted.delete(clientId);
    return true;
  }

  /** Forgets a client that disconnected. */
  forget(clientId: string): void {
    this.granted.delete(clientId);
    this.reports = this.reports.filter((r) => r.clientId !== clientId);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.reports = [];
    this.granted.clear();
  }

  private close(): void {
    this.timer = undefined;
    const reports = this.reports;
    this.reports = [];
    this.settle(reports);
  }

  private settle(reports: WakeReport[]): void {
    if (reports.length === 0) return;
    const { winner, decision } = chooseWake(reports, this.options.margin?.() ?? 0);
    this.granted.set(winner.clientId, winner.wakeId);
    for (const report of reports) this.options.decide(report, report === winner);
    if (reports.length > 1) this.options.contested?.(reports, winner, decision);
  }
}
