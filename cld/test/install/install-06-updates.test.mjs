// INSTALL-6: several updates in a row (bundle file, release folder, URL), each one checked: the daemon answers
// with the new version, the engine's sessions are taken over, the CLI works, the data stays; a data-format change
// takes a rollback snapshot; two old versions are kept, older ones removed; rollback goes back one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { release, scenario, serve } from './harness.mjs';

test('INSTALL-6: 1.0.0 -> 1.1.0 -> 1.2.0 (data format change) -> 1.3.0, two old versions kept, rollback one back', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i6-updates'); t.after(() => s.cleanup());
  s.seedData();
  fs.writeFileSync(path.join(s.ctl, 'projects.json'), JSON.stringify([{ name: 'shop', state: 'on' }]));
  const v3 = { 'projects.json': 3 };
  const rel = { '1.0.0': release('1.0.0'), '1.1.0': release('1.1.0'), '1.2.0': release('1.2.0', { dataSchema: v3 }), '1.3.0': release('1.3.0', { dataSchema: v3 }) };
  s.flag('migrate', '1.2.0');
  const web = await serve(rel['1.3.0'].dir); t.after(() => web.close());

  let r = await s.installSh(rel['1.0.0']);
  assert.equal(r.code, 0, r.out + r.err);
  const data = s.files();
  const check = async (version) => {
    assert.equal((await s.health())?.version, version);
    assert.equal(s.daemons().length, 1, `one daemon on ${version}`);
    const st = await s.agty(['status', '--json']);
    assert.equal(st.code, 0, st.out + st.err);
    const status = JSON.parse(st.out);
    assert.equal(status.install.current, version); assert.equal(status.install.health.matches, true);
    assert.deepEqual(status.projects.map((p) => [p.name, p.state]), [['shop', 'on']], 'the session is on again under the new daemon');
    assert.equal(JSON.parse((await s.agty(['version'])).out)['cld-gui'], version, 'agty version');
  };
  await check('1.0.0');

  r = await s.agty(['update', '--from', rel['1.1.0'].bundle]); // a bundle file, checked with the pinned key
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /updated 1\.0\.0 -> 1\.1\.0/);
  await check('1.1.0');
  assert.deepEqual(s.files(), data);

  r = await s.agty(['update', '--from', rel['1.2.0'].dir]); // a release folder
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /rollback snapshot of .*\.config\/cld-gui/);
  await check('1.2.0');
  assert.equal(fs.readFileSync(path.join(s.home, '.config/cld-gui/data-version.txt'), 'utf8'), 'migrated by 1.2.0\n');

  r = await s.agty(['update', '--check', '--json', '--from', web.url]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(JSON.parse(r.out).available, '1.3.0');
  r = await s.agty(['update', '--from', web.url]); // a URL (the release over HTTP)
  assert.equal(r.code, 0, r.out + r.err);
  await check('1.3.0');

  const record = s.record();
  assert.deepEqual(Object.keys(record.versions).sort(), ['1.1.0', '1.2.0', '1.3.0'], 'current + two old versions');
  assert.equal(record.previous, '1.2.0');
  assert.equal(fs.existsSync(path.join(s.root, 'versions', '1.0.0')), false, '1.0.0 removed');
  assert.deepEqual(fs.readdirSync(path.join(s.root, 'versions')).sort(), ['1.1.0', '1.2.0', '1.3.0']);
  assert.ok(record.versions['1.2.0'].snapshot && fs.existsSync(record.versions['1.2.0'].snapshot), 'the snapshot from before 1.2.0 is kept for its rollback');
  assert.deepEqual(fs.readdirSync(path.join(s.root, 'downloads')), [], 'no download left behind');
  const { ['data-version.txt']: migrated, ...rest } = s.files();
  assert.ok(migrated); assert.deepEqual(rest, data, 'the rest of the data is as it was');

  r = await s.agty(['rollback', '--yes']);
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /rolled back 1\.3\.0 -> 1\.2\.0/);
  await check('1.2.0');
});
