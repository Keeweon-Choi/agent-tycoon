import { describe, expect, it } from 'vitest';

import { GpuBoardFold, RECENT_MAX } from './gpuBoard.js';

const ev = (type: string, id: string, more: Record<string, unknown> = {}) => ({
  v: 1,
  type,
  ts: '2026-10-22T01:00:00+09:00',
  source: 'cli',
  id,
  project: id.split('-').pop(),
  ...more,
});
const fold = (...events: Array<Record<string, unknown>>) => {
  const f = new GpuBoardFold();
  for (const e of events) f.apply(e);
  return f.board();
};
const ids = (list: Array<{ id: string }>) => list.map((t) => t.id);

describe('GPU board fold (T-0046)', () => {
  it('queues in arrival order with ticket numbers', () => {
    const b = fold(
      ev('gpu_queue', 'g-a', { vram_gib: 2, exclusive: false, label: '추론' }),
      ev('gpu_queue', 'g-b', { vram_gib: 6, exclusive: true }),
      ev('gpu_queue', 'g-c', { vram_gib: 1, exclusive: false }),
    );
    expect(ids(b.queue)).toEqual(['g-a', 'g-b', 'g-c']);
    expect(b.queue.map((t) => t.ticket)).toEqual([1, 2, 3]);
    expect(b.queue[0]).toMatchObject({ project: 'a', label: '추론', vramGib: 2, exclusive: false });
    expect(b.queue[1].exclusive).toBe(true);
  });

  it('gpu_move puts a ticket at its 1-based position; the others keep their order', () => {
    const q = ['g-a', 'g-b', 'g-c', 'g-d'].map((id) => ev('gpu_queue', id));
    expect(ids(fold(...q, ev('gpu_move', 'g-d', { position: 1 })).queue)).toEqual([
      'g-d',
      'g-a',
      'g-b',
      'g-c',
    ]);
    expect(ids(fold(...q, ev('gpu_move', 'g-a', { position: 3 })).queue)).toEqual([
      'g-b',
      'g-c',
      'g-a',
      'g-d',
    ]);
    // Past the end: last. A moved ticket keeps its number.
    const b = fold(...q, ev('gpu_move', 'g-b', { position: 99 }));
    expect(ids(b.queue)).toEqual(['g-a', 'g-c', 'g-d', 'g-b']);
    expect(b.queue[3].ticket).toBe(2);
  });

  it('a lease moves the ticket to the holders, keeping its label and number', () => {
    const b = fold(
      ev('gpu_queue', 'g-a', { vram_gib: 2, label: '학습' }),
      ev('gpu_queue', 'g-b', { vram_gib: 1 }),
      ev('gpu_lease', 'g-a', { vram_gib: 2, exclusive: false, waited_s: 30 }),
    );
    expect(ids(b.queue)).toEqual(['g-b']);
    expect(b.holders).toEqual([expect.objectContaining({ id: 'g-a', label: '학습', ticket: 1 })]);
  });

  it('no --vram reads as running alone', () => {
    expect(fold(ev('gpu_queue', 'g-a')).queue[0]).toMatchObject({ vramGib: null, exclusive: true });
  });

  it('release and cancel end a ticket into recent, with the reason', () => {
    const b = fold(
      ev('gpu_queue', 'g-a', { vram_gib: 2, label: 'x' }),
      ev('gpu_lease', 'g-a', { vram_gib: 2 }),
      ev('gpu_queue', 'g-b', { vram_gib: 1 }),
      ev('gpu_cancel', 'g-b', { reason: 'wait' }),
      ev('gpu_release', 'g-a', { exit: 0 }),
    );
    expect(b.holders).toEqual([]);
    expect(b.queue).toEqual([]);
    expect(b.recent).toEqual([
      expect.objectContaining({ id: 'g-b', kind: 'cancel', reason: 'wait' }),
      expect.objectContaining({ id: 'g-a', kind: 'release', exit: 0, label: 'x' }),
    ]);
  });

  it('keeps the last few endings only, and ignores other events', () => {
    const f = new GpuBoardFold();
    expect(f.apply({ type: 'turn_end', ts: 't', name: 'x' })).toBe(false);
    expect(f.apply({ type: 'gpu_queue', ts: 't' })).toBe(false); // no id
    for (let k = 0; k < RECENT_MAX + 3; k++)
      f.apply(ev('gpu_cancel', `g-${k}`, { reason: 'stop' }));
    expect(f.board().recent).toHaveLength(RECENT_MAX);
    expect(f.board().recent.at(-1)!.id).toBe(`g-${RECENT_MAX + 2}`);
  });
});
