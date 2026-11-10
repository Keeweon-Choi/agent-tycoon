import { afterEach, describe, expect, it, vi } from 'vitest';

import { diskBytes, diskMeasuredAt } from './diskCard.js';

afterEach(() => vi.restoreAllMocks());

describe('diskBytes', () => {
  it('formats bytes through terabytes with one useful decimal', () => {
    expect(diskBytes(0)).toBe('0 B');
    expect(diskBytes(340 * 1024 * 1024)).toBe('340 MB');
    expect(diskBytes(1.2 * 1024 * 1024 * 1024)).toBe('1.2 GB');
    expect(diskBytes(-5)).toBe('0 B');
  });

  it('formats the reading in the app language locale', () => {
    const format = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('formatted reading');

    expect(diskMeasuredAt('2026-10-31T15:00:00.000Z', 'ko')).toBe('formatted reading');
    expect(format).toHaveBeenLastCalledWith('ko-KR');
    expect(diskMeasuredAt('2026-10-31T15:00:00.000Z', 'en')).toBe('formatted reading');
    expect(format).toHaveBeenLastCalledWith('en-US');
  });
});
