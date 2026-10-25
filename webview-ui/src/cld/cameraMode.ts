/**
 * GFX camera modes (owner 10-25, Part A): how the office is framed.
 *   fit     the floor shown, all of it, at the largest whole zoom that fits
 *   fill    the floor shown covering the view, at the nearest whole zoom (the rest pans)
 *   focus   fill's zoom, centred on the selected or a working employee
 *   classic the camera as it was (zoom from the screen's pixel ratio, the floor centred)
 * Per browser (localStorage). Default: fill on a desktop, focus on a phone; only the cld office
 * frames (the upstream surfaces keep classic).
 *
 * A manual pan or zoom wins over the framing until the user asks again (picks a mode, or 0).
 * The view is re-framed when the canvas size, the floor, the layout or the panels change.
 */
import { useSyncExternalStore } from 'react';

export const CAMERA_MODES = ['fit', 'fill', 'focus', 'classic'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];
export const CAMERA_MODE_KEY = 'cld.camera-mode';

export const parseCameraMode = (raw: string | null): CameraMode | null =>
  CAMERA_MODES.find((m) => m === raw) ?? null;
export const defaultCameraMode = (phone: boolean): CameraMode => (phone ? 'focus' : 'fill');

function read(): CameraMode | null {
  try {
    return parseCameraMode(localStorage.getItem(CAMERA_MODE_KEY));
  } catch {
    return null;
  }
}

let chosen = read();
/** Bumped by every ask (a mode picked, even the same one; the 0 key): frame again. */
let asks = 0;
/** The user moved the camera since the last framing. */
let manual = false;
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  for (const l of listeners) l();
};

export const cameraMode = (phone: boolean): CameraMode => chosen ?? defaultCameraMode(phone);
export const cameraAsks = (): number => asks;
export const isCameraManual = (): boolean => manual;

/** A drag, wheel, pinch or key moved the camera: framing waits until asked again. */
export function noteManualCamera(): void {
  manual = true;
}
/** Frame again in the current mode (the 0 key, a mode button pressed again). */
export function askFraming(): void {
  manual = false;
  asks++;
  emit();
}
export function setCameraMode(mode: CameraMode): void {
  chosen = mode;
  try {
    localStorage.setItem(CAMERA_MODE_KEY, mode);
  } catch {
    // Private mode or a locked-down webview: this visit still remembers it.
  }
  askFraming();
}
/** G1 restore: a saved view the user had moved by hand stays theirs after a refresh. */
export function restoreManual(on: boolean): void {
  manual = on;
}

export const useCameraMode = (phone: boolean): CameraMode => {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => version,
  );
  return cameraMode(phone);
};

/** What the last framing saw (the e2e test hook reads it). */
export interface Framing {
  mode: CameraMode;
  zoom: number;
  view: { x: number; y: number; w: number; h: number };
  box: { x: number; y: number; w: number; h: number };
}
let framed: Framing | null = null;
export const lastFraming = (): Framing | null => framed;
export const noteFraming = (f: Framing): void => void (framed = f);

/** Tests: read the store again (after stubbing localStorage). */
export function cameraModeResetForTests(): void {
  chosen = read();
  asks = 0;
  manual = false;
}
