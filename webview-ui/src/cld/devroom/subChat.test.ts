import { describe, expect, it } from 'vitest';

import type { ChatItem } from '../../../../core/src/messages.js';
import { countSteps, failedSteps, failureHint, foldTranscript, outputsOf, stepKind } from './subChat.js';

let n = 0;
const it_ = (kind: ChatItem['kind'], text: string, more: Partial<ChatItem> = {}): ChatItem => ({ kind, text, id: `${++n}`, at: 0, ...more });
const call = (toolName: string, args: string) => it_('tool', `${toolName} ${args}`, { toolName, args });
const ok = (text = 'done') => it_('result', text);
const bad = (text = 'boom') => it_('result', text, { failed: true });

describe('foldTranscript (DEVROOM-SUBCHAT)', () => {
  const items = [
    it_('user', 'task'),
    it_('assistant', 'looking'),
    call('Bash', 'ls'),
    ok(),
    call('Read', 'a.ts'),
    ok(),
    call('Bash', 'npm test'),
    bad(),
    it_('assistant', 'one test fails'),
    call('Edit', 'a.ts'),
    ok(),
  ];
  const f = foldTranscript(items);

  it('takes the first user item as the task and keeps the sayings in order', () => {
    expect(f.prompt?.text).toBe('task');
    expect(f.blocks.map((b) => (b.kind === 'say' ? b.item.text : `steps:${b.steps.length}`))).toEqual(['looking', 'steps:3', 'one test fails', 'steps:1']);
  });

  it('joins each result to its call, in order, and marks the failed one', () => {
    const [, run] = f.blocks;
    if (run.kind !== 'steps') throw new Error('steps');
    expect(run.steps.map((s) => [s.call.toolName, s.result?.text, s.failed])).toEqual([
      ['Bash', 'done', false],
      ['Read', 'done', false],
      ['Bash', 'boom', true],
    ]);
    expect(failedSteps(run.steps)).toHaveLength(1);
  });

  it('a call still running has no result and is not failed; a result with no call is dropped', () => {
    const g = foldTranscript([ok('orphan'), call('Bash', 'sleep 9')]);
    expect(g.prompt).toBeNull();
    expect(g.blocks).toHaveLength(1);
    const [b] = g.blocks;
    const step = b.kind === 'steps' ? b.steps[0] : undefined;
    expect([step?.result, step?.failed]).toEqual([undefined, false]);
  });
});

describe('countSteps', () => {
  it('counts by kind in a fixed order and leaves out the empty kinds', () => {
    const f = foldTranscript([call('Read', 'a'), call('Bash', 'x'), call('Grep', 'p'), call('Bash', 'y'), call('Bash', 'z'), call('WebFetch', 'u')]);
    const [b] = f.blocks;
    expect(b.kind === 'steps' && countSteps(b.steps)).toEqual([
      ['command', 3],
      ['read', 2],
      ['other', 1],
    ]);
  });
  it('classifies the tools', () => {
    expect(['Bash', 'Read', 'Write', 'Edit', 'Task', undefined].map(stepKind)).toEqual(['command', 'read', 'edit', 'edit', 'other', 'other']);
  });
});

describe('outputsOf', () => {
  const blocks = foldTranscript([
    call('Write', '/p/src/new.ts'),
    ok(),
    call('Edit', '/p/src/new.ts'),
    ok(),
    call('Edit', '/p/src/broken.ts'),
    bad(),
    call('Bash', 'git commit -m "fix sum"'),
    ok('[feat/x 1a2b3c4] fix sum\n 1 file changed'),
    call('Bash', 'git commit -m "nothing"'),
    bad('nothing to commit'),
    call('Bash', 'ls'),
    ok('[not a commit]'),
  ]).blocks;

  it('lists a written file once and a made commit, from the calls that worked', () => {
    expect(outputsOf(blocks).map((c) => [c.kind, c.label])).toEqual([
      ['file', 'new.ts'],
      ['commit', '1a2b3c4 fix sum'],
    ]);
  });
  it('negative control: with every result failed there is no chip', () => {
    const allBad = blocks.map((b) => (b.kind === 'steps' ? { ...b, steps: b.steps.map((s) => ({ ...s, failed: true })) } : b));
    expect(outputsOf(allBad)).toEqual([]);
  });
});

describe('failureHint', () => {
  it('picks the line that names the error, else the first line', () => {
    expect(failureHint(' ✓ a.test.ts (11 tests)\n ✗ b.test.ts > sum\n   → expected 1')).toBe('✗ b.test.ts > sum');
    expect(failureHint('\n\nplain words\nmore')).toBe('plain words');
    expect(failureHint('')).toBe('');
  });
});
