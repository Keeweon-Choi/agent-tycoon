import { beforeEach, describe, expect, it } from 'vitest';

import type {
  EngineAction,
  EngineActionResult,
  EngineProject,
  EngineState,
  OfficeOrchestrator,
  OfficeSnapshot,
} from '../../../core/src/messages.js';
import { setLanguage } from '../i18n/index.js';
import {
  engineConfirmText,
  engineToast,
  formError,
  formFields,
  formFor,
  rulesFileLabel,
  sessionActions,
} from './engine.js';
import {
  engineAsk,
  engineCancel,
  engineConfirm,
  engineConnectionLost,
  engineGetSnapshot,
  engineOpenForm,
  engineResetForTests,
  engineSubmit,
} from './engineStore.js';
import { cldHandleMessage, cldResetForTests, identityForAgent } from './officeStore.js';

const project = (over: Partial<EngineProject> = {}): EngineProject => ({
  name: 'alpha',
  folder: '/w/alpha',
  room: 'alpha',
  wantRunning: false,
  live: false,
  ...over,
});
const state = (projects: EngineProject[]): EngineState => ({ type: 'engineState', projects });
const result = (over: Partial<EngineActionResult>): EngineActionResult => ({
  type: 'engineActionResult',
  requestId: 'x',
  action: 'start',
  name: 'alpha',
  ok: true,
  ...over,
});

beforeEach(() => {
  setLanguage('ko');
  engineResetForTests();
  cldResetForTests();
});

describe('engine card and texts', () => {
  it('shows a rules file name without changing the stored path', () => {
    const rulesFile = '/home/u/.config/team/rules-engine.md';

    expect(rulesFileLabel(rulesFile)).toBe('rules-engine.md');
    expect(formFor(project({ rulesFile })).rulesFile).toBe(rulesFile);
  });

  it('off -> \ucf1c\uae30; a live background session -> \ub044\uae30, \uc7ac\uc2dc\uc791; open in a terminal -> none', () => {
    expect(sessionActions(project())).toEqual(['start']);
    expect(sessionActions(project({ live: true, bgId: '1a2b3c4d' }))).toEqual(['stop', 'restart']);
    expect(sessionActions(project({ live: true }))).toEqual([]);
  });

  it('T-0010’s confirmations, and a delete that keeps the conversation', () => {
    expect(engineConfirmText('start', 'alpha')).toEqual({ question: 'alpha\ub97c \ucf24\uae4c\uc694?' });
    expect(engineConfirmText('stop', '\uc5f0\uad6c')).toEqual({
      question: '\uc5f0\uad6c\ub97c \ub04c\uae4c\uc694?',
      note: '\ud558\ub358 \uc77c\uc774 \uba48\ucd9c \uc218 \uc788\uc5b4\uc694.',
    });
    expect(engineConfirmText('restart', 'alpha').question).toBe('alpha\ub97c \uc7ac\uc2dc\uc791\ud560\uae4c\uc694?');
    expect(engineConfirmText('remove', 'beta')).toEqual({
      question: 'beta\ub97c \uc0ad\uc81c\ud560\uae4c\uc694?',
      note: '\uc138\uc158\uc744 \ub044\uace0 \ubaa9\ub85d\uc5d0\uc11c \ube7c\uc694. \ub300\ud654 \uae30\ub85d\uc740 \ub0a8\uc544\uc694.',
    });
  });

  it('toasts: done, a note in place of a start’s, errors', () => {
    expect(engineToast(result({}))).toEqual({ text: '\ucf30\uc5b4\uc694', tone: 'ok' });
    expect(engineToast(result({ note: '\uc774\ubbf8 \ucf1c\uc838 \uc788\uc5b4\uc694' }))).toEqual({
      text: '\uc774\ubbf8 \ucf1c\uc838 \uc788\uc5b4\uc694',
      tone: 'info',
    });
    expect(engineToast(result({ action: 'remove', note: '\ub300\ud654 \uae30\ub85d\uc740 \ub0a8\uc544\uc694' }))).toEqual({
      text: '\uc0ad\uc81c\ud588\uc5b4\uc694. \ub300\ud654 \uae30\ub85d\uc740 \ub0a8\uc544\uc694',
      tone: 'info',
    });
    expect(engineToast(result({ ok: false, error: '\ubaa8\ub974\ub294 \ud504\ub85c\uc81d\ud2b8\uc608\uc694' }))).toEqual({
      text: '\ubaa8\ub974\ub294 \ud504\ub85c\uc81d\ud2b8\uc608\uc694',
      tone: 'error',
    });
  });

  it('form: add sends what is filled; edit sends only changes, "" clears', () => {
    const f = { ...formFor(null), folder: ' ~/p/alpha ', name: 'alpha', model: 'm-1' };
    expect(formError({ ...f, folder: '' }, true, null)).toBe('\ud3f4\ub354\ub97c \uc801\uc5b4 \uc8fc\uc138\uc694');
    expect(formError({ ...f, name: '-x' }, true, null)).toMatch(/^\uc774\ub984\uc740/);
    expect(formError(f, true, null)).toBeNull();
    // With the host known, its folder rules apply before anything is sent (T-0032).
    const win = { os: 'win32' as const, home: 'C:\\Users\\me', caseInsensitive: true };
    expect(formError({ ...f, folder: 'C:\\work\\CON' }, true, win)).toMatch(/\uc7a5\uce58 \uc774\ub984/);
    expect(formError({ ...f, folder: '~\\p\\alpha' }, true, win)).toBeNull();
    // An add always says its model and effort: '' is Claude's own default, chosen on purpose.
    expect(formFields(f, null)).toEqual({ folder: '~/p/alpha', model: 'm-1', effort: '' });
    const p = project({ room: 'Lab', model: 'm-1', remoteControl: true, alwaysOn: true });
    const edit = formFor(p);
    expect(edit).toMatchObject({
      folder: '/w/alpha',
      room: 'Lab',
      model: 'm-1',
      remoteControl: true,
      alwaysOn: true,
    });
    expect(formFor(project()).room).toBe(''); // the folder's name is the default, not a choice
    expect(formFields(edit, p)).toEqual({});
    expect(formFields({ ...edit, model: '', remoteControl: false, alwaysOn: false, effort: 'low' }, p)).toEqual({
      model: '',
      remoteControl: false,
      alwaysOn: false,
      effort: 'low',
    });
  });
});

