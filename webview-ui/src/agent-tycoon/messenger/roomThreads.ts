/** ROOM-THREADS: a room's posts as threads (a 답글 joins its thread, as in Slack) and each thread's rail. */
import type { GroupPostItem } from '../../../../core/src/messages.js';
import { ROOM_WAITING_MS } from '../../constants.js';

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
    for (const reply of post.replies) for (const item of reply.items) threadOf.set(item.id, thread);
  }
  return threads;
}

export const ThreadTone = { notice: 'notice', waiting: 'waiting', plain: 'plain' } as const;
export type ThreadTone = (typeof ThreadTone)[keyof typeof ThreadTone];

/** A tagged post (바로) some target has not answered yet (no text of theirs under it), for a day. */
const waits = (post: GroupPostItem, now: number): boolean =>
  !post.notice &&
  !post.system &&
  now - post.at < ROOM_WAITING_MS &&
  post.targets.some(
    (member) =>
      !post.replies.some((r) => r.member === member && r.items.some((i) => i.kind === 'assistant')),
  );

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
  const see = (name: string | null, at: number) => {
    count++;
    if (!last || at >= last.at) last = { name, at };
  };
  thread.posts.forEach((post, i) => {
    if (i > 0) see(post.sender ?? null, post.at);
    for (const reply of post.replies)
      for (const item of reply.items) if (item.kind === 'assistant') see(reply.member, item.at);
  });
  return { count, last };
}
