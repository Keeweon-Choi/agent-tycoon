/** The office messenger's group-room client-message routes and room list / timeline publishing. */
import { createHash } from 'crypto';
import * as fs from 'fs';

import { pickRefusal, refused, type WithError } from '../../../../core/src/agent-tycoon/serverText.js';
import type { Conversations, Lead } from '../conversations.js';
import { listedText, readOptions } from '../conversations.js';
import { deviceLabel } from '../device.js';
import type { GroupMessages } from '../engine/groupMessages.js';
import {
  ROOM_BACKFILL_MAX_BUILDS,
  ROOM_BACKFILL_STEP_MS,
  roomEvents,
  roomTranscript,
  roomTranscriptAt,
  transcriptsAt,
} from '../engine/groupMessages.js';
import type { GroupRoom, GroupStore } from '../engine/groups.js';
import type { TurnLedger } from '../engine/turnLedger.js';
import type { ClientMessageContext, WsSend } from '../hooks.js';
import type { AgentEntry } from '../providers/types.js';
import type { TurnInfo } from '../push.js';
import { applyRoomReplies, RoomSummaries, type RoomSummary } from '../roomUnread.js';
import { searchAll } from '../searchAll.js';
import { CHAT_TAIL_BYTES, currentTurn, type RoomRef, type RoomReply, RoomTurnFilter } from '../transcriptView.js';

