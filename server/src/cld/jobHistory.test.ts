import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';

import { estimateProgress, historyMedian, rememberDuration } from './jobHistory.js';

const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((home) => fs.rmSync(home, { recursive: true, force: true })),
);
it('keeps the latest five successful durations per exact name and reads their median', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-history-'));
  homes.push(home);
  expect(historyMedian(home, '배포')).toBeNull();
  for (const ms of [1000, 2000, 3000, 4000, 5000, 6000]) rememberDuration(home, '배포', ms);
  expect(historyMedian(home, '배포')).toBe(4000);
  expect(historyMedian(home, '시험')).toBeNull();
  const saved = JSON.parse(
    fs.readFileSync(path.join(home, '.config/cld-gui/job-history.json'), 'utf8'),
  );
  expect(saved['배포']).toEqual([2000, 3000, 4000, 5000, 6000]);
});
it('estimates a bar: known steps, else the last runs (capped at 95 %), else indeterminate', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-history-'));
  homes.push(home);
  const steps = estimateProgress(
    home,
    '시험',
    'npx vitest run',
    ' Test Files  3 passed (3)\n',
    1000,
  );
  expect(steps).toMatchObject({ label: '1/2단계', pct: 50 });
  expect(estimateProgress(home, 'sleep 작업', 'sleep 9', '', 60_000)).toMatchObject({
    label: '첫 실행',
    indeterminate: true,
  });
  rememberDuration(home, 'sleep 작업', 4 * 60_000);
  expect(estimateProgress(home, 'sleep 작업', 'sleep 9', '', 2 * 60_000)).toMatchObject({
    label: '지난번 4분 · 약 2분 남음',
    pct: 50,
  });
  expect(estimateProgress(home, 'sleep 작업', 'sleep 9', '', 10 * 60_000).pct).toBe(95);
});
