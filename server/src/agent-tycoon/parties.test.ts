import * as fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PARTY_ID_MAX,
  PARTY_MAX,
  PARTY_MEMBER_KEY_MAX,
  PARTY_MEMBER_MAX,
  PARTY_NAME_MAX,
} from '../../../core/src/constants.js';
import type { Parties } from '../../../core/src/messages.js';
import { ROSTER, startEngineOffice } from './officeTestKit.js';
import { cleanParties } from './parties.js';

afterEach(() => vi.restoreAllMocks());

const latest = (list: Array<Record<string, unknown>>) =>
  ([...list].reverse().find((m) => m.type === 'parties') as unknown as Parties | undefined)?.parties;

describe('parties (FEAT-PARTY-V2)', () => {
  it('a change reaches everyone, is written 0600 and survives a restart', async () => {
    const first = await startEngineOffice({ projects: ROSTER });
    const send = vi.fn();
    const save = (parties: unknown) =>
      first.office.onClientMessage({ type: 'setParties', parties }, send, true, 'ua');
    save([{ id: 'p1', name: '  front  ', members: ['alpha', 'beta', 'alpha'] }]);
    expect(latest(first.messages)).toEqual([{ id: 'p1', name: 'front', members: ['alpha', 'beta'] }]);
    save([
      { id: 'p1', name: 'front', members: ['beta'] },
      { id: 'p2', name: 'back', members: [] },
    ]);
    const file = `${first.home}/.config/agent-tycoon/parties.json`;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const home = first.home;
    first.stop();
    const again = await startEngineOffice({ projects: ROSTER, home });
    const got: Array<Record<string, unknown>> = [];
    again.office.onClientReady((m: Record<string, unknown>) => got.push(m));
    expect(latest(got)).toEqual([
      { id: 'p1', name: 'front', members: ['beta'] },
      { id: 'p2', name: 'back', members: [] },
    ]);
    again.stop();
  });

  it('always sent at ready, empty too (a reconnecting phone drops parties deleted meanwhile)', async () => {
    const o = await startEngineOffice({ projects: ROSTER });
    const got: Array<Record<string, unknown>> = [];
    o.office.onClientReady((m: Record<string, unknown>) => got.push(m));
    expect(latest(got)).toEqual([]);
    o.stop();
  });

  it('a read-only client or a bad list is refused and told what is kept', async () => {
    const o = await startEngineOffice({ projects: ROSTER });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => sent.push(m);
    const ok = [{ id: 'p1', name: 'a', members: [] }];
    o.office.onClientMessage({ type: 'setParties', parties: ok }, send, false, 'ua');
    o.office.onClientMessage({ type: 'setParties', parties: 'x' }, send, true, 'ua');
    expect(latest(sent)).toEqual([]);
    expect(latest(o.messages)).toBeUndefined();
    o.stop();
  });

  it('cleanParties refuses the default id, duplicates, empty names and junk members', () => {
    expect(typeof cleanParties([{ id: 'all', name: 'x', members: [] }])).toBe('string');
    expect(typeof cleanParties([{ id: 'a', name: 'x', members: [] }, { id: 'a', name: 'y', members: [] }])).toBe('string');
    expect(typeof cleanParties([{ id: 'a', name: '   ', members: [] }])).toBe('string');
    expect(typeof cleanParties([{ id: 'a', name: 'x', members: [3] }])).toBe('string');
    expect(typeof cleanParties([{ id: 'a', name: 'x', members: [''] }])).toBe('string');
    expect(typeof cleanParties(Array.from({ length: PARTY_MAX + 1 }, (_, i) => ({ id: `p${i}`, name: 'x', members: [] })))).toBe('string');
    expect(cleanParties([])).toEqual([]);
  });

  it('each limit holds at its edge and refuses one past it', () => {
    const one = (p: Record<string, unknown>) => cleanParties([{ id: 'p', name: 'x', members: [], ...p }]);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: 'x', members: [] }));
    expect(cleanParties(many(PARTY_MAX))).toHaveLength(PARTY_MAX);
    expect(typeof cleanParties(many(PARTY_MAX + 1))).toBe('string');
    expect(typeof one({ id: 'i'.repeat(PARTY_ID_MAX) })).not.toBe('string');
    expect(typeof one({ id: 'i'.repeat(PARTY_ID_MAX + 1) })).toBe('string');
    expect(typeof one({ name: 'n'.repeat(PARTY_NAME_MAX) })).not.toBe('string');
    expect(typeof one({ name: 'n'.repeat(PARTY_NAME_MAX + 1) })).toBe('string');
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
    expect(typeof one({ members: keys(PARTY_MEMBER_MAX) })).not.toBe('string');
    expect(typeof one({ members: keys(PARTY_MEMBER_MAX + 1) })).toBe('string');
    expect(typeof one({ members: ['k'.repeat(PARTY_MEMBER_KEY_MAX)] })).not.toBe('string');
    expect(typeof one({ members: ['k'.repeat(PARTY_MEMBER_KEY_MAX + 1)] })).toBe('string');
  });
});
