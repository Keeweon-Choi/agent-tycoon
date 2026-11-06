import { describe, expect, it } from 'vitest';

import type { ToolActivity } from '../office/types.js';
import { publishWaiting, waitingIds, waitingSince, waitReason, waitReasons } from './waiting.js';

const tool = (over: Partial<ToolActivity>): ToolActivity =>
  ({ toolId: 't', status: 'x', done: false, ...over }) as ToolActivity;

describe('who waits for the person (the one rule)', () => {
  it('a question (a turn that ended asking, or the question tool open) or a permission; nothing else', () => {
    expect(waitReason(undefined, true)).toBe('question');
    expect(waitReason([tool({ toolName: 'AskUserQuestion' })], false)).toBe('question');
    expect(waitReason([tool({ permissionWait: true })], false)).toBe('permission');
    expect(waitReason([tool({ permissionWait: true, done: true })], false)).toBeNull();
    expect(waitReason([tool({ toolName: 'Read' })], false)).toBeNull();
    expect(waitReason(undefined, false)).toBeNull();
  });

  it('maps every agent and keeps the order of the ids asked about', () => {
    const reasons = waitReasons({ 1: [tool({ permissionWait: true })], 2: [tool({})] }, { 3: true, 4: false });
    expect(reasons).toEqual({ 1: 'permission', 3: 'question' });
    expect(waitingIds([4, 3, 2, 1], reasons)).toEqual([3, 1]);
  });

  it('remembers since when each agent waits, the first time it was seen waiting', () => {
    publishWaiting({ 1: 'permission' }, 100);
    publishWaiting({ 1: 'question', 2: 'permission' }, 200);
    expect([waitingSince(1), waitingSince(2)]).toEqual([100, 200]);
    publishWaiting({ 2: 'permission' }, 300);
    publishWaiting({ 1: 'permission', 2: 'permission' }, 400);
    expect([waitingSince(1), waitingSince(2)]).toEqual([400, 200]);
    publishWaiting({}, 500);
    expect(waitingSince(2)).toBeUndefined();
  });
});
