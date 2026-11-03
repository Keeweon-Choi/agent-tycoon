/** The office messenger's group-room client-message routes and room list / timeline publishing. */
import { pickRefusal, refused, type WithError } from '../../../../core/src/cld/serverText.js';
import type { Conversations, Lead } from '../conversations.js';
import { listedText, readOptions } from '../conversations.js';
import { deviceLabel } from '../device.js';
import type { GroupMessages } from '../engine/groupMessages.js';
import { roomEvents, roomTranscript } from '../engine/groupMessages.js';
import type { GroupRoom, GroupStore } from '../engine/groups.js';
import type { TurnLedger } from '../engine/turnLedger.js';
import type { ClientMessageContext, WsSend } from '../hooks.js';
import type { AgentEntry } from '../providers/types.js';
import type { TurnInfo } from '../push.js';
import { applyRoomReplies, RoomSummaries, type RoomSummary } from '../roomUnread.js';
import { currentTurn, type RoomRef } from '../transcriptView.js';

interface RoomDeps {
  opts: { chat?: boolean };
  groupStore: GroupStore | null;
  groupMessages: GroupMessages | null;
  conversations: Conversations;
  turnLedger: TurnLedger;
  entryOf(agentId: number): AgentEntry | null;
  leads(): Lead[];
  noticeEmployee(execution: string): { employeeId: string; nameId: string } | undefined;
  publish<T extends { type: string }>(msg: T): void;
}

export class OfficeRooms {
  /** Open room timelines are the only reason to read member transcripts for replies. */
  private readonly groupViews = new Map<WsSend, Set<string>>();
  /** C3: each room's list summary, kept incrementally (roomUnread.ts). */
  private readonly roomSummaries = new RoomSummaries((room) => this.buildRoomSummary(room));

  constructor(private readonly deps: RoomDeps) {}

