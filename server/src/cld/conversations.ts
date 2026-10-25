/**
 * The office messenger's server side (T-0043): one TranscriptTail per lead,
 * at most MAX_TAILS per daemon (leads with an open conversation first), and
 * the conversations each client has open, at most MAX_OPEN_PER_CLIENT.
 *
 * poll() runs only while someone watches (the office's wake/sleep): each tail
 * stats its file and reads what was appended. A changed tail goes to the
 * clients that have its conversation open (the new items only), and the
 * contact list (last message, latest reply ids) is republished.
 */
import { koText, refused } from '../../../core/src/cld/serverText.js';
import type { ChatItem, ChatQueued, MessengerContact } from '../../../core/src/messages.js';
import type { TurnLedger } from './engine/turnLedger.js';
import { sendOutbox } from './files/outbox.js';
import type { WsSend } from './hooks.js';
import { replyPreview } from './push.js';
import { chatHistory, chatSearch, type HistoryCursor } from './transcriptHistory.js';
import {
  type LineOptions,
  type RoomRef,
  type RoomReply,
  RoomTurnFilter,
  TranscriptTail,
} from './transcriptView.js';

export const MAX_OPEN_PER_CLIENT = 4;
export const MAX_TAILS = 12;
const PREVIEW_MAX = 80;
const REPLIES_MAX = 50;
/** Room replies waiting for the office (a tail loading a big history can read many). */
const ROOM_REPLIES_MAX = 5_000;

/** A lead as the messenger needs it. */
export interface Lead {
  agentId: number;
  key: string;
  name: string;
  /** D3: a Worker's project (the messenger lists it under that project); absent for a Lead. */
  project?: string;
  transcript: string | null;
  /** Its project folder: where the files it sends are kept (T-0105); absent = they are not shown. */
  dir?: string;
  canSend: boolean;
  /** The boss's messages still waiting for it (engine projects). */
  queued?: ChatQueued[];
  /** Its session waits on its terminal; messages are held (messenger.held). */
  held?: boolean;
  /** PERM-PROMPT: a permission dialog holds its session: the card. */
  permission?: MessengerContact['permission'];
}

/** A contact's summary of its conversation so far. */
export function contactOf(
  lead: Lead,
  items: ChatItem[] | null,
  /** C3: the room whose turn the lead is in (its newest user turn is a room post), if any. */
  room?: RoomRef | null,
  /** ROOM-NOTICE: the lead's newest text reply in that room turn (a masked preview). */
  roomReply?: MessengerContact['roomReply'],
): MessengerContact {
  const c: MessengerContact = {
    agentId: lead.agentId,
    name: lead.name,
    ...(lead.project && { project: lead.project }),
    canSend: lead.canSend,
    ...(lead.held && { held: true }),
    ...(lead.permission && { permission: lead.permission }),
    ...(room && {
      room: room.name,
      ...(room.id && { roomId: room.id }),
      ...(room.post && { roomPost: room.post }),
      ...(roomReply && { roomReply }),
    }),
    replies: [],
  };
  if (!items) return c;
  const last = [...items].reverse().find((i) => i.kind !== 'tool');
  if (last) {
    // Bold marks (a task notice's summary, a lead's emphasis) are not words: the list shows plain text.
    c.preview = (last.text || koText('attachment_label'))
      .split('\n', 1)[0]
      .replace(/\*\*/g, '')
      .slice(0, PREVIEW_MAX);
    c.lastAt = last.at;
    c.lastKind = last.kind;
    if (last.from) c.lastFrom = last.from;
    if (last.fromName) c.lastFromName = last.fromName;
  }
  c.replies = items
    .filter((i) => i.kind === 'assistant')
    .slice(-REPLIES_MAX)
    .map((i) => i.id);
  return c;
}

/** How a lead's lines are read: its sent files are copied into its project folder. */
export function readOptions(lead: Lead, employeeOf?: LineOptions['employeeOf']): LineOptions {
  const dir = lead.dir;
  return {
    ...(dir && dir.startsWith('/') && { outbox: (source: string) => sendOutbox(dir, source) }),
    ...(employeeOf && { employeeOf }),
  };
}

/** A room reply a tail read. `replayed`: the tail started over (a new file, or a jump past one read)
 *  and read it again from the transcript's past, so it is not news: the room's summary is read
 *  again by the view's rule instead of adding it (roomUnread.ts applyRoomReplies). */
export interface RoomReplyRead {
  member: string;
  reply: RoomReply;
  replayed: boolean;
}

