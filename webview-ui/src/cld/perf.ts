/**
 * HD64-SAMPLE: the performance readout the owner can turn on (Settings) to check the office on
 * their own phone: the draw time of the last frames, the characters drawn (how many at 64×128),
 * the sprite cache built for the current zoom. A per-browser setting; off, nothing is kept.
 */
import { useSyncExternalStore } from 'react';

import { PERF_FRAMES } from '../constants.js';

const KEY = 'cld.perf-readout';
let on = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();
export const perfOn = (): boolean => on;
export function setPerfOn(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    // Private browsing or a locked-down webview: keep the in-memory choice.
  }
  for (const l of listeners) l();
}
export const usePerfOn = (): boolean =>
  useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, perfOn);

const frames: number[] = [];
let shown = { characters: 0, hd64: 0, zoom: 1 };
/** One drawn frame: how long it took (ms), the characters in it, how many drew at 64×128. */
export function perfFrame(ms: number, characters: number, hd64: number, zoom: number): void {
  if (!on) return;
  frames.push(ms);
  if (frames.length > PERF_FRAMES) frames.shift();
  shown = { characters, hd64, zoom };
}

/** Bytes of sprite canvases built since the page loaded (every scale: an HD character's cache
 *  is keyed by its own scale, not the world zoom; counted when built, never freed here). */
let cacheBytes = 0;
export function perfCache(bytes: number): void {
  if (!on) return;
  cacheBytes += bytes;
}

export function perfSnapshot() {
  const avg = frames.length ? frames.reduce((t, v) => t + v, 0) / frames.length : 0;
  return {
    avgMs: avg,
    maxMs: frames.length ? Math.max(...frames) : 0,
    ...shown,
    cacheBytes,
  };
}
