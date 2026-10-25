/**
 * charpack v3 §6A, the DOM side of the nameplates: the per-browser on/off
 * choice, and the overlap pass. The pass reads the plates' projected screen
 * boxes (after zoom, pan, camera, movement and resize) every NAMEPLATE_PASS_MS
 * and at once when the focus or the zoom changes or the office comes back on
 * screen (none while it is off screen, gameLoop's own signal), dims the ones that overlap
 * (nameplate.ts dimmedPlates) by writing their opacity directly, and keeps each
 * overlay's size for edge clamping. No React state: the overlay re-renders on
 * the canvas's frames anyway and only reads the sizes.
 */
import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';

import {
  NAMEPLATE_OVERLAP_OPACITY,
  NAMEPLATE_OVERLAP_SLOP_PX,
  NAMEPLATE_PASS_MS,
} from '../../constants.js';
import { officeOnScreen, onOfficeShown } from '../../office/engine/gameLoop.js';
import { dimmedPlates, plateOpacity,type PlateRect } from './nameplate.js';

const NAMEPLATES_KEY = 'cld.nameplates';
let nameplates = (() => {
  try {
    return localStorage.getItem(NAMEPLATES_KEY) !== 'off';
  } catch {
    return true;
  }
})();

/** Nameplates on every character (a per-browser setting, on unless turned off). */
export const nameplatesOn = () => nameplates;
export function setNameplates(on: boolean): void {
  nameplates = on;
  try {
    localStorage.setItem(NAMEPLATES_KEY, on ? 'on' : 'off');
  } catch {
    // Private browsing or a locked-down webview: keep the in-memory choice.
  }
}

/** Each character's whole overlay (badges, plate), as last measured. */
export type PlateSizes = Map<number, { w: number; h: number }>;

/** What the passes cost (the nameplate runner reads it through the e2e hooks). */
export const nameplateStats = { passes: 0, ms: 0, maxMs: 0, plates: 0 };

function runPass(root: HTMLElement | null, sizes: PlateSizes): void {
  // Off screen (the phone's terminal page in front) or hidden: nothing to measure.
  if (!root || document.hidden || !officeOnScreen()) return;
  const t0 = performance.now();
  const nodes = root.querySelectorAll<HTMLElement>('[data-nameplate]');
  const rects: PlateRect[] = [];
  const focus = new Set<number>();
  sizes.clear();
  for (const node of nodes) {
    const id = Number(node.dataset.agentId);
    const r = node.getBoundingClientRect();
    rects.push({ id, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    if (node.dataset.focus !== undefined) focus.add(id);
    const box = node.closest<HTMLElement>('[data-testid="agent-overlay"]');
    if (box) sizes.set(id, { w: box.offsetWidth, h: box.offsetHeight });
  }
  const dim = dimmedPlates(rects, focus, NAMEPLATE_OVERLAP_SLOP_PX);
  for (const node of nodes) {
    const dimmed = dim.has(Number(node.dataset.agentId));
    // The overlay's own opacity (an off character's) composes with the plate's.
    const base = Number(node.closest<HTMLElement>('[data-testid="agent-overlay"]')?.style.opacity || 1);
    const opacity = plateOpacity(dimmed, base, NAMEPLATE_OVERLAP_OPACITY);
    const value = opacity === 1 ? '' : String(opacity);
    if (node.style.opacity !== value) node.style.opacity = value;
    if (node.hasAttribute('data-dim') !== dimmed) node.toggleAttribute('data-dim', dimmed);
  }
  const ms = performance.now() - t0;
  nameplateStats.passes++;
  nameplateStats.ms += ms;
  nameplateStats.maxMs = Math.max(nameplateStats.maxMs, ms);
  nameplateStats.plates = rects.length;
}

/** Runs the overlap pass for the plates under `rootRef`; `key` changing (focus, zoom) runs it at once. */
export function useNameplatePass(rootRef: RefObject<HTMLElement | null>, key: string): PlateSizes {
  const [sizes] = useState<PlateSizes>(() => new Map());
  useEffect(() => {
    const pass = () => runPass(rootRef.current, sizes);
    const timer = setInterval(pass, NAMEPLATE_PASS_MS);
    window.addEventListener('resize', pass);
    const unsubscribe = onOfficeShown(pass); // back on screen: at once
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', pass);
      unsubscribe();
    };
  }, [rootRef, sizes]);
  useLayoutEffect(() => runPass(rootRef.current, sizes), [rootRef, sizes, key]);
  return sizes;
}
