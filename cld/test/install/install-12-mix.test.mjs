// INSTALL-12 (CLI parts): GUI and CLI share one install record and one daemon.
//   CLI install answering "no" to the desktop app -> (the app install is manual) -> CLI update: one record, one daemon;
//   an install made by the app's manager (--installed-by gui) -> install.sh -> agty update: the same record (still gui);
//   two updates at once (and an install.sh meanwhile): one runs, the others are refused by the manager lock.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PUB, release, scenario, sleep, until } from './harness.mjs';

const SETUP = 'Pixel.Office_1.0.0_x64-setup.exe';
const r1 = release('1.0.0', { extra: { [SETUP]: [`#!/bin/sh\nprintf 'setup.exe\\t%s\\n' "$*" >>"$AT_TEST_CTL/calls.log"\n`, 0o755] } });
const r2 = release('1.1.0');
const r3 = release('1.2.0');

test('INSTALL-12: CLI install (desktop app: no) -> CLI updates; two updates at once: one runs, the rest are refused', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i12-cli'); t.after(() => s.cleanup());
  let r = await s.installSh(r1); // --gui no
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /desktop app skipped/);
  assert.equal(s.calls().filter((c) => c[0] === 'setup.exe').length, 0);
  const id = s.record().id;
  r = await s.agty(['update', '--from', r2.dir]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(s.record().id, id); assert.equal(s.record().installedBy, 'cli');

  s.flag('health-delay', '1.2.0', 3000); // the first update holds the lock while 1.2.0 starts
  const first = s.agty(['update', '--from', r3.dir]);
  await until(() => fs.existsSync(path.join(s.root, 'manager.lock')));
  await sleep(300);
  const [second, viaScript] = await Promise.all([s.agty(['update', '--from', r3.dir]), s.installSh(r3)]);
  assert.equal(second.code, 4, second.out + second.err);
  assert.match(second.err, /another manager operation is running: update \(pid \d+/);
  assert.notEqual(viaScript.code, 0);
  assert.match(viaScript.err, /another manager operation is running: update/);
  const done = await first;
  assert.equal(done.code, 0, done.out + done.err);
  assert.equal((await s.health())?.version, '1.2.0');
  assert.equal(s.daemons().length, 1);
  assert.equal(s.record().id, id); assert.equal(s.record().current, '1.2.0');
  assert.equal(fs.existsSync(path.join(s.root, 'manager.lock')), false);
});

test('INSTALL-12: an install by the app\'s manager (gui) is the one install.sh and agty update then use', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i12-gui'); t.after(() => s.cleanup());
  // The desktop app carries the bundle and runs its manager with the bundle's Node (H §5.2); here from an unpacked copy.
  const app = path.join(s.base, 'app');
  fs.mkdirSync(app);
  assert.equal(spawnSync('tar', ['-xzf', r1.bundle, '-C', app]).status, 0);
  let r = await s.run(path.join(app, 'node', 'bin', 'node'), [path.join(app, 'cld', 'install', 'manager.mjs'), 'install', '--from', r1.bundle, '--pub', PUB, '--installed-by', 'gui', '--port', String(s.port)]);
  assert.equal(r.code, 0, r.out + r.err);
  const id = s.record().id;
  assert.equal(s.record().installedBy, 'gui');

  r = await s.installSh(r1); // the CLI one-liner on the same machine
  assert.equal(r.code, 0, r.out + r.err);
  r = await s.agty(['update', '--from', r2.dir]);
  assert.equal(r.code, 0, r.out + r.err);
  const record = s.record();
  assert.equal(record.id, id); assert.equal(record.installedBy, 'gui'); assert.equal(record.current, '1.1.0');
  assert.equal(s.daemons().length, 1);
  assert.deepEqual(fs.readdirSync(path.join(s.home, '.config/systemd/user')), ['agent-tycoon.service'], 'one service');
});
