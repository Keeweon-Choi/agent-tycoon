import { beforeAll, describe, expect, it } from 'vitest';

import { OfficeState } from '../office/engine/officeState.js';
import type { LoadedAssetData } from '../office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js';
import { type OfficeLayout, TileType } from '../office/types.js';

beforeAll(() => {
  const chair: LoadedAssetData['catalog'][number] = {
    id: 'CHAIR',
    label: 'CHAIR',
    category: 'chairs',
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
  };
  expect(buildDynamicCatalog({ catalog: [chair], sprites: { CHAIR: [['']] } })).toBe(true);
});

// T-0066: the server names the chair for a member whose own chair the user removed.
const layout = (mineCol: number): OfficeLayout & { cldSeats: Record<string, string | null> } => ({
  version: 1,
  cols: 8,
  rows: 3,
  tiles: new Array(24).fill(TileType.FLOOR_1),
  furniture: [
    { uid: 'seat:a2', type: 'CHAIR', col: 1, row: 1 },
    { uid: 'mine', type: 'CHAIR', col: mineCol, row: 1 },
    { uid: 'spare', type: 'CHAIR', col: 6, row: 1 },
  ],
  cldSeats: { 'seat:a1': 'mine', 'seat:a3': null },
});

describe('cldSeats', () => {
  it('seats a member at the named chair, or nowhere, and keeps it across a re-sent office', () => {
    const office = new OfficeState(layout(4));
    office.addAgent(1, 0, 0, 'seat:a1', true);
    office.addAgent(3, 0, 0, 'seat:a3', true);
    office.addAgent(2, 0, 0, 'seat:a2', true);
    expect(office.characters.get(1)!.seatId).toBe('mine');
    expect(office.characters.get(3)!.seatId).toBeNull(); // 'spare' stays free
    expect(office.characters.get(2)!.seatId).toBe('seat:a2');
    office.rebuildFromLayout(layout(5));
    expect(office.characters.get(1)!.seatId).toBe('mine');
    expect(office.characters.get(1)!.tileCol).toBe(5);
    expect(office.characters.get(3)!.seatId).toBeNull();
    // The chair back (a reset): its member sits there again.
    const back = layout(5);
    back.furniture.push({ uid: 'seat:a3', type: 'CHAIR', col: 3, row: 2 });
    back.cldSeats = {};
    office.rebuildFromLayout(back);
    expect(office.characters.get(3)!.seatId).toBe('seat:a3');
  });

  it('a member whose chair was not in the office yet takes it once an office has it (ELEVATOR)', () => {
    const office = new OfficeState(layout(4));
    office.addAgent(9, 0, 0, 'seat:late', true);
    expect(office.characters.get(9)!.seatId).not.toBe('seat:late'); // a free one meanwhile
    const later = layout(4);
    later.furniture.push({ uid: 'seat:late', type: 'CHAIR', col: 7, row: 2 });
    office.rebuildFromLayout(later);
    const ch = office.characters.get(9)!;
    expect([ch.seatId, ch.tileCol, ch.tileRow]).toEqual(['seat:late', 7, 2]);
  });
});
