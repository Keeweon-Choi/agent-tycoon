/**
 * SHEET-IMPORT (owner 10-26 02:14): once the layout is in, every office character's frames and
 * every furniture sprite of the top-down office are queued for its zoom (and the follow zoom), a
 * slice at a time (smoothSprite.ts's queue), into the caches the office draws from afterwards.
 * BOOT-LOAD: the loading screen in front of the lobby drains that queue (BootScreen.tsx); without
 * it the queue drains in idle time after the office shows. Nothing is queued for the isometric
 * view (it never draws these: it queues its own characters as it draws them, render.ts), and a
 * phone or a small-memory device warms only the zoom shown (the follow zoom builds when it is used).
 * The follow zoom is not the first view: it is queued once the loading screen is done.
 */
import { useEffect } from 'react';

import { BOOT_LEAN_MEMORY_GB, CAMERA_FOLLOW_ZOOM_STEPS, ZOOM_MAX } from '../../constants.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { forgetWarm, warmOnce } from '../../office/sprites/smoothSprite.js';
import { getCachedSprite } from '../../office/sprites/spriteCache.js';
import { getCharacterSprites, spritesAtZoom } from '../../office/sprites/spriteData.js';
import { framesOf } from '../../office/sprites/warm.js';
import { useLooksUi } from '../characters/looks.js';
import { dimmedSprite } from '../ez/drawVisuals.js';
import { useTitleScene } from './titleSceneState.js';

/** One batch replaces the prior one when the view or looks change, so abandoned zooms and
 * departed characters cannot accumulate work. */
const batchOwner = {};

/** A phone, or a device that says it has little memory (Safari says nothing: the phone flag). */
export function leanDevice(phone: boolean): boolean {
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return phone || (gb !== undefined && gb <= BOOT_LEAN_MEMORY_GB);
}

function warmUp(os: OfficeState, zoom: number, lean: boolean): void {
  const zooms = lean
    ? [zoom]
    : [...new Set([zoom, Math.min(ZOOM_MAX, zoom + CAMERA_FOLLOW_ZOOM_STEPS)])];
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
  forgetWarm(batchOwner);
  if (jobs.length) warmOnce(batchOwner, zoom, () => jobs);
}

/** Warm the top-down office up for `zoom` once its layout is in (again when looks or the zoom
 *  change: only what is new is queued); nothing in the isometric view. */
export function useOfficeWarmUp(
  getOfficeState: () => OfficeState,
  zoom: number,
  layoutReady: boolean,
  iso: boolean,
  phone: boolean,
): void {
  const { version } = useLooksUi();
  const { booting } = useTitleScene();
  useEffect(() => {
    if (iso) forgetWarm(batchOwner);
    else if (layoutReady) warmUp(getOfficeState(), zoom, booting || leanDevice(phone));
  }, [getOfficeState, zoom, layoutReady, version, iso, phone, booting]);
}
