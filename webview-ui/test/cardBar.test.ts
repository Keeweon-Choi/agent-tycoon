import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cardsExpanded,
  cardVariant,
  groupOrder,
  loadSavedOrder,
  mergeOrder,
  reorderByPointer,
  savedCardsExpanded,
  saveOrder,
} from '../src/components/cardBar.js';

describe('cardVariant', () => {
  it('the showing pane wins over the selected character', () => {
    expect(cardVariant(1, { activeId: 1, focusedId: 1 })).toBe('active');
    expect(cardVariant(2, { activeId: 1, focusedId: 2 })).toBe('focused');
    expect(cardVariant(3, { activeId: 1, focusedId: 2 })).toBe('default');
  });
});

describe('mergeOrder', () => {
  it('keeps the saved order, drops closed agents, appends new ones in creation order', () => {
    expect(mergeOrder([3, 1, 9], [1, 2, 3, 4])).toEqual([3, 1, 2, 4]);
  });

  it('is the live order when nothing was saved', () => {
    expect(mergeOrder([], [5, 6])).toEqual([5, 6]);
  });
});

describe('reorderByPointer', () => {
  // Cards 1..4 laid out 100px apart: midpoints 50, 150, 250, 350.
  const mid = (id: number) => (id - 1) * 100 + 50;

  it('inserts before the first other card whose midpoint is right of the finger', () => {
    expect(reorderByPointer([1, 2, 3, 4], 4, mid, 120)).toEqual([1, 4, 2, 3]);
  });

  it('moves the card last when the finger is past every midpoint', () => {
    expect(reorderByPointer([1, 2, 3, 4], 1, mid, 900)).toEqual([2, 3, 4, 1]);
  });

  it('moves the card first when the finger is left of every midpoint', () => {
    expect(reorderByPointer([1, 2, 3, 4], 3, mid, 0)).toEqual([3, 1, 2, 4]);
  });

  it('skips cards that are not laid out', () => {
    const partial = (id: number) => (id === 2 ? null : mid(id));
    expect(reorderByPointer([1, 2, 3], 1, partial, 200)).toEqual([2, 1, 3]);
  });
});

// cld-gui (T-0036): cards grouped by kind, manual order kept inside groups.
describe('groups', () => {
  // 1, 2 and 5 are group 0; 3 and 4 group 1.
  const groupOf = (id: number) => (id === 3 || id === 4 ? 1 : 0);
  const mid = (id: number) => (id - 1) * 100 + 50;

  it('groupOrder sorts by group and keeps the order inside each group', () => {
    expect(groupOrder([4, 5, 3, 1, 2], groupOf)).toEqual([5, 1, 2, 4, 3]);
  });

  it('a manual order survives grouping: saved order first, then grouped', () => {
    expect(groupOrder(mergeOrder([2, 4, 1], [1, 2, 3, 4, 5]), groupOf)).toEqual([2, 1, 5, 4, 3]);
  });

  it('a drag moves the card within its group', () => {
    // [1 2 5 | 3 4]: 5 dragged left of 1.
    const ids = [1, 2, 5, 3, 4];
    const at = (id: number) => mid(ids.indexOf(id) + 1);
    expect(reorderByPointer(ids, 5, at, 0, groupOf)).toEqual([5, 1, 2, 3, 4]);
  });

  it('a drag never crosses into another group', () => {
    const ids = [1, 2, 5, 3, 4];
    const at = (id: number) => mid(ids.indexOf(id) + 1);
    // 1 dragged past every card: last of its own group, before 3 and 4.
    expect(reorderByPointer(ids, 1, at, 900, groupOf)).toEqual([2, 5, 1, 3, 4]);
    // 4 dragged to the far left: first of its group, still after group 0.
    expect(reorderByPointer(ids, 4, at, 0, groupOf)).toEqual([1, 2, 5, 4, 3]);
  });
});

describe("the phone's cards: compact or expanded (owner 10-24)", () => {
  it('compact by default: nothing stored, junk, or the collapsed value', () => {
    expect(cardsExpanded(null)).toBe(false);
    expect(cardsExpanded('yes')).toBe(false);
    expect(cardsExpanded(savedCardsExpanded(false))).toBe(false);
  });

  it('an expand is remembered and read back', () => {
    expect(cardsExpanded(savedCardsExpanded(true))).toBe(true);
  });
});

// Owner 10-24: the desktop's container drags a card along a column of fixed slots (y instead of x).
describe('the desktop column', () => {
  // Slots 120px apart, so midpoints 60, 180, 300, 420 whatever the order is.
  const slotsOf = (order: number[]) => (id: number) => order.indexOf(id) * 120 + 60;
  const order = [1, 2, 3, 4];

  it('a drag down to the third slot shifts the cards it passes up', () => {
    expect(reorderByPointer(order, 1, slotsOf(order), 310)).toEqual([2, 3, 1, 4]);
  });

  it('a drag up to the first slot shifts the others down', () => {
    expect(reorderByPointer(order, 4, slotsOf(order), 10)).toEqual([4, 1, 2, 3]);
  });

  it('a card never leaves its group, even when dropped over another group', () => {
    const groupOf = (id: number) => (id === 4 ? 1 : 0);
    expect(reorderByPointer(order, 1, slotsOf(order), 500, groupOf)).toEqual([2, 3, 1, 4]);
  });
});

describe('the saved order', () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  afterEach(() => store.clear());

  it('round-trips, and junk reads as nothing saved', () => {
    expect(loadSavedOrder()).toEqual([]);
    saveOrder([3, 1, 2]);
    expect(loadSavedOrder()).toEqual([3, 1, 2]);
    store.set([...store.keys()][0], '{"a":1}');
    expect(loadSavedOrder()).toEqual([]);
  });
});
