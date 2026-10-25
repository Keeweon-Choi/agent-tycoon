import { beforeEach, describe, expect, it } from 'vitest';

import type { ClientMessage, EngineProject } from '../../../core/src/messages.js';
import { setLanguage } from '../i18n/index.js';
import { formError, formFields, formFor } from './engine.js';
import { jobGetSnapshot, jobHandleMessage, jobRequest, jobResetForTests } from './jobStore.js';

beforeEach(() => {
  setLanguage('ko');
  jobResetForTests();
});

describe('engine jobs in the job panel (T-0019)', () => {
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
