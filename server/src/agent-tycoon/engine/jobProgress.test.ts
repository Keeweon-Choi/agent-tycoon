import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { parseTqdm, readLogTail } from './jobProgress.js';

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

describe('readLogTail', () => {
  it('starts at a line start when the read did not begin at offset 0 (S8.5)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'));
    try {
      const file = path.join(dir, 'job.log');
      const line = 'DB_PASSWORD=made-up-not-real-value\n';
      fs.writeFileSync(file, `${line}${line}${line}`);
      // 40 bytes back from the end falls inside the second line's name.
      const tail = readLogTail(file, 40);
      expect(tail).toBe(line);
      expect(readLogTail(file, 4096)).toBe(`${line}${line}${line}`);
      expect(readLogTail(path.join(dir, 'missing.log'))).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
