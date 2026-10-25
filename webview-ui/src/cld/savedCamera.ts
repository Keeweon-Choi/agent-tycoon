import { ZOOM_MAX, ZOOM_MIN } from '../constants.js';
import type { Vec } from './camera.js';

/**
 * G1: a refresh keeps the view. The zoom and pan are saved when the page goes away and read
 * once at startup. ponytail: the pan is the one-floor / default floor camera as it was; a view
 * on another floor opens on the default floor with the same offset.
 */
const KEY = 'cld.camera';
export interface SavedCamera {
  zoom: number;
  pan: Vec;
  /** GFX: the user had moved it by hand (a framed view is framed again instead). */
  manual?: boolean;
}

/** The saved view, or null when it is missing, malformed or out of range. */
export function parseSavedCamera(raw: string | null): SavedCamera | null {
  try {
    const v = JSON.parse(raw ?? 'null') as {
      zoom?: unknown;
      pan?: { x?: unknown; y?: unknown };
      manual?: unknown;
    };
    const { zoom, pan, manual } = v ?? {};
    if (typeof zoom !== 'number' || !Number.isInteger(zoom) || zoom < ZOOM_MIN || zoom > ZOOM_MAX)
      return null;
    if (!Number.isFinite(pan?.x) || !Number.isFinite(pan?.y)) return null;
    return {
      zoom,
      pan: { x: pan!.x as number, y: pan!.y as number },
      ...(manual === true && { manual: true }),
    };
  } catch {
    return null;
  }
}

export function loadSavedCamera(): SavedCamera | null {
  try {
    return parseSavedCamera(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function saveCamera(camera: SavedCamera): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(camera));
  } catch {
    // Private browsing: this visit just does not remember.
  }
}
