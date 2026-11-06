/**
 * charpack v3 §6A, the DOM side of the nameplates: the per-browser on/off
 * choice, and the overlap pass. The pass reads the plates' projected screen
 * boxes (after zoom, pan, camera, movement and resize) every NAMEPLATE_PASS_MS
 * and at once when the focus or the zoom changes or the office comes back on
 * screen (none while it is off screen, gameLoop's own signal), dims the ones that overlap
 * (nameplate.ts dimmedPlates) by writing their opacity directly, makes the off duty and
 * asleep ones give way to the working ones (crowdPlates: data-crowd shrinks a plate to its
 * name, marginTop lifts it; the placer owns transform and Tailwind's translate classes the
 * translate property), and keeps each overlay's size for edge clamping. No React state: the overlay re-renders on
 * the canvas's frames anyway and only reads the sizes.
 */
import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';

import {
  NAMEPLATE_CROWD_GAP_PX,
  NAMEPLATE_OVERLAP_OPACITY,
  NAMEPLATE_OVERLAP_SLOP_PX,
  NAMEPLATE_PASS_MS,
} from '../../constants.js';
import { officeOnScreen, onOfficeShown } from '../../office/engine/gameLoop.js';
import { type CrowdItem, crowdPlates, dimmedPlates, plateAt, plateOpacity, type PlateRect } from './nameplate.js';

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

/** overlayPlacer.ts's `translate(Xpx,Ypx)`: the overlay's bottom centre in its container. */
const ANCHOR = /^translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)$/;

/** What the passes cost (the nameplate runner reads it through the e2e hooks). */
export const nameplateStats = { passes: 0, ms: 0, maxMs: 0, plates: 0 };

/**
 * The crowd step: every overlay's un-nudged box (its full size is kept in the dataset while it is
 * shrunk, so the decision does not flicker), then data-crowd and marginTop to match the fates.
 */
function crowdPass(root: HTMLElement): void {
  const items: CrowdItem[] = [];
  const origins = new Map<Element, DOMRect>();
  const nodes = new Map<string, HTMLElement>();
  for (const box of root.querySelectorAll<HTMLElement>('[data-testid="agent-overlay"]')) {
    const key = `o${box.dataset.agentId}`;
    const r = box.getBoundingClientRect();
    // T-67: a focused (hovered, selected) resting plate holds where it is, as it is: moved from under the
    // pointer it would lose the hover and come back under it, every pass. The others give way to it.
    if (box.querySelector('[data-nameplate][data-focus]')) {
      items.push({ key, rect: r, low: false });
      continue;
    }
    const crowded = box.hasAttribute('data-crowd');
    const dy = crowded ? parseFloat(box.style.marginTop) || 0 : 0;
    // T-67: the un-nudged bottom centre is the placer's own anchor (overlayPlacer.ts writes it as the
    // transform), exact every frame; a box read back minus its margin was a hair off and flipped the order.
    const at = ANCHOR.exec(box.style.transform);
    const parent = box.offsetParent;
    let origin = parent ? origins.get(parent) : undefined;
    if (parent && !origin) origins.set(parent, (origin = parent.getBoundingClientRect()));
    const w = crowded ? Number(box.dataset.fullW) || r.width : r.width;
    const h = crowded ? Number(box.dataset.fullH) || r.height : r.height;
    if (crowded) {
      box.dataset.smallW = String(r.width);
      box.dataset.smallH = String(r.height);
    } else {
      box.dataset.fullW = String(r.width);
      box.dataset.fullH = String(r.height);
    }
    const cx = at && origin ? origin.left + Number(at[1]) : (r.left + r.right) / 2;
    const bottom = at && origin ? origin.top + Number(at[2]) : r.bottom - dy;
    const small = box.dataset.smallW
      ? { w: Number(box.dataset.smallW), h: Number(box.dataset.smallH) }
      : undefined;
    items.push({
      key,
      rect: { left: cx - w / 2, right: cx + w / 2, top: bottom - h, bottom },
      low: box.hasAttribute('data-rest'),
      small,
      was: crowded ? dy : undefined,
    });
    nodes.set(key, box);
  }
  for (const feet of root.querySelectorAll<HTMLElement>('[data-testid="feet-badges"]')) {
    const r = feet.getBoundingClientRect();
    const key = `f${feet.dataset.agentId}`;
    items.push({ key, rect: r, low: true, fixed: true });
    nodes.set(key, feet);
  }
  const fates = crowdPlates(items, NAMEPLATE_OVERLAP_SLOP_PX, NAMEPLATE_CROWD_GAP_PX);
  for (const [key, node] of nodes) {
    const fate = fates.get(key);
    const crowd = !!fate?.crowd;
    if (node.hasAttribute('data-crowd') !== crowd) node.toggleAttribute('data-crowd', crowd);
    if (key.startsWith('o')) {
      const lift = fate && fate.dy ? `${fate.dy}px` : '';
      if (node.style.marginTop !== lift) node.style.marginTop = lift;
    }
  }
}

function runPass(root: HTMLElement | null, sizes: PlateSizes): void {
  // Off screen (the phone's terminal page in front) or hidden: nothing to measure.
  if (!root || document.hidden || !officeOnScreen()) return;
  const t0 = performance.now();
  const nodes = root.querySelectorAll<HTMLElement>('[data-nameplate]');
  crowdPass(root);
  const rects: PlateRect[] = [];
  const focus = new Set<number>();
  sizes.clear();
  for (const node of nodes) {
    const id = Number(node.dataset.agentId);
    const box = node.closest<HTMLElement>('[data-testid="agent-overlay"]');
    // A shrunk plate is clamped by its full size, so shrinking never moves its anchor (and so its fate).
    const full = box?.hasAttribute('data-crowd') ? Number(box.dataset.fullH) : 0;
    if (box) sizes.set(id, { w: box.offsetWidth, h: full || box.offsetHeight });
    if (box?.hasAttribute('data-rest')) continue; // gives way in crowdPass instead of dimming
    const r = node.getBoundingClientRect();
    rects.push({ id, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    if (node.dataset.focus !== undefined) focus.add(id);
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
  nameplateStats.plates = nodes.length;
}

/** The character whose plate is under a viewport point, if any (the canvas's hover and click fall back to it). */
export function plateUnder(x: number, y: number): number | null {
  const rects: PlateRect[] = [];
  for (const node of document.querySelectorAll<HTMLElement>('[data-nameplate]')) {
    const r = node.getBoundingClientRect();
    if (r.width > 0) rects.push({ id: Number(node.dataset.agentId), left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return plateAt(rects, x, y);
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
