import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { leadDefaults } from '../../../../core/src/cld/leadDefaults.js';
import type { EngineAction } from '../../../../core/src/messages.js';
import { makeEngineHome, removeTestHome } from '../testHome.js';
import { Engine } from './engine.js';

const CLAUDE = { models: ['fable', 'opus', 'sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

describe('a new Lead never falls back to an empty model (owner 10-25 22:48)', () => {
  it('leadDefaults: the Leads’ common pair, else the top family and the highest effort', () => {
    const leads = [
      { model: 'claude-opus-5-5', effort: 'max' },
      { model: 'claude-opus-5-5', effort: 'max' },
      { model: 'sonnet', effort: 'high' },
      {},
    ];
    expect(leadDefaults(leads, CLAUDE)).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
    expect(leadDefaults([], CLAUDE)).toEqual({ model: 'opus', effort: 'max' });
    expect(leadDefaults([{}], { models: ['sonnet', 'haiku'], efforts: ['low', 'high'] })).toEqual({
      model: 'sonnet',
      effort: 'high',
    });
    expect(leadDefaults([], undefined)).toEqual({ model: undefined, effort: undefined });
  });

  it('the engine’s add: no model stores the default, an explicit empty one stays empty', async () => {
    const { home, claudePath } = makeEngineHome();
    const e = new Engine({
      claudePath,
      home,
      readOnly: false,
      systemdRun: null,
      log: () => undefined,
      env: { ...process.env, HOME: home },
      binDir: null,
      agentChoices: { discover: () => ({ claude: CLAUDE }) },
    });
    cleanup.push(() => {
      e.dispose();
      removeTestHome(home);
    });
    let n = 0;
    const add = (name: string, fields: Partial<EngineAction> = {}) => {
      const folder = path.join(home, 'work', name);
      fs.mkdirSync(folder, { recursive: true });
      return e.run({ type: 'engineAction', requestId: `r${++n}`, action: 'add', name, folder, ...fields }, true, 'cli');
    };
    const lead = (name: string) => e.state().projects.find((p) => p.name === name);
    // No Leads yet: the installed Claude Code's top model and effort.
    await add('first');
    expect(lead('first')).toMatchObject({ model: 'opus', effort: 'max' });
    await add('second', { model: 'claude-opus-5-5', effort: 'max' });
    await add('third', { model: 'claude-opus-5-5' });
    // Now the Leads' common pair.
    await add('fourth');
    expect(lead('fourth')).toMatchObject({ model: 'claude-opus-5-5', effort: 'max' });
    // Cleared in the form: Claude's own default, on purpose.
    await add('fifth', { model: '', effort: '' });
    expect(lead('fifth')!.model).toBeUndefined();
    expect(lead('fifth')!.effort).toBeUndefined();
  });
});
