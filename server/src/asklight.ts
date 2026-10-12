import type { Hub, Session } from "./hub.js";

/**
 * Tells every screen how many questions wait for the person somewhere it is
 * not showing them: on another device, or on none (an OpenClaw agent's
 * question the device gave up on while the gateway still waits). A board
 * pulses its edges blue while there are any, so a question asked at the desk
 * is noticed from the kitchen. Each screen is told only when its number changes.
 */
export class AskLight {
  private readonly told = new Map<string, number>();

  constructor(
    private readonly hub: Hub,
    /** Questions waiting on no device right now. */
    private readonly unshown: () => number = () => 0,
  ) {
    hub.onConnect((session) => {
      this.told.delete(session.client.id);
      this.tell(session);
    });
    hub.onAsksChange(() => this.refresh());
  }

  /** Works the numbers out again and tells the screens whose number changed. */
  refresh(): void {
    for (const session of this.hub.sessions()) this.tell(session);
  }

  /** How many wait where `clientId` is not showing them. */
  elsewhere(clientId: string): number {
    const asking = this.hub.askingClients();
    return asking.filter((id) => id !== clientId).length + this.unshown();
  }

  private tell(session: Session): void {
    if (!session.client.capabilities.includes("screen")) return;
    const elsewhere = this.elsewhere(session.client.id);
    // A screen that has never been told assumes none.
    if ((this.told.get(session.client.id) ?? 0) === elsewhere) return;
    this.told.set(session.client.id, elsewhere);
    // A client that does not know the command says so; nothing to do about that.
    this.hub.command(session, "ask.waiting", { elsewhere }, 3000).catch(() => undefined);
  }
}