  onClientMessage(msg: Record<string, unknown>, ctx: ClientMessageContext): boolean {
    const { send, privileged, userAgent } = ctx;
    if (msg.type === 'groupView') {
      // Like chatView: reading a member's transcript needs the chat feature.
      if (!this.deps.opts.chat || typeof msg.room !== 'string' || typeof msg.on !== 'boolean')
        return true;
      const room = this.deps.groupStore?.find(msg.room);
      if (!room || !this.deps.groupMessages) return true;
      const mine = this.groupViews.get(send) ?? new Set<string>();
      if (msg.on) {
        mine.add(room.id);
        this.groupViews.set(send, mine);
        send({ type: 'groupTimeline', room, posts: this.roomTimeline(room) });
      } else {
        mine.delete(room.id);
        if (!mine.size) this.groupViews.delete(send);
      }
      return true;
    }
    if (msg.type === 'groupPost') {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
      const room = typeof msg.room === 'string' ? msg.room : '';
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!this.deps.opts.chat || !privileged || !requestId || !this.deps.groupMessages) {
        send({
          type: 'groupActionResult',
          requestId,
          ok: false,
          ...(!this.deps.opts.chat ? refused('chat_off') : refused('no_permission')),
        });
        return true;
      }
      void this.deps.groupMessages
        .post({
          room,
          text,
          from: null,
          source: `messenger:${deviceLabel(userAgent)}`,
          replyTo: msg.replyTo,
        })
        .then((result) => {
          send({
            type: 'groupActionResult',
            requestId,
            ok: result.ok,
            ...(!result.ok && pickRefusal(result)),
          });
          if (result.ok) this.publishGroups(room);
        });
      return true;
    }
    if (msg.type === 'groupAction') {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
      const action = typeof msg.action === 'string' ? msg.action : '';
      const id = typeof msg.id === 'string' ? msg.id : '';
      const name = typeof msg.name === 'string' ? msg.name : '';
      const members =
        Array.isArray(msg.members) && msg.members.every((x) => typeof x === 'string')
          ? msg.members
          : [];
      let result: { ok: boolean } & Partial<WithError> = { ok: false, ...refused('bad_request') };
      if (!privileged) result = { ok: false, ...refused('no_permission') };
      else if (this.deps.groupStore) {
        if (action === 'create') result = this.deps.groupStore.create(name, members);
        else if (action === 'rename') result = this.deps.groupStore.rename(id, name);
        else if (action === 'delete') result = this.deps.groupStore.remove(id);
        else if (action === 'setMembers') result = this.deps.groupStore.setMembers(id, members);
        else if (action === 'systemLines' && typeof msg.on === 'boolean')
          result = this.deps.groupStore.setSystemLines(id, msg.on);
      }
      send({
        type: 'groupActionResult',
        requestId,
        ok: result.ok,
        ...(!result.ok &&
          (result.error ? pickRefusal(result as WithError) : refused('group_change_failed'))),
      });
      if (result.ok) this.publishGroups();
      return true;
    }
    return false;
  }

  onClientClosed(send: WsSend): void {
    this.groupViews.delete(send);
  }

  /** The 1.5 s view poll: the room list's reply activity, then the open room timelines. */
  poll(): void {
    this.publishRoomActivity();
    this.pollGroupViews();
  }

  /** C3: a member's reply to a room post lands in its transcript, not in the room's record. The
   *  replies the tails read are added to the room list's summaries (no transcript is read) and the
   *  rooms that changed are sent, each at most once per ROOM_PUBLISH_MS. */
  private publishRoomActivity(): void {
    if (!this.deps.groupStore) return;
    const groups = this.deps.groupStore;
    const rebuilt = applyRoomReplies(
      this.roomSummaries,
      this.deps.conversations.takeRoomReplies(),
      (room) => groups.find(room),
    );
    if (rebuilt || this.roomSummaries.due().length)
      this.deps.publish({ type: 'groupRooms', rooms: this.groupRooms() });
  }

  /** C3 + U-49: the room the newest turn of character `id` belongs to, and the text it ended with,
   *  for a turn end's push. What the messenger typed answers the room at once; the transcript is
   *  read (async, and only when push has someone to tell) for the text and for a turn it did not type. */
  async turnOf(id: number): Promise<TurnInfo> {
    const name = this.deps.entryOf(id)?.name;
    if (!name) return { room: null, text: null };
    const typed = this.deps.turnLedger.current(name); // asked now: a later post must not change this turn's room
    const lead = this.deps.leads().find((l) => l.agentId === id);
    // The lead's sent files are read as the messenger reads them (copied once into its outbox).
    const read = await currentTurn(
      this.deps.entryOf(id)?.transcript ?? null,
      lead ? readOptions(lead, (x) => this.deps.noticeEmployee(x)) : {},
    );
    const files = read.attachments ? { attachments: read.attachments } : {};
    if (!this.deps.groupStore) return { room: null, text: read.text, ...files };
    const withId = (ref: RoomRef | null): RoomRef | null =>
      ref && !ref.id ? { ...ref, id: this.deps.groupStore?.find(ref.name)?.id } : ref;
    return {
      room: withId(typed !== undefined ? typed : read.room ? { name: read.room } : null),
      text: read.text,
      ...files,
    };
  }

  /** A room change has a small global list update; open clients request/read its timeline. */
  publishGroups(roomName?: string): void {
    if (!this.deps.groupStore) return;
    const room = roomName ? this.deps.groupStore.find(roomName) : null;
    if (room) this.roomSummaries.invalidate(room.id); // a post or delivery changed it: read it again
    this.deps.publish({ type: 'groupRooms', rooms: this.groupRooms() });
    if (room && this.deps.groupMessages)
      for (const [send, viewed] of this.groupViews)
        if (viewed.has(room.id))
          send({ type: 'groupTimeline', room, posts: this.roomTimeline(room) });
  }

  /** Small room-list summaries: enough to sort, preview and count unseen room
   * activity without making the client open every room conversation. */
  groupRooms() {
    const rooms = this.deps.groupStore!.list();
    this.roomSummaries.retain(rooms);
    return rooms.map((room) => {
      const { updates, ...rest } = this.roomSummaries.get(room);
      return { ...room, ...rest, ...(updates.length && { updates }) };
    });
  }

  /** One room's summary, read from the transcripts (the expensive one: RoomSummaries keeps it). */
  private buildRoomSummary(room: GroupRoom): RoomSummary {
    const posts = this.deps.groupMessages ? this.roomTimeline(room) : [];
    const events = roomEvents(posts);
    const last = events.reduce<(typeof events)[number] | undefined>(
      (newest, event) => (!newest || event.at >= newest.at ? event : newest),
      undefined,
    );
    return {
      ...(last && { preview: `${last.sender ? `${last.sender}: ` : ''}${listedText(last.text)}` }),
      ...(last && { lastAt: last.at }),
      updates: events.filter((event) => event.counts).map((event) => event.id),
    };
  }

  /** Read reply turns only for room viewers; a room record itself never copies a transcript. */
  private roomTimeline(room: GroupRoom) {
    const lead = (member: string) => this.deps.leads().find((l) => l.name === member);
    return this.deps.groupMessages!.timelineWithReplies(
      room,
      (member, since) => {
        const transcript = lead(member)?.transcript;
        return transcript ? roomTranscript(transcript, since) : null; // its end, never the whole file
      },
      undefined,
      (member) => {
        const found = lead(member);
        return found ? readOptions(found, (x) => this.deps.noticeEmployee(x)) : {};
      },
    );
  }

  private pollGroupViews(): void {
    if (!this.deps.groupStore || !this.deps.groupMessages || !this.groupViews.size) return;
    for (const [send, rooms] of this.groupViews)
      for (const id of rooms) {
        const room = this.deps.groupStore.find(id);
        if (room) send({ type: 'groupTimeline', room, posts: this.roomTimeline(room) });
      }
  }
}
