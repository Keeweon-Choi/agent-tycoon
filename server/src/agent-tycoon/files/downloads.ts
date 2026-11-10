import { randomBytes } from 'node:crypto';

import { EXTERNAL_TICKET_MAX_MS } from '../../constants.js';

export interface Ticket {
  session: string;
  project: string;
  root?: string;
  task?: string;
  path: string;
  mode: 'preview' | 'download';
  /** A player asks for the same URL many times (iOS Safari probes, then fetches ranges): not used up by a request. */
  reusable?: boolean;
  /**
   * DESKTOP-ACTIONS: an 'open' ticket, which the desktop app hands to the default browser. That
   * browser has no session cookie, so the ticket stands for the session that minted it (`session`,
   * looked up again on every use) and never lives past EXTERNAL_TICKET_MAX_MS from its mint.
   */
  external?: boolean;
  expires: number;
  /** The hard end of an external ticket, whatever a reusable ticket's idle extension says. */
  deadline?: number;
}

/** A reusable ticket stays good this long after its last request. */
export const REUSABLE_TICKET_IDLE_MS = 10 * 60_000;

/** Consume before opening the file: a concurrent second request cannot reuse it. */
export class DownloadTickets {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly now = Date.now) {}

  mint(ticket: Omit<Ticket, 'expires' | 'deadline'>): string {
    for (const [key, value] of this.tickets)
      if (value.expires <= this.now()) this.tickets.delete(key);
    const key = randomBytes(24).toString('base64url');
    this.tickets.set(key, {
      ...ticket,
      expires: this.now() + 60_000,
      ...(ticket.external && { deadline: this.now() + EXTERNAL_TICKET_MAX_MS }),
    });
    return key;
  }

  /** The minting session's hash of a live external ticket (the caller checks that session is still live). */
  externalSession(key: string): string | undefined {
    const ticket = this.tickets.get(key);
    return ticket?.external && ticket.expires > this.now() ? ticket.session : undefined;
  }

  consume(key: string, session: string): Ticket | null {
    const ticket = this.tickets.get(key);
    if (!ticket?.reusable) this.tickets.delete(key);
    const good = ticket && ticket.session === session && ticket.expires > this.now();
    if (good && ticket.reusable)
      ticket.expires = Math.min(this.now() + REUSABLE_TICKET_IDLE_MS, ticket.deadline ?? Infinity);
    return good ? ticket : null;
  }
}
