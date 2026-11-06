import { describe, expect, it } from 'vitest';

import type { ChatItem, GroupPostItem } from '../../../../core/src/messages.js';
import { ROOM_WAITING_MS } from '../../constants.js';
import { roomThreads, threadReplies, threadTone } from './roomThreads.js';

const NOW = 1_800_000_000_000;
const said = (id: string, kind: ChatItem['kind'] = 'assistant'): ChatItem => ({ id, at: NOW - 1000, kind, text: id });
const post = (id: string, over: Partial<GroupPostItem> = {}): GroupPostItem => ({
  id,
  at: NOW - 60_000,
  text: id,
  targets: [],
  delivery: {},
  replies: [],
  ...over,
});
const tone = (...posts: GroupPostItem[]) => threadTone({ posts }, NOW);

describe('ROOM-THREADS: a thread\'s rail', () => {
  it('a tagged post every target answered is plain; one nobody answered waits', () => {
    const answered = post('p', { targets: ['alpha'], replies: [{ member: 'alpha', items: [said('a1')] }] });
    expect(tone(answered)).toBe('plain');
    expect(tone(post('p', { targets: ['alpha'], replies: [{ member: 'alpha', items: [] }] }))).toBe('waiting');
  });

  it('some targets answered, one not (or only with a tool line): it waits', () => {
    const partly = post('p', {
      targets: ['alpha', 'beta'],
      replies: [
        { member: 'alpha', items: [said('a1')] },
        { member: 'beta', items: [said('b1', 'tool')] },
      ],
    });
    expect(tone(partly)).toBe('waiting');
  });

  it('a notice is its own colour and never waits; an untagged post is plain', () => {
    expect(tone(post('p', { notice: true, targets: ['alpha', 'beta'] }))).toBe('notice');
    expect(tone(post('p'))).toBe('plain');
  });

  it('a day after the post, an unanswered tag no longer waits', () => {
    expect(tone(post('p', { targets: ['alpha'], at: NOW - ROOM_WAITING_MS }))).toBe('plain');
    expect(tone(post('p', { targets: ['alpha'], at: NOW - ROOM_WAITING_MS + 60_000 }))).toBe('waiting');
  });

  it('a thread waits while any post in it (an answer included) still waits', () => {
    const root = post('p', { targets: ['alpha'], replies: [{ member: 'alpha', items: [said('a1')] }] });
    expect(tone(root, post('q', { targets: ['alpha'], replyTo: { id: 'a1', text: 'a1' } }))).toBe('waiting');
    expect(tone(post('n', { notice: true, targets: ['alpha'] }), post('q', { replyTo: { id: 'n', text: 'n' } }))).toBe('notice');
  });
});

describe('ROOM-THREADS: threads', () => {
  it('a reply to a post or to a member reply in it joins that thread, also through a chain', () => {
    const root = post('p1', { targets: ['alpha'], replies: [{ member: 'alpha', items: [said('a1')] }] });
    const other = post('p2');
    const onRoot = post('p3', { replyTo: { id: 'p1', text: 'p1' } });
    const onMember = post('p4', { replyTo: { id: 'a1', sender: 'alpha', text: 'a1' }, targets: ['alpha'], replies: [{ member: 'alpha', items: [said('a2')] }] });
    const onAnswer = post('p5', { replyTo: { id: 'a2', sender: 'alpha', text: 'a2' } });
    const ids = roomThreads([root, other, onRoot, onMember, onAnswer]).map((t) => t.posts.map((p) => p.id));
    expect(ids).toEqual([['p1', 'p3', 'p4', 'p5'], ['p2']]);
  });

  it('a reply whose target is not shown starts its own thread; a system line never joins one', () => {
    const lost = post('p1', { replyTo: { id: 'gone', text: 'old' } });
    const system = post('s1', { system: true, replyTo: { id: 'p1', text: 'p1' } });
    expect(roomThreads([lost, system]).map((t) => t.posts.map((p) => p.id))).toEqual([['p1'], ['s1']]);
  });
});

describe('ROOM-FOLD: what a folded thread says', () => {
  const at = (n: number, over: Partial<ChatItem> = {}): ChatItem => ({ ...said(`i${n}`), at: NOW + n, ...over });
  it('counts the members\' lines and the reply posts, and names the last speaker', () => {
    const root = post('p', {
      targets: ['alpha', 'beta'],
      replies: [
        { member: 'alpha', items: [at(1), at(2, { kind: 'tool' })] },
        { member: 'beta', items: [at(5)] },
      ],
    });
    const answer = post('q', { at: NOW + 3, sender: undefined, replyTo: { id: 'i1', text: 'x' } });
    expect(threadReplies({ posts: [root, answer] })).toEqual({ count: 3, last: { name: 'beta', at: NOW + 5 } });
    expect(threadReplies({ posts: [root, answer, post('r', { at: NOW + 9, sender: 'alpha' })] }).last).toEqual({ name: 'alpha', at: NOW + 9 });
  });

  it('a thread nobody answered has no replies and no last speaker', () => {
    expect(threadReplies({ posts: [post('p')] })).toEqual({ count: 0, last: null });
  });
});
