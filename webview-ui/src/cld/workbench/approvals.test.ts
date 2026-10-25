import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DelegationApproval, DelegationDecision } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import {
  approvalsFor,
  approvalsGetSnapshot,
  approvalsHandleMessage,
  approvalsResetForTests,
  decide,
} from './approvals.js';

const proved = vi.hoisted(() => ({ ok: true, asked: 0 }));
vi.mock('../auth/stepUp.js', () => ({
  requestStepUp: async () => {
    proved.asked++;
    return proved.ok;
  },
}));

const card = (id: string, project: string, createdAt: string): DelegationApproval => ({
  id,
  project,
  caller: project,
  check: 'limits',
  why: 'x',
  title: 't',
  target: 'claude',
  newWorker: true,
  createdAt,
});

beforeEach(() => {
  approvalsResetForTests();
  proved.ok = true;
  proved.asked = 0;
});

describe('C6: the approval cards', () => {
  it('a project sees its own cards, oldest first', () => {
    const list = [card('b', 'alpha', '2026-10-24T02:00'), card('a', 'alpha', '2026-10-24T01:00'), card('c', 'beta', '1')];
    expect(approvalsFor(list, 'alpha').map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('a decision waits for its answer; "stepup" proves the device and sends it once more', async () => {
    const sent: DelegationDecision[] = [];
    const toasts: string[] = [];
    const toast = (text: string) => toasts.push(text);
    approvalsHandleMessage({ type: 'delegationApprovals', approvals: [card('ap-1', 'alpha', '1')] }, toast);
    decide((m) => sent.push(m), 'ap-1', 'approve');
    decide((m) => sent.push(m), 'ap-1', 'approve'); // a second click while it waits: nothing
    expect(sent).toHaveLength(1);
    approvalsHandleMessage(
      { type: 'delegationApprovals', approvals: [card('ap-1', 'alpha', '1')], requestId: sent[0].requestId, error: 'stepup' },
      toast,
    );
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(proved.asked).toBe(1);
    expect(sent[1]).toMatchObject({ id: 'ap-1', decision: 'approve' });
    approvalsHandleMessage(
      { type: 'delegationApprovals', approvals: [], requestId: sent[1].requestId, outcome: 'accepted', taskId: 'T-4' },
      toast,
    );
    expect(approvalsGetSnapshot()).toEqual({ approvals: [], busy: {} });
    expect(toasts).toEqual([t('approvals.done', { task: 'T-4' })]);
  });

  it('a refused step-up sends nothing more and says so', async () => {
    proved.ok = false;
    const sent: DelegationDecision[] = [];
    const toasts: string[] = [];
    decide((m) => sent.push(m), 'ap-2', 'approve');
    approvalsHandleMessage(
      { type: 'delegationApprovals', approvals: [], requestId: sent[0].requestId, error: 'stepup' },
      (text) => toasts.push(text),
    );
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    expect(sent).toHaveLength(1);
    expect(approvalsGetSnapshot().busy).toEqual({});
  });
});
