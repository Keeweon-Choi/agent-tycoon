/**
 * WINDOW-LAYERS: where the fixed panels (card bar, icon dock, elevator) are, in the HUD layer's own
 * coordinates, so a window can keep its title buttons out from under them (layout.keepButtonsClear).
 * HudLayer measures the elements marked `data-hud-fixed` inside its panel slot: on a resize of one,
 * of the layer, or when the slot's children come and go. No polling.
 */
import { type ReactNode, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import type { Rect } from './layout.js';

let panels: readonly Rect[] = [];
const listeners = new Set<() => void>();

const same = (a: readonly Rect[], b: readonly Rect[]) =>
  a.length === b.length &&
  a.every((r, i) => r.x === b[i].x && r.y === b[i].y && r.w === b[i].w && r.h === b[i].h);

/** The panels in `layer`'s coordinates; the very array again while nothing moved. */
export function measurePanels(layer: HTMLElement, slot: HTMLElement): readonly Rect[] {
  const room = layer.getBoundingClientRect();
  const next = [...slot.querySelectorAll<HTMLElement>('[data-hud-fixed]')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => {
      const box = el.getBoundingClientRect();
      return {
        x: Math.round(box.left - room.left - layer.clientLeft),
        y: Math.round(box.top - room.top - layer.clientTop),
        w: Math.round(box.width),
        h: Math.round(box.height),
      };
    });
  return same(panels, next) ? panels : next;
}

/** HudLayer publishes (null on unmount). */
export function setFixedPanels(next: readonly Rect[]): void {
  if (next === panels) return;
  panels = next;
  for (const l of listeners) l();
}

/** The panels now (the very array while nothing moved): the camera frames around them. */
export const fixedPanels = (): readonly Rect[] => panels;

export const useFixedPanels = (): readonly Rect[] =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => panels,
  );

// ── The slot the panels render into ───────────────────────────

let slot: HTMLElement | null = null;
const slotListeners = new Set<() => void>();

/** HudLayer publishes its panel slot (null on unmount). */
export function setPanelSlot(el: HTMLElement | null): void {
  slot = el;
  for (const l of slotListeners) l();
}

/** The HUD layer's panel slot, or null where there is none (VS Code, the phone): panels then render in place. */
export const usePanelSlot = (): HTMLElement | null =>
  useSyncExternalStore(
    (l) => {
      slotListeners.add(l);
      return () => void slotListeners.delete(l);
    },
    () => slot,
  );

/** A fixed panel (card bar, elevator): drawn in the HUD layer's panel slot, over normal windows, where there is one; in place elsewhere. */
export function HudPanel({ children }: { children: ReactNode }): ReactNode {
  const slot = usePanelSlot();
  return slot ? createPortal(children, slot) : children;
}
