import {
  TEXT_ZOOM_DEFAULT,
  TEXT_ZOOM_STEPS,
  TEXT_ZOOM_STORAGE_PREFIX,
} from '../constants.js';

/** The places the owner can zoom, each remembered on its own. */
export type ZoomSurface = 'editor' | 'preview' | 'diff';

const FIRST = TEXT_ZOOM_STEPS[0];
const LAST = TEXT_ZOOM_STEPS[TEXT_ZOOM_STEPS.length - 1];

export const clampZoom = (z: number): number =>
  Number.isFinite(z) ? Math.min(LAST, Math.max(FIRST, z)) : TEXT_ZOOM_DEFAULT;

/** The next step up (+1) or down (-1) from any scale, e.g. one a pinch left between two steps. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const eps = 1e-6;
  const next =
    dir === 1
      ? TEXT_ZOOM_STEPS.find((s) => s > z + eps)
      : [...TEXT_ZOOM_STEPS].reverse().find((s) => s < z - eps);
  return next ?? clampZoom(z);
}

/** A stored value back to a scale; anything unreadable is the default. */
export function parseZoom(raw: string | null): number {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 ? clampZoom(n) : TEXT_ZOOM_DEFAULT;
}

export const zoomPercent = (z: number): number => Math.round(z * 100);

/** The font size of `base` (a CSS length such as `var(--text-xs)`) at scale `z`; undefined at 1 so the class's own size stays. */
export const scaledSize = (base: string, z: number): string | undefined =>
  z === TEXT_ZOOM_DEFAULT ? undefined : `calc(${base} * ${z})`;

export function loadZoom(surface: ZoomSurface): number {
  try {
    return parseZoom(localStorage.getItem(TEXT_ZOOM_STORAGE_PREFIX + surface));
  } catch {
    return TEXT_ZOOM_DEFAULT;
  }
}

export function saveZoom(surface: ZoomSurface, z: number): void {
  try {
    localStorage.setItem(TEXT_ZOOM_STORAGE_PREFIX + surface, String(z));
  } catch {
    /* private window or blocked storage: the zoom just is not remembered */
  }
}
