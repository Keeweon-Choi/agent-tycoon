/** ROOM-THREADS: a room's posts as threads (a 답글 joins its thread, as in Slack) and each thread's rail. */
import type { GroupPostItem, GroupReply } from '../../../../core/src/messages.js';
import { ROOM_WAITING_MS } from '../../constants.js';

/** T-113: a member's reply lines under a post: the ones loaded (its words, never a tool line) and the ones the
 *  room recorded (`seen`, sent while the post's replies are not loaded). The same line has the same id in both. */
export const replyLines = (reply: GroupReply): string[] => [
  ...new Set([...reply.items.filter((item) => item.kind === 'assistant').map((item) => item.id), ...(reply.seen ?? [])]),
];

/** A thread: its first post, then the posts answering it or anything in it, oldest first. */
export interface RoomThread {
  posts: GroupPostItem[];
}

/**
 * The room's posts (oldest first) as threads. A post whose 답글 names a post the room shows, or
 * a member's reply under one, joins that post's thread; one whose target is not shown (older
 * than the loaded posts) starts its own and keeps its quote. A system line is a thread of its own.
 */
export function roomThreads(posts: GroupPostItem[]): RoomThread[] {
  const threads: RoomThread[] = [];
  const threadOf = new Map<string, RoomThread>(); // a post id, or a member reply's item id
  for (const post of posts) {
    const parent = post.replyTo && !post.system ? threadOf.get(post.replyTo.id) : undefined;
    const thread = parent ?? { posts: [] };
    thread.posts.push(post);
    if (!parent) threads.push(thread);
    if (post.system) continue;
    threadOf.set(post.id, thread);
    for (const reply of post.replies) {
      for (const item of reply.items) threadOf.set(item.id, thread);
      for (const id of reply.seen ?? []) threadOf.set(id, thread);
    }
  }
  return threads;
}

/** The thread a post, a 답글 post or a member's reply (by its item id) belongs to. */
export const threadHolding = (threads: readonly RoomThread[], id: string): RoomThread | undefined =>
  threads.find((thread) =>
    thread.posts.some(
      (post) =>
        post.id === id ||
        post.replies.some((reply) => reply.items.some((item) => item.id === id) || !!reply.seen?.includes(id)),
    ),
  );

/** T-113: a tagged post (not a 공지, not a system line) whose replies are not loaded yet. */
const unloaded = (post: GroupPostItem): boolean => !post.loaded && !post.system && !post.notice && post.targets.length > 0;

/**
 * T-113: what a thread on screen asks the daemon for. `open` (the reader opened it, or it shows open): the posts
 * with replies to draw that are not loaded yet. `probe`: a thread that shows no reply at all has its tagged posts
 * that reached a member read once (H2: a reply the room never recorded, an older post the count did not reach):
 * what is found becomes its count.
 */
export function threadAsks(thread: RoomThread, open: boolean): { open: string[]; probe: string[] } {
  if (threadReplies(thread).count > 0) return { open: open ? thread.posts.filter(unloaded).map((p) => p.id) : [], probe: [] };
  const reached = (post: GroupPostItem) => post.targets.some((m) => post.delivery[m] === 'delivered' || post.delivery[m] === 'off');
  return { open: [], probe: thread.posts.filter((post) => unloaded(post) && reached(post)).map((p) => p.id) };
}

/** A post's targets with the delivered ones first, the rest in the order they came (the room's). */
export const deliveredFirst = (targets: readonly string[], delivery: Record<string, string>): string[] => [
  ...targets.filter((member) => delivery[member] === 'delivered'),
  ...targets.filter((member) => delivery[member] !== 'delivered'),
];

export const ThreadTone = { notice: 'notice', waiting: 'waiting', plain: 'plain' } as const;
export type ThreadTone = (typeof ThreadTone)[keyof typeof ThreadTone];

/** A tagged post (바로) some target has not answered yet (no text of theirs under it), for a day. */
const waits = (post: GroupPostItem, now: number): boolean =>
  !post.notice &&
  !post.system &&
  now - post.at < ROOM_WAITING_MS &&
  post.targets.some((member) => !post.replies.some((r) => r.member === member && replyLines(r).length > 0));

/**
 * The thread's rail: waiting (a tag in it still unanswered, its post under ROOM_WAITING_MS old),
 * else notice (it starts with a 공지), else plain. An untagged post never waits.
 */
export function threadTone(thread: RoomThread, now: number): ThreadTone {
  if (thread.posts.some((post) => waits(post, now))) return ThreadTone.waiting;
  return thread.posts[0]?.notice ? ThreadTone.notice : ThreadTone.plain;
}

/** A thread's answers: the members' words under its posts and the 답글 posts in it, and who spoke last. */
export interface ThreadReplies {
  count: number;
  /** `name` null: the boss. */
  last: { name: string | null; at: number } | null;
}

/** Counts what a folded thread hides: each member line (tool lines are never shown) and each 답글 post. */
export function threadReplies(thread: RoomThread): ThreadReplies {
  let count = 0;
  let last: ThreadReplies['last'] = null;
  const see = (name: string | null, at: number, n = 1) => {
    count += n;
    if (!last || at >= last.at) last = { name, at };
  };
  thread.posts.forEach((post, i) => {
    if (i > 0) see(post.sender ?? null, post.at);
    for (const reply of post.replies) {
      const n = replyLines(reply).length;
      const at = Math.max(reply.lastAt ?? 0, ...reply.items.filter((item) => item.kind === 'assistant').map((item) => item.at));
      if (n) see(reply.member, at, n);
    }
  });
  return { count, last };
}
