import type { MobileKeyModifier } from '../constants.js';
import type { KeyModifiers } from './keyModifiers.js';

const emptyModifiers = (): KeyModifiers => ({ ctrl: false, shift: false, alt: false });

let armed = emptyModifiers();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

function set(next: KeyModifiers): void {
  if (next.ctrl === armed.ctrl && next.shift === armed.shift && next.alt === armed.alt) return;
  armed = next;
  emit();
}

/** Read the modifiers armed for the next phone terminal input. */
export const getArmedKeyModifiers = (): KeyModifiers => armed;

/** Whether the next phone terminal input needs modifier encoding. */
export const hasArmedKeyModifiers = (): boolean => armed.ctrl || armed.shift || armed.alt;

/** Toggle one independently armed key-bar modifier. */
export function toggleArmedKeyModifier(modifier: MobileKeyModifier): void {
  set({ ...armed, [modifier]: !armed[modifier] });
}

/** Take the one-shot modifiers and release them before the input is written. */
export function consumeArmedKeyModifiers(): KeyModifiers {
  const consumed = armed;
  set(emptyModifiers());
  return consumed;
}

/** React and the mobile key bar subscribe to the same armed state. */
export function subscribeArmedKeyModifiers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests start each store assertion without modifiers armed by another test. */
export function resetArmedKeyModifiersForTests(): void {
  set(emptyModifiers());
}
