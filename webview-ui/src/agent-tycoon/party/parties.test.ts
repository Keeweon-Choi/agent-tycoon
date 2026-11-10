import { describe, expect, it } from 'vitest';

import { PARTY_MAX, PARTY_MEMBER_MAX } from '../../../../core/src/constants.js';


const {
  ALL_PARTY,
  createParty,
  currentParty,
  deleteParty,
  partiesHandleMessage,
  partiesNow,
  partyIds,
  renameParty,
  saveParties,
  selectedNow,
  selectParty,
  toggleMember,
} = await import('./parties.js');

describe('the party model (FEAT-PARTY-V2)', () => {
  it('create, rename, add and remove a member, delete', () => {
    let list = createParty([], '  front ', 'p1');
    expect(list).toEqual([{ id: 'p1', name: 'front', members: [] }]);
    list = toggleMember(list, 'p1', 'alpha');
    list = toggleMember(list, 'p1', 'beta');
    expect(list[0].members).toEqual(['alpha', 'beta']);
    list = toggleMember(list, 'p1', 'alpha');
    expect(list[0].members).toEqual(['beta']);
    list = renameParty(list, 'p1', 'back');
    expect(list[0].name).toBe('back');
    expect(renameParty(list, 'p1', '   ')[0].name).toBe('back'); // a blank name keeps the old one
    expect(deleteParty(list, 'p1')).toEqual([]);
  });

  it('no unnamed, duplicate, default-id or one-too-many party', () => {
    const one = createParty([], 'a', 'p1');
    expect(createParty(one, ' ', 'p2')).toEqual(one);
    expect(createParty(one, 'b', 'p1')).toEqual(one);
    expect(createParty(one, 'b', ALL_PARTY)).toEqual(one);
    let full: ReturnType<typeof createParty> = [];
    for (let i = 0; i < PARTY_MAX; i++) full = createParty(full, `n${i}`, `p${i}`);
    expect(createParty(full, 'more', 'pX')).toHaveLength(PARTY_MAX);
  });

  it('no member past the cap; a member already in can still leave', () => {
    const keys = Array.from({ length: PARTY_MEMBER_MAX }, (_, i) => `m${i}`);
    const full = [{ id: 'p', name: 'x', members: keys }];
    expect(toggleMember(full, 'p', 'one-more')[0].members).toHaveLength(PARTY_MEMBER_MAX);
    expect(toggleMember(full, 'p', 'm0')[0].members).toHaveLength(PARTY_MEMBER_MAX - 1);
  });

  it('the default party is everyone; a composed one shows its members in the column order', () => {
    const keys: Record<number, string> = { 1: 'alpha', 2: 'beta', 3: 'gamma' };
    const keyOf = (id: number) => keys[id];
    expect(partyIds([3, 1, 2], null, keyOf)).toEqual([3, 1, 2]);
    expect(partyIds([3, 1, 2, 4], { id: 'p', name: 'x', members: ['beta', 'gamma', 'gone'] }, keyOf)).toEqual([3, 2]);
    const list = [{ id: 'p', name: 'x', members: [] }];
    expect(currentParty(list, 'p')?.id).toBe('p');
    expect(currentParty(list, 'deleted')).toBeNull(); // a deleted party falls back to everyone
    expect(currentParty(list, null)).toBeNull();
  });

  it('round trip: an edit goes out whole, the daemon answer replaces the list, the choice stays on this device', () => {
    const sent: unknown[] = [];
    saveParties([{ id: 'p1', name: 'a', members: ['alpha'] }], (m) => sent.push(m));
    expect(sent).toEqual([{ type: 'setParties', parties: [{ id: 'p1', name: 'a', members: ['alpha'] }] }]);
    expect(partiesNow()).toHaveLength(1); // applied here at once
    partiesHandleMessage({ type: 'parties', parties: [{ id: 'p2', name: 'b', members: [] }] });
    expect(partiesNow()).toEqual([{ id: 'p2', name: 'b', members: [] }]);
    selectParty('p2');
    expect(selectedNow()).toBe('p2');
    selectParty(ALL_PARTY);
    expect(selectedNow()).toBeNull(); // the default party: nothing kept
  });
});