/** T-113 (M2): an open room reads at most this much of what a member's transcript gained since its last look. */
const ROOM_FOLLOW_MAX_BYTES = CHAT_TAIL_BYTES;
const NL = 0x0a;
/** A reply line's delivery ids: every part of a joined turn (L6), else its one. */
const deliveryIdsOf = (reply: RoomReply): string[] => reply.deliveryIds ?? (reply.deliveryId ? [reply.deliveryId] : []);

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
  /** Open room timelines are the only reason to read member transcripts for replies. T-113: per client, each
   *  open room and the posts whose replies it asked for (groupThread); the other posts carry recorded counts. */
  private readonly groupViews = new Map<WsSend, Map<string, Set<string>>>();
  /** P3.1: per open room of a client (its loaded set): what its last timeline was built from, whether that
   *  build left an earlier window for the next one, when its soonest unfound post is due, and what it showed (sha1). */
  private readonly built = new WeakMap<ReadonlySet<string>, { inputs: string; pending: boolean; retryAt: number; hash: string }>();
  /** T-113: rooms whose earlier posts are being counted once (backfill). */
  private readonly backfilling = new Set<string>();
  /** T-113 (M2): per member of an open room, where its transcript was last looked at, and the turn being read. */
  //   `cut`: `offset` is inside a line (a first look ROOM_FOLLOW_MAX_BYTES before the end).
  private readonly follow = new Map<string, { file: string; offset: number; cut: boolean; turns: RoomTurnFilter; read: RoomReply[] }>();
  /** The messenger-wide search each client last asked for: a newer one cancels it. */
  private readonly searchToken = new Map<WsSend, number>();
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
      const mine = this.groupViews.get(send) ?? new Map<string, Set<string>>();
      if (msg.on) {
        const loaded = mine.get(room.id) ?? new Set<string>();
        mine.set(room.id, loaded);
        this.groupViews.set(send, mine);
        // T-113: the posts and their recorded counts; a thread's replies are read when it is opened.
        this.sendTimeline(send, room, loaded);
        this.backfill(room);
      } else {
        mine.delete(room.id);
        if (!mine.size) this.groupViews.delete(send);
        this.letGoEarlier();
      }
      return true;
    }
    if (msg.type === 'groupThread') {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
      const answer = (rest: { ok: boolean } & Partial<WithError>) => send({ type: 'groupThreadResult', requestId, ...rest });
      const room = typeof msg.room === 'string' ? this.deps.groupStore?.find(msg.room) : null;
      const loaded = room ? this.groupViews.get(send)?.get(room.id) : undefined;
      if (!this.deps.opts.chat) answer({ ok: false, ...refused('chat_off') });
      else if (!room || !loaded || !this.deps.groupMessages) answer({ ok: false, ...refused('room_missing') });
      else
        try {
          // L3: only the room's own posts that it shows: the set never holds more than those.
          const shown = new Set(this.deps.groupMessages.timeline(room).map((post) => post.id));
          const posts = new Set(Array.isArray(msg.posts) ? msg.posts.filter((id): id is string => typeof id === 'string' && shown.has(id)) : []);
          for (const id of loaded) if (!shown.has(id)) loaded.delete(id);
          const mode = msg.mode;
          // N4: a mode the protocol does not list is no load
          if (mode !== undefined && mode !== 'probe' && mode !== 'fold') {
            answer({ ok: false, ...refused('bad_request') });
            return true;
          }
          // 'fold': no longer read (L4); 'probe': read once (its lines are recorded), not kept; else kept loaded.
          for (const id of posts) if (mode === 'fold') loaded.delete(id);
          if (mode !== 'fold' && mode !== 'probe') for (const id of posts) loaded.add(id);
          const reads = mode === 'probe' ? new Set([...loaded, ...posts]) : loaded;
          this.sendTimeline(send, room, reads);
          answer({ ok: true });
          // H2: a probe's post whose reply lies in an earlier conversation needs more windows: read on in the background.
          if (mode === 'probe' && this.deps.groupMessages.earlierPending > 0) this.countPosts(room, posts, null);
        } catch (error: unknown) {
          console.log(`[Agent Tycoon] room thread read failed: ${String(error)}`);
          answer({ ok: false, ...refused('room_thread_failed') });
        }
      return true;
    }
    if (msg.type === 'chatSearchAll') {
      if (!this.deps.opts.chat || typeof msg.requestId !== 'string' || typeof msg.query !== 'string')
        return true;
      this.searchAll(send, msg.requestId, msg.query, privileged);
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

  /** The overall search (ChatSearchAll): every conversation's text, bounded (searchAll.ts). */
  private searchAll(send: WsSend, requestId: string, query: string, privileged: boolean): void {
    const answer = (rest: Record<string, unknown>) =>
      send({ type: 'chatSearchAllResult', requestId, groups: [], truncated: false, ...rest });
    if (!privileged) return answer(refused('no_permission'));
    const token = (this.searchToken.get(send) ?? 0) + 1;
    this.searchToken.set(send, token);
    const cancelled = () => this.searchToken.get(send) !== token;
    const messages = this.deps.groupMessages;
    void searchAll(
      query,
      {
        leads: this.deps.leads(),
        rooms: this.deps.groupStore?.list() ?? [],
        roomPosts: (room, folded, opts) =>
          messages ? messages.searchPosts(room, folded, opts) : { hits: [], truncated: false },
      },
      cancelled,
    ).then(
      (result) => {
        if (!cancelled()) answer(result);
      },
      (error: unknown) => {
        if (!cancelled()) answer({ error: String(error) });
      },
    );
  }

  onClientClosed(send: WsSend): void {
    this.searchToken.delete(send);
    this.groupViews.delete(send);
    this.letGoEarlier();
  }

  /** ROOM-THREADS: no room is viewed: the earlier replies read for one are not kept. */
  private letGoEarlier(): void {
    if (!this.groupViews.size) this.deps.groupMessages?.forgetEarlier();
  }

  /** The 1.5 s view poll: the room list's reply activity, the open rooms' new reply lines, then their timelines. */
  poll(): void {
    this.publishRoomActivity();
    this.followMembers();
    this.pollGroupViews();
  }

  /** C3: a member's reply to a room post lands in its transcript, not in the room's record. The
   *  replies the tails read are added to the room list's summaries (no transcript is read) and the
   *  rooms that changed are sent, each at most once per ROOM_PUBLISH_MS. */
  private publishRoomActivity(): void {
    if (!this.deps.groupStore) return;
    const groups = this.deps.groupStore;
    const replies = this.deps.conversations.takeRoomReplies();
    // T-113: each reply line under its post, so an open room's folded rows count it without a read.
    this.deps.groupMessages?.noteReplies(
      replies.flatMap(({ member, reply }) => {
        const room = groups.find(reply.room.id ?? reply.room.name);
        const deliveryIds = deliveryIdsOf(reply);
        return room && deliveryIds.length ? [{ room, member, deliveryIds, item: reply.item }] : [];
      }),
    );
    const rebuilt = applyRoomReplies(this.roomSummaries, replies, (room) => groups.find(room));
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
    if (room) this.sendViews(room);
  }

  /** The room's timeline to each client that has it open, with the replies each asked for. */
  private sendViews(room: GroupRoom): void {
    if (!this.deps.groupMessages) return;
    for (const [send, viewed] of this.groupViews) {
      const loaded = viewed.get(room.id);
      if (loaded) this.sendTimeline(send, room, loaded);
    }
  }

  /**
   * T-113 (E): the room's posts from before it recorded its reply lines have no count. Once per room (its first
   * open), they are read as an open room read every post before T-113 (the tails, then one earlier window per
   * member per build), build after build in the background, and what is found is recorded; then the room is
   * marked counted and its counts are never read from a transcript again. Viewers see the counts as they come.
   */
  private backfill(room: GroupRoom): void {
    const messages = this.deps.groupMessages;
    if (!messages || this.backfilling.has(room.id) || messages.counted(room) !== null) return;
    const until = Date.now();
    // Only a tagged post can have replies: a room without one has nothing to count, and nothing is written (H1).
    const old = new Set(
      messages
        .timeline(room)
        .filter((post) => post.at < until && post.targets.length && !post.notice && !post.system)
        .map((post) => post.id),
    );
    if (old.size) this.countPosts(room, old, until);
  }

  /** T-113: read these posts' replies build after build until each is found or has nothing left to try (or
   *  ROOM_BACKFILL_MAX_BUILDS), recording what is found and showing it to the room's viewers; `mark`: then mark the
   *  room counted (the backfill's posts made before then). One at a time per room. */
  private countPosts(room: GroupRoom, ids: ReadonlySet<string>, mark: number | null): void {
    const messages = this.deps.groupMessages;
    if (!messages || this.backfilling.has(room.id)) return;
    this.backfilling.add(room.id);
    let found = 0;
    let builds = 0;
    const step = () => {
      try {
        const seen = this.roomTimeline(room, true, ids).reduce(
          (n, post) => n + post.replies.reduce((k, reply) => k + (reply.seen?.length ?? 0), 0),
          0,
        );
        if (seen > found) this.sendViews(room);
        found = seen;
        // H2: on while a post still has a transcript to look in; marked only when each was found or has none left.
        if (messages.earlierPending > 0 && ++builds < ROOM_BACKFILL_MAX_BUILDS)
          return void setTimeout(step, ROOM_BACKFILL_STEP_MS);
        // ponytail: the mark lives in the month it was written; a later month of 50 posts no longer reads it
        // and counts its shown posts once more (one more backfill a month at most). Past the most builds the
        // room is not marked: its next open goes on (the not-found marks stay in memory).
        if (mark !== null && messages.earlierPending === 0) messages.markCounted(room.id, mark);
      } catch (error: unknown) {
        console.log(`[Agent Tycoon] room count backfill failed: ${String(error)}`);
      }
      this.backfilling.delete(room.id);
      this.letGoEarlier();
    };
    setTimeout(step, 0);
  }

  /**
   * T-113 (M2): an open room's counts stay live for every member (the tails read at most MAX_TAILS leads, and a
   * renamed room's turn is known by its old name): each poll looks at what each member's transcript gained since
   * the last look (a stat, then at most ROOM_FOLLOW_MAX_BYTES), and records its reply lines under the posts their
   * delivery ids name. The first look starts ROOM_FOLLOW_MAX_BYTES before the end.
   */
  // ponytail: a reply whose turn began more than ROOM_FOLLOW_MAX_BYTES before the first look (or before a skip past
  // a burst larger than that) is not bound to its post live; it is counted when its thread is read.
  private followMembers(): void {
    const store = this.deps.groupStore;
    const messages = this.deps.groupMessages;
    if (!store || !messages) return;
    const rooms = [...new Set([...this.groupViews.values()].flatMap((viewed) => [...viewed.keys()]))].flatMap(
      (id) => store.find(id) ?? [],
    );
    const members = new Set(rooms.flatMap((room) => room.members));
    for (const member of this.follow.keys()) if (!members.has(member)) this.follow.delete(member);
    const read: Array<{ member: string; reply: RoomReply }> = [];
    for (const member of members) {
      const lead = this.deps.leads().find((l) => l.name === member);
      const file = lead?.transcript;
      if (!lead || !file) continue;
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      let look = this.follow.get(member);
      if (!look || look.file !== file || size < look.offset) {
        const replies: RoomReply[] = [];
        const offset = Math.max(0, size - ROOM_FOLLOW_MAX_BYTES);
        look = { file, offset, cut: offset > 0, turns: new RoomTurnFilter({ onReply: (r) => replies.push(r) }), read: replies };
        this.follow.set(member, look);
      }
      if (size <= look.offset) continue;
      const from = Math.max(look.offset, size - ROOM_FOLLOW_MAX_BYTES);
      if (from > look.offset) look.turns.reset(); // a burst was skipped: no line binds to a turn read before it
      let buf: Buffer;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const read = Buffer.alloc(size - from);
          buf = read.subarray(0, fs.readSync(fd, read, 0, read.length, from));
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      // Whole lines only, found on the bytes (N2: a cut can fall inside a character, which decodes longer): a line
      // cut at the start (a first look, a skip) is dropped, one cut at the end waits for the next look.
      const head = from > look.offset || look.cut ? buf.indexOf(NL) + 1 : 0;
      const end = buf.lastIndexOf(NL) + 1;
      if (head === 0 && (from > look.offset || look.cut)) continue; // no line ends in it yet
      if (end <= head) continue;
      look.offset = from + end;
      look.cut = false;
      const opts = readOptions(lead, (x) => this.deps.noticeEmployee(x));
      for (const line of buf.toString('utf8', head, end).split('\n')) if (line) look.turns.items(line, 0, opts);
      for (const reply of look.read.splice(0)) read.push({ member, reply });
    }
    if (!read.length) return;
    messages.noteReplies(
      rooms.flatMap((room) =>
        read.flatMap(({ member, reply }) =>
          room.members.includes(member) ? [{ room, member, deliveryIds: deliveryIdsOf(reply), item: reply.item }] : [],
        ),
      ),
    );
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

  /** Read reply turns only for room viewers; a room record itself never copies a transcript.
   *  `viewed` (an open room): ROOM-THREADS, a post older than a member's tail is read from the
   *  transcript it was in at the time (roomTranscriptAt). The room list's summary does not: its
   *  newest activity is in the tails, and an old reply is no unread. */
  private roomTimeline(room: GroupRoom, viewed = false, only?: ReadonlySet<string>) {
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
      viewed
        ? (member) => {
            const transcript = lead(member)?.transcript;
            return transcript
              ? { files: (at: number) => transcriptsAt(transcript, at), window: roomTranscriptAt }
              : null;
          }
        : undefined,
      only,
    );
  }

  private pollGroupViews(): void {
    if (!this.deps.groupStore || !this.deps.groupMessages || !this.groupViews.size) return;
    for (const [send, rooms] of this.groupViews)
      for (const [id, loaded] of rooms) {
        const room = this.deps.groupStore.find(id);
        if (room) this.sendTimeline(send, room, loaded, true);
      }
  }

  /**
   * An open room's timeline to one client. `poll` (P3.1): built only when what it is built from changed (the room,
   * its log, its members' transcripts, the threads asked for) or an earlier window is due, and sent only when it
   * differs from the last one: a quiet room no longer reads each loaded thread's members (up to 4 MB each) and
   * resends the whole timeline every 1.5 s per client.
   */
  // ponytail: built per client (two clients on one room read twice on a change), a shared build if that shows.
  private sendTimeline(send: WsSend, room: GroupRoom, loaded: ReadonlySet<string>, poll = false): void {
    const messages = this.deps.groupMessages!;
    const lead = (member: string) => this.deps.leads().find((l) => l.name === member);
    const inputs = JSON.stringify([
      room,
      [...loaded].sort(),
      messages.stamp(room.id),
      room.members.map((member) => {
        const file = lead(member)?.transcript;
        try {
          const st = file ? fs.statSync(file) : null;
          return st ? [file, st.size, st.mtimeMs] : file;
        } catch {
          return file;
        }
      }),
    ]);
    const last = this.built.get(loaded);
    if (poll && last && last.inputs === inputs && !last.pending && !messages.retryDue(last.retryAt)) return;
    const posts = this.roomTimeline(room, true, loaded);
    const hash = createHash('sha1').update(JSON.stringify(posts)).digest('hex');
    this.built.set(loaded, { inputs, pending: messages.earlierPending > 0, retryAt: messages.nextRetryAt, hash });
    if (!poll || last?.hash !== hash) send({ type: 'groupTimeline', room, posts });
  }
}
