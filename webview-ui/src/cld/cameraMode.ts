/**
 * GFX camera (owner 10-25 22:27: "사무실과 배경을 고정해두고 현재 클릭한 캐릭터에 따라 시점이 바뀌게
 * 하는 게 낫지 않나? 그거랑 자유 시점만 있으면 될듯"). Two modes:
 *   auto  the office (and backdrop) framed and fixed (the floor shown covering the view at the
 *         nearest whole zoom, the panels left out); clicking a character zooms onto it and
 *         follows it; clicking empty floor, Esc or 0 returns to the framed office
 *   free  manual pan and zoom only: nothing moves the camera by itself, a click only selects
 * Per browser (localStorage). The earlier fit / fill / focus / classic values read as auto.
 * 'off' is not offered: the camera as upstream has it (no framing, a click follows), for the
 * upstream surfaces and the browser runners that click where it puts things.
 *
 * In auto a manual pan or zoom wins until the user asks again (the toggle, 0, Esc, a click on
 * the floor or on a character).
 */
import { useSyncExternalStore } from 'react';

export const CAMERA_MODES = ['auto', 'free'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number] | 'off';
export const CAMERA_MODE_KEY = 'cld.camera-mode';
/** The modes of the first GFX round, now auto. */
const LEGACY = ['fit', 'fill', 'focus', 'classic'];

export const parseCameraMode = (raw: string | null): CameraMode | null =>
  raw === 'auto' || raw === 'free' || raw === 'off'
    ? raw
    : raw !== null && LEGACY.includes(raw)
      ? 'auto'
      : null;
export const defaultCameraMode = (): CameraMode => 'auto';

function read(): CameraMode | null {
  try {
    const raw = localStorage.getItem(CAMERA_MODE_KEY);
    const mode = parseCameraMode(raw);
    if (mode && mode !== raw) localStorage.setItem(CAMERA_MODE_KEY, mode); // migrated once
    return mode;
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

export const cameraMode = (): CameraMode => chosen ?? defaultCameraMode();
export const cameraAsks = (): number => asks;
export const isCameraManual = (): boolean => manual;

/** A drag, wheel, pinch or key moved the camera: framing waits until asked again. */
export function noteManualCamera(): void {
  manual = true;
}
/** Frame again (the 0 key, the toggle, the end of a follow in auto). */
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

export const useCameraMode = (): CameraMode => {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => version,
  );
  return cameraMode();
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
