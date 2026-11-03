import { describe, expect, it } from 'vitest';

import type { EngineProject } from '../../../../core/src/messages.js';
import { bucketOf, projectAgents } from './agentBoard.js';

describe('the terminal board (DEVROOM-SUBVIEW)', () => {
  it('groups: waiting needs you, a turn is working, recent news is done, old news or off is idle', () => {
    const DONE = 30 * 60_000;
    expect(bucketOf('waiting', DONE * 9, DONE)).toBe('needs');
    expect(bucketOf('thinking', 0, DONE)).toBe('working');
    expect(bucketOf('resting', DONE - 1, DONE)).toBe('done');
    expect(bucketOf('resting', DONE, DONE)).toBe('idle');
    expect(bucketOf('off', 0, DONE)).toBe('idle');
  });

  it("the project's Lead first, then its Workers; nobody else's", () => {
    const p = (name: string, over: Partial<EngineProject> = {}) => ({ name, folder: '/', room: '', wantRunning: true, live: true, ...over }) as EngineProject;
    const engine = [p('w1', { role: 'worker', project: 'shop' }), p('other'), p('shop'), p('w2', { role: 'worker', project: 'other' })];
    expect(projectAgents('shop', engine).map((x) => x.name)).toEqual(['shop', 'w1']);
  });
});
