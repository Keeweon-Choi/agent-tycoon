/**
 * GFX2 office backdrop (owner 10-25 22:27): the city around the office seen from above, like the
 * office itself (the side-view skyline read wrong behind a top-down office). The owner's scene of
 * the floors from above, snapped to its true pixels with the interior roofed over
 * (cld/scripts/gen-topdown-backdrop.ts): a tower, a street with trees and lamps, rooftops.
 *
 * It is the CSS background of the canvas's own container (the canvas clears to transparent, so
 * the void shows it): behind the world only, never over a floor, wall, furniture, character or
 * the DOM UI; one decoded picture the browser keeps, no frame drawn for it. It belongs to the
 * world, so it moves and scales with the camera: its roofed hole sits under the floor shown, each
 * picture px is TOPDOWN_WORLD_PX world px, so at a whole zoom it is a whole number of device px,
 * nearest-neighbour; it repeats beyond its edges as a 2 x 2 tile of the picture and its mirror
 * images (no seam). Its size and place are written only when the camera moved.
 *
 * Per browser: `cld.backdrop` (on unless 'off').
 */
import { useSyncExternalStore } from 'react';

import { TOPDOWN_WORLD_PX } from '../../constants.js';
import META from './art/topdown-night.json';
import picture from './art/topdown-night.png';

export const BACKDROP_KEY = 'cld.backdrop';

const readOn = (): boolean => {
  try {
    return localStorage.getItem(BACKDROP_KEY) !== 'off';
  } catch {
    return true;
  }
};

let state = { on: readOn() };
const listeners = new Set<() => void>();
export const backdropState = () => state;
export const useBackdrop = () =>
  useSyncExternalStore((l) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  }, backdropState);
export function setBackdrop(next: { on: boolean }): void {
  state = { on: next.on };
  try {
    localStorage.setItem(BACKDROP_KEY, next.on ? 'on' : 'off');
  } catch {
    // Private mode: this visit still remembers it.
  }
  for (const l of listeners) l();
}

/** The container's fixed background properties (empty strings: the plain background). */
export function backdropStyle(on: boolean): Record<string, string> {
  return on
    ? {
        backgroundImage: `url("${picture}")`,
        // The picture repeats: a city of blocks, each roofed hole another roof; the one under
        // the floor shown is covered by the office.
        backgroundRepeat: 'repeat',
        backgroundColor: META.fill,
        imageRendering: 'pixelated',
      }
    : {
        backgroundImage: '',
        backgroundRepeat: '',
        backgroundColor: '',
        backgroundSize: '',
        backgroundPosition: '',
        imageRendering: '',
      };
}

/** Where the picture goes for this camera (CSS px): its hole centred on the world point
 *  `centre` (the floor shown), which is drawn at device px (offsetX + centre.x * zoom, ...). */
export function backdropPlacement(
  offset: { x: number; y: number },
  zoom: number,
  dpr: number,
  centre: { x: number; y: number },
): { size: string; position: string } {
  const k = TOPDOWN_WORLD_PX * zoom; // device px per picture px, a whole number
  const left = offset.x + Math.round(centre.x * zoom) - Math.round(META.holeX * k);
  const top = offset.y + Math.round(centre.y * zoom) - Math.round(META.holeY * k);
  return {
    size: `${(META.w * k) / dpr}px ${(META.h * k) / dpr}px`,
    position: `${left / dpr}px ${top / dpr}px`,
  };
}
