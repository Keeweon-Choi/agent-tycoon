/**
 * REST-ANIM: a character whose 휴식 (compaction) count goes up while this screen watches plays a
 * short drink at its mouth (theme.ts picks the drink). A count first seen (page load) or replayed
 * by a reconnect is only a baseline. Idle costs one Map lookup per character per frame.
 */
import {
  ACTIVITY_PROP_FRAME_SEC,
  REST_ANIM_SEC,
  REST_LIFT_SEC,
  REST_SETTLE_MS,
} from '../constants.js';
import type { SpriteData } from '../office/types.js';
import { HUMAN_SIP } from './characters/compose.js';
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

/** The drink's frame \`sec\` into a rest moment: lifted, sipped (two frames), lowered. */
export function restFrame(drink: Drink, sec: number): SpriteData {
  const { frames } = REST_SPRITES[drink];
  if (sec < REST_LIFT_SEC || sec >= REST_ANIM_SEC - REST_LIFT_SEC) return frames[0];
  return frames[1 + (Math.floor(sec / ACTIVITY_PROP_FRAME_SEC) % 2)];
}

const sips = new Map<number, readonly [number, number]>();
/** The mouth of a composed look's palette (looks.ts), for the drink. */
export const setSipAnchor = (palette: number, sip: readonly [number, number]) =>
  void sips.set(palette, sip);
export const sipAnchorOf = (palette: number): readonly [number, number] =>
  sips.get(palette) ?? HUMAN_SIP;

export class RestWatch {
  private readonly seen = new Map<number, number>();
  private readonly started = new Map<number, number>();
  private quietUntil = -Infinity;

  /** A (re)connect handshake: what comes next is the daemon's replay, not news. */
  connected(nowMs: number): void {
    this.seen.clear();
    this.quietUntil = nowMs + REST_SETTLE_MS;
  }

  /** A character's 휴식 count as the screen sees it now. True when its rest moment starts. */
  observe(id: number, count: number, nowMs: number): boolean {
    const before = this.seen.get(id);
    this.seen.set(id, count);
    if (before === undefined || count <= before || nowMs < this.quietUntil) return false;
    this.started.set(id, nowMs);
    return true;
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
