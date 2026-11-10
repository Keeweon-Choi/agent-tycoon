import { expect, it } from 'vitest';

import { OFFICE_CANVAS_TEST_ID } from '../constants.js';
import { isOfficeCanvasTarget } from './canvasTarget.js';

const el = (testId?: string) =>
  ({
    getAttribute: (n: string) => (n === 'data-testid' ? (testId ?? null) : null),
  }) as unknown as EventTarget;

it('only the office canvas counts, not another canvas (xterm) or a panel', () => {
  expect(isOfficeCanvasTarget(el(OFFICE_CANVAS_TEST_ID))).toBe(true);
  expect(isOfficeCanvasTarget(el())).toBe(false); // the terminal panel's canvas
  expect(isOfficeCanvasTarget(el('lobby-board'))).toBe(false);
  expect(isOfficeCanvasTarget(null)).toBe(false);
  expect(isOfficeCanvasTarget({} as EventTarget)).toBe(false);
});
