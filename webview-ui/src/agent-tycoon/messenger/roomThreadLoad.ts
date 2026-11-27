/**
 * T-113: a room's posts come with their reply counts; a thread's replies are read when the reader opens it
 * (groupThread). Here: each asked post (room + post id) on its way, failed, or read once (a probe); one answered
 * is loaded, and the timeline says so (GroupPostItem.loaded). Kept for the page only: the daemon forgets a
 * room's loads when it closes or the socket drops (the room asks again then: forgetRoomLoads).
 */
import { useSyncExternalStore } from 'react';

import type { GroupThread, GroupThreadResult } from '../../../../core/src/messages.js';
import { ROOM_THREAD_LOAD_MS } from '../../constants.js';

/** The transport's send, given by the room (officeStore loads this module and must not load the transport). */
export type SendThread = (msg: GroupThread) => void;

export const ThreadLoad = { pending: 'pending', failed: 'failed', probed: 'probed', answered: 'answered' } as const;
export type ThreadLoad = (typeof ThreadLoad)[keyof typeof ThreadLoad];
type Loads = Record<string, ThreadLoad>;

const SEP = '\n';
export const loadKey = (room: string, post: string): string => `${room}${SEP}${post}`;

let loads: Loads = {};
const asked = new Map<string, { keys: string[]; probe: boolean; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();
let seq = 0;
const set = (next: Loads) => {
  loads = next;
  listeners.forEach((l) => l());
};

/**
 * Ask for these posts' replies, except those on their way, failed (a failed one waits for retryThread) or answered
 * (asked again only after a fold or a new socket: the thread's effect runs on every change of the loads).
 * `probe`: read them once, not kept loaded (a thread that shows no reply); asked once per room view.
 */
export function loadThread(send: SendThread, room: string, posts: string[], probe = false): void {
  const keys = posts
    .map((post) => loadKey(room, post))
    .filter((key) => !loads[key] || (!probe && loads[key] === ThreadLoad.probed));
  if (!keys.length) return;
  const requestId = `group-thread-${Date.now()}-${++seq}`;
  // No answer in time (the socket dropped, the daemon is busy): it failed, and the reader can ask again.
  asked.set(requestId, { keys, probe, timer: setTimeout(() => settle(requestId, false), ROOM_THREAD_LOAD_MS) });
  set({ ...loads, ...Object.fromEntries(keys.map((key) => [key, ThreadLoad.pending])) });
  const ids = keys.map((key) => key.slice(room.length + SEP.length));
  send({ type: 'groupThread', requestId, room, posts: ids, ...(probe && { mode: 'probe' as const }) });
}

function settle(requestId: string, ok: boolean): void {
  const request = asked.get(requestId);
  if (!request) return;
  asked.delete(requestId);
  clearTimeout(request.timer);
  const next = { ...loads };
  for (const key of request.keys)
    if (request.probe) next[key] = ThreadLoad.probed; // a probe shows nothing to retry: asked once either way
    else next[key] = ok ? ThreadLoad.answered : ThreadLoad.failed;
  set(next);
}

/** The answer: the timeline with the replies came just before it. */
export const threadLoadResult = (msg: GroupThreadResult): void => settle(msg.requestId, msg.ok);

/** The reader asks again (다시 시도). */
export function retryThread(send: SendThread, room: string, posts: string[]): void {
  const next = { ...loads };
  for (const post of posts) if (next[loadKey(room, post)] === ThreadLoad.failed) delete next[loadKey(room, post)];
  loads = next;
  loadThread(send, room, posts);
}

/** L4: the reader folded these loaded posts again: the daemon stops reading them (asked again when reopened). */
export function foldThreadLoad(send: SendThread, room: string, posts: string[]): void {
  if (!posts.length) return;
  set(Object.fromEntries(Object.entries(loads).filter(([key]) => !posts.some((post) => key === loadKey(room, post)))));
  send({ type: 'groupThread', requestId: `group-fold-${Date.now()}-${++seq}`, room, posts, mode: 'fold' });
}

/**
 * N1 safety net: a thread showing its spinner for ROOM_THREAD_SPIN_MAX_MS with nothing of it on its way (answered
 * without its replies, forgotten, whatever the cause) shows the retry line instead. A load still on its way keeps
 * its own timer (ROOM_THREAD_LOAD_MS). Returns the loads after it.
 */
export function stalledThread(room: string, posts: string[]): Loads {
  const keys = posts.map((post) => loadKey(room, post)).filter((key) => loads[key] !== ThreadLoad.pending);
  if (keys.length) set({ ...loads, ...Object.fromEntries(keys.map((key) => [key, ThreadLoad.failed])) });
  return loads;
}

/** The room was closed, or its socket is new (H3): its loads are let go, as the daemon let them go, and asked again. */
export function forgetRoomLoads(room: string): void {
  const prefix = loadKey(room, '');
  for (const [id, request] of asked)
    if (request.keys.some((key) => key.startsWith(prefix))) {
      clearTimeout(request.timer);
      asked.delete(id);
    }
  if (Object.keys(loads).some((key) => key.startsWith(prefix)))
    set(Object.fromEntries(Object.entries(loads).filter(([key]) => !key.startsWith(prefix))));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const useThreadLoads = (): Loads => useSyncExternalStore(subscribe, () => loads);
