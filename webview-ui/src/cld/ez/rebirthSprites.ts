/**
 * STAT-2: the rebirth mark, a soul flame in two flicker frames and a small sparkle, drawn in code.
 * Keys: o outer, y inner, x sparkle.
 */
import { REBIRTH_COLORS } from '../../constants.js';
import type { SpriteData } from '../../office/types.js';

const FLAME_A = ['...o...', '..oo...', '..ooo..', '.ooooo.', '.ooyoo.', 'oooyyoo', 'oooyyoo', '.oyyyo.', '..ooo..'];
const FLAME_B = ['...o...', '...oo..', '..ooo..', '.ooooo.', '.oyooo.', 'oooyyoo', 'oooyyoo', '.oyyyo.', '..ooo..'];
const SPARK = ['.x.', 'xxx', '.x.'];

const colors: Record<string, string> = {
  o: REBIRTH_COLORS.outer,
  y: REBIRTH_COLORS.inner,
  x: REBIRTH_COLORS.spark,
};
const toSprite = (rows: string[]): SpriteData => rows.map((row) => [...row].map((c) => (c === '.' ? '' : colors[c])));

export const REBIRTH_FLAME_A = toSprite(FLAME_A);
export const REBIRTH_FLAME_B = toSprite(FLAME_B);
export const REBIRTH_SPARK = toSprite(SPARK);
