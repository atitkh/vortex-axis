import type { Activity } from "./activity.js";

/** Wrong credentials from one address before it is shut out. */
export const ADMIN_FAILURES = 10;
/** How long an address stays shut out. */
export const ADMIN_LOCK_MS = 5 * 60_000;

class LockedOut extends Error {
  readonly status = 429;
}

/** Wrong credentials per address for one door; ten shut that address out of that door for five minutes. */
export class Lockout {
  private readonly failures = new Map<string, { count: number; until: number }>();

  /**
   * @param what  what was wrong, as said in the activity note ("agent tokens")
   * @param error turns the refusal message into the error to throw (the HTTP layer's 429)
   */
  constructor(
    private readonly what: string,
    private readonly now: () => number,
    private readonly activity: Activity | undefined,
    private readonly error: (status: number, message: string) => Error = (_status, message) => new LockedOut(message),
  ) {}

  /** Throws 429 while the address is shut out; a lock that ran out is forgotten. */
  check(address: string): void {
    const locked = this.failures.get(address);
    if (locked && locked.count >= ADMIN_FAILURES) {
      if (this.now() < locked.until) throw this.error(429, "too many wrong tokens from this address, wait five minutes");
      this.failures.delete(address);
    }
  }

  /** Counts one wrong credential from the address. */
  fail(address: string): void {
    const failed = this.failures.get(address) ?? { count: 0, until: 0 };
    failed.count += 1;
    failed.until = this.now() + ADMIN_LOCK_MS;
    this.failures.set(address, failed);
    if (failed.count === ADMIN_FAILURES) this.activity?.note("admin", "", `Ten wrong ${this.what} from ${address}; that address is shut out for five minutes`, "warn");
    if (this.failures.size > 5000) this.failures.clear();
  }

  /** A right credential: the address starts again from nothing. */
  clear(address: string): void {
    this.failures.delete(address);
  }
}
