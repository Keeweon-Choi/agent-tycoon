import { beforeEach, expect, it } from 'vitest';

import type { ChatItem } from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import { toolRuns } from './toolFold.js';

beforeEach(() => setLanguage('en'));

let n = 0;
const tool = (toolName: string, extra: Partial<ChatItem> = {}): ChatItem => ({
  id: `t${n++}`,
  kind: 'tool',
  at: 1,
  toolName,
  text: `Using ${toolName}`,
  ...extra,
});
const said = (): ChatItem => ({ id: `m${n++}`, kind: 'assistant', at: 1, text: 'hi' });
const UPDATE = 'mcp__agty__update_task';
const CREATE = 'mcp__agty__create_task';

const shape = (items: ChatItem[], breaks?: (i: number) => boolean) => {
  const r = toolRuns(items, breaks);
  return { heads: [...r.heads].map(([i, run]) => [i, run.length]), hidden: [...r.hidden] };
};

it('folds consecutive calls of one tool, whatever their inputs', () => {
  const items = [
    said(),
    ...Array.from({ length: 16 }, (_, i) => tool(UPDATE, { args: `taskId: T-${i}` })),
    said(),
  ];
  const r = shape(items);
  expect(r.heads).toEqual([[1, 16]]);
  expect(r.hidden).toHaveLength(15);
});

it('a different tool, a text message or a result ends the run; a single row stays alone', () => {
  const items = [
    tool(UPDATE),
    tool(UPDATE),
    tool(CREATE),
    tool(UPDATE),
    tool(UPDATE),
    said(),
    tool(UPDATE),
  ];
  expect(shape(items)).toEqual({
    heads: [
      [0, 2],
      [3, 2],
    ],
    hidden: [1, 4],
  });
  const result: ChatItem = { id: 'r', kind: 'result', at: 1, text: 'ok' };
  expect(shape([tool(UPDATE), result, tool(UPDATE)]).heads).toEqual([]);
});

it('a caller-given break (a divider, a record) ends a run', () => {
  const items = [tool(UPDATE), tool(UPDATE), tool(UPDATE)];
  expect(shape(items, (i) => i === 2)).toEqual({ heads: [[0, 2]], hidden: [1] });
});

it('other tools fold only when their rows read the same', () => {
  const bash = (desc: string) => tool('Bash', { text: 'Running: ls', desc });
  expect(shape([bash('one'), bash('two')]).heads).toEqual([]);
  expect(shape([bash('one'), bash('one')]).heads).toEqual([[0, 2]]);
  expect(shape([]).heads).toEqual([]);
});
