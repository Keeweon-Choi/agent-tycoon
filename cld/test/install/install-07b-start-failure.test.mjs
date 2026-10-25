// INSTALL-7 (part 2): the new version migrates the data and then fails to start. The manager waits for health
// (30 s), puts `current` back, restores the data snapshot (the migrated copy is moved aside, never deleted) and
// starts 1.0.0 again; 1.1.0 is marked failed and refused until --force. With --force (and the fault gone) it
// installs; a rollback then restores the data from before it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { release, scenario } from './harness.mjs';

test('INSTALL-7: a version that migrates and fails to start: back on 1.0.0 with the data from before', { timeout: 90_000 }, async (t) => {
  const s = await scenario('i7-start'); t.after(() => s.cleanup());
  s.seedData();
  let r = await s.installSh(release('1.0.0'));
  assert.equal(r.code, 0, r.out + r.err);
  const data = s.files();
  const next = release('1.1.0', { dataSchema: { 'projects.json': 3 } });
  s.flag('migrate', '1.1.0'); s.flag('crash', '1.1.0');

  r = await s.agty(['update', '--from', next.dir]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /update to 1\.1\.0 failed \(failed health: 1\.1\.0 did not answer on port \d+\); back on 1\.0\.0 \(healthy\); data restored from the snapshot taken before \(the data it replaced is kept in .*cld-gui\.replaced-\d+/);
  assert.equal((await s.health())?.version, '1.0.0');
  assert.equal(s.daemons().length, 1);
  assert.deepEqual(s.files(), data, 'the data is back as it was before the update');
  const aside = fs.readdirSync(path.join(s.home, '.config')).filter((n) => n.startsWith('cld-gui.replaced-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(s.home, '.config', aside[0], 'data-version.txt'), 'utf8'), 'migrated by 1.1.0\n', 'the migrated data is kept aside, not deleted');
  assert.deepEqual(s.record().failedVersions, ['1.1.0']);
  assert.equal(s.record().current, '1.0.0');

  r = await s.agty(['update', '--from', next.dir]);
  assert.notEqual(r.code, 0); assert.match(r.err, /1\.1\.0 failed before; pass --force/);

  s.unflag('crash', '1.1.0');
  r = await s.agty(['update', '--from', next.dir, '--force']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal((await s.health())?.version, '1.1.0');
  assert.equal(s.files()['data-version.txt'] !== undefined, true);

  r = await s.agty(['rollback', '--yes']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /data restored from/);
  assert.equal((await s.health())?.version, '1.0.0');
  assert.deepEqual(s.files(), data, 'rollback: the data from before 1.1.0');
});
