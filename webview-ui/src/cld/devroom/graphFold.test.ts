import { describe, expect, it } from 'vitest';

import { graphLines } from './devroomState.js';
import { foldLines, parseFold, pathTo, toggleFold, trunkLine, unfoldNodes } from './graphFold.js';

const row = (branch: string, base: string) => ({ wt: { branch, base }, id: branch });
type R = ReturnType<typeof row>;
// main -> [integ] -> codex-a, codex-b; main -> task/ui -> task/sub; main -> codex-old
const ROWS = [
  row('task/codex-a', 'integ/1024-1815'),
  row('task/ui', 'main'),
  row('task/codex-b', 'integ/1024-1815'),
  row('task/sub', 'task/ui'),
  row('task/codex-old', 'main'),
];
const LINES = [trunkLine<R>('main'), ...graphLines(ROWS, 'main')];
const shown = (folded: string[], keep: string | null = null) =>
  foldLines(LINES, (id) => folded.includes(id), keep).map((l) => `${l.id}${l.count ? `(${l.open ? '-' : '+'}${l.count})` : ''}`);

describe('graph folds (DEVROOM-GRAPH2)', () => {
  it('toggle adds and removes a node per project; unfold takes a path off; the state stays when nothing changes', () => {
    let s = toggleFold({}, 'shop', 'integ/1024-1815');
    s = toggleFold(s, 'shop', 'main');
    s = toggleFold(s, 'api', 'main');
    expect(s).toEqual({ shop: ['integ/1024-1815', 'main'], api: ['main'] });
    s = toggleFold(s, 'api', 'main');
    expect(s).toEqual({ shop: ['integ/1024-1815', 'main'] });
    expect(unfoldNodes(s, 'shop', ['main', 'integ/1024-1815'])).toEqual({});
    expect(unfoldNodes(s, 'shop', ['task/ui'])).toBe(s);
  });

  it('storage: lists of names per project only; junk reads as nothing folded', () => {
    expect(parseFold('{"shop":["main","#graph"],"bad":[1],"empty":[],"x":"main"}')).toEqual({ shop: ['main', '#graph'] });
    expect(parseFold('not json')).toEqual({});
    expect(parseFold('[1]')).toEqual({});
    expect(parseFold(null)).toEqual({});
  });

  it('every node with cards under it carries their count; a folded one hides them', () => {
    expect(shown([])).toEqual(['main(-5)', 'integ/1024-1815(-2)', 'task/codex-a', 'task/codex-b', 'task/ui(-1)', 'task/sub', 'task/codex-old']);
    expect(shown(['integ/1024-1815'])).toEqual(['main(-5)', 'integ/1024-1815(+2)', 'task/ui(-1)', 'task/sub', 'task/codex-old']);
    expect(shown(['task/ui', 'integ/1024-1815'])).toEqual(['main(-5)', 'integ/1024-1815(+2)', 'task/ui(+1)', 'task/codex-old']);
    expect(shown(['main'])).toEqual(['main(+5)']);
  });

  it('the selected card stays drawn under a folded branch, with the way to it', () => {
    expect(shown(['integ/1024-1815'], 'task/codex-b')).toEqual(['main(-5)', 'integ/1024-1815(+2)', 'task/codex-b', 'task/ui(-1)', 'task/sub', 'task/codex-old']);
    expect(shown(['main'], 'task/sub')).toEqual(['main(+5)', 'task/ui(-1)', 'task/sub']);
  });

  it('pathTo: the lines above a card up to the trunk (what a pick unfolds)', () => {
    expect(pathTo(LINES, 'task/codex-b')).toEqual(['main', 'integ/1024-1815']);
    expect(pathTo(LINES, 'task/sub')).toEqual(['main', 'task/ui']);
    expect(pathTo(LINES, 'task/codex-old')).toEqual(['main']);
    expect(pathTo(LINES, 'nope')).toEqual([]);
  });
});
