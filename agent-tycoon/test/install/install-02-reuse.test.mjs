// INSTALL-2 (CLI part): an existing daemon is found and reused, never a second one. A rerun of install.sh keeps
// the install record, port and the one daemon.
// The app finding the WSL daemon from Windows is manual (agent-tycoon/docs/test/install-owner-checklist.md).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { winEnvCommand } from '../../install/manager.mjs';
import { release, scenario } from './harness.mjs';

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
  // Reading %LOCALAPPDATA% to find a Windows-side install is a read-only lookup (it was `cmd.exe /c echo`,
  // now PowerShell with UTF-8 output for a Korean user folder): not a change outside our folders.
  const readOnly = JSON.stringify(winEnvCommand('LOCALAPPDATA'));
  const outside = s.calls().filter((c) => OUTSIDE.has(c[0]) && JSON.stringify(c) !== readOnly);
  assert.deepEqual(outside, [], 'no sudo, linger, WSL, Windows or crontab command');
  assert.ok(s.calls().every((c) => c[0] !== 'systemctl' || c[1] === '--user'), 'systemctl --user only');
  for (const rc of ['.bashrc', '.profile', '.zshrc', '.bash_profile']) assert.equal(fs.existsSync(path.join(s.home, rc)), false, `${rc} not written`);
});