export class Conversations {
  private readonly tails = new Map<string, TranscriptTail>();
  /** Open conversations per client (agentIds). */
  private readonly open = new Map<WsSend, Set<number>>();
  /** What each client was last told canSend and queued are, per agentId. */
  private readonly told = new Map<WsSend, Map<number, string>>();
  private lastLeads = '';
  /** C3: each tail's room-turn filter, and the room it was in when the contacts were last published. */
  private readonly filters = new Map<string, RoomTurnFilter>();
  private readonly toldRoom = new Map<string, string>();
  /** C3: the text replies of room turns the tails read (the DM view hides them, so no delta shows
   *  them): the office adds them to the room list's unread (takeRoomReplies). */
  private roomReplies: RoomReplyRead[] = [];
  /** The replies the poll in progress reads: a tail that starts over replays them (`replayed`). */
  private polled: RoomReplyRead[] = [];
  /** ROOM-NOTICE: each lead's newest text reply in a room turn (preview), and one arrived since the last publish. */
  private readonly lastRoomReply = new Map<string, { room: RoomRef; id: string; text: string }>();
  private roomReplyFresh = false;
  private readonly historyBusy = new Map<WsSend, Set<number>>();
  private readonly searchToken = new Map<WsSend, number>();
  /** Where each client's last history page stopped, keyed by its oldest item. */
  private readonly cursors = new Map<WsSend, Map<number, HistoryCursor & { id: string }>>();

  constructor(
    private readonly leads: () => Lead[],
    private readonly publish: (contacts: MessengerContact[]) => void,
    private readonly log: (line: string) => void = (l) => console.log(`[cld] messenger: ${l}`),
    /** C3: what the messenger typed, which turn belongs to which room. */
    private readonly ledger?: TurnLedger,
    /** MSG-ALIGN: a run's employee, for the task notices' names. */
    private readonly employeeOf?: LineOptions['employeeOf'],
  ) {}

  /** C3: the room replies the tails read since the last call, oldest first. */
  takeRoomReplies(): RoomReplyRead[] {
    const out = this.roomReplies;
    this.roomReplies = [];
    return out;
  }

  /** C3: the room of lead `name`'s newest turn: what the messenger typed that the transcript has
   *  not shown yet, else what the transcript shows (itself classified by what the messenger typed). */
  private roomOf(lead: Lead): RoomRef | null {
    const typed = this.ledger?.unseen(lead.name);
    return typed ? typed.room : (this.filters.get(lead.key)?.turn ?? null);
  }

  /** The contacts again, now (a turn was just typed: it can end before the next poll). */
  republish(): void {
    const leads = this.leads();
    this.publish(
      leads.map((l) => {
        const room = this.roomOf(l);
        const last = this.lastRoomReply.get(l.key);
        // Only a reply of the turn the contact is in (a newer post must not show the older one's text).
        const mine = room && last && (last.room.post ?? last.room.name) === (room.post ?? room.name);
        return contactOf(l, this.tails.get(l.key)?.items ?? null, room, mine ? { id: last.id, text: last.text } : undefined);
      }),
    );
  }

  /** chatView: open (everything the tail holds now, then appends) or close. */
  view(send: WsSend, agentId: number, on: boolean): void {
    const mine = this.open.get(send) ?? new Set<number>();
    if (!on) {
      mine.delete(agentId);
      this.told.get(send)?.delete(agentId);
      if (!mine.size) this.drop(send);
      return;
    }
    if (!this.leads().some((l) => l.agentId === agentId)) return;
    if (!mine.has(agentId) && mine.size >= MAX_OPEN_PER_CLIENT) {
      this.log(`conversation ${agentId} refused: ${MAX_OPEN_PER_CLIENT} already open`);
      return;
    }
    mine.add(agentId);
    this.open.set(send, mine);
    this.told.get(send)?.delete(agentId); // a fresh full answer below
    this.poll();
  }

  /** PERM-PROMPT: some client has lead `agentId`'s conversation open. */
  viewing(agentId: number): boolean {
    return [...this.open.values()].some((ids) => ids.has(agentId));
  }

  /** A client left. */
  drop(send: WsSend): void {
    this.open.delete(send);
    this.told.delete(send);
    this.historyBusy.delete(send);
    this.searchToken.delete(send);
    this.cursors.delete(send);
  }

  /** One history read per client and lead. The result is always tied to its request id. */
  history(send: WsSend, agentId: number, requestId: string, before?: string, until?: number): void {
    const lead = this.leads().find((l) => l.agentId === agentId);
    if (!lead) {
      send({
        type: 'chatHistoryResult',
        requestId,
        agentId,
        items: [],
        done: false,
        ...refused('conversation_not_found'),
      });
      return;
    }
    let busy = this.historyBusy.get(send);
    if (!busy) this.historyBusy.set(send, (busy = new Set()));
    if (busy.has(agentId)) {
      send({
        type: 'chatHistoryResult',
        requestId,
        agentId,
        items: [],
        done: false,
        ...refused('conversation_loading'),
      });
      return;
    }
    busy.add(agentId);
    let cursors = this.cursors.get(send);
    if (!cursors) this.cursors.set(send, (cursors = new Map()));
    const at = cursors.get(agentId);
    const from = before !== undefined && at?.id === before ? at : undefined;
    void chatHistory(lead.transcript, before, until, from, readOptions(lead, this.employeeOf))
      .then(
        ({ cursor, ...page }) => {
          const oldest = page.items[0]?.id ?? before;
          if (cursor && oldest) cursors.set(agentId, { ...cursor, id: oldest });
          // Nothing complete within the byte budget: one line is bigger than it.
          const error =
            !page.items.length && !page.done ? koText('history_too_big') : undefined;
          send({ type: 'chatHistoryResult', requestId, agentId, ...page, ...(error && { error }) });
        },
        (error: unknown) =>
          send({
            type: 'chatHistoryResult',
            requestId,
            agentId,
            items: [],
            done: false,
            error: String(error),
          }),
      )
      .finally(() => busy.delete(agentId));
  }

