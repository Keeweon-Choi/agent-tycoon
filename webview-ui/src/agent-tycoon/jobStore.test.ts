import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientMessage, EngineProject } from '../../../core/src/messages.js';
import { setLanguage } from '../i18n/index.js';
import { formError, formFields, formFor } from './engine.js';
import {
  jobGetSnapshot,
  jobHandleMessage,
  jobKeepOnly,
  jobPollLog,
  jobRequest,
  jobResetForTests,
} from './jobStore.js';

beforeEach(() => {
  setLanguage('ko');
  jobResetForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('engine jobs in the job panel (T-0019)', () => {
  it('P1.2: a hidden page reads no log on the poll\'s ticks (a socket down meanwhile would queue them all)', () => {
    vi.useFakeTimers();
    const page = { visibilityState: 'visible' };
    vi.stubGlobal('document', page);
    const sent: ClientMessage[] = [];
    const link = { send: (m: ClientMessage) => void sent.push(m), state: 'connected' as const };
    const stop = jobPollLog(link, 'run-1', true, 3_000);
    expect(sent).toHaveLength(1); // read at once
    vi.advanceTimersByTime(3_000);
    expect(sent).toHaveLength(2);
    page.visibilityState = 'hidden';
    vi.advanceTimersByTime(8 * 3_600_000); // a night minimized
    expect(sent).toHaveLength(2);
    page.visibilityState = 'visible';
    vi.advanceTimersByTime(3_000);
    expect(sent).toHaveLength(3);
    stop();
    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(3);
    // An ended run is read once, hidden or not (its last lines), and not polled.
    page.visibilityState = 'hidden';
    jobPollLog(link, 'run-2', false, 3_000)();
    vi.advanceTimersByTime(30_000);
    expect(sent.map((m) => m.type === 'jobAction' && m.id)).toEqual(['run-1', 'run-1', 'run-1', 'run-2']);
  });

  it('P1.2: a visible page whose socket is down queues no log request per tick (all replayed on reconnect)', () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const sent: ClientMessage[] = [];
    const link: { send: (m: ClientMessage) => void; state: string } = { send: (m) => void sent.push(m), state: 'connected' };
    const stop = jobPollLog(link as Parameters<typeof jobPollLog>[0], 'run-1', true, 3_000);
    expect(sent).toHaveLength(1);
    link.state = 'reconnecting';
    vi.advanceTimersByTime(8 * 3_600_000); // a night with the network gone
    expect(sent).toHaveLength(1);
    link.state = 'connected';
    vi.advanceTimersByTime(3_000);
    expect(sent).toHaveLength(2);
    stop();
  });

  it('a log request and its answer; a stop is sent once and toasted', () => {
    const sent: ClientMessage[] = [];
    const toasts: string[] = [];
    const toast = (name: string, text: string) => toasts.push(`${name}: ${text}`);
    jobRequest((m) => sent.push(m), 'log', '1021-231502-alpha');
    expect(sent).toEqual([
      { type: 'jobAction', requestId: 'job-1', action: 'log', id: '1021-231502-alpha' },
    ]);
    jobHandleMessage(
      {
        type: 'jobActionResult',
        requestId: 'job-1',
        action: 'log',
        id: '1021-231502-alpha',
        ok: true,
        log: 'epoch 1\n',
        truncated: false,
      },
      toast,
    );
    expect(jobGetSnapshot().logs['1021-231502-alpha']).toEqual({
      text: 'epoch 1\n',
      truncated: false,
    });
    jobRequest((m) => sent.push(m), 'stop', '1021-231502-alpha');
    jobRequest((m) => sent.push(m), 'stop', '1021-231502-alpha'); // already on its way
    expect(sent.filter((m) => m.type === 'jobAction' && m.action === 'stop')).toHaveLength(1);
    expect(jobGetSnapshot().stopping['1021-231502-alpha']).toBe(true);
    jobHandleMessage(
      {
        type: 'jobActionResult',
        requestId: 'job-2',
        action: 'stop',
        id: '1021-231502-alpha',
        ok: false,
        error: '\uc77d\uae30 \uc804\uc6a9 \ubaa8\ub4dc\ub77c \uc870\uc791\ud560 \uc218 \uc5c6\uc5b4\uc694',
      },
      toast,
    );
    expect(jobGetSnapshot().stopping).toEqual({});
    expect(jobGetSnapshot().errors['1021-231502-alpha']).toBe('\uc77d\uae30 \uc804\uc6a9 \ubaa8\ub4dc\ub77c \uc870\uc791\ud560 \uc218 \uc5c6\uc5b4\uc694');
    expect(toasts).toEqual(['1021-231502-alpha: \uc77d\uae30 \uc804\uc6a9 \ubaa8\ub4dc\ub77c \uc870\uc791\ud560 \uc218 \uc5c6\uc5b4\uc694']);
    // Answers to requests this client did not make are ignored.
    jobHandleMessage(
      { type: 'jobActionResult', requestId: 'job-99', action: 'stop', id: 'x', ok: true },
      toast,
    );
    expect(toasts).toHaveLength(1);
  });

  it('P1.4: a job list keeps only the logs and errors of the jobs it still names', () => {
    const toast = () => undefined;
    const ids = Array.from({ length: 20 }, (_, i) => `run-${i}`);
    for (const id of ids) jobRequest(() => undefined, 'log', id);
    ids.forEach((id, i) =>
      jobHandleMessage(
        { type: 'jobActionResult', requestId: `job-${i + 1}`, action: 'log', id, ok: i !== 3, log: 'x'.repeat(1000), truncated: false },
        toast,
      ),
    );
    expect(Object.keys(jobGetSnapshot().logs)).toHaveLength(19);
    jobKeepOnly(['run-3', 'run-7', 'pid:42']);
    expect(Object.keys(jobGetSnapshot().logs)).toEqual(['run-7']);
    expect(Object.keys(jobGetSnapshot().errors)).toEqual(['run-3']);
  });

  it('the project form: compaction nudge off by default, 1..99, 0 turns it off on edit', () => {
    const p: EngineProject = {
      name: 'alpha',
      folder: '/w/alpha',
      room: 'alpha',
      wantRunning: false,
      live: false,
    };
    const f = formFor(null);
    expect(f.compactionNudge).toBe('');
    expect(formFields({ ...f, folder: '/w/a', name: 'a' }, null)).not.toHaveProperty(
      'compactionNudge',
    );
    expect(
      formFields({ ...f, folder: '/w/a', name: 'a', compactionNudge: '2' }, null),
    ).toMatchObject({
      compactionNudge: 2,
    });
    expect(
      formError({ ...f, folder: '/w/a', name: 'a', compactionNudge: '0' }, true, null),
    ).toMatch(/1\uc5d0\uc11c 4/);
    expect(
      formError({ ...f, folder: '/w/a', name: 'a', compactionNudge: 'x' }, true, null),
    ).toMatch(/1\uc5d0\uc11c 4/);
    const was = { ...p, compactionNudge: 2 };
    expect(formFor(was).compactionNudge).toBe('2');
    expect(formFields({ ...formFor(was), compactionNudge: '' }, was)).toEqual({
      compactionNudge: 0,
    });
    expect(formFields(formFor(was), was)).toEqual({});
  });
});
