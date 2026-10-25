import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { digestJobLog, maskJobLog } from './jobDigest.js';
import { REPO_ROOT } from './testHome.js';

describe('readable job logs', () => {
  it('digests the installer dry-run output and hides the first-device link', () => {
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, 'server/src/cld/fixtures/install-dry-run.txt'),
      'utf8',
    );
    const result = digestJobLog('node cld/install/install.mjs', raw);
    expect(result.steps.map((s) => s.name)).toEqual([
      '프로토콜 생성',
      '빌드',
      '화면 빌드',
      '설정',
      '서비스 다시 켜기',
      '끝',
    ]);
    expect(result.steps.every((s) => s.state === 'done')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('DRY_RUN_CODE');
    expect(maskJobLog(raw)).toContain('/login?code=***');
  });
  it('reads gate and run-all milestones', () => {
    expect(digestJobLog('bash gate.sh', '== lint\nPASS lint\n== tests\nFAIL tests').steps).toEqual([
      { name: 'lint', state: 'done' },
      { name: 'tests', state: 'failed' },
    ]);
    expect(
      digestJobLog(
        'npx tsx cld/test/run-all.ts',
        'run-all: run-chat PASS (5 checks)\nrun-all: run-files FAIL (2 checks)',
      ).steps,
    ).toEqual([
      { name: '브라우저 시험(chat)', state: 'done' },
      { name: '브라우저 시험(files)', state: 'failed' },
    ]);
  });
  it('drops noise and masks secrets in generic and raw views', () => {
    const raw =
      '\x1b[31m npm warn noisy\rworking\n/login?code=ABCDEFGH\n코드: 12345678\nfailed with token=secret';
    const digest = digestJobLog('custom thing', raw);
    expect(digest.steps).toEqual([]);
    expect(JSON.stringify(digest)).not.toMatch(/ABCDEFGH|12345678|token=secret|npm warn/);
    expect(maskJobLog(raw)).not.toMatch(/ABCDEFGH|12345678|token=secret/);
    expect(digest.lines.at(-1)?.error).toBe(true);
  });
});