describe('engine action flow', () => {
  const sent: EngineAction[] = [];
  const out = (m: EngineAction) => sent.push(m);
  beforeEach(() => {
    sent.length = 0;
    cldHandleMessage(state([project()]));
  });

  it('confirm sends one request; the card is busy until its result; \ucde8\uc18c sends nothing', () => {
    engineAsk('start', 'alpha');
    engineCancel();
    expect(sent).toEqual([]);
    engineAsk('start', 'alpha');
    engineConfirm(out, true);
    expect(sent).toEqual([
      { type: 'engineAction', requestId: expect.any(String), action: 'start', name: 'alpha' },
    ]);
    expect(engineGetSnapshot().busy.alpha).toBeDefined();
    engineAsk('stop', 'alpha'); // busy: ignored
    expect(engineGetSnapshot().confirm).toBeNull();
    cldHandleMessage(result({ requestId: 'someone-else' }));
    expect(engineGetSnapshot().busy.alpha).toBeDefined();
    cldHandleMessage(result({ requestId: sent[0].requestId, bgId: '1a2b3c4d' }));
    expect(engineGetSnapshot().busy).toEqual({});
    expect(engineGetSnapshot().toast).toMatchObject({ name: 'alpha', text: '\ucf30\uc5b4\uc694' });
  });

  it('never queued while disconnected, and running ones end on a dropped socket', () => {
    engineAsk('stop', 'alpha');
    engineConfirm(out, false);
    expect(sent).toEqual([]);
    expect(engineGetSnapshot().toast?.text).toBe('\uc5f0\uacb0\uc774 \ub04a\uaca8 \ubcf4\ub0b4\uc9c0 \uc54a\uc558\uc5b4\uc694');
    engineAsk('stop', 'alpha');
    engineConfirm(out, true);
    engineConnectionLost();
    expect(engineGetSnapshot().busy).toEqual({});
    expect(engineGetSnapshot().toast?.tone).toBe('error');
  });

  it('a missing folder is made only after the user agrees, with the same fields', () => {
    engineOpenForm(null);
    engineSubmit(out, true, 'add', 'beta', { folder: '/w/beta', model: 'm-1' });
    expect(engineGetSnapshot().form).toBeNull();
    cldHandleMessage(
      result({
        requestId: sent[0].requestId,
        action: 'add',
        name: 'beta',
        ok: false,
        error: '\ud3f4\ub354\uac00 \uc5c6\uc5b4\uc694',
        folderMissing: true,
      }),
    );
    expect(engineGetSnapshot().confirm).toEqual({
      action: 'add',
      name: 'beta',
      fields: { folder: '/w/beta', model: 'm-1' },
      mkdir: '/w/beta',
    });
    expect(engineGetSnapshot().toast).toBeNull();
    engineConfirm(out, true);
    expect(sent[1]).toMatchObject({
      action: 'add',
      name: 'beta',
      folder: '/w/beta',
      model: 'm-1',
      mkdir: true,
    });
  });

  it('a picker-new folder sends mkdir at once, while a typed folder does not', () => {
    engineOpenForm(null);
    engineSubmit(out, true, 'add', 'picked', { folder: '/w/picked', mkdir: true });
    engineOpenForm(null);
    engineSubmit(out, true, 'add', 'typed', { folder: '/w/typed' });
    expect(sent[0]).toMatchObject({ action: 'add', name: 'picked', mkdir: true });
    expect(sent[1]).toMatchObject({ action: 'add', name: 'typed', folder: '/w/typed' });
    expect(sent[1]).not.toHaveProperty('mkdir');
  });

  it('an edit without changes sends nothing', () => {
    engineOpenForm('alpha');
    engineSubmit(out, true, 'edit', 'alpha', {});
    expect(sent).toEqual([]);
    expect(engineGetSnapshot().form).toBeNull();
  });

  it('opens an add form that marks a required new office', () => {
    engineOpenForm(null, { newOffice: true });
    expect(engineGetSnapshot().form).toEqual({ name: null, newOffice: true });
  });

  it('engine projects get the \uc5d4\uc9c4 badge', () => {
    const orch = (name: string, agentId: number): OfficeOrchestrator => ({
      name,
      dir: '/w',
      tab: 't',
      order: 1,
      state: 'running',
      busy: false,
      bg: null,
      remoteControl: { on: false, url: null },
      compactions: 0,
      alive: true,
      agentId,
    });
    const office: OfficeSnapshot = {
      type: 'officeSnapshot',
      readOnly: false,
      tabs: [],
      orchestrators: [orch('alpha', 1), orch('other', 2)],
    };
    expect(identityForAgent(1, office, null)?.engine).toBe(true);
    expect(identityForAgent(2, office, null)?.engine).toBe(false);
  });
});
