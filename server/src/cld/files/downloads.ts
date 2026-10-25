import { randomBytes } from 'node:crypto';

export interface Ticket {
  session: string;
  project: string;
  root?: string;
  path: string;
  mode: 'preview' | 'download';
  expires: number;
}

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
    this.tickets.delete(key);
    return ticket && ticket.session === session && ticket.expires > this.now() ? ticket : null;
  }
}
