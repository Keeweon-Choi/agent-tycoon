import { describe, expect, it } from 'vitest';

import { parseTqdm } from './jobProgress.js';

describe('tqdm progress', () => {
  it('takes the last \\r segment of the log', () => {
    const log =
      'epoch 1\r  1%|          | 1/100 [00:00<01:00,  1.00it/s]\r train:  46%|████▌     | 460/1000 [01:23<01:40,  5.41it/s]\n';
    expect(parseTqdm(log)).toEqual({ label: 'train', pct: 46, rate: '5.41it/s', eta: '01:40' });
  });
  it('parses the spec example and a bar without a label', () => {
    expect(parseTqdm('label: 45%|███▌ | 450/1000 [01:23<01:41, 5.4it/s]')).toEqual({
      label: 'label',
      pct: 45,
      rate: '5.4it/s',
      eta: '01:41',
    });
    expect(parseTqdm(' 7%|▋         | 7/100 [00:01<00:13,  6.95it/s]\n')).toMatchObject({
      label: null,
      pct: 7,
    });
  });
  it('returns null when the tail is not a bar', () => {
    expect(parseTqdm('epoch 3 done\n')).toBeNull();
    expect(parseTqdm('')).toBeNull();
  });
});
