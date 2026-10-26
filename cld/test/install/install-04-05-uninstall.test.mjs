// INSTALL-4 (program removal -> reinstall keeps data and the development environment) and INSTALL-5 (full reset:
// the delete list first, an optional backup, then a fresh install; Claude, Codex and Git projects stay as they are).
// INSTALL-3 (remove only the desktop app) needs the Windows app: manual (install-owner-checklist.md).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { release, scenario, snapshot } from './harness.mjs';

const require = createRequire(import.meta.url);
const { configDirectory, legacyConfigDirectory } = require('../../../core/src/cld/configPath.cjs');
const r1 = release('1.0.0');
const devenv = (s) => { const v = snapshot({ home: s.home, system: false }); return Object.fromEntries(Object.entries(v).filter(([k]) => /^(rc |claude|codex|nvm|fnm|volta|login|interactive|npm)/.test(k))); };

test('INSTALL-4: uninstall --program removes the program and keeps every piece of data; a reinstall picks it up again', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i4-program'); t.after(() => s.cleanup());
  s.seedData();
  let r = await s.installSh(r1);
  assert.equal(r.code, 0, r.out + r.err);
  const data = s.files();
  const claude = s.files('.claude'); const codex = s.files('.codex'); const env = devenv(s);
  assert.ok(data['projects.json'] && data['config.json']);

  r = await s.agty(['uninstall', '--program', '--yes']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /6\. 지우지 않는 것: ~\/\.claude, ~\/\.codex/);
  assert.match(r.out, /프로그램 제거 완료/);
  assert.equal(fs.existsSync(s.root), false, 'install root gone');
  assert.equal(fs.existsSync(path.join(s.home, '.config/systemd/user/agent-tycoon.service')), false);
  assert.ok(s.calls().some((c) => c.join(' ') === 'systemctl --user disable --now agent-tycoon'));
  assert.equal(s.daemons().length, 0); assert.equal(await s.health(), null);
  assert.deepEqual(s.files(), data, 'settings data unchanged, file by file');
  assert.deepEqual(s.files('.claude'), claude); assert.deepEqual(s.files('.codex'), codex);
  assert.deepEqual(devenv(s), env);

  // Reinstall without --port: the port comes back from the kept config.json.
  r = await s.installSh(r1, ['--yes', '--gui', 'no', '--launch', 'no'], { defaults: false });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(s.record().port, s.port);
  assert.equal((await s.health()).version, '1.0.0');
  assert.deepEqual(s.files(), data, 'the reinstalled daemon has the same data');
  assert.deepEqual(s.files('.claude'), claude); assert.deepEqual(s.files('.codex'), codex);
});

test('INSTALL-5: uninstall --reset shows its list, removes our data only; backup and restore carry it over; Claude, Codex and Git stay', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i5-reset'); t.after(() => s.cleanup());
  s.seedData();
  const put = (rel, text) => { const f = path.join(s.home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  for (const f of ['layout.json', 'config.json', 'vscode-state.json', 'hooks/claude-hook.js', 'standalone-state.json', 'standalone-token']) put(`.pixel-agents/${f}`, `${f}\n`);
  // A Git project with a commit, an uncommitted change and a worktree on its own branch (.worktrees/, as our features make).
  const proj = path.join(s.home, 'work', 'shop');
  const genv = { ...process.env, HOME: s.home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...a) => { const g = spawnSync('git', a, { cwd: proj, env: genv, encoding: 'utf8' }); assert.equal(g.status, 0, g.stderr); return g.stdout; };
  put('work/shop/app.js', 'v1\n');
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'one'); git('worktree', 'add', '-q', '-b', 'feature', '.worktrees/feature');
  put('work/shop/app.js', 'v2 (not committed)\n');
  const gitState = () => [git('status', '--porcelain'), git('worktree', 'list', '--porcelain'), git('branch', '-a'), git('rev-parse', 'HEAD'), fs.readFileSync(path.join(proj, 'app.js'), 'utf8')].join('\n--\n');

  let r = await s.installSh(r1);
  assert.equal(r.code, 0, r.out + r.err);
  const before = { git: gitState(), claude: s.files('.claude'), codex: s.files('.codex'), env: devenv(s), data: s.files() };
  assert.ok(fs.existsSync(path.join(s.home, '.pixel-agents/server.json')), 'the daemon wrote server.json');

  r = await s.agty(['uninstall', '--reset', '--dry-run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.out.split('\n').some((line) => line.startsWith('5. 완전 초기화:') && line.includes(configDirectory(s.home))));
  assert.match(r.out, /남김\(공유 Pixel Agents 파일\): .*layout\.json/);
  assert.match(r.out, /DRY-RUN: 변경하지 않았습니다/);
  assert.deepEqual(s.files(), before.data, 'a dry run changes nothing');
  assert.ok(s.record());

  const backup = path.join(s.home, 'at-backup.json.gz');
  r = await s.agty(['backup', '--out', backup]);
  assert.equal(r.code, 0, r.out + r.err);

  r = await s.agty(['uninstall', '--reset', '--yes']);
  assert.equal(r.code, 0, r.out + r.err);
  for (const dataFolder of [legacyConfigDirectory(s.home), path.join(s.home, '.config', 'agent-tycoon')])
    assert.equal(fs.existsSync(dataFolder), false, `${dataFolder}: our data folder is gone`);
  for (const f of ['standalone-state.json', 'standalone-token', 'server.json']) assert.equal(fs.existsSync(path.join(s.home, '.pixel-agents', f)), false, f);
  for (const f of ['layout.json', 'config.json', 'vscode-state.json', 'hooks/claude-hook.js']) assert.ok(fs.existsSync(path.join(s.home, '.pixel-agents', f)), `${f} kept`);
  assert.equal(fs.existsSync(s.root), false);
  assert.equal(gitState(), before.git, 'git status, worktrees, branches and the uncommitted change are untouched');
  assert.deepEqual(s.files('.claude'), before.claude); assert.deepEqual(s.files('.codex'), before.codex);
  assert.deepEqual(devenv(s), before.env);
  assert.ok(fs.existsSync(backup), 'the backup file (outside the data folder) is kept');

  // A fresh install: a new record, a new data folder; then the backup brings the projects and tasks back.
  r = await s.installSh(r1);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal((await s.health()).version, '1.0.0');
  assert.equal(s.files()['projects.json'], undefined, 'fresh: no old data');
  // restore wants the daemon stopped: agty stop --daemon, restore, agty start.
  for (const args of [['stop', '--daemon', '--yes'], ['restore', backup, '--yes'], ['start']]) { r = await s.agty(args); assert.equal(r.code, 0, `${args.join(' ')}: ${r.out}${r.err}`); }
  assert.equal((await s.health()).version, '1.0.0');
  for (const f of ['projects.json', 'tasks.json', 'groups/team.jsonl']) assert.equal(s.files()[f], before.data[f], `${f} restored`);
  assert.equal(gitState(), before.git);
  assert.deepEqual(s.files('.claude'), before.claude); assert.deepEqual(s.files('.codex'), before.codex);
});
