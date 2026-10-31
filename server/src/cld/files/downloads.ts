import { randomBytes } from 'node:crypto';

export interface Ticket {
  session: string;
  project: string;
  root?: string;
  task?: string;
  path: string;
  mode: 'preview' | 'download';
  /** A player asks for the same URL many times (iOS Safari probes, then fetches ranges): not used up by a request. */
  reusable?: boolean;
  expires: number;
}

/** A reusable ticket stays good this long after its last request. */
export const REUSABLE_TICKET_IDLE_MS = 10 * 60_000;

/** Consume before opening the file: a concurrent second request cannot reuse it. */
export class DownloadTickets {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly now = Date.now) {}

  mint(ticket: Omit<Ticket, 'expires'>): string {
    for (const [key, value] of this.tickets)
      if (value.expires <= this.now()) this.tickets.delete(key);
    const key = randomBytes(24).toString('base64url');
    this.tickets.set(key, { ...ticket, expires: this.now() + 60_000 });
    return key;
  }

  consume(key: string, session: string): Ticket | null {
    const ticket = this.tickets.get(key);
    if (!ticket?.reusable) this.tickets.delete(key);
    const good = ticket && ticket.session === session && ticket.expires > this.now();
    if (good && ticket.reusable) ticket.expires = this.now() + REUSABLE_TICKET_IDLE_MS;
    return good ? ticket : null;
  }
}
