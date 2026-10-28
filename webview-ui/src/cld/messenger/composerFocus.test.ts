import { expect, it } from 'vitest';

import { keepPhoneComposerFocus } from './composerFocus.js';

/**
 * Models the browser's focus default: a pointerdown focuses the button unless
 * it is cancelled. The configured test environment is Node and this repo has
 * no jsdom dependency; neither environment models an iPhone keyboard or visual
 * viewport, so the device check remains a real-iPhone verification.
 */
const press = (phone: boolean, action: () => void) => {
  let inputFocused = true;
  const event = new Event('pointerdown', { cancelable: true });
  keepPhoneComposerFocus(phone, event);
  if (!event.defaultPrevented) inputFocused = false;
  action();
  return { inputFocused, defaultPrevented: event.defaultPrevented };
};

it('a phone composer control keeps its focused input through pointerdown and runs its click action', () => {
  for (const control of ['attach', 'send now', 'send'] as const) {
    const action = { control: null as typeof control | null };
    const result = press(true, () => (action.control = control));
    expect(result).toEqual({ inputFocused: true, defaultPrevented: true });
    expect(action.control).toBe(control);
  }
});

it('leaves desktop pointerdown unchanged', () => {
  const result = press(false, () => undefined);
  expect(result).toEqual({ inputFocused: false, defaultPrevented: false });
});
