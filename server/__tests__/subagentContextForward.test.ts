import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { SubagentWatch } from '../src/subagentWatch.js';

describe('SubagentWatch: a sub-agent’s own context report reaches its employee', () => {
  it('forwards the limit basis and the compactions its transcript counted, keyed by the lead and the spawn', () => {
    const main = new AgentStateStore();
    const watch = new SubagentWatch(main);
    const seen: unknown[] = [];
    watch.onContext = (...args) => seen.push(['context', ...args]);
    watch.onCompactions = (...args) => seen.push(['compactions', ...args]);
    const shadow = 777;
    (watch as unknown as { subKeys: Map<number, unknown> }).subKeys.set(shadow, {
      leadId: 4,
      spawnToolUseId: 'toolu_1',
    });
    watch.store.broadcast({
      type: 'agentContextUsage',
      id: shadow,
      contextTokens: 9,
      maxContextTokens: 200_000,
      limitBasis: 'estimated',
    });
    watch.store.broadcast({ type: 'agentCompactions', id: shadow, count: 2, recent: [] });
    watch.store.broadcast({ type: 'agentCompactions', id: 12345, count: 9, recent: [] }); // not a watched sub
    expect(seen).toEqual([
      ['context', 4, 'toolu_1', 9, 200_000, 'estimated'],
      ['compactions', 4, 'toolu_1', 2],
    ]);
  });
});
