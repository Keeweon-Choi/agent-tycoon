/** DEVROOM-NAMES: who did a Codex run's worktree. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';

import { type CodexRecord, readCodex, saveCodex } from './engine/codex.js';
import { RosterStore } from './roster.js';
import { WorktreeWho } from './worktreeWho.js';

let dir = '';
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const record = (id: string, o: Partial<CodexRecord>): CodexRecord => ({
  id, project: 'alpha', model: null, state: 'done', dir: '/p', worktree: null, branch: null, base: null,
  spec: 's.md', started: '2026-10-22T19:50:11', ended: '2026-10-22T20:00:00', exit: 0, resetAt: null,
  sid: null, commits: 1, jobId: id, log: 'l', pid: null, source: 'cli', ...o,
});

it('a bound run is its employee; an older ended run gets one of the project staff, kept; a Worker run its name', () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtwho-'));
  const codex = path.join(dir, 'codex');
  fs.mkdirSync(codex);
  let n = 0;
  const roster = new RosterStore(path.join(dir, 'roster.json'), { newId: () => `e${++n}` });
  const a = roster.bind('alpha', 'codex:1026-003552-a', { provider: 'codex' })!;
  roster.release('codex:1026-003552-a');
  saveCodex(codex, record('1026-003552-a', { worktree: '/p/.worktrees/codex-1026-003552' }));
  saveCodex(codex, record('1022-195011-b', { worktree: '/p/.worktrees/codex-1022-195011' }));
  saveCodex(codex, record('1027-004953-c', { worktree: '/p/.worktrees/codex-1027-004953', agent: 'kim' }));
  saveCodex(codex, record('1028-000000-d', { worktree: '/p/.worktrees/codex-1028-000000', state: 'running', ended: null }));
  const who = new WorktreeWho({ dir: () => codex, roster });

  expect(who.of('alpha', '/p/.worktrees/codex-1026-003552')).toEqual({ employee: { employeeId: a.id, nameId: a.nameId } });
  expect(who.of('alpha', '/p/.worktrees/codex-1022-195011')).toEqual({ employee: { employeeId: a.id, nameId: a.nameId } });
  expect(readCodex(codex, '1022-195011-b')?.employee).toEqual({ employeeId: a.id, nameId: a.nameId });
  expect(who.of('alpha', '/p/.worktrees/codex-1027-004953')).toEqual({ agent: 'kim' });
  // Running, not bound: nothing yet, nothing written.
  expect(who.of('alpha', '/p/.worktrees/codex-1028-000000')).toBeUndefined();
  expect(readCodex(codex, '1028-000000-d')?.employee).toBeUndefined();
  expect(who.of('alpha', '/p/.worktrees/other')).toBeUndefined();
});
