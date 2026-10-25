// O4: the permission mode new agents start with. A default for records made AFTER the answer;
// existing records and the upstream host-wide flag are never involved.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { Engine } from './engine/engine.js';
import { loadRegistry, registryPath } from './engine/registry.js';
import {
  handleNewAgentPermission,
  newAgentPermissionMessage,
  readNewAgentMode,
  seededPermission,
} from './newAgentPermission.js';
import { makeEngineHome, removeTestHome } from './testHome.js';

const homes: string[] = [];
const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-newperm-'));
  homes.push(home);
  return home;
};
/** A home with the engine's fake `claude` (a Worker add checks it is there). */
const engineHome = () => {
  const h = makeEngineHome();
  homes.push(h.home);
  return h;
};
afterEach(() => {
  for (const h of homes.splice(0)) removeTestHome(h);
});

type Ctx = Parameters<typeof handleNewAgentPermission>[2];
function ask(home: string, mode: unknown, over: Partial<Ctx> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const told: Array<Record<string, unknown>> = [];
  handleNewAgentPermission({ type: 'newAgentPermissionRequest', mode }, (m) => sent.push(m), {
    home,
    privileged: true,
    readOnly: false,
    broadcast: (m) => told.push(m),
    ...over,
  });
  return { sent, told };
}

describe('the stored default', () => {
  it('is unanswered until chosen, then saved and told to every office', () => {
    const home = makeHome();
    expect(readNewAgentMode(home)).toBe('');
    expect(newAgentPermissionMessage(home)).toEqual({ type: 'newAgentPermission', mode: '' });
    const { sent, told } = ask(home, 'bypass');
    expect(readNewAgentMode(home)).toBe('bypass');
    expect(sent).toEqual([]);
    expect(told).toEqual([{ type: 'newAgentPermission', mode: 'bypass' }]);
    expect(seededPermission(home)).toEqual({ permissionMode: 'bypassPermissions' });
    ask(home, 'ask');
    expect(seededPermission(home)).toEqual({});
  });

  it('refuses an unprivileged client and a read-only daemon, and the answer is the truth', () => {
    for (const over of [{ privileged: false }, { readOnly: true }]) {
      const home = makeHome();
      const { sent, told } = ask(home, 'bypass', over);
      expect(readNewAgentMode(home)).toBe('');
      expect(told).toEqual([]);
      expect(sent).toEqual([{ type: 'newAgentPermission', mode: '', error: 'read_only' }]);
    }
  });

  it('a remote session needs a fresh step-up to choose bypass; choosing ask never does', () => {
    const home = makeHome();
    const remote = (fresh: boolean) => ({ stepUp: { remote: true, fresh: () => fresh } });
    expect(ask(home, 'bypass', remote(false)).sent).toEqual([
      { type: 'newAgentPermission', mode: '', error: 'stepup' },
    ]);
    expect(readNewAgentMode(home)).toBe('');
    expect(ask(home, 'bypass', remote(true)).told).toHaveLength(1);
    expect(readNewAgentMode(home)).toBe('bypass');
    // turning it off from an unproved remote session is allowed
    expect(ask(home, 'ask', remote(false)).told).toEqual([{ type: 'newAgentPermission', mode: 'ask' }]);
    // this PC's own page (not remote) needs none
    expect(ask(home, 'bypass', { stepUp: { remote: false, fresh: () => false } }).told).toHaveLength(1);
  });

  it('ignores anything but ask or bypass', () => {
    const home = makeHome();
    expect(ask(home, 'yes')).toEqual({ sent: [], told: [] });
    expect(readNewAgentMode(home)).toBe('');
  });

  it('the old upstream host-wide flag is never read as an answer', () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.pixel-agents', 'config.json'),
      JSON.stringify({ standalone: { bypassPermissions: true, bypassAnswered: true } }),
    );
    expect(readNewAgentMode(home)).toBe('');
    expect(seededPermission(home)).toEqual({});
  });
});

describe('what new records get', () => {
  const boot = (home: string, claudePath = '/missing/claude') => {
    const e = new Engine({
      claudePath,
      home,
      readOnly: false,
      systemdRun: null,
      timing: { watchMs: 0 },
    });
    e.start();
    return e;
  };
  const act = (e: Engine, action: 'add', name: string, fields: Record<string, unknown>) =>
    e.run({ type: 'engineAction', requestId: `r-${name}`, action, name, ...fields } as never, true);
  const stored = (home: string, name: string) =>
    loadRegistry(registryPath(home)).projects.find((p) => p.name === name);

  it('a project and a Worker made after the answer start in it; existing ones and explicit modes are untouched', async () => {
    const { home, claudePath } = engineHome();
    const dir = (n: string) => fs.mkdirSync(path.join(home, 'work', n), { recursive: true }) && path.join(home, 'work', n);
    const e = boot(home, claudePath);
    try {
      expect(await act(e, 'add', 'before', { folder: dir('before') })).toMatchObject({ ok: true });
      expect(stored(home, 'before')?.permissionMode).toBeUndefined();

      ask(home, 'bypass');
      expect(await act(e, 'add', 'after', { folder: dir('after') })).toMatchObject({ ok: true });
      expect(stored(home, 'after')?.permissionMode).toBe('bypassPermissions');
      expect(await act(e, 'add', 'w1', { role: 'worker', project: 'after' })).toMatchObject({ ok: true });
      expect(stored(home, 'w1')?.permissionMode).toBe('bypassPermissions');
      // the request's own mode wins, even an empty one (Claude Code's own default)
      expect(await act(e, 'add', 'own', { folder: dir('own'), permissionMode: 'plan' })).toMatchObject({ ok: true });
      expect(stored(home, 'own')?.permissionMode).toBe('plan');
      expect(await act(e, 'add', 'blank', { folder: dir('blank'), permissionMode: '' })).toMatchObject({ ok: true });
      expect(stored(home, 'blank')?.permissionMode).toBeUndefined();
      // existing records never change
      expect(stored(home, 'before')?.permissionMode).toBeUndefined();

      // "ask" seeds nothing, and does not rewrite what was seeded
      ask(home, 'ask');
      expect(await act(e, 'add', 'later', { folder: dir('later') })).toMatchObject({ ok: true });
      expect(stored(home, 'later')?.permissionMode).toBeUndefined();
      expect(stored(home, 'after')?.permissionMode).toBe('bypassPermissions');
    } finally {
      e.dispose();
    }
  });

  it('an import made after the answer starts in it', async () => {
    const home = makeHome();
    const folder = path.join(home, 'projects', 'one');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'), 'rules');
    const e = boot(home);
    try {
      ask(home, 'bypass');
      const result = await e.importProjects(
        'imp',
        path.join(home, 'projects'),
        [{ folder, name: 'one', room: 'projects', resume: false, start: false }],
        true,
      );
      expect(result.rows[0].status).toBe('added');
      expect(stored(home, 'one')?.permissionMode).toBe('bypassPermissions');
    } finally {
      e.dispose();
    }
  });
});
