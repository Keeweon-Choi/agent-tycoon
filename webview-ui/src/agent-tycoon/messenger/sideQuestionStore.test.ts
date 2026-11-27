import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSend, SideAsk, SideCancel } from '../../../../core/src/messages.js';
import { SIDE_ANSWER_MAX, SIDE_QUESTION_DEFAULT_MODEL } from '../../constants.js';
import { setLanguage } from '../../i18n/index.js';
import { agtyConnectionLost, agtyHandleMessage } from '../officeStore.js';
import { messengerGetSnapshot, messengerResetForTests } from './messengerStore.js';
import {
  sideAsk,
  sideAsking,
  sideClose,
  sideDismiss,
  sideForProvider,
  sideForward,
  sideForwardText,
  sideGetSnapshot,
  sideModel,
  sideOpen,
  sidePickModel,
  sideResetForTests,
  sideRetry,
} from './sideQuestionStore.js';

vi.mock('../auth/stepUp.js', () => ({ requestStepUp: vi.fn() }));

const MODELS = [
  { value: 'default', displayName: 'Default' },
  { value: SIDE_QUESTION_DEFAULT_MODEL, displayName: 'Light 5.5' },
  { value: 'other', displayName: 'Other 1' },
];
const asked: SideAsk[] = [];
const ask = (m: SideAsk) => asked.push(m);
const answer = (requestId: string, ok: boolean, text?: string, errorCode?: string) =>
  agtyHandleMessage({
    type: 'sideAnswer',
    requestId,
    agentId: 7,
    ok,
    ...(text && { text }),
    ...(errorCode && { errorCode, error: 'x' }),
  });
const cards = () => sideGetSnapshot().cards[7] ?? [];

beforeEach(() => {
  setLanguage('ko');
  sideResetForTests();
  messengerResetForTests();
  asked.length = 0;
});

