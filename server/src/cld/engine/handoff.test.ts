import { describe, expect, it } from 'vitest';

import type { GitRunner } from './git/gitRun.js';
import { COMMIT_REFS_MAX, handoffFormat, handoffRefs, keepCommits, renewPrompt } from './handoff.js';

describe('K1 handoff (BRN §3.2 B1, B5)', () => {
  it('the form: the four required headings (Korean or English), optional ones and (선택) allowed', () => {
    expect(handoffFormat('## 목표\n- a\n## 완료 (선택)\n## 미해결\n### 다음 행동\n## 결정')).toBe('ok');
    expect(handoffFormat('## Goal\n## Done\n## Open\n## Next')).toBe('ok');
    expect(handoffFormat('## 목표\n## 완료\n## 미해결')).toBe('free'); // 다음 행동 missing
    expect(handoffFormat('목표: 다 했다\n완료\n미해결\n다음 행동')).toBe('free'); // not headings
    expect(handoffFormat('')).toBe('free');
  });

  it('references: UIDs, display IDs, Tasks, SHAs and message IDs, once each, in order', () => {
    const text = [
      '- [사실] FR-OFC-001 은 r_abcdefgh23 로, 문서 d_abcdefgh23, 구성요소 c_abcdefgh23',
      '- [사실] T-3 끝냄, 커밋 5c24f88e 와 1234567(숫자만이라 아님) ⟨m:abcdefgh⟩',
      '- [판단] T-0050 다시, FR-OFC-001 한 번 더, 5C24F88E 는 대문자라 아님',
    ].join('\n');
    expect(handoffRefs(text, new Set(['T-3']), 'alpha')).toEqual([
      { t: 'display', id: 'FR-OFC-001' },
      { t: 'req', uid: 'r_abcdefgh23' },
      { t: 'doc', uid: 'd_abcdefgh23' },
      { t: 'comp', uid: 'c_abcdefgh23' },
      { t: 'task', id: 'T-3' },
      { t: 'commit', sha: '5c24f88e' },
      { t: 'msg', where: 'alpha', id: 'abcdefgh' },
      { t: 'display', id: 'T-0050' },
    ]);
  });

  it('a free handoff says so in the head; an empty one still renews with a note', () => {
    const free = renewPrompt({ when: '11-05 00:00', handoff: '그냥 글', file: null, format: 'free', basis: 'B' });
    expect(free).toContain('양식(목표·완료·미해결·다음 행동)을 따르지 않았다');
    expect(free.indexOf('그냥 글')).toBeLessThan(free.indexOf('\nB'));
    expect(renewPrompt({ when: 'w', handoff: '  ', file: null, format: 'free', basis: '' })).toContain('(비어 있음');
  });
});

describe('K1 (B5): commit references are the repository\'s commits only', () => {
  const sha = 'c324dafeca5ad7ba50fef091f1c2392e264af834';
  const seen: string[][] = [];
  const run: GitRunner = (_cwd, args) => {
    seen.push(args);
    const out = args.filter((a) => sha.startsWith(a)).length ? `${sha}\n` : '';
    return Promise.resolve({ code: 0, stdout: Buffer.from(out), stderr: '', capped: false, timedOut: false });
  };

  it('a resolving short SHA becomes the full one; a hex secret is dropped; one git call, capped', async () => {
    const secret = 'deadbeefcafe0123456789abcdef0123'; // 32 hex: an API key shape
    const refs = handoffRefs(`커밋 c324daf, 다시 ${sha}, 키 ${secret}, T-3`, new Set(['T-3']), 'alpha');
    expect(refs.filter((r) => r.t === 'commit')).toHaveLength(3);
    expect(await keepCommits(refs, run, '/w')).toEqual([{ t: 'commit', sha }, { t: 'task', id: 'T-3' }]);
    expect(seen).toEqual([['rev-list', '--no-walk', '--ignore-missing', 'c324daf', sha, secret]]);
    const many = Array.from({ length: COMMIT_REFS_MAX + 5 }, (_, i) => `abc${String(i).padStart(5, '0')}`).join(' ');
    await keepCommits(handoffRefs(many, new Set(), 'alpha'), run, '/w');
    expect(seen.at(-1)!.length).toBe(3 + COMMIT_REFS_MAX);
  });

  it('git failing or missing keeps no commit at all', async () => {
    const broken: GitRunner = () => Promise.reject(new Error('git missing'));
    expect(await keepCommits([{ t: 'commit', sha: 'c324daf' }, { t: 'display', id: 'FR-A-1' }], broken, '/w')).toEqual([
      { t: 'display', id: 'FR-A-1' },
    ]);
  });
});
