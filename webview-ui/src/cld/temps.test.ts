import { beforeEach, describe, expect, it } from 'vitest';

import { setLanguage } from '../i18n/index.js';
import { modelBadge } from './modelBadges.js';
import {
  capRows,
  codexFold,
  codexTaskLine,
  groupTemps,
  homeLine,
  shouldGoHome,
  taskLine,
  type TempRow,
  workRefOf,
} from './temps.js';

const MIN = 60_000;

beforeEach(() => setLanguage('ko'));

describe('temps (T-0041)', () => {
  it('go home only when the lead is done, nothing new came and the linger time passed', () => {
    const t = { working: false, lastWorkAt: 0 };
    expect(shouldGoHome(t, true, 10 * MIN, 10 * MIN)).toBe(true);
    expect(shouldGoHome(t, true, 10 * MIN - 1, 10 * MIN)).toBe(false); // still lingering
    expect(shouldGoHome(t, false, 60 * MIN, 10 * MIN)).toBe(false); // the lead's turn goes on
    expect(shouldGoHome({ working: true, lastWorkAt: 0 }, true, 60 * MIN, 10 * MIN)).toBe(false);
    // New work moved lastWorkAt on: the clock starts again.
    const later = { working: false, lastWorkAt: 5 * MIN };
    expect(shouldGoHome(later, true, 10 * MIN, 10 * MIN)).toBe(false);
  });

  it('badges the models the stores name, and nothing else', () => {
    expect(modelBadge('claude-opus-4-5')).toBe('opus');
    expect(modelBadge('sonnet')).toBe('sonnet');
    expect(modelBadge('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelBadge('terra')).toBe('terra');
    expect(modelBadge('gpt-x sol high')).toBe('sol');
    expect(modelBadge('luna')).toBe('luna');
    expect(modelBadge('gpt-x')).toBe(null);
    expect(modelBadge('solar')).toBe(null);
    expect(modelBadge(null)).toBe(null);
  });

  it('says what a temp does in one line', () => {
    expect(taskLine('scout', { description: 'scout the repo', ez: '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911' })).toBe(
      'scout the repo',
    );
    // A sub-agent's name is its description: the activity speaks instead.
    expect(taskLine('fix login', { description: 'fix login', ez: '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911' })).toBe(
      '🔎 \ucc3e\uc544\ubcf4\ub294 \uc911',
    );
    expect(taskLine('x', { status: 'Reading a.ts' })).toBe('Reading a.ts');
    const long = taskLine('x', {
      description: 'Generating push messages into messages.ts '.repeat(3),
    });
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
    expect(codexTaskLine({ id: '1021-230000-alpha', spec: 'T-0041-temps.md' })).toBe(
      'T-0041-temps',
    );
    expect(codexTaskLine({ id: '1021-230000-alpha', spec: null })).toBe('1021-230000-alpha');
  });

  it("groups temps under their lead's card (+N), the rest under \uc678\uc8fc", () => {
    const row = (id: number, leadId: number | null): TempRow => ({
      id,
      kind: 'subagent',
      leadId,
      name: `t${id}`,
      task: '',
      model: null,
      modelId: null,
      phase: 'working',
      since: 0,
      work: null,
    });
    const { byLead, outsourced } = groupTemps(
      [row(-1, 1), row(-2, 1), row(-3, 2), row(-4, null), row(-5, 99)],
      new Set([1, 2]),
    );
    expect(byLead.get(1)?.map((r) => r.id)).toEqual([-1, -2]);
    expect(byLead.get(2)?.map((r) => r.id)).toEqual([-3]);
    expect(outsourced.map((r) => r.id)).toEqual([-4, -5]);
  });

  it('folds finished Codex tasks', () => {
    const tasks = [
      ...Array(12).fill({ state: 'done' }),
      { state: 'failed' },
      { state: 'stopped' },
      { state: 'running' },
    ];
    expect(codexFold(tasks)).toBe('Codex \uc644\ub8cc 12 · \uc2e4\ud328 1 · \uc911\uc9c0 1');
    expect(codexFold([{ state: 'running' }])).toBe(null);
    expect(capRows([1, 2, 3, 4, 5, 6, 7])).toEqual({ shown: [1, 2, 3, 4, 5], more: 2 });
    expect(homeLine('fix login', 4 * MIN)).toBe('fix login · \ub05d (4\ubd84)');
  });
});

describe("what a temp's work view reads (T-0056)", () => {
  it('a sub-agent by its lead and spawn, a teammate by itself, a Codex worker by none', () => {
    expect(workRefOf('subagent', { id: -3 }, { lead: { agentId: 7, toolId: 'toolu_1' } })).toEqual({
      kind: 'subagent',
      agentId: 7,
      id: 'toolu_1',
    });
    expect(workRefOf('teammate', { id: 12 }, {})).toEqual({ kind: 'teammate', agentId: 12 });
  });
  it('none when the spawn or the task is not known', () => {
    expect(workRefOf('subagent', { id: -3 }, {})).toBeNull();
    expect(workRefOf('codex', { id: -9 }, {})).toBeNull();
  });
});
