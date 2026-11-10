/**
 * Postponed features (owner 11-04): the interior editor, and the looks window's 사람 꾸미기 and 커스텀
 * tabs, have no way in while their flags in constants.ts are false; the code stays for when they
 * come back (the 꾸미기 window itself shows 마스코트 and 사람).
 * Under the e2e harness both are on, so the runners that test the features themselves keep working;
 * `window.__AGENT_TYCOON_LATER_FEATURES = 'off'` (init script) turns that off to test the hidden state.
 */
import { FEATURE_INTERIOR, FEATURE_LOOKS_CUSTOM } from '../constants.js';
import { isE2E } from '../runtime.js';

const e2eOn =
  isE2E &&
  (globalThis as { __AGENT_TYCOON_LATER_FEATURES?: string }).__AGENT_TYCOON_LATER_FEATURES !==
    'off';

export const interiorOn: boolean = FEATURE_INTERIOR || e2eOn;
export const looksCustomOn: boolean = FEATURE_LOOKS_CUSTOM || e2eOn;
