/**
 * BACKGROUND: the isometric office's surroundings as a setting the daemon keeps for every screen:
 * when the sky is day (the host's clock, always, never), what stands around the building, and the
 * seed that places it. Pure; the daemon validates what a client sends with it, and the screen
 * reads what the daemon sent with it.
 */
import type { BackgroundMix, BackgroundTime, OfficeBackground } from '../messages.js';

export const BACKGROUND_TIMES: readonly BackgroundTime[] = ['clock', 'day', 'night'];
export const BACKGROUND_MIXES: readonly BackgroundMix[] = ['houses', 'towers', 'mixed'];
export const BACKGROUND_SEED_MAX = 2147483647;

export type BackgroundSettings = Pick<OfficeBackground, 'time' | 'mix' | 'seed'>;

export const DEFAULT_BACKGROUND: BackgroundSettings = { time: 'clock', mix: 'mixed', seed: 1101 };

/** `raw` as settings, or null when any field is missing or out of range. */
export function parseBackground(raw: unknown): BackgroundSettings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { time, mix, seed } = raw as Record<string, unknown>;
  if (!BACKGROUND_TIMES.includes(time as BackgroundTime)) return null;
  if (!BACKGROUND_MIXES.includes(mix as BackgroundMix)) return null;
  if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > BACKGROUND_SEED_MAX)
    return null;
  return { time: time as BackgroundTime, mix: mix as BackgroundMix, seed: seed as number };
}

/** A new seed: any whole number but the one in use. */
export function nextSeed(current: number, random: () => number = Math.random): number {
  const seed = Math.floor(random() * (BACKGROUND_SEED_MAX + 1));
  return seed === current ? (seed + 1) % (BACKGROUND_SEED_MAX + 1) : seed;
}
