import { describe, expect, it } from 'vitest';

import { TURN_DELIVERIES_MAX, TURN_PENDING_MS, TurnLedger } from './turnLedger.js';

const ROOM = {
  messageId: 'aaaaaaaa',
  group: { roomId: 'r1', roomName: '출시팀', messageId: 'p1' },
};

describe('C3: TurnLedger', () => {
  it('the newest typed message decides the agent turn; a seen turn is the transcript to say', () => {
    const ledger = new TurnLedger();
    ledger.typed('alpha', ROOM);
    expect(ledger.unseen('alpha')).toEqual({ room: { id: 'r1', name: '출시팀', post: 'p1' } });
    ledger.seen('alpha', 'bbbbbbbb'); // another turn's mark
    expect(ledger.unseen('alpha')).toBeDefined();
    ledger.seen('alpha', 'aaaaaaaa');
    expect(ledger.unseen('alpha')).toBeUndefined();
    expect(ledger.current('alpha')).toMatchObject({ name: '출시팀' }); // still the newest typed turn
    expect(ledger.current('beta')).toBeUndefined(); // nothing typed this run: the caller reads the transcript
  });

  it('an unseen turn that never shows is dropped after a while', () => {
    let now = 0;
    const ledger = new TurnLedger(() => now);
    ledger.typed('alpha', ROOM);
    now = TURN_PENDING_MS - 1;
    expect(ledger.unseen('alpha')).toBeDefined();
    now = TURN_PENDING_MS;
    expect(ledger.unseen('alpha')).toBeUndefined();
  });

  it('remembers the room of a delivery id, a DM as null, and forgets the oldest past the cap', () => {
    const ledger = new TurnLedger();
    ledger.typed('alpha', ROOM);
    ledger.typed('alpha', { messageId: 'dmdmdmdm' });
    expect(ledger.classify('aaaaaaaa')).toMatchObject({ post: 'p1' });
    expect(ledger.classify('dmdmdmdm')).toBeNull();
    expect(ledger.classify('zzzzzzzz')).toBeUndefined();
    expect(ledger.classify(undefined)).toBeUndefined();
    for (let i = 0; i < TURN_DELIVERIES_MAX; i++) ledger.typed('beta', { messageId: `m${i}` });
    expect(ledger.classify('aaaaaaaa')).toBeUndefined();
  });

  it('tells its listener at every typing', () => {
    const ledger = new TurnLedger();
    const told: string[] = [];
    ledger.onChange = (agent) => told.push(agent);
    ledger.typed('alpha', ROOM);
    ledger.typed('alpha', { inbox: ['x.md'] });
    expect(told).toEqual(['alpha', 'alpha']);
  });
});
