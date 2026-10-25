import { describe, expect, it } from 'vitest';

import { STAFF_NAMES } from '../../../../core/src/cld/staffNames.js';
import type { ChatItem } from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import { employeePalette, noticeEmployee, noticeName, senderKey, shellDone, startsRun } from './senderFace.js';

const item = (o: Partial<ChatItem>): ChatItem => ({ kind: 'assistant', text: 'x', id: '1-a', at: 1, ...o });

describe('MSG-UI2 sender faces', () => {
  it('who has a face', () => {
    expect(senderKey(item({}))).toBe('lead');
    expect(senderKey(item({ kind: 'user', from: 'peer', fromName: 'beta' }))).toBe('peer:beta');
    expect(senderKey(item({ kind: 'user', from: 'peer', fromName: 'task notice', execution: 'claude:t1' }))).toBe(
      'peer:claude:t1',
    );
    expect(senderKey(item({ kind: 'user' }))).toBe('owner'); // the boss, MSG-UI3
    expect(senderKey(item({ kind: 'user', from: 'system' }))).toBeNull();
    expect(senderKey(item({ kind: 'tool' }))).toBeNull();
  });

  it('a run shows the face once; another sender or the boss in between shows it again', () => {
    const items = [
      item({ id: '1-a' }),
      item({ id: '2-a' }),
      item({ id: '3-t', kind: 'tool' }),
      item({ id: '4-a' }),
      item({ id: '5-u', kind: 'user' }),
      item({ id: '6-a' }),
      item({ id: '7-p', kind: 'user', from: 'peer', fromName: 'beta' }),
      item({ id: '8-a' }),
    ];
    expect(items.map((_, i) => startsRun(items, i))).toEqual([
      true, false, false, false, true, true, true, true,
    ]);
  });

  it('an employee keeps one built-in palette', () => {
    expect(employeePalette('e-1')).toBe(employeePalette('e-1'));
    expect(employeePalette('e-1')).toBeLessThan(6);
  });
});

describe('MSG-UI3 named task notices', () => {
  const staff = [{ execution: 'claude:t1', employeeId: 'e1', nameId: STAFF_NAMES[0].id }];
  it('prefixes the temp employee, keeps the label when there is none', () => {
    setLanguage('en');
    expect(noticeName('Task notice', staff[0])).toBe(`${STAFF_NAMES[0].en} \u00b7 Task notice`);
    expect(noticeName('Task notice', undefined)).toBe('Task notice');
  });

  it('MSG-ALIGN: the stamped employee wins and outlives the staff list; the list is the fallback', () => {
    const stamped = { employeeId: 'e9', nameId: STAFF_NAMES[1].id };
    // the run is no longer in the current staff list (its employee was reused): the stamp still names it
    expect(noticeEmployee(item({ execution: 'claude:old', employee: stamped }), staff)).toEqual(stamped);
    expect(noticeEmployee(item({ execution: 'claude:t1', employee: stamped }), staff)).toEqual(stamped);
    expect(noticeEmployee(item({ execution: 'claude:t1' }), staff)).toBe(staff[0]);
    expect(noticeEmployee(item({ execution: 'claude:other' }), staff)).toBeUndefined();
    expect(noticeEmployee(item({}), staff)).toBeUndefined();
  });
});

it('a background command end is a command line, not a speaker; a sub-agent notice stays one', () => {
  const shell = { kind: 'user', from: 'peer', at: 1, id: 's', text: '**Background command "wait for the gate" completed (exit code 0)**' } as ChatItem;
  const failed = { ...shell, text: '**Background command "build" failed (exit code 2)**' } as ChatItem;
  const agent = { ...shell, text: '**Agent "TEMP-STATE" finished**\n\nAll three fixed.', execution: 'claude:x' } as ChatItem;
  expect(shellDone(shell)).toEqual({ desc: 'wait for the gate', code: 0 });
  expect(shellDone(failed)).toEqual({ desc: 'build', code: 2 });
  expect(shellDone(agent)).toBeNull();
  expect(senderKey(shell)).toBeNull();
  expect(senderKey(agent)).toBe('peer:claude:x');
});
