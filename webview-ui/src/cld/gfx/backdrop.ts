/**
 * GFX office backdrop (owner 10-25): the owner's night skyline in the void around the office.
 *
 * It is the CSS background of the canvas's own container (the canvas clears to transparent, so
 * the void shows it): behind the world only, never over a floor, wall, furniture, character or
 * the DOM UI. The browser keeps it as one decoded image; nothing is drawn per frame, so an idle
 * office costs no more frames than before. Scaled by a whole number of device pixels per art
 * pixel with `image-rendering: pixelated`, so it stays crisp.
 *
 * Optional parallax (off by default, and off under reduced motion): the four layers move by a
 * small share of the camera pan, each capped, through two CSS variables the render loop sets
 * only when the pan changed.
 *
 * Per browser: `cld.backdrop` (on unless 'off') and `cld.backdrop-parallax` ('on' to move).
 */
import { useSyncExternalStore } from 'react';

import { BACKDROP_ART_H, BACKDROP_ART_W, BACKDROP_PARALLAX } from '../../constants.js';
import { reducedMotion } from '../floors.js';
import city from './art/night-city.png';
import facade from './art/night-facade.png';
import far from './art/night-far.png';
import mid from './art/night-mid.png';
import sky from './art/night-sky.png';

export const BACKDROP_KEY = 'cld.backdrop';
export const BACKDROP_PARALLAX_KEY = 'cld.backdrop-parallax';

const readFlag = (key: string, on: (v: string | null) => boolean): boolean => {
  try {
    return on(localStorage.getItem(key));
  } catch {
    return on(null);
  }
};

let state = {
  on: readFlag(BACKDROP_KEY, (v) => v !== 'off'),
  parallax: readFlag(BACKDROP_PARALLAX_KEY, (v) => v === 'on'),
};
const listeners = new Set<() => void>();
const write = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    // Private mode: this visit still remembers it.
  }
};
export const backdropState = () => state;
export const useBackdrop = () =>
  useSyncExternalStore((l) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  }, backdropState);
export function setBackdrop(next: Partial<typeof state>): void {
  state = { ...state, ...next };
  if (next.on !== undefined) write(BACKDROP_KEY, next.on);
  if (next.parallax !== undefined) write(BACKDROP_PARALLAX_KEY, next.parallax);
  for (const l of listeners) l();
}

/** Device px per art px: the smallest whole number at which the art covers a `w` x `h` device
 *  px view with `margin` to spare on every side (room for the parallax to move). */
export function backdropScale(w: number, h: number, margin = 0): number {
  return Math.max(
    1,
    Math.ceil(Math.max((w + 2 * margin) / BACKDROP_ART_W, (h + 2 * margin) / BACKDROP_ART_H)),
  );
}

/** The container's inline background for a `cssW` x `cssH` box at `dpr` (empty: the plain one). */
export function backdropStyle(
  cssW: number,
  cssH: number,
  dpr: number,
  opts: { on: boolean; parallax: boolean },
): Record<string, string> {
  if (!opts.on)
    return {
      backgroundImage: '',
      backgroundSize: '',
      backgroundPosition: '',
      backgroundRepeat: '',
      imageRendering: '',
    };
  const cap = BACKDROP_PARALLAX.capPx; // CSS px
  const moving = opts.parallax && !reducedMotion();
  const k = backdropScale(cssW * dpr, cssH * dpr, moving ? cap * dpr : 0);
  const size = `${(BACKDROP_ART_W * k) / dpr}px ${(BACKDROP_ART_H * k) / dpr}px`;
  if (!moving)
    return {
      backgroundImage: `url("${city}")`,
      backgroundSize: size,
      backgroundPosition: 'center bottom',
      backgroundRepeat: 'no-repeat',
      imageRendering: 'pixelated',
    };
  // Front layer first (CSS paints the first image on top). The bottom edge sits `cap` below
  // the box, so a layer can move `cap` up or down without showing its edge.
  const layers = [
    [facade, BACKDROP_PARALLAX.facade],
    [mid, BACKDROP_PARALLAX.mid],
    [far, BACKDROP_PARALLAX.far],
    [sky, BACKDROP_PARALLAX.sky],
  ] as const;
  const shift = (axis: 'x' | 'y', ratio: number) =>
    `clamp(${-cap}px, var(--cld-bd-${axis}, 0px) * ${ratio}, ${cap}px)`;
  return {
    backgroundImage: layers.map(([u]) => `url("${u}")`).join(', '),
    backgroundSize: layers.map(() => size).join(', '),
    backgroundPosition: layers
      .map(([, r]) => `calc(50% + ${shift('x', r)}) calc(100% + ${cap}px + ${shift('y', r)})`)
      .join(', '),
    backgroundRepeat: 'no-repeat',
    imageRendering: 'pixelated',
  };
}
