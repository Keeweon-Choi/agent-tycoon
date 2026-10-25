/**
 * C3: the room list's summary per room (preview, last time, and the ids the client counts as
 * unread: the posts and each member's text reply), kept incrementally.
 *
 * Building one reads the end of each member's transcript once (groupMessages roomTranscript, at
 * most ROOM_SCAN_MAX_BYTES; PERF-ROOM). That is done once per room (when
 * the list is first sent, and when a post or delivery changes that room). A member's reply
 * that the transcript tails read afterwards is ADDED here without reading anything, and a room
 * is sent again at most once per ROOM_PUBLISH_MS.
 */
import type { GroupRoom } from '../../../core/src/messages.js';
import type { RoomReplyRead } from './conversations.js';
import type { RoomReply } from './transcriptView.js';

/** A room's summary is sent again at most this often while its members' replies stream in. */
export const ROOM_PUBLISH_MS = 2_000;

export interface RoomSummary {
  preview?: string;
  lastAt?: number;
  updates: string[];
}

interface Held {
  summary: RoomSummary;
  ids: Set<string>;
}

export class RoomSummaries {
  private readonly held = new Map<string, Held>();
  private readonly lastSent = new Map<string, number>();
  private readonly dirty = new Set<string>();

  constructor(
    /** The expensive one: reads the transcripts. Called once per room until it is invalidated. */
    private readonly build: (room: GroupRoom) => RoomSummary,
    private readonly now: () => number = Date.now,
  ) {}

  /** The room's summary: built from the transcripts the first time, then kept. */
  get(room: GroupRoom): RoomSummary {
    let held = this.held.get(room.id);
    if (!held) {
      const summary = this.build(room);
      this.held.set(room.id, (held = { summary, ids: new Set(summary.updates) }));
    }
    return held.summary;
  }

  /** Whether the room's summary is held (built and kept). */
  has(roomId: string): boolean {
    return this.held.has(roomId);
  }

  /** A post or a delivery changed this room: read it again next time. */
  invalidate(roomId: string): void {
    this.held.delete(roomId);
  }

  /** Rooms that no longer exist. */
  retain(rooms: GroupRoom[]): void {
    const live = new Set(rooms.map((room) => room.id));
    for (const id of [...this.held.keys()]) if (!live.has(id)) this.held.delete(id);
  }

  /**
   * A member's text reply that a tail read. Nothing is read: it is appended to the room's
   * summary when that is held (a room not built yet will contain it when it is). Returns
   * whether the room's summary changed.
   */
  add(roomId: string, reply: RoomReply, member: string): boolean {
    const held = this.held.get(roomId);
    if (!held || held.ids.has(reply.item.id)) return false;
    held.ids.add(reply.item.id);
    const { summary } = held;
    summary.updates.push(reply.item.id);
    if (summary.lastAt === undefined || reply.item.at >= summary.lastAt) {
      summary.lastAt = reply.item.at;
      summary.preview = `${member}: ${reply.item.text}`;
    }
    this.dirty.add(roomId);
    return true;
  }

  /** Rooms to send now: changed, and not sent within ROOM_PUBLISH_MS. The rest wait for a later call. */
  due(): string[] {
    const now = this.now();
    const out: string[] = [];
    for (const id of this.dirty) {
      if (now - (this.lastSent.get(id) ?? -Infinity) < ROOM_PUBLISH_MS) continue;
      this.lastSent.set(id, now);
      this.dirty.delete(id);
      out.push(id);
    }
    return out;
  }
}

/**
 * The replies the tails read, into the room list. A live one is added (nothing is read); a replayed
 * one (a tail that started over read it from the past) is not news and may lie where the room view
 * does not look (the tail reaches CHAT_SCAN_MAX_BYTES back, the view ROOM_SCAN_MAX_BYTES), so
 * adding it counted replies the room never shows: the room is read again by the view's rule instead.
 * Returns whether a room must be sent now (it was read again).
 */
export function applyRoomReplies(
  summaries: RoomSummaries,
  replies: RoomReplyRead[],
  find: (room: string) => GroupRoom | null | undefined,
): boolean {
  let rebuilt = false;
  for (const { member, reply, replayed } of replies) {
    const room = find(reply.room.id ?? reply.room.name);
    if (!room) continue;
    if (!replayed) summaries.add(room.id, reply, member);
    else if (summaries.has(room.id)) {
      summaries.invalidate(room.id);
      rebuilt = true;
    }
  }
  return rebuilt;
}