  /** A newer request cancels the previous search for this client. */
  search(send: WsSend, agentId: number, requestId: string, query: string): void {
    const lead = this.leads().find((l) => l.agentId === agentId);
    if (!lead) {
      send({
        type: 'chatSearchResult',
        requestId,
        agentId,
        hits: [],
        truncated: false,
        ...refused('conversation_not_found'),
      });
      return;
    }
    const token = (this.searchToken.get(send) ?? 0) + 1;
    this.searchToken.set(send, token);
    void chatSearch(lead.transcript, query, {
      cancelled: () => this.searchToken.get(send) !== token,
    }).then(
      (page) => {
        if (this.searchToken.get(send) === token)
          send({ type: 'chatSearchResult', requestId, agentId, ...page });
      },
      (error: unknown) => {
        if (this.searchToken.get(send) === token)
          send({
            type: 'chatSearchResult',
            requestId,
            agentId,
            hits: [],
            truncated: false,
            error: String(error),
          });
      },
    );
  }

  /** Tails in use (tests, status). */
  get size(): number {
    return this.tails.size;
  }

  /** Catch every tail up; tell the open conversations and republish the contacts. */
  poll(): void {
    const leads = this.leads();
    const opened = new Set([...this.open.values()].flatMap((s) => [...s]));
    const tailed = [
      ...leads.filter((l) => opened.has(l.agentId)),
      ...leads.filter((l) => !opened.has(l.agentId)),
    ].slice(0, MAX_TAILS);
    const keep = new Set(tailed.map((l) => l.key));
    for (const key of this.tails.keys())
      if (!keep.has(key)) {
        this.tails.delete(key);
        this.filters.delete(key);
        this.toldRoom.delete(key);
        this.lastRoomReply.delete(key);
      }
    let changed = false;
    for (const lead of tailed) {
      let tail = this.tails.get(lead.key);
      if (!tail) {
        const opts = readOptions(lead, this.employeeOf);
        const roomTurns = new RoomTurnFilter({
          classify: (id) => this.ledger?.classify(id),
          onTurn: (id) => this.ledger?.seen(lead.name, id),
          onReply: (reply) => {
            const read = { member: lead.name, reply, replayed: false };
            this.polled.push(read);
            this.roomReplies.push(read);
            // The same masked one-line preview a push carries; it reaches the contact below.
            const text = replyPreview(reply.item.text);
            if (text) {
              this.lastRoomReply.set(lead.key, { room: reply.room, id: reply.item.id, text });
              this.roomReplyFresh = true;
            }
            if (this.roomReplies.length > ROOM_REPLIES_MAX) this.roomReplies.shift();
          },
        });
        this.filters.set(lead.key, roomTurns);
        const parse = Object.assign((line: string, n: number) => roomTurns.items(line, n, opts), {
          reset: () => roomTurns.reset(),
        });
        this.tails.set(lead.key, (tail = new TranscriptTail(undefined, parse)));
      }
      this.polled = [];
      const delta = tail.poll(lead.transcript);
      if (delta?.reset) for (const read of this.polled) read.replayed = true;
      if (delta) changed = true;
      const room = this.roomOf(lead);
      const told = room ? `${room.id ?? ''}|${room.post ?? ''}|${room.name}` : '';
      if (this.toldRoom.get(lead.key) !== told) {
        this.toldRoom.set(lead.key, told);
        changed = true; // a room turn adds no item: only the contact tells which channel it is in
      }
      for (const [send, ids] of this.open) {
        if (!ids.has(lead.agentId)) continue;
        let told = this.told.get(send);
        if (!told) this.told.set(send, (told = new Map()));
        const fresh = !told.has(lead.agentId);
        const sig = JSON.stringify([lead.canSend, lead.queued]);
        if (!fresh && !delta && told.get(lead.agentId) === sig) continue;
        told.set(lead.agentId, sig);
        const full = fresh || delta?.reset;
        send({
          type: 'chatTranscript',
          agentId: lead.agentId,
          items: full ? tail.items : (delta?.added ?? []),
          canSend: lead.canSend,
          ...(!full && { append: true }),
          ...(lead.queued && { queued: lead.queued }),
        });
      }
    }
    const stale = this.contactsStale(leads);
    if (changed || stale || this.roomReplyFresh) {
      this.roomReplyFresh = false;
      this.republish();
    }
  }

  /** The lead list itself changed (names, ids, canSend). */
  private contactsStale(leads: Lead[]): boolean {
    const sig = JSON.stringify(
      leads.map((l) => [l.agentId, l.name, l.canSend, !!l.held, l.project ?? null, l.permission ?? null]),
    );
    if (sig === this.lastLeads) return false;
    this.lastLeads = sig;
    return true;
  }
}
