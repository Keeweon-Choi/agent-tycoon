import { describe, expect, it } from 'vitest';

import { OfficeState } from '../../office/engine/officeState.js';
import { type OfficeLayout, TileType } from '../../office/types.js';
import { characterDrawns, isoScene } from './render.js';

const layout = (): OfficeLayout => ({
  version: 1,
  cols: 6,
  rows: 6,
  tiles: new Array(36).fill(TileType.FLOOR_1),
  furniture: [],
});

describe('the isometric hit list', () => {
  it('B7.5: a character that is despawning cannot be picked', () => {
    const os = new OfficeState(layout());
    os.addAgent(1, 0, 0, undefined, true);
    const { stack } = isoScene(os);
    const draw = () =>
      characterDrawns(
        os.getCharacters(),
        stack,
        stack.floors[0],
        { selected: null, hovered: null, follow: null },
        1,
      );
    expect(draw().map((d) => d.hit?.id)).toEqual([1]);
    os.removeAgent(1);
    expect(os.getCharacters()).toHaveLength(1); // still drawn for the effect
    expect(draw().filter((d) => d.hit)).toEqual([]);
  });
});
