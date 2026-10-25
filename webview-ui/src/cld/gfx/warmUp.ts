/**
 * SHEET-IMPORT (owner 10-26 02:14): while the lobby shows (and, when it is skipped, in idle time
 * after the office shows), every office character's frames and every furniture sprite are built
 * for the office's zoom and the follow zoom, a slice at a time (smoothSprite.ts's queue), so the
 * office starts with its pictures ready. Entering early never waits: the rest goes on in idle
 * time, and the pictures are the same caches the office draws from afterwards.
 */
import { useEffect, useSyncExternalStore } from 'react';

import { CAMERA_FOLLOW_ZOOM_STEPS, ZOOM_MAX } from '../../constants.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { forgetWarm, warmOnce } from '../../office/sprites/smoothSprite.js';
import { getCachedSprite } from '../../office/sprites/spriteCache.js';
import { getCharacterSprites, spritesAtZoom } from '../../office/sprites/spriteData.js';
import { framesOf } from '../../office/sprites/warm.js';
import { useLooksUi } from '../characters/looks.js';
import { dimmedSprite } from '../ez/drawVisuals.js';

/** Progress refreshes the lobby's line at most every this many pictures. */
const NOTIFY_EVERY = 8;

let progress = { done: 0, total: 0 };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
export const useWarmUp = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => progress,
  );

/** One lobby batch replaces the prior one when the view or looks change, so abandoned zooms and
 * departed characters cannot accumulate work. */
const lobbyOwner = {};

function warmUp(os: OfficeState, zoom: number): void {
  const zooms = [...new Set([zoom, Math.min(ZOOM_MAX, zoom + CAMERA_FOLLOW_ZOOM_STEPS)])];
  const jobs: Array<() => void> = [];
  for (const z of zooms) {
    for (const ch of os.characters.values()) {
      const sprites = spritesAtZoom(getCharacterSprites(ch.palette, ch.hueShift), z);
      const scale = z / sprites.density;
      for (const f of framesOf(sprites))
        jobs.push(() => {
          getCachedSprite(f, scale);
          getCachedSprite(dimmedSprite(f), scale);
        });
    }
    for (const f of os.furniture) jobs.push(() => getCachedSprite(f.sprite, z));
  }
  if (!jobs.length) return;
  progress = { done: 0, total: jobs.length };
  notify();
  forgetWarm(lobbyOwner);
  warmOnce(lobbyOwner, zoom, () =>
    jobs.map((job) => () => {
      job();
      const done = progress.done + 1;
      progress = { done, total: progress.total };
      if (done % NOTIFY_EVERY === 0 || done === progress.total) notify();
    }),
  );
}

/** Warm the office up for `zoom` once its layout is in (again when looks or the zoom change:
 *  only what is new is queued). */
export function useOfficeWarmUp(
  getOfficeState: () => OfficeState,
  zoom: number,
  layoutReady: boolean,
): void {
  const { version } = useLooksUi();
  useEffect(() => {
    if (layoutReady) warmUp(getOfficeState(), zoom);
  }, [getOfficeState, zoom, layoutReady, version]);
}
