import { describe, expect, it } from 'vitest';

import type { LeadTerm } from './leadSwap.js';
import { historyHop, type RenewTerm } from './renewals.js';

describe('K1 (B3): the conversation before, by the recorded history', () => {
  const lead1: LeadTerm = { projectId: 'p_1', assignmentId: 'a_1', sessionId: 'L1', transcript: '/d/L1.jsonl', bytes: 10, endedAt: 1000 };
  const renew23: RenewTerm = { name: 'proj', projectId: 'p_1', sessionId: 'L2', next: 'L3', transcript: '/d/L2.jsonl', bytes: 20, endedAt: 5000 };
  // L3 leads p_1 now; L2 (its renewed-away conversation) no longer runs.
  const projectOf = (sid: string) => (sid === 'L3' ? 'p_1' : null);

  it('a Lead swapped in once, then renewed: back from L3 is L2 (the renew), then L1 (the swap)', () => {
    expect(historyHop('/d/L3.jsonl', 6000, [lead1], [renew23], projectOf)).toEqual({ file: '/d/L2.jsonl', end: 20 });
    expect(historyHop('/d/L2.jsonl', 1500, [lead1], [renew23], projectOf)).toEqual({ file: '/d/L1.jsonl', end: 10 });
    expect(historyHop('/d/L1.jsonl', 500, [lead1], [renew23], projectOf)).toBeNull();
  });

  it('the latest that ended by the start wins; a Worker renew does not join the Lead chain', () => {
    const later: LeadTerm = { ...lead1, sessionId: 'L2', transcript: '/d/L2b.jsonl', endedAt: 7000 };
    // A swap after the renew (ended 7000) is the one before a conversation started at 8000.
    expect(historyHop('/d/L3.jsonl', 8000, [lead1, later], [renew23], projectOf)).toEqual({ file: '/d/L2b.jsonl', end: 10 });
    const worker: RenewTerm = { name: 'w', sessionId: 'W1', next: 'W2', transcript: '/d/W1.jsonl', bytes: 5, endedAt: 3000 };
    expect(historyHop('/d/W2.jsonl', 4000, [lead1], [worker], () => null)).toEqual({ file: '/d/W1.jsonl', end: 5 });
    expect(historyHop('/d/W1.jsonl', 2000, [lead1], [worker], () => null)).toBeNull();
  });
});
