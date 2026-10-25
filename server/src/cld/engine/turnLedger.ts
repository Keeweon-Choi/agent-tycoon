/**
 * C3: which channel the turn a session is in belongs to, as the messenger knows it. The
 * messenger types every message into a session and knows exactly what it typed and when; a
 * transcript is only evidence of that afterwards. So this record is written at the moment of
 * typing and is what the DM view's room-turn hiding, the contact's `room`, the turn-end push and
 * the on-screen notice all read. The header of a transcript's user turn (roomOfPrompt) decides
 * only for turns the messenger did not type: old records, a daemon that restarted mid-turn.
 *
 * Memory only: a restart forgets it and the fallback takes over.
 */
import type { RoomRef } from '../transcriptView.js';

/** A typed message whose turn the transcript has not shown yet counts as the agent's turn this long. */
export const TURN_PENDING_MS = 60_000;
/** Delivery ids remembered (the DM view looks a turn up by the mark in its header). */
export const TURN_DELIVERIES_MAX = 500;

interface Typed {
  deliveryId?: string;
  room: RoomRef | null;
  at: number;
  /** A tail has read the user turn that carries `deliveryId`. */
  seen: boolean;
}

export class TurnLedger {
  private readonly latest = new Map<string, Typed>();
  /** delivery id → the room it was a delivery for (null: typed as a one-to-one message); oldest first. */
  private readonly deliveries = new Map<string, RoomRef | null>();
  /** An agent's record changed: the contacts are sent again at once (a turn can end within a poll). */
  onChange?: (agent: string) => void;

  constructor(private readonly now: () => number = Date.now) {}

  /** The messenger just typed `item` into `agent`'s session: its turn starts here. */
  typed(
    agent: string,
    item: {
      messageId?: string;
      inbox?: string[];
      group?: { roomId: string; roomName: string; messageId: string };
    },
  ): void {
    // The start hook's joined inbox files are several messages in one turn: the transcript decides.
    if (item.inbox) {
      this.latest.delete(agent);
    } else {
      const room: RoomRef | null = item.group
        ? { id: item.group.roomId, name: item.group.roomName, post: item.group.messageId }
        : null;
      if (item.messageId) {
        this.deliveries.delete(item.messageId);
        this.deliveries.set(item.messageId, room);
        for (const old of this.deliveries.keys()) {
          if (this.deliveries.size <= TURN_DELIVERIES_MAX) break;
          this.deliveries.delete(old);
        }
      }
      this.latest.set(agent, {
        ...(item.messageId && { deliveryId: item.messageId }),
        room,
        at: this.now(),
        seen: false,
      });
    }
    this.onChange?.(agent);
  }

  /** What the messenger typed under this delivery id: its room, null for a DM, undefined if unknown. */
  classify(deliveryId: string | undefined): RoomRef | null | undefined {
    return deliveryId === undefined ? undefined : this.deliveries.get(deliveryId);
  }

  /** A tail read the user turn marked `deliveryId` in `agent`'s transcript. */
  seen(agent: string, deliveryId: string | undefined): void {
    const last = this.latest.get(agent);
    if (last && deliveryId !== undefined && last.deliveryId === deliveryId) last.seen = true;
  }

  /**
   * The newest turn the messenger typed, while the transcript has not shown it yet (and for at
   * most TURN_PENDING_MS): `{ room }` is its room, or null for a one-to-one message. Undefined
   * once a tail has read that turn (the transcript, classified by this record, says it then).
   */
  unseen(agent: string): { room: RoomRef | null } | undefined {
    const last = this.latest.get(agent);
    return last && !last.seen && this.now() - last.at < TURN_PENDING_MS
      ? { room: last.room }
      : undefined;
  }

  /**
   * The newest turn the messenger typed into `agent`: its room (null: a one-to-one message), or
   * undefined when it typed nothing this run (the caller falls back to the transcript).
   */
  current(agent: string): RoomRef | null | undefined {
    return this.latest.get(agent)?.room;
  }
}
