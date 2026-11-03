/**
 * One small zoom for text surfaces (editor, preview, dev room diff): the scale per surface lives in a
 * tiny store so every file of a diff follows one control, and is remembered in the browser. `useZoomHost`
 * turns Ctrl/Cmd + wheel, Ctrl/Cmd + / - / 0 (while focus is inside) and a two-finger pinch on an element
 * into the same steps; Zoom.tsx has the visible bar.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { TEXT_ZOOM_DEFAULT, TEXT_ZOOM_WHEEL_NOTCH } from '../constants.js';
import {
  clampZoom,
  loadZoom,
  saveZoom,
  stepZoom,
  type ZoomSurface,
} from './zoomState.js';

const scales = new Map<ZoomSurface, number>();
const listeners = new Set<() => void>();
const read = (surface: ZoomSurface): number => {
  let z = scales.get(surface);
  if (z === undefined) {
    z = loadZoom(surface);
    scales.set(surface, z);
  }
  return z;
};
function write(surface: ZoomSurface, z: number, remember = true): void {
  const next = Math.round(clampZoom(z) * 100) / 100;
  if (next === read(surface)) return;
  scales.set(surface, next);
  if (remember) saveZoom(surface, next);
  listeners.forEach((fn) => fn());
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export function useTextZoom(surface: ZoomSurface) {
  const zoom = useSyncExternalStore(
    subscribe,
    () => read(surface),
    () => TEXT_ZOOM_DEFAULT,
  );
  return {
    zoom,
    step: (dir: 1 | -1) => write(surface, stepZoom(read(surface), dir)),
    reset: () => write(surface, TEXT_ZOOM_DEFAULT),
  };
}

const distance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/** The ref callback for the element that takes the zoom gestures of `surface`. */
export function useZoomHost(surface: ZoomSurface): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      acc += e.deltaMode === 1 ? e.deltaY * TEXT_ZOOM_WHEEL_NOTCH : e.deltaY;
      while (Math.abs(acc) >= TEXT_ZOOM_WHEEL_NOTCH) {
        write(surface, stepZoom(read(surface), acc < 0 ? 1 : -1));
        acc -= Math.sign(acc) * TEXT_ZOOM_WHEEL_NOTCH;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if ((!e.ctrlKey && !e.metaKey) || e.altKey) return;
      const dir = e.key === '+' || e.key === '=' ? 1 : e.key === '-' || e.key === '_' ? -1 : 0;
      if (dir) write(surface, stepZoom(read(surface), dir));
      else if (e.key === '0') write(surface, TEXT_ZOOM_DEFAULT);
      else return;
      e.preventDefault();
    };
    let pinch: { dist: number; zoom: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      pinch =
        e.touches.length === 2
          ? { dist: distance(e.touches[0], e.touches[1]), zoom: read(surface) }
          : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2 || pinch.dist === 0) return;
      e.preventDefault();
      write(surface, pinch.zoom * (distance(e.touches[0], e.touches[1]) / pinch.dist));
    };
    const onTouchEnd = () => {
      pinch = null;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('keydown', onKey);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [el, surface]);
  return useCallback((node: HTMLElement | null) => setEl(node), []);
}
