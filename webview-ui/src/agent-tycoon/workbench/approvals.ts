/**
 * C6: the delegate_task calls waiting for the user (`delegationApprovals`),
 * shown as cards at the top of the 작업실's Task tab, each with 승인 / 거절.
 * A decision goes out as `delegationDecision`; the answer comes back with its
 * requestId. Approving one that starts a new Worker from a remote device may
 * answer `stepup`: prove this device, then the same decision goes once more.
 */
import { useSyncExternalStore } from 'react';

import type {
  DelegationApproval,
  DelegationApprovals,
  DelegationDecision,
} from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { stepUpFailedText } from '../auth/authApi.js';
import { requestStepUp } from '../auth/stepUp.js';
import { serverText } from '../serverText.js';

export interface ApprovalsSnapshot {
  approvals: DelegationApproval[];
  /** Approval id → the decision on its way (its buttons wait). */
  busy: Record<string, { requestId: string; decision: 'approve' | 'deny'; retried?: boolean }>;
}

let snapshot: ApprovalsSnapshot = { approvals: [], busy: {} };
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
function set(next: Partial<ApprovalsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}
export const approvalsGetSnapshot = () => snapshot;
export const useApprovals = () => useSyncExternalStore(subscribe, approvalsGetSnapshot);

/** A project's cards, oldest first. */
export const approvalsFor = (list: DelegationApproval[], project: string): DelegationApproval[] =>
  list.filter((a) => a.project === project).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

let seq = 0;
let out: ((msg: DelegationDecision) => void) | null = null;

/** What a decision's answer means for the screen: a toast text, or nothing to say. */
export function outcomeText(msg: Pick<DelegationApprovals, 'error' | 'errorCode' | 'errorParams' | 'outcome' | 'taskId'>): {
  text: string;
  tone: 'ok' | 'error';
} {
  if (msg.error) return { text: serverText(msg), tone: 'error' };
  if (msg.outcome === 'rejected') return { text: t('approvals.rejectedAfter'), tone: 'error' };
  if (msg.outcome === 'pending_approval') return { text: t('approvals.askedAgain'), tone: 'ok' };
  return {
    text: msg.taskId ? t('approvals.done', { task: msg.taskId }) : t('approvals.decided'),
    tone: 'ok',
  };
}

/** The server's list (and, with a requestId, this screen's answer). */
export function approvalsHandleMessage(
  msg: DelegationApprovals,
  toast: (text: string, tone: 'ok' | 'error') => void,
): void {
  const entry = Object.entries(snapshot.busy).find(([, b]) => b.requestId === msg.requestId);
  if (!entry) {
    set({ approvals: msg.approvals });
    return;
  }
  const [id, run] = entry;
  // S1: prove this device, then send the same decision once more.
  if (msg.error === 'stepup' && !run.retried && out) {
    const send = out;
    set({ approvals: msg.approvals });
    void requestStepUp().then(
      (ok) => (ok ? decide(send, id, run.decision, true) : done(id, stepUpFailedText(), toast)),
      () => done(id, stepUpFailedText(), toast),
    );
    return;
  }
  const busy = { ...snapshot.busy };
  delete busy[id];
  set({ approvals: msg.approvals, busy });
  const o = outcomeText(msg);
  toast(o.text, o.tone);
}

function done(id: string, text: string, toast: (text: string, tone: 'ok' | 'error') => void) {
  const busy = { ...snapshot.busy };
  delete busy[id];
  set({ busy });
  toast(text, 'error');
}

/** 승인 / 거절 on a card. Ignored while that card's decision is on its way. */
export function decide(
  send: (msg: DelegationDecision) => void,
  id: string,
  decision: 'approve' | 'deny',
  retried = false,
): void {
  if (snapshot.busy[id] && !retried) return;
  const requestId = `${Date.now().toString(36)}-d${++seq}`;
  out = send;
  set({ busy: { ...snapshot.busy, [id]: { requestId, decision, retried } } });
  send({ type: 'delegationDecision', requestId, id, decision });
}

export function approvalsResetForTests(): void {
  snapshot = { approvals: [], busy: {} };
  out = null;
}
