import { describe, expect, it } from 'vitest';

import type { ChatSearchAllResult, GroupRoom, MessengerContact } from '../../../../core/src/messages.js';
import { searchAllQuery, searchAllRows } from './searchAllView.js';

const contact = (agentId: number, name: string) => ({ agentId, name, canSend: true, replies: [] }) as MessengerContact;
const room = (id: string, name: string): GroupRoom => ({ id, name, members: [] });
const hit = (id: string, at: number) => ({ id, at, kind: 'user' as const, snippet: id });

describe('overall text search in the messenger list', () => {
  it('searches from two characters on, ignoring the spaces around them', () => {
    expect(searchAllQuery('')).toBeNull();
    expect(searchAllQuery(' a ')).toBeNull();
    expect(searchAllQuery(' deploy ')).toBe('deploy');
  });

  it('names each group as the list does, keeps the daemon\'s order and drops a conversation the list lacks', () => {
    const groups: ChatSearchAllResult['groups'] = [
      { roomId: 'r1', hits: [hit('p', 9)], more: false },
      { agentId: 7, hits: [hit('a', 8), hit('b', 3)], more: true },
      { agentId: 99, hits: [hit('c', 2)], more: false },
      { roomId: 'gone', hits: [hit('d', 1)], more: false },
    ];
    const rows = searchAllRows(groups, [contact(7, 'alpha')], [room('r1', 'Launch team')]);
    expect(rows.map((r) => [r.key, r.name, r.hits.length, r.more])).toEqual([
      ['room:r1', 'Launch team', 1, false],
      ['lead:7', 'alpha', 2, true],
    ]);
    expect(rows[0].roomId).toBe('r1');
    expect(rows[1].agentId).toBe(7);
  });
});
