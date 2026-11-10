import { OFFICE_CANVAS_TEST_ID } from '../constants.js';

/**
 * U-28: whether a pointer event's target is the office canvas itself. Panels
 * (the terminal's xterm draws on its own <canvas>) live inside the office
 * container, so "a canvas" is not enough: container-level tap handlers (the
 * board, the whiteboards) act only when this says yes. DOM-free on purpose.
 */
export const isOfficeCanvasTarget = (target: EventTarget | null): boolean =>
  (target as Element | null)?.getAttribute?.('data-testid') === OFFICE_CANVAS_TEST_ID;
