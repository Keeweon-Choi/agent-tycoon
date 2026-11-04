/**
 * GAME-UI-0: the one place that decides whether the game parts move ('게임 효과', owner 11-03).
 * On by default. Off when the setting is off or the device asks for reduced motion: every game
 * animation then shows its end state at once. It sets data-game-motion="on|off" on <html>;
 * game.css animates only under :root[data-game-motion='on'], and a part that moves from script
 * asks useGameMotion(). Stored per browser like uiFont: localStorage behind try/catch.
 */
import { useSyncExternalStore } from 'react';

export const GAME_EFFECTS_KEY = 'cld.game-effects';
const REDUCE = '(prefers-reduced-motion: reduce)';

function readSetting(): boolean {
  try {
    return localStorage.getItem(GAME_EFFECTS_KEY) !== 'off';
  } catch {
    return true;
  }
}
function reduced(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(REDUCE).matches;
  } catch {
    return false;
  }
}

let effects = readSetting();
let motion = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function update(): void {
  motion = effects && !reduced();
  if (typeof document !== 'undefined') document.documentElement.dataset.gameMotion = motion ? 'on' : 'off';
  for (const l of listeners) l();
}
update();
try {
  // The device setting can change while the page is open.
  if (typeof matchMedia === 'function') matchMedia(REDUCE).addEventListener('change', update);
} catch {
  // An old engine without MediaQueryList events: the next load picks it up.
}

/** The setting (the switch shows it), whatever the device says. */
export const gameEffects = () => effects;
export const useGameEffects = () => useSyncExternalStore(subscribe, gameEffects);
/** Whether game animations play now: the setting and no reduced motion. */
export const gameMotion = () => motion;
export const useGameMotion = () => useSyncExternalStore(subscribe, gameMotion);

export function setGameEffects(on: boolean): void {
  effects = on;
  try {
    localStorage.setItem(GAME_EFFECTS_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode: this visit still remembers it.
  }
  update();
}

/** Tests: read the store and the device again (after stubbing localStorage or matchMedia). */
export const reloadGameMotion = (): void => {
  effects = readSetting();
  update();
};
