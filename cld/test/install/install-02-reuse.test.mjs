// INSTALL-2 (CLI part): an existing daemon is found and reused, never a second one. A rerun of install.sh keeps
// the install record, port and the one daemon; a running source install (the old `cld-gui` service) is adopted
// (stopped, its unit kept for revert-adopt, its CLI link moved to ours) and revert-adopt puts it back.
// The app finding the WSL daemon from Windows is manual (cld/docs/test/install-owner-checklist.md).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mergeConfig, renderSystemdUnit } from '../../install/install.mjs';
import { release, scenario, tree, until } from './harness.mjs';

const OUTSIDE = new Set(['sudo', 'loginctl', 'wsl', 'wsl.exe', 'powershell', 'powershell.exe', 'schtasks', 'schtasks.exe', 'netsh', 'netsh.exe', 'reg.exe', 'crontab']);
const r1 = release('1.0.0');

test('INSTALL-2: a rerun of install.sh reuses the install: same record, port and one daemon', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i2-rerun'); t.after(() => s.cleanup());
  let r = await s.installSh(r1);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /SHA-256 matches/); assert.match(r.out, /Agent Tycoon 1\.0\.0 is running on port/);
  const first = s.record();
  assert.equal(first.current, '1.0.0'); assert.equal(first.installedBy, 'cli'); assert.equal(first.service.kind, 'systemd'); assert.equal(first.port, s.port); assert.equal(first.wslDistro, 'AtTest');
  assert.equal((await s.health()).version, '1.0.0');
  assert.equal(s.daemons().length, 1);
  const unit = fs.readFileSync(path.join(s.home, '.config/systemd/user/agent-tycoon.service'), 'utf8');
  assert.match(unit, new RegExp(`ExecStart=${s.root}/current/node/bin/node .*${s.root}/current/dist/cli.js --port ${s.port}`));

  r = await s.installSh(r1);
  assert.equal(r.code, 0, r.out + r.err);
  const again = s.record();
  assert.equal(again.id, first.id); assert.equal(again.createdAt, first.createdAt); assert.deepEqual(Object.keys(again.versions), ['1.0.0']);
  assert.equal(again.port, s.port);
  assert.equal(s.daemons().length, 1, 'still one daemon');
  assert.equal((await s.health()).version, '1.0.0');
  const outside = s.calls().filter((c) => OUTSIDE.has(c[0]));
  assert.deepEqual(outside, [], 'no sudo, linger, WSL, Windows or crontab command');
  assert.ok(s.calls().every((c) => c[0] !== 'systemctl' || c[1] === '--user'), 'systemctl --user only');
  for (const rc of ['.bashrc', '.profile', '.zshrc', '.bash_profile']) assert.equal(fs.existsSync(path.join(s.home, rc)), false, `${rc} not written`);
});

test('INSTALL-2: a running source install (cld-gui service) is adopted, not doubled, and revert-adopt restores it', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i2-adopt'); t.after(() => s.cleanup());
  // A source checkout as get.sh leaves it: its daemon (the same fake) under the old service name, its CLI link.
  const repo = path.join(s.home, 'src', 'cld-gui');
  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true }); fs.mkdirSync(path.join(repo, 'cld', 'bin'), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'fake', 'daemon.cjs'), path.join(repo, 'dist', 'cli.js'));
  fs.writeFileSync(path.join(repo, 'manifest.json'), JSON.stringify({ version: 'source', protocol: 1 }));
  fs.writeFileSync(path.join(repo, 'cld', 'bin', 'cld-gui'), '// source cli\n');
  const config = mergeConfig({ port: s.port });
  fs.mkdirSync(path.join(s.home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.config/cld-gui/config.json'), JSON.stringify(config));
  const oldUnit = path.join(s.home, '.config/systemd/user/cld-gui.service');
  fs.mkdirSync(path.dirname(oldUnit), { recursive: true });
  fs.writeFileSync(oldUnit, renderSystemdUnit({ repo, node: process.execPath, home: s.home, config, name: 'cld-gui' }));
  fs.mkdirSync(path.join(s.home, '.local/bin'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'cld', 'bin', 'cld-gui'), path.join(s.home, '.local/bin/cld-gui'));
  assert.equal((await s.run('systemctl', ['--user', 'enable', 'cld-gui'])).code, 0);
  assert.equal((await s.run('systemctl', ['--user', 'start', 'cld-gui'])).code, 0);
  assert.equal((await until(() => s.health())).version, 'source');
  const repoBefore = tree(repo);

  const r = await s.installSh(r1);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /adopted the cld-gui service \(source install .*the repo is left as it is\)/);
  assert.ok(s.calls().some((c) => c.join(' ') === 'systemctl --user disable --now cld-gui'));
  assert.equal(fs.existsSync(oldUnit), false);
  assert.ok(fs.existsSync(path.join(s.root, 'adopted', 'cld-gui.service')));
  assert.equal(fs.readlinkSync(path.join(s.home, '.local/bin/cld-gui')), path.join(s.root, 'bin', 'cld-gui'));
  assert.equal((await s.health()).version, '1.0.0');
  assert.equal(s.daemons().length, 1, 'the old daemon stopped, one daemon on the port');
  assert.equal(s.record().adopted.repo, repo);
  assert.equal(tree(repo), repoBefore, 'the source checkout is untouched');

  const back = await s.agty(['revert-adopt']);
  assert.equal(back.code, 0, back.out + back.err);
  assert.ok(fs.existsSync(oldUnit));
  assert.equal(fs.readlinkSync(path.join(s.home, '.local/bin/cld-gui')), path.join(repo, 'cld', 'bin', 'cld-gui'));
  assert.equal((await until(() => s.health())).version, 'source');
  assert.equal(s.daemons().length, 1);
});
