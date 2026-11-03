import { describe, expect, it } from 'vitest';

import type { ToolActivity } from '../office/types.js';
import { waitingIds, waitReason, waitReasons } from './waiting.js';

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
});