describe('side question drawer (T-115)', () => {
  it('is offered for Claude Leads (background or PTY host), not for Codex', () => {
    expect([undefined, 'claude', 'claude-pty'].map(sideForProvider)).toEqual([true, true, true]);
    expect(['codex', 'gemini'].map(sideForProvider)).toEqual([false, false]);
  });

  it('opens and closes per Lead; closing drops its exchanges and stops the question still waiting', () => {
    sideOpen(7);
    expect(sideGetSnapshot().open).toBe(7);
    sideAsk(ask, 7, 'q');
    const cancels: SideCancel[] = [];
    sideClose((m) => cancels.push(m), 7);
    expect(cancels).toEqual([{ type: 'sideCancel', requestId: asked[0].requestId }]);
    expect(sideGetSnapshot()).toMatchObject({ open: null, cards: {} });
    // Nothing waits: closing sends nothing.
    sideOpen(7);
    sideAsk(ask, 7, 'q2');
    answer(asked[1].requestId, true, 'a');
    sideClose((m) => cancels.push(m), 7);
    expect(cancels).toHaveLength(1);
  });

  it('defaults to the chosen model when the CLI lists it, else its first; a pick wins', () => {
    expect(sideModel()).toBe(SIDE_QUESTION_DEFAULT_MODEL);
    agtyHandleMessage({
      type: 'slashCommandsList',
      requestId: 'r',
      agentId: 7,
      commands: [],
      models: MODELS,
    });
    expect(sideGetSnapshot().models).toEqual(MODELS);
    expect(sideModel()).toBe(SIDE_QUESTION_DEFAULT_MODEL);
    expect(sideModel({ model: null, models: [MODELS[2]] })).toBe('other');
    sidePickModel('other');
    expect(sideModel()).toBe('other');
  });

  it('asks one question at a time and carries the earlier answered exchanges', () => {
    expect(sideAsk(ask, 7, '  ')).toBe(false);
    expect(sideAsk(ask, 7, 'first?')).toBe(true);
    expect(sideAsking(7)).toBe(true);
    expect(sideAsk(ask, 7, 'second?')).toBe(false); // still waiting
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      type: 'sideAsk',
      agentId: 7,
      question: 'first?',
      model: SIDE_QUESTION_DEFAULT_MODEL,
      earlier: [],
    });
    answer(asked[0].requestId, true, 'one');
    expect(cards()[0]).toMatchObject({ state: 'answered', text: 'one' });
    expect(sideAsk(ask, 7, 'second?')).toBe(true);
    expect(asked[1].earlier).toEqual([{ question: 'first?', answer: 'one' }]);
  });

  it('an earlier answer longer than the protocol allows is cut, so the next ask is not refused', () => {
    sideAsk(ask, 7, 'first?');
    answer(asked[0].requestId, true, 'x'.repeat(SIDE_ANSWER_MAX + 5));
    sideAsk(ask, 7, 'second?');
    expect(asked[1].earlier[0].answer).toHaveLength(SIDE_ANSWER_MAX);
  });

  it('a failure says only what failed, never that the Lead keeps working (it may be idle)', () => {
    setLanguage('en');
    for (const code of ['side_timeout', 'side_failed', undefined]) {
      sideResetForTests();
      asked.length = 0;
      sideAsk(ask, 7, 'q?');
      agtyHandleMessage({
        type: 'sideAnswer',
        requestId: asked[0].requestId,
        agentId: 7,
        ok: false,
        ...(code && { errorCode: code, errorParams: { seconds: 120 } }),
      });
      expect(cards()[0].error).toBeTruthy();
      expect(cards()[0].error).not.toMatch(/keeps working/i);
    }
  });

  it('a failed fork says why in the viewer language: log in, the usage limit, or the CLI reason (T-140)', () => {
    const failed = (errorCode: string, errorParams?: Record<string, string>) => {
      sideResetForTests();
      asked.length = 0;
      sideAsk(ask, 7, 'q?');
      agtyHandleMessage({
        type: 'sideAnswer',
        requestId: asked[0].requestId,
        agentId: 7,
        ok: false,
        errorCode,
        error: 'x',
        ...(errorParams && { errorParams }),
      });
      return cards()[0].error;
    };
    setLanguage('en');
    expect(failed('side_login')).toBe(
      'Claude Code needs you to log in. Open claude in a terminal and run /login.',
    );
    expect(failed('side_limit_reset', { reset: '7pm' })).toBe(
      'You hit your usage limit. It resets 7pm.',
    );
    expect(failed('side_failed_reason', { reason: 'API Error: 500' })).toBe(
      'Claude Code ended without an answer: API Error: 500',
    );
    setLanguage('ko');
    expect(failed('side_login')).toMatch(/\/login/);
    expect(failed('side_login')).not.toMatch(/log in/);
    expect(failed('side_limit_reset', { reset: '7pm' })).toMatch(/7pm/);
    expect(failed('side_failed_reason', { reason: 'API Error: 500' })).toMatch(/: API Error: 500$/);
  });

  it('a failure shows the server reason; retry asks the same question in its place', () => {
    sideAsk(ask, 7, 'q?');
    answer(asked[0].requestId, false, undefined, 'side_timeout');
    expect(cards()).toHaveLength(1);
    expect(cards()[0].state).toBe('failed');
    expect(cards()[0].error).toBeTruthy();
    expect(sideRetry(ask, 7, cards()[0].id)).toBe(true);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatchObject({ question: 'q?', state: 'asking' });
    expect(asked[1]).toMatchObject({ question: 'q?', earlier: [] });
  });

  it('an answer for an unknown or settled request is ignored; a lost socket fails what waits', () => {
    sideAsk(ask, 7, 'q?');
    answer('nope', true, 'x');
    expect(cards()[0].state).toBe('asking');
    agtyConnectionLost();
    expect(cards()[0].state).toBe('failed');
    answer(asked[0].requestId, true, 'late');
    expect(cards()[0].state).toBe('failed');
  });

  it('closing a card removes only that exchange', () => {
    sideAsk(ask, 7, 'a?');
    answer(asked[0].requestId, true, 'A');
    sideAsk(ask, 7, 'b?');
    answer(asked[1].requestId, true, 'B');
    sideDismiss(7, cards()[0].id);
    expect(cards().map((c) => c.question)).toEqual(['b?']);
  });

  it('forwarding to the Lead sends one ordinary chatSend with the question and the answer, once', () => {
    agtyHandleMessage({
      type: 'slashCommandsList',
      requestId: 'r',
      agentId: 7,
      commands: [],
      models: MODELS,
    });
    sideAsk(ask, 7, 'which deploy?');
    answer(asked[0].requestId, true, 'the sixth');
    const sent: ChatSend[] = [];
    const id = cards()[0].id;
    sideForward((m) => sent.push(m as ChatSend), true, 7, 'alpha', id);
    sideForward((m) => sent.push(m as ChatSend), true, 7, 'alpha', id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'chatSend',
      name: 'alpha',
      text: sideForwardText(cards()[0]),
    });
    expect(sent[0].text).toContain('which deploy?');
    expect(sent[0].text).toContain('the sixth');
    expect(sent[0].text).toContain('Light 5.5');
    // The messenger shows it as its own bubble on the way, like any send.
    expect(messengerGetSnapshot().pending[7]?.map((p) => p.text)).toEqual([sent[0].text]);
    expect(cards()[0].forwarded).toBe(true);
  });

  it('a failed card cannot be forwarded', () => {
    sideAsk(ask, 7, 'q?');
    answer(asked[0].requestId, false, undefined, 'side_failed');
    const sent: ChatSend[] = [];
    sideForward((m) => sent.push(m as ChatSend), true, 7, 'alpha', cards()[0].id);
    expect(sent).toEqual([]);
  });
});
