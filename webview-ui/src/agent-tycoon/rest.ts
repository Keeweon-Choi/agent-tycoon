/**
 * REST-ANIM: a character whose 휴식 (compaction) count goes up while this screen watches takes a
 * coffee break (agent-tycoon/director), or with no machine on its floor a short drink at its mouth
 * (theme.ts picks the drink). A count first seen (page load) or replayed
 * by a reconnect is only a baseline. Idle costs one Map lookup per character per frame.
 */
import {
  ACTIVITY_PROP_FRAME_SEC,
  ISO8_DRINK_CELLS,
  PALETTE_COUNT,
  REST_ANIM_SEC,
  REST_LIFT_SEC,
  REST_SETTLE_MS,
} from '../constants.js';
import type { SpriteData } from '../office/types.js';
import { BUILT_IN_SIP, HUMAN_SIP } from './characters/compose.js';
import propData from './ez/props.json';

type Drink = 'coffee' | 'energy';
const palette: Record<string, string> = propData.palette;
/** The drinks (props.json `rest`): `at` is the top-left corner from the mouth (sip anchor). */
export const REST_SPRITES = Object.fromEntries(
  Object.entries(propData.rest).map(([id, s]) => [
    id,
    {
      at: s.at as [number, number],
      frames: s.frames.map((rows) =>
        rows.map((row) => [...row].map((k) => (k === '.' ? '' : palette[k]))),
      ),
    },
  ]),
) as Record<Drink, { at: [number, number]; frames: SpriteData[] }>;

/** The stage `sec` into a drink of `total` s: 0 lifted (and lowered for the last
 *  REST_LIFT_SEC), 1 and 2 the two sips in turn. */
export function sipStage(sec: number, total: number = REST_ANIM_SEC): 0 | 1 | 2 {
  if (sec < REST_LIFT_SEC || sec >= total - REST_LIFT_SEC) return 0;
  return (1 + (Math.floor(sec / ACTIVITY_PROP_FRAME_SEC) % 2)) as 1 | 2;
}

/** The drink's frame \`sec\` into a rest moment: lifted, sipped (two frames), lowered. */
export function restFrame(drink: Drink, sec: number): SpriteData {
  return REST_SPRITES[drink].frames[sipStage(sec)];
}

/** C1: a sheet's drinking poses (an iso8 sheet's 6th row) by the palette of its three-quarter
 *  view: `cells` coffee lifted, sipping, sipping with eyes closed, then the same with a can;
 *  `steam` where a held cup's steam rises in each (px of the sheet's cell, or null: no cup's
 *  surface shows, or a can). */
export interface DrinkCells {
  cells: SpriteData[];
  steam: ReadonlyArray<readonly [number, number] | null>;
}
const drinkCells = new Map<number, DrinkCells>();
export const setDrinkCells = (palette: number, d: DrinkCells) => void drinkCells.set(palette, d);
/** LOOKS-MEM: its sheet was let go. */
export const forgetDrinkCells = (palette: number) => void drinkCells.delete(palette);
export const drinkCellsOf = (palette: number): DrinkCells | undefined => drinkCells.get(palette);

/** C1: the drink row's cell (0-5) `sec` into a drink of `total` s: the rest moment's
 *  lifted, sipped, lowered (sipStage), the coffee's three cells or the can's. */
export const drinkCell = (drink: 'coffee' | 'can', sec: number, total: number): number =>
  (drink === 'can' ? ISO8_DRINK_CELLS / 2 : 0) + sipStage(sec, total);

const sips = new Map<number, readonly [number, number]>();
/** The mouth of a composed look's palette (looks.ts), for the drink; a built-in person's (palettes
 *  below CHAR_COUNT) is theirs, any other (an external char_N, a preset sheet) the old body's. */
export const setSipAnchor = (palette: number, sip: readonly [number, number]) =>
  void sips.set(palette, sip);
export const sipAnchorOf = (palette: number): readonly [number, number] =>
  sips.get(palette) ?? (palette < PALETTE_COUNT ? BUILT_IN_SIP : HUMAN_SIP);

export class RestWatch {
  private readonly seen = new Map<number, number>();
  private readonly started = new Map<number, number>();
  private quietUntil = -Infinity;

  /** A (re)connect handshake: what comes next is the daemon's replay, not news. */
  connected(nowMs: number): void {
    this.seen.clear();
    this.quietUntil = nowMs + REST_SETTLE_MS;
  }

  /** A character's count (휴식, or 환생 for C1) as the screen sees it now. True: it went up live
   *  (the caller hands the moment to the director, agent-tycoon/director). */
  observe(id: number, count: number, nowMs: number): boolean {
    const before = this.seen.get(id);
    this.seen.set(id, count);
    return before !== undefined && count > before && nowMs >= this.quietUntil;
  }

  /** The drink at the mouth starts now (C1: the coffee break with no machine on the floor). */
  sip(id: number, nowMs: number): void {
    this.started.set(id, nowMs);
  }

  /** Seconds into the character's rest moment, or null (none, or over). */
  progress(id: number, nowMs: number): number | null {
    const t0 = this.started.get(id);
    if (t0 === undefined) return null;
    const sec = (nowMs - t0) / 1000;
    if (sec < REST_ANIM_SEC) return sec;
    this.started.delete(id);
    return null;
  }
}

export const restWatch = new RestWatch();
/** C1: the 환생 count (the stats view's rebirth flames), watched the same way. */
export const rebirthWatch = new RestWatch();
/** C1-FX2: the Lv (a level-up burst), watched the same way. */
export const levelWatch = new RestWatch();
/** COMPACT-COFFEE: the characters whose agent compacts its conversation now (their coffee break
 *  drinks on meanwhile, actions.ts); officeStore refills it from each snapshot. */
export const compactHolds = new Set<number>();
