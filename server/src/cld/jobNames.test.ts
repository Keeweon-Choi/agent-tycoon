import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { codexOutcome, jobOutcome, workAction, workNotice } from '../../../core/src/cld/work.js';
import {
  codexShownTitle,
  codexTitle,
  deriveJobName,
  jobDescription,
  particle,
} from './jobNames.js';

describe('human work names', () => {
  it.each([
    ['node cld/install/install.mjs', '배포'],
    ['bash cld/scripts/gate.sh', '병합 검사'],
    ['npx tsx cld/test/run-all.ts', '브라우저 시험 전체'],
    ['npx tsx cld/test/run-chat.ts', '브라우저 시험(chat)'],
    ['npm run test:unit', '시험'],
    ['npx vitest run', '시험'],
    ['esbuild src/main.ts', '빌드'],
    ['python train.py', '학습'],
    ['ffmpeg -i x.mp4 y.mp4', '영상 변환'],
    ['python3 weird.py', 'python3 작업'],
  ])('%s → %s', (cmd, name) => expect(deriveJobName(cmd)).toBe(name));
  it('user rules take precedence', () => {
    expect(
      deriveJobName('node cld/install/install.mjs', [{ pattern: 'install', name: '새 배포' }]),
    ).toBe('새 배포');
  });
  it('validates a one-line description', () => {
    expect(jobDescription('  데이터 백업  ')).toBe('데이터 백업');
    expect(() => jobDescription('a'.repeat(81))).toThrow();
    expect(() => jobDescription('한 줄\n다음 줄')).toThrow();
  });
  it('finds the first heading once, with a file-name fallback', () => {
    expect(codexTitle('/tmp/T-0065.md', 'text\n# T-0065: whiteboard\n## later')).toBe(
      'T-0065: whiteboard',
    );
    expect(codexTitle('/tmp/T-0065.md', 'text')).toBe('T-0065.md');
  });
  it('chooses Korean particles by final consonant', () => {
    expect(particle('배포', '이/가')).toBe('가');
    expect(particle('시험', '이/가')).toBe('이');
    expect(particle('배포', '을/를')).toBe('를');
    expect(particle('시험', '을/를')).toBe('을');
  });
  it('uses outcomes without process numbers', () => {
    expect(jobOutcome(null, false)).toBe('진행 중');
    expect(jobOutcome(0, true)).toBe('끝남(성공)');
    expect(jobOutcome(2, true)).toBe('실패');
    expect(jobOutcome(143, true, true)).toBe('멈춤(사용자가 멈춤)');
    expect(jobOutcome(124, true)).toBe('시간 초과');
    expect(codexOutcome('limit')).toBe('한도 대기');
    expect(workNotice('배포', '끝남(성공)')).toBe('배포가 끝났어요');
    expect(workNotice('시험', '실패')).toBe('시험이 실패했어요');
    expect(workNotice('T-0065: whiteboard', '끝남(성공)')).toBe('T-0065 작업이 끝났어요');
    expect(workNotice('브라우저 시험(chat)', '실패')).toBe('브라우저 시험(chat)이 실패했어요');
    expect(workAction('배포', 'work_started')).toBe('배포를 시작했어요');
    expect(workAction('T-0065: whiteboard', 'work_stopping')).toBe(
      'T-0065 작업을 멈추는 중이에요',
    );
  });
});

describe("a Codex run's title says what it does", () => {
  const RULES =
    '# Rules for this task (from the orchestrator, via `cld-gui codex`)\n\n- Work only here.\n\n';
  it('skips the orchestrator rules block at the top of a spec', () => {
    expect(codexTitle('/tmp/spec-u50.md', `${RULES}# Task U-50: room posts\n## Change`)).toBe(
      'Task U-50: room posts',
    );
    expect(codexTitle('/tmp/spec-x.md', RULES)).toBe('spec-x.md');
  });
  it('a title recorded as the rules heading is read again from the spec; others stay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-title-'));
    const spec = path.join(dir, 'spec-y.md');
    fs.writeFileSync(spec, `${RULES}# Task Y: the real work\n`);
    expect(
      codexShownTitle('Rules for this task (from the orchestrator, via `cld-gui codex`)', spec),
    ).toBe('Task Y: the real work');
    expect(codexShownTitle('Task Z', spec)).toBe('Task Z');
    expect(codexShownTitle(undefined, path.join(dir, 'gone.md'))).toBe('gone.md');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
