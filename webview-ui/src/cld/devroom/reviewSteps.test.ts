import { describe, expect, it } from 'vitest';

import { reviewStep } from './reviewSteps.js';

const base = { notes: [], sending: false, fixing: false, merged: false };
const sent = { sentAt: '2026-11-01T01:12:00Z' };

describe('reviewStep', () => {
  it('walks the loop: look, note, send, fix, look again, merge', () => {
    expect(reviewStep(base)).toBe(1);
    expect(reviewStep({ ...base, notes: [{}] })).toBe(2);
    expect(reviewStep({ ...base, notes: [sent], sending: true })).toBe(3);
    expect(reviewStep({ ...base, notes: [sent], fixing: true })).toBe(4);
    expect(reviewStep({ ...base, notes: [sent] })).toBe(5);
    expect(reviewStep({ ...base, notes: [sent], merged: true })).toBe(6);
  });

  it('goes back to 2 when a new note is written after a send', () => {
    expect(reviewStep({ ...base, notes: [sent, {}], fixing: true })).toBe(2);
  });
});
