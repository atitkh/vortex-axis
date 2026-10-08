export interface WakeReport {
  clientId: string;
  wakeId: string;
  /** Detection confidence, 0 to 1. */
  score: number;
  /** Loudness, 0 to 1. Breaks ties. */
  level: number;
}

export interface WakeArbiterOptions {
  /** How long to wait for other clients to report the same wake word. */
  windowMs: number;
  /** How many clients could have heard it. With one or none there is nothing to arbitrate. */
  listeners: () => number;
  /** Called once per report with the outcome. */
  decide: (report: WakeReport, granted: boolean) => void;
}

/**
 * Picks one client when several hear the wake word at once. The first report
 * opens a short window; when it closes, the best-scoring client is granted
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
    const winner = reports.reduce((best, r) =>
      r.score > best.score || (r.score === best.score && r.level > best.level) ? r : best,
    );
    this.granted.set(winner.clientId, winner.wakeId);
    for (const report of reports) this.options.decide(report, report === winner);
  }
}
