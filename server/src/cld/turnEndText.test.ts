import { describe, expect, it } from 'vitest';

import { doingTaskTitle, turnEndText } from '../../../core/src/cld/notices.js';
import { koText, textIn } from '../../../core/src/cld/serverText.js';
import { codexTitle } from './jobNames.js';

describe('turnEndText (owner 11-01: say what finished)', () => {
  it('names the Task', () => {
    expect(turnEndText({ task: '앱 알림 UI 개선', doing: '파일 읽는 중' })).toBe(
      "'앱 알림 UI 개선' 작업을 마쳤어요",
    );
  });
  it('else the last activity line', () => {
    expect(turnEndText({ task: null, doing: '테스트 돌리는 중' })).toBe(
      '일을 마쳤어요 · 테스트 돌리는 중',
    );
  });
  it('else today\'s text', () => {
    expect(turnEndText({})).toBe('일을 마쳤어요');
    expect(turnEndText({ task: '  ', doing: '' })).toBe('일을 마쳤어요');
  });
  it('a long or marked-up title is plain and short', () => {
    expect(turnEndText({ task: '**굵은** `제목`' })).toBe("'굵은 제목' 작업을 마쳤어요");
    const out = turnEndText({ task: '가'.repeat(80) });
    expect(out).toBe(`'${'가'.repeat(39)}…' 작업을 마쳤어요`);
  });
  it('reads in English for the English push', () => {
    expect(textIn('en', turnEndText({ task: 'Fix it' }))).toBe("Finished 'Fix it'");
  });
});

describe('doingTaskTitle', () => {
  const task = (title: string, status: string, updatedAt: string, name = 'alpha') => ({
    title,
    status,
    updatedAt,
    assignee: { name },
  });
  it('the newest doing Task of that agent', () => {
    const tasks = [
      task('옛 일', 'doing', '2026-11-01T01:00:00Z'),
      task('새 일', 'doing', '2026-11-01T02:00:00Z'),
      task('끝난 일', 'done', '2026-11-01T03:00:00Z'),
      task('남의 일', 'doing', '2026-11-01T04:00:00Z', 'beta'),
    ];
    expect(doingTaskTitle(tasks, 'alpha')).toBe('새 일');
    expect(doingTaskTitle(tasks, 'gamma')).toBeNull();
  });
});

describe('permission wait names the agent as the subject', () => {
  it('particle by the name', () => {
    expect(koText('cause_permission_sub', { sub: '우치하 사스케줄' })).toBe('우치하 사스케줄이 허락을 기다려요');
    expect(koText('cause_permission_sub', { sub: '롤로노아 제로데이' })).toBe('롤로노아 제로데이가 허락을 기다려요');
    expect(textIn('en', '우치하 사스케줄이 허락을 기다려요')).toBe('우치하 사스케줄 is waiting for your permission');
  });
});

describe('codexTitle: the spec heading without its leading id', () => {
  it('drops "ID:"', () => {
    expect(
      codexTitle('/s/a.md', '# REQ-STATUS-DOC: bring cld/docs/plan/requirements-status.md up to date\n'),
    ).toBe('bring cld/docs/plan/requirements-status.md up to date');
    expect(codexTitle('/s/a.md', '# T-0065: 알림 고치기\n')).toBe('알림 고치기');
  });
  it('keeps an ordinary heading with a colon', () => {
    expect(codexTitle('/s/a.md', '# Note: keep this\n')).toBe('Note: keep this');
    expect(codexTitle('/s/a.md', '# 배포 정리\n')).toBe('배포 정리');
  });
});
