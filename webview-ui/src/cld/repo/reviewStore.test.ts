import { beforeEach, describe, expect, it } from 'vitest';

import type { BoardTask, ReviewNote } from '../../../../core/src/messages.js';
import { setLanguage, t } from '../../i18n/index.js';
import { diffRows } from './repoText.js';
import {
  inRange,
  lineRange,
  newlyInReview,
  placeNotes,
  reviewGetSnapshot,
  reviewHandleMessage,
  reviewKey,
  reviewResetForTests,
  reviewSendNotes,
  unsentNotes,
} from './reviewStore.js';

const note = (over: Partial<ReviewNote>): ReviewNote => ({
  id: 'n',
  file: 'a.ts',
  side: 'new',
  line: 1,
  body: 'x',
  createdAt: '2026-11-01T00:00:00.000Z',
  diffIdentity: 'a'.repeat(40),
  by: 'gui:pc',
  ...over,
});

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,4 @@',
  ' keep',
  '-old',
  '+new one',
  '+new two',
  ' tail',
].join('\n');

beforeEach(() => {
  setLanguage('en');
  reviewResetForTests();
});

describe('note anchoring', () => {
  it('puts a note under the row showing its last new-side line, others loose', () => {
    const rows = diffRows(DIFF);
    const notes = [
      note({ id: 'on-add', line: 2 }),
      note({ id: 'range', startLine: 2, line: 3 }),
      note({ id: 'ctx', line: 4 }),
      note({ id: 'file', line: 0 }),
      note({ id: 'gone', line: 40 }),
      note({ id: 'other-file', file: 'b.ts', line: 2 }),
    ];
    const { byRow, loose } = placeNotes(rows, notes, 'a.ts');
    const at = (no: number) => byRow.get(rows.find((r) => r.newNo === no)!.key)?.map((n) => n.id);
    expect(at(2)).toEqual(['on-add']);
    expect(at(3)).toEqual(['range']);
    expect(at(4)).toEqual(['ctx']);
    expect(at(1)).toBeUndefined();
    expect(loose.map((n) => n.id)).toEqual(['file', 'gone']);
    // a deleted row has no new-side number: nothing anchors there
    expect(rows.find((r) => r.kind === 'del')!.newNo).toBeUndefined();
  });

  it('makes a range from a shift-click in either order and marks its rows', () => {
    expect(lineRange(null, 5)).toEqual({ line: 5 });
    expect(lineRange(5, 5)).toEqual({ line: 5 });
    expect(lineRange(7, 3)).toEqual({ startLine: 3, line: 7 });
    expect(lineRange(3, 7)).toEqual({ startLine: 3, line: 7 });
    const sel = { startLine: 3, line: 7 };
    expect([2, 3, 7, 8].map((n) => inRange(n, sel))).toEqual([false, true, true, false]);
    expect(inRange(undefined, sel)).toBe(false);
    expect(inRange(0, { line: 0 })).toBe(false);
  });

  it('counts only unsent notes', () => {
    expect(
      unsentNotes([note({ id: 'a' }), note({ id: 'b', sentAt: '2026-11-01T00:00:01.000Z' })]).map(
        (n) => n.id,
      ),
    ).toEqual(['a']);
  });
});

describe('review ready', () => {
  const task = (id: string, status: BoardTask['status']) => ({ id, status }) as BoardTask;
  it('names Tasks newly in review, nothing on the first board', () => {
    expect(newlyInReview(null, { tasks: [task('T-1', 'review')] })).toEqual([]);
    const before = { tasks: [task('T-1', 'doing'), task('T-2', 'review')] };
    const after = { tasks: [task('T-1', 'review'), task('T-2', 'review'), task('T-3', 'review')] };
    expect(newlyInReview(before, after).map((x) => x.id)).toEqual(['T-1']);
  });
});

describe('send', () => {
  it('sends once, then records who got it', () => {
    const sent: Array<{ requestId: string }> = [];
    const toasts: string[] = [];
    reviewSendNotes('p', 'wt', (m) => void sent.push(m));
    reviewSendNotes('p', 'wt', (m) => void sent.push(m));
    expect(sent).toHaveLength(1);
    const requestId = sent[0].requestId;
    reviewHandleMessage(
      {
        type: 'reviewSendResult',
        requestId,
        project: 'p',
        task: 'wt',
        ok: true,
        to: 'web-worker',
        count: 2,
        delivered: 'queued',
        moved: true,
      },
      (_n, text) => void toasts.push(text),
      1000,
    );
    expect(reviewGetSnapshot().sending).toEqual({});
    expect(reviewGetSnapshot().sent[reviewKey('p', 'wt')]).toEqual({
      to: 'web-worker',
      count: 2,
      at: 1000,
    });
    expect(toasts).toEqual([t('review.sentToast', { name: 'web-worker', count: 2 })]);
  });

  it('ignores an answer it did not ask for and frees the button on a refusal', () => {
    const toasts: string[] = [];
    reviewHandleMessage(
      { type: 'reviewSendResult', requestId: 'x', project: 'p', task: 'wt', ok: true },
      (_n, s) => void toasts.push(s),
    );
    expect(toasts).toEqual([]);
    const sent: Array<{ requestId: string }> = [];
    reviewSendNotes('p', 'wt', (m) => void sent.push(m));
    reviewHandleMessage(
      {
        type: 'reviewSendResult',
        requestId: sent[0].requestId,
        project: 'p',
        task: 'wt',
        ok: false,
        error: 'nope',
      },
      (_n, s) => void toasts.push(s),
    );
    expect(reviewGetSnapshot().sending).toEqual({});
    expect(toasts).toEqual(['nope']);
  });
});
