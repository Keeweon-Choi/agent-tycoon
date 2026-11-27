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
const layout = (mineCol: number): OfficeLayout & { agtySeats: Record<string, string | null> } => ({
  version: 1,
  cols: 8,
  rows: 3,
  tiles: new Array(24).fill(TileType.FLOOR_1),
  furniture: [
    { uid: 'seat:a2', type: 'CHAIR', col: 1, row: 1 },
    { uid: 'mine', type: 'CHAIR', col: mineCol, row: 1 },
    { uid: 'spare', type: 'CHAIR', col: 6, row: 1 },
  ],
  agtySeats: { 'seat:a1': 'mine', 'seat:a3': null },
});

describe('agtySeats', () => {
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
    back.agtySeats = {};
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

  it('B7.3: a rebuild while an agent despawns never gives its old chair back to it', () => {
    const one = (): OfficeLayout => ({
      version: 1,
      cols: 8,
      rows: 3,
      tiles: new Array(24).fill(TileType.FLOOR_1),
      furniture: [{ uid: 'seat:a', type: 'CHAIR', col: 1, row: 1 }],
    });
    const office = new OfficeState(one());
    office.addAgent(1, 0, 0, 'seat:a', true);
    office.removeAgent(1);
    office.addAgent(2, 0, 0, 'seat:a', true);
    expect(office.characters.get(2)!.seatId).toBe('seat:a');
    office.rebuildFromLayout(one());
    for (let t = 0; t < 1; t += 0.05) office.update(0.05);
    expect(office.characters.has(1)).toBe(false);
    expect(office.characters.get(2)!.seatId).toBe('seat:a');
    expect(office.seats.get('seat:a')!.assigned).toBe(true);
    // The same for a sub-agent that is removed: its seat is gone with it.
    const two = (): OfficeLayout => ({
      ...one(),
      furniture: [
        { uid: 'seat:a', type: 'CHAIR', col: 1, row: 1 },
        { uid: 'seat:b', type: 'CHAIR', col: 2, row: 1 },
      ],
    });
    const o2 = new OfficeState(two());
    o2.addAgent(5, 0, 0, 'seat:a', true);
    const sub = o2.addSubagent(5, 'tu');
    o2.reassignSeat(sub, 'seat:b'); // the staff director seats a temp
    expect(o2.characters.get(sub)!.seatId).toBe('seat:b');
    o2.removeSubagent(5, 'tu');
    o2.addAgent(6, 0, 0, 'seat:b', true);
    o2.rebuildFromLayout(two());
    for (let t = 0; t < 1; t += 0.05) o2.update(0.05);
    expect(o2.characters.has(sub)).toBe(false);
    expect(o2.characters.get(6)!.seatId).toBe('seat:b');
    expect(o2.characters.get(5)!.seatId).toBe('seat:a');
  });
});
