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
