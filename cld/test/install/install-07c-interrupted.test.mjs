// INSTALL-7 (part 3): an update cut off (the updater killed, as when the PC goes off) and the next `agty update`.
//   at 'unpacked' (during the self-test): nothing had changed, the staged version is dropped, still 1.0.0;
//   at 'switching', the new version slow but fine: the update is finished;
//   at 'switching', the new version dead: under --yes nothing is reverted (it may have served for days), and the
//   person's "y" on a terminal reverts to the previous version.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { processesUnder, release, scenario, until } from './harness.mjs';

test('INSTALL-7: an interrupted update is finished or reverted by the next agty update', { timeout: 120_000 }, async (t) => {
  const s = await scenario('i7-cut'); t.after(() => s.cleanup());
  s.seedData();
  let r = await s.installSh(release('1.0.0'));
  assert.equal(r.code, 0, r.out + r.err);
  const data = s.files();
  /** Starts `agty update --from <dir>` and kills it once install.json says it reached `step`. */
  const cutAt = async (dir, step, also = () => true) => {
    let child;
    const done = s.agty(['update', '--from', dir], { child: (c) => { child = c; } });
    await until(() => s.record()?.update?.step === step && also(), 40_000);
    process.kill(child.pid, 'SIGKILL');
    return done;
  };

  // 1. During the self-test.
  s.flag('selftest-sleep', '1.1.0');
  const selfTests = () => processesUnder(s.base).filter((p) => p.cmd.includes('--self-test'));
  r = await cutAt(release('1.1.0').dir, 'unpacked', () => selfTests().length > 0);
  for (const p of selfTests()) process.kill(p.pid, 'SIGKILL'); // the orphaned self-test of the killed updater
  assert.equal(JSON.parse((await s.agty(['status', '--json'])).out).install.pendingUpdate.step, 'unpacked');
  r = await s.agty(['update']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /nothing had changed yet: still on 1\.0\.0/);
  assert.deepEqual(fs.readdirSync(path.join(s.root, 'versions')), ['1.0.0']);
  assert.equal((await s.health())?.version, '1.0.0');

  // 2. While the new version is starting (it answers 6 s later).
  s.flag('health-delay', '1.2.0', 6000);
  // Killed only once the service manager was asked to start the new version (the pointer is switched by then).
  const restarts = () => s.calls().filter((c) => c.join(' ') === 'systemctl --user restart agent-tycoon').length;
  let before = restarts();
  r = await cutAt(release('1.2.0').dir, 'switching', () => restarts() > before);
  r = await s.agty(['update']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /finished: 1\.2\.0 is running/);
  assert.equal(s.record().current, '1.2.0'); assert.equal(s.record().previous, '1.0.0');
  assert.equal((await s.health())?.version, '1.2.0');
  assert.equal(s.daemons().length, 1);

  // 3. The new version never answers.
  s.flag('crash', '1.3.0');
  before = restarts();
  r = await cutAt(release('1.3.0').dir, 'switching', () => restarts() > before);
  r = await s.agty(['update', '--yes']);
  assert.equal(r.code, 3, r.out + r.err);
  assert.match(r.err, /not reverting under --yes: reverting would stop 1\.3\.0 .* and start 1\.2\.0\. Nothing was changed/);
  assert.equal(s.record().update.step, 'switching', 'still pending');
  // A person answers y on a terminal (script(1) gives the CLI one).
  r = await s.run('script', ['-qec', `${path.join(s.root, 'bin', 'agty')} update`, '/dev/null'], { input: 'y\n' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /update to 1\.3\.0 failed \(interrupted at 'switching'\); back on 1\.2\.0 \(healthy\)/);
  assert.equal(s.record().current, '1.2.0'); assert.ok(!s.record().update);
  assert.deepEqual(s.record().failedVersions, ['1.3.0']);
  assert.equal((await s.health())?.version, '1.2.0');
  assert.deepEqual(s.files(), data, 'no data was touched (no format change)');
});
