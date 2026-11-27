import { describe, expect, it } from 'vitest';

import { ROOM_FOLD_MAX } from '../../constants.js';
import { foldThread, isOpen, openThread, parseFold, unseenReplies } from './roomFold.js';
import { roomThreads, threadHolding } from './roomThreads.js';

describe('ROOM-FOLD: the fold state', () => {
  it('a thread is folded until the reader opens it, and an opened one is remembered', () => {
    expect(isOpen({}, 't1')).toBe(false);
    const s = openThread({}, 't1', 2);
    expect(isOpen(s, 't1')).toBe(true);
    expect(isOpen(s, 't2')).toBe(false);
    expect(openThread(s, 't1', 9)).toBe(s); // already open: nothing changes
  });

  it('replies after the reader last had the thread open are new; one never opened has nothing new', () => {
    expect(unseenReplies({}, 't1', 5)).toBe(0);
    const open = openThread({}, 't1', 2);
    expect(unseenReplies(open, 't1', 5)).toBe(0); // open: the reader sees them
    const folded = foldThread(open, 't1', 4); // folded by hand with 4 replies
    expect(isOpen(folded, 't1')).toBe(false);
    expect(unseenReplies(folded, 't1', 4)).toBe(0);
    expect(unseenReplies(folded, 't1', 7)).toBe(3);
    expect(unseenReplies(openThread(folded, 't1', 7), 't1', 7)).toBe(0);
  });

  it('keeps only the newest ROOM_FOLD_MAX threads, and touching one makes it the newest', () => {
    let s = openThread({}, 'first', 1);
    for (let i = 0; i < ROOM_FOLD_MAX - 1; i++) s = openThread(s, `t${i}`, 1);
    expect(Object.keys(s)).toHaveLength(ROOM_FOLD_MAX);
    expect(isOpen(s, 'first')).toBe(true);
    s = foldThread(s, 'first', 1); // newest now
    s = openThread(s, 'extra', 1); // pushes the oldest (t0) out
    expect(Object.keys(s)).toHaveLength(ROOM_FOLD_MAX);
    expect(isOpen(s, 't0')).toBe(false);
    expect(s.first).toEqual({ open: false, seen: 1 });
    expect(isOpen(s, 'extra')).toBe(true);
  });

  it('a stored value that is junk gives nothing opened, and the old fold map is not misread', () => {
    expect(parseFold('{"a":{"open":true,"seen":2},"b":"x","c":{"open":1,"seen":2},"d":{"open":false,"seen":-1}}')).toEqual({
      a: { open: true, seen: 2 },
    });
    expect(parseFold('{"old":3}')).toEqual({}); // the pre-T-105 shape (thread -> count when folded)
    expect(parseFold('not json')).toEqual({});
    expect(parseFold('[1]')).toEqual({});
    expect(parseFold(null)).toEqual({});
  });
});

describe('ROOM-FOLD: which thread holds a post', () => {
  const post = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, at: 1, sender: null, text: id, targets: [], delivery: {}, replies: [], ...over }) as never;
  it('finds the thread of a root, a reply post or a member reply item', () => {
    const posts = [
      post('root', { replies: [{ member: 'alpha', items: [{ id: 'item1', kind: 'assistant', text: 'x', at: 2 }] }] }),
      post('answer', { replyTo: { id: 'item1', text: 'x' } }),
      post('other'),
    ];
    const threads = roomThreads(posts);
    expect(threads).toHaveLength(2);
    expect(threadHolding(threads, 'item1')?.posts[0].id).toBe('root');
    expect(threadHolding(threads, 'answer')?.posts[0].id).toBe('root');
    expect(threadHolding(threads, 'other')?.posts[0].id).toBe('other');
    expect(threadHolding(threads, 'nope')).toBeUndefined();
  });
});
