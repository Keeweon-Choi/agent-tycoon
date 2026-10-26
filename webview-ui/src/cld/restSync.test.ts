import { describe, expect, it } from 'vitest';

import { OfficeState } from '../office/engine/officeState.js';
import { type OfficeLayout, TileType } from '../office/types.js';
import { syncUnattachedActive } from './restSync.js';

const VIRTUAL = -1_000_000_000; // virtualAgentId(): an orchestrator with no live agent

const resting = (busy: boolean | null) => {
  const tiles: TileType[] = Array.from({ length: 3 * 8 }, () => TileType.FLOOR_1);
  const layout: OfficeLayout = { version: 1, cols: 8, rows: 3, tiles, furniture: [] };
  const office = new OfficeState(layout);
  office.addAgent(VIRTUAL, 0, 0, undefined, true, 'cex'); // what the officeSnapshot path does
  const ch = office.characters.get(VIRTUAL)!;
  office.selectedAgentId = VIRTUAL;
  syncUnattachedActive(office, [{ id: VIRTUAL, busy }]);
  return { office, ch };
};

describe('REST-BUSY: a resting orchestrator is not at work', () => {
  it('can be walked by the owner when its row is not busy (rest or off)', () => {
    const { office, ch } = resting(false);
    expect(ch.isActive).toBe(false);
    expect(office.walkSelectedStep('right')).not.toBe('active');
    expect(resting(null).ch.isActive).toBe(false);
  });

  it('stays at its desk when its row is busy', () => {
    const { office, ch } = resting(true);
    expect(ch.isActive).toBe(true);
    expect(office.walkSelectedStep('right')).toBe('active');
  });

  it('leaves one that is away to staff.ts', () => {
    const { office, ch } = resting(false);
    ch.cldAway = true;
    ch.isActive = false;
    syncUnattachedActive(office, [{ id: VIRTUAL, busy: true }]);
    expect(ch.isActive).toBe(false);
  });
});
