// INSTALL-7 (part 1): update failures that are refused before the running version is touched: a damaged bundle,
// a signature by another key, a manifest that disagrees with its name (version mismatch), a bundle for another
// machine, a download that breaks off (network gone), a failing self-test (then not retried without --force),
// an older version, an older data format. After each: the same daemon process still answers with 1.0.0, the data
// is unchanged, no version folder or download is left behind.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ARCH, EVIL, OS, release, scenario, serve } from './harness.mjs';

test('INSTALL-7: refused updates leave 1.0.0 running, its data and its folders as they were', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i7-refused'); t.after(() => s.cleanup());
  s.seedData();
  let r = await s.installSh(release('1.0.0'));
  assert.equal(r.code, 0, r.out + r.err);
  const data = s.files();
  const pid = (await s.health()).pid;
  const unchanged = async (what) => {
    const h = await s.health();
    assert.equal(h?.version, '1.0.0', `${what}: still 1.0.0`); assert.equal(h.pid, pid, `${what}: the daemon was not even restarted`);
    assert.equal(s.record().current, '1.0.0'); assert.ok(!s.record().update, `${what}: no update pending`);
    assert.deepEqual(fs.readdirSync(path.join(s.root, 'versions')), ['1.0.0'], `${what}: no version folder left`);
    assert.equal(fs.readdirSync(path.join(s.root, 'downloads')).length, 0, `${what}: no download left`);
    assert.deepEqual(s.files(), data, `${what}: data unchanged`);
  };
  fs.mkdirSync(path.join(s.root, 'downloads'), { recursive: true }); // the URL cases create it; the check reads it
  const refuse = async (what, from, pattern, extra = []) => {
    const res = await s.agty(['update', '--from', from, ...extra]);
    assert.notEqual(res.code, 0, `${what} must be refused`);
    assert.match(res.err, pattern, what);
    await unchanged(what);
  };

  const damaged = release('1.1.0');
  const bytes = fs.readFileSync(damaged.bundle); bytes[bytes.length >> 1] ^= 0xff; fs.writeFileSync(damaged.bundle, bytes);
  await refuse('damaged bundle', damaged.bundle, /refused .*SHA-256 does not match SHA256SUMS[\s\S]*supply-chain risk/);

  await refuse('signature by another key', release('1.1.0', { key: EVIL }).dir, /SHA256SUMS signature is not valid for this key/);

  await refuse('version mismatch (manifest says 1.5.0, the name 1.4.0)', release('1.4.0', { manifestVersion: '1.5.0' }).bundle, /manifest\.json says 1\.5\.0/);

  const other = `${OS}-${ARCH === 'x64' ? 'arm64' : 'x64'}`;
  await refuse(`a bundle for ${other}`, release('1.1.0', { target: other }).bundle, new RegExp(`built for ${other}.*needs agent-tycoon-daemon-1\\.1\\.0-${OS}-${ARCH}`));

  const net = await serve(release('1.1.0').dir, { cut: `agent-tycoon-daemon-1.1.0-${OS}-${ARCH}.tar.gz` });
  try { await refuse('the network going away mid-download', net.url, /download failed .*nothing installed was changed/); } finally { await net.close(); }

  s.flag('selftest-fail', '1.6.0');
  const bad = release('1.6.0');
  await refuse('a failing self-test', bad.dir, /self-test of 1\.6\.0 failed; still on 1\.0\.0 \(1\.6\.0 is marked failed\)/);
  assert.deepEqual(s.record().failedVersions, ['1.6.0']);
  await refuse('a version that failed before', bad.dir, /1\.6\.0 failed before; pass --force/);

  await refuse('an older version', release('0.9.0').dir, /0\.9\.0 is older than the installed 1\.0\.0/);
  await refuse('an older data format', release('1.7.0', { dataSchema: { 'projects.json': 1 } }).dir, /reads older data formats \(projects\.json 2 -> 1\)/);
});
