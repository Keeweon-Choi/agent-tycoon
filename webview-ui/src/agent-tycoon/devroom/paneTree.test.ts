import { describe, expect, it } from 'vitest';

import { closeAt, drop, fillTree, leaves, LEAVES_MAX, type PaneNode, parseTree, preset, resize, setView } from './paneTree.js';

const names = (n: PaneNode) => leaves(n).map((l) => l.name);

describe('the pane tree (DEVROOM-SUBVIEW, Orca-style free layout)', () => {
  it('an edge drop splits the pane there; the centre takes it', () => {
    const one: PaneNode = { leaf: 'lead' };
    const right = drop(one, [], 'right', 'w1');
    expect(right).toEqual({ dir: 'row', a: { leaf: 'lead' }, b: { leaf: 'w1' }, ratio: 0.5 });
    // One big pane left, two stacked right.
    const three = drop(right, ['b'], 'bottom', 'w2');
    expect(three).toEqual({ dir: 'row', a: { leaf: 'lead' }, b: { dir: 'col', a: { leaf: 'w1' }, b: { leaf: 'w2' }, ratio: 0.5 }, ratio: 0.5 });
    expect(names(drop(three, ['a'], 'top', 'w3'))).toEqual(['w3', 'lead', 'w1', 'w2']);
    expect(names(drop(three, ['a'], 'center', 'w3'))).toEqual(['w3', 'w1', 'w2']);
  });

  it('a shown agent moves: an edge drop closes its old pane, a centre drop swaps', () => {
    const three = drop(drop({ leaf: 'lead' }, [], 'right', 'w1'), ['b'], 'bottom', 'w2');
    expect(drop(three, ['a'], 'left', 'w2')).toEqual({
      dir: 'row',
      a: { dir: 'row', a: { leaf: 'w2' }, b: { leaf: 'lead' }, ratio: 0.5 },
      b: { leaf: 'w1' },
      ratio: 0.5,
    });
    expect(names(drop(three, ['a'], 'center', 'w2'))).toEqual(['w2', 'w1', 'lead']);
    expect(drop(three, ['a'], 'right', 'lead')).toBe(three); // onto itself: nothing
  });

  it('close: the sibling takes the space; the last pane empties', () => {
    const three = drop(drop({ leaf: 'lead' }, [], 'right', 'w1'), ['b'], 'bottom', 'w2');
    expect(closeAt(three, ['b', 'a'])).toEqual({ dir: 'row', a: { leaf: 'lead' }, b: { leaf: 'w2' }, ratio: 0.5 });
    expect(closeAt(closeAt(three, ['a']), ['a'])).toEqual({ leaf: 'w2' });
    expect(closeAt({ leaf: 'x' }, [])).toEqual({ leaf: null });
  });

  it('resize clamps; a drop past the pane cap is refused', () => {
    const two = preset(2, ['a', 'b']);
    expect(resize(two, [], 0.99)).toMatchObject({ ratio: 0.9 });
    expect(resize(two, [], 0.2, 0.3)).toMatchObject({ ratio: 0.3 });
    let t: PaneNode = { leaf: 'n0' };
    for (let i = 1; i < LEAVES_MAX + 3; i++) t = drop(t, leaves(t).at(-1)!.path, 'right', `n${i}`);
    expect(leaves(t)).toHaveLength(LEAVES_MAX);
  });

  it('presets, filling, and a stored tree checked node by node', () => {
    expect(names(preset(4, ['a', 'b']))).toEqual(['a', 'b', null, null]);
    expect(names(fillTree(preset(4, ['gone', 'b']), ['a', 'b', 'c']))).toEqual(['a', 'b', 'c', null]);
    const tree = preset(2, ['a', 'b']);
    expect(parseTree(JSON.parse(JSON.stringify(tree)))).toEqual(tree);
    expect(parseTree({ dir: 'row', a: { leaf: 'a' }, ratio: 0.5 })).toBeNull();
    expect(parseTree({ dir: 'diag', a: { leaf: 1 }, b: { leaf: 'b' }, ratio: 0.5 })).toBeNull();
    expect(parseTree('x')).toBeNull();
  });

  it('a pane keeps its view (chat by default), an old tree without views still loads, a view moves with its agent', () => {
    const old = parseTree({ dir: 'row', a: { leaf: 'lead' }, b: { leaf: 'w1' }, ratio: 0.5 })!;
    expect(leaves(old).map((l) => l.view)).toEqual(['chat', 'chat']);
    const term = setView(old, ['b'], 'terminal');
    expect(parseTree(JSON.parse(JSON.stringify(term)))).toEqual(term);
    expect(parseTree({ leaf: 'x', view: 'video' })).toEqual({ leaf: 'x' });
    expect(leaves(drop(term, ['a'], 'center', 'w1')).map((l) => `${l.name}:${l.view}`)).toEqual(['w1:terminal', 'lead:chat']);
    expect(leaves(drop(term, ['a'], 'left', 'w1')).map((l) => `${l.name}:${l.view}`)).toEqual(['w1:terminal', 'lead:chat']);
    expect(fillTree(term, ['lead', 'w1'])).toEqual(term);
  });
});
