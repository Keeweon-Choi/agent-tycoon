import { describe, expect, it } from 'vitest';

import { summarizeEvent, WORKER_RUN_END } from './eventSummary.js';

describe('event summaries', () => {
  it('Korean one-liners without bodies or commands', () => {
    const send = summarizeEvent({
      v: 1,
      type: 'send',
      ts: 't',
      source: 'cli',
      from: 'a',
      to: 'b',
      preview: 'SECRET',
      delivered: 'inbox',
    })!;
    expect(send).toEqual({
      ts: 't',
      kind: 'send',
      source: 'cli',
      name: 'b',
      summary: 'a → b 메시지 (inbox)',
    });
    // The app's sends have no `from`: the device from `source`, never '?'.
    const fromApp = summarizeEvent({ type: 'send', ts: 't', source: 'gui:windows', to: 'b' })!;
    expect(fromApp.summary).toBe('나(windows) → b 메시지');
    // The boss's other ways (the messenger, the terminal) read as the boss; the engine's own as the daemon.
    for (const source of ['cli', 'messenger:phone'])
      expect(summarizeEvent({ type: 'send', ts: 't', source, to: 'b' })!.summary).toBe('사장 → b 메시지');
    expect(summarizeEvent({ type: 'send', ts: 't', source: 'engine', to: 'b' })!.summary).toBe(
      'cld-gui → b 메시지',
    );
    // Every kind the engine writes has words: none shows as its raw code.
    for (const [type, fields] of [
      ['send_hold', { on: true }],
      ['send_hold', { on: false }],
      ['send_edit', {}],
      ['send_cancel', {}],
      ['send_stuck', {}],
      ['token_guard', {}],
    ] as const) {
      const hold = summarizeEvent({ type, ts: 't', source: 'cli', to: 'b', ...fields })!;
      expect(hold.summary).toMatch(/b/);
      expect(hold.summary).not.toContain('_');
    }
    const job = summarizeEvent({
      v: 1,
      type: 'job_start',
      ts: 't',
      source: 'cli',
      pid: 1,
      project: 'p',
      cmd: 'x --token=abc',
    })!;
    expect(JSON.stringify(job)).not.toMatch(/token|SECRET/);
    expect(
      summarizeEvent({
        type: 'orch_giveup',
        ts: 't',
        name: 'alpha',
        error: '세션을 켜지 못했어요',
      })!.summary,
    ).toBe('alpha: 자꾸 꺼져서 다시 띄우지 않아요 (세션을 켜지 못했어요)');
    expect(summarizeEvent({ type: 'turn_end', ts: 't', name: 'alpha' })!.summary).toBe(
      'alpha 턴 끝',
    );
    expect(
      summarizeEvent({
        type: 'codex_end',
        ts: 't',
        id: 'c1',
        state: 'done',
        title: 'T-0065: memo',
      })!.summary,
    ).toBe('T-0065 작업이 끝났어요');
    const failed = summarizeEvent({
      type: 'job_end',
      ts: 't',
      id: 'j-7',
      pid: 9901,
      exit: 42,
      label: '브라우저 시험(chat)',
    })!;
    expect(failed.summary).toBe('브라우저 시험(chat)이 실패했어요');
    expect(failed.summary).not.toMatch(/42|9901|exit|pid/);
    expect(summarizeEvent({ type: 'gpu_wait', ts: 't', project: 'p' })!.summary).toBe(
      'GPU wait: p',
    );
    const gpu = (type: string, more: Record<string, unknown> = {}) =>
      summarizeEvent({ type, ts: 't', id: 'g-1', project: 'p', ...more })!.summary;
    expect(gpu('gpu_queue', { label: 'secret label' })).toBe('GPU 줄 섬: p');
    expect(gpu('gpu_lease')).toBe('GPU 차례 옴: p');
    expect(gpu('gpu_release', { exit: 0 })).toBe('GPU 반납: p');
    expect(gpu('gpu_release', { reason: 'dead' })).toBe('GPU 반납: p (비정상 종료)');
    expect(gpu('gpu_cancel', { reason: 'wait' })).toBe('GPU 대기 끝: p (시간 초과)');
    expect(gpu('gpu_cancel', { reason: 'stop' })).toBe('GPU 대기 끝: p (멈춤)');
    expect(gpu('gpu_move', { position: 1 })).toBe('GPU 순서 바뀜: p → 1번째');
    expect(
      summarizeEvent({ type: 'usage_reset_early', ts: 't', provider: 'codex', period: 'sevenDay' }),
    ).toMatchObject({
      summary: 'Codex 주간 사용량이 예정보다 일찍 초기화됐어요',
      provider: 'codex',
      period: 'sevenDay',
    });
    expect(summarizeEvent({ ts: 't' })).toBeNull();
  });

  it('D5: a Codex Worker’s run is its own; only a failed end stays codex_end (a notice and a push)', () => {
    const w = { ts: 't', id: 'c1', project: 'alpha', agent: 'alpha-w1', title: 'T-1 로그인' };
    expect(summarizeEvent({ ...w, type: 'codex_start' })).toMatchObject({ kind: 'codex_start', name: 'alpha-w1' });
    for (const state of ['done', 'stopped'])
      expect(summarizeEvent({ ...w, type: 'codex_end', state })).toMatchObject({
        kind: WORKER_RUN_END,
        name: 'alpha-w1',
        ref: 'c1',
        summary: expect.stringMatching(/^alpha-w1 · /),
      });
    expect(summarizeEvent({ ...w, type: 'codex_end', state: 'failed' })).toMatchObject({ kind: 'codex_end', name: 'alpha-w1', ref: 'c1' });
    // Its engine job's end is not a second line (nor a notice).
    expect(summarizeEvent({ type: 'job_end', ts: 't', id: 'c1', kind: 'codex', agent: 'alpha-w1', exit: 0 })).toBeNull();
    expect(summarizeEvent({ type: 'job_end', ts: 't', id: 'c2', kind: 'codex', exit: 0 })).toMatchObject({ kind: 'job_end' });
    // A `cld-gui codex` task is as before.
    expect(summarizeEvent({ type: 'codex_end', ts: 't', id: 'c2', project: 'alpha', state: 'done' })).toMatchObject({ kind: 'codex_end', name: 'alpha' });
  });

  it('a job or Codex end names which one (ref) for its notice to open (T-0043)', () => {
    expect(summarizeEvent({ type: 'codex_end', ts: 't', id: 'c1', state: 'done' })!.ref).toBe('c1');
    expect(summarizeEvent({ type: 'job_end', ts: 't', id: 'j-7', pid: 9 })!.ref).toBe('j-7');
    expect(summarizeEvent({ type: 'job_end', ts: 't', pid: 4242, exit: 0 })!.ref).toBe('pid:4242');
    expect(summarizeEvent({ type: 'turn_end', ts: 't', name: 'a' })!).not.toHaveProperty('ref');
  });
});
