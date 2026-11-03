import { describe, expect, it } from 'vitest';

import { REST_ANIM_SEC, REST_LIFT_SEC } from '../constants.js';
import { DRINK_SEC } from './lounge.js';
import { drinkCell } from './rest.js';

describe('C1: the drink row cell a drinking character shows', () => {
  it('lifts, sips with eyes open and closed in turn, and lowers, as the rest moment does', () => {
    const cells = [0, REST_LIFT_SEC + 0.01, 0.75, 1.1, REST_ANIM_SEC - 0.1].map((t) =>
      drinkCell('coffee', t, REST_ANIM_SEC),
    );
    expect(cells[0]).toBe(0);
    expect(new Set(cells.slice(1, 4))).toEqual(new Set([1, 2]));
    expect(cells[4]).toBe(0);
  });
  it('takes the can cells (4-6) for a can, over the lounge drink as long', () => {
    expect(drinkCell('can', 0, DRINK_SEC)).toBe(3);
    expect([4, 5]).toContain(drinkCell('can', DRINK_SEC / 2, DRINK_SEC));
    expect(drinkCell('can', DRINK_SEC - 0.1, DRINK_SEC)).toBe(3);
  });
});
