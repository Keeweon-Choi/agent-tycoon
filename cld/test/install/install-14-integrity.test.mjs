// INSTALL-14: a damaged or substituted bundle, a forged signature and a tampered desktop installer are refused
// before anything of theirs runs or is unpacked: no install root, no service, no data folder, no temp folder left.
// Both trust paths: the repository's unstamped install.sh (--from --pub, openssl checks SHA256SUMS.sig) and a
// stamped one (the release's hashes and key inside the script) downloading from a local server.
// Updates refuse the same (install-07a-refused.test.mjs). negative-control.test.mjs runs this file against an
// install.sh with its SHA-256 check removed and expects it to fail.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { stampInstallers } from '../../release/stamp-installers.mjs';
import { ARCH, EVIL, INSTALL_SH, KEY, OS, release, scenario, serve } from './harness.mjs';

const require = createRequire(import.meta.url);
const { legacyConfigDirectory } = require('../../../core/src/cld/configPath.cjs');
const MARK = 'substituted-bundle-ran';
/** A complete, well-formed bundle that is not the signed one: its wizard leaves a mark if it is ever run. */
const substitute = () => release('1.0.0', { files: { 'cld/install/wizard.mjs': `import fs from 'node:fs';\nfs.writeFileSync(process.env.AT_TEST_CTL + '/${MARK}', 'ran');\n` } });

function nothingInstalled(s, what) {
  assert.equal(fs.existsSync(s.root), false, `${what}: no install root`);
  assert.equal(fs.existsSync(path.join(s.home, '.config/systemd/user')), false, `${what}: no service`);
  for (const dataFolder of [legacyConfigDirectory(s.home), path.join(s.home, '.config', 'agent-tycoon')])
    assert.equal(fs.existsSync(dataFolder), false, `${what}: no data folder at ${dataFolder}`);
  assert.equal(fs.existsSync(path.join(s.ctl, MARK)), false, `${what}: nothing from the refused bundle ran`);
  assert.deepEqual(fs.readdirSync(s.env.TMPDIR), [], `${what}: the temp folder is gone`);
  assert.equal(s.daemons().length, 0);
}

test('INSTALL-14: install.sh --from refuses a substituted bundle, a damaged one, a forged signature and edited sums', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i14-from'); t.after(() => s.cleanup());
  const good = release('1.0.0');

  const swapped = release('1.0.0'); fs.copyFileSync(substitute().bundle, swapped.bundle);
  let r = await s.installSh(swapped);
  nothingInstalled(s, 'substituted bundle');
  assert.equal(r.code, 1); assert.match(r.err, /refused agent-tycoon-daemon-1\.0\.0-.*: SHA-256 [0-9a-f]{64} does not match [0-9a-f]{64}; nothing was unpacked/);

  const damaged = release('1.0.0');
  const bytes = fs.readFileSync(damaged.bundle); bytes[bytes.length >> 1] ^= 0xff; fs.writeFileSync(damaged.bundle, bytes);
  r = await s.installSh(damaged);
  assert.equal(r.code, 1); assert.match(r.err, /SHA-256 .* does not match .*nothing was unpacked/);
  nothingInstalled(s, 'damaged bundle');

  r = await s.installSh(release('1.0.0', { key: EVIL }));
  assert.equal(r.code, 1); assert.match(r.err, /SHA256SUMS\.sig is not a valid signature by --pub/);
  nothingInstalled(s, 'signed by another key');

  const edited = release('1.0.0'); const sub = substitute();
  fs.copyFileSync(sub.bundle, edited.bundle);
  fs.writeFileSync(path.join(edited.dir, 'SHA256SUMS'), fs.readFileSync(path.join(sub.dir, 'SHA256SUMS'))); // sums to match, the signature left as it was
  r = await s.installSh(edited);
  assert.equal(r.code, 1); assert.match(r.err, /SHA256SUMS\.sig is not a valid signature/);
  nothingInstalled(s, 'SHA256SUMS edited to match');

  r = await s.installSh(good); // and the real one installs
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal((await s.health())?.version, '1.0.0');
});

test('INSTALL-14: a stamped install.sh refuses a substituted download and installs the real one', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i14-stamped'); t.after(() => s.cleanup());
  const good = release('1.0.0');
  const target = `${OS}-${ARCH}`;
  const stamped = path.join(s.base, 'install.sh');
  fs.writeFileSync(stamped, stampInstallers({ sh: fs.readFileSync(INSTALL_SH, 'utf8'), ps1: fs.readFileSync(path.join(path.dirname(INSTALL_SH), 'install.ps1'), 'utf8'), version: '1.0.0', pubPem: KEY.pem, sumsText: fs.readFileSync(path.join(good.dir, 'SHA256SUMS'), 'utf8'), targets: [target] }).sh);
  const args = (url) => [stamped, '--base-url', url, '--insecure-localhost', '--yes', '--gui', 'no', '--launch', 'no', '--port', String(s.port)];

  const bad = release('1.0.0'); fs.copyFileSync(substitute().bundle, bad.bundle); // the server's files replaced
  const evil = await serve(bad.dir); t.after(() => evil.close());
  let r = await s.run('sh', args(evil.url));
  assert.equal(r.code, 1); assert.match(r.err, /SHA-256 .* does not match .*nothing was unpacked/);
  nothingInstalled(s, 'stamped, substituted download');

  const web = await serve(good.dir); t.after(() => web.close());
  r = await s.run('sh', args(web.url));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal((await s.health())?.version, '1.0.0');
  assert.equal(fs.readFileSync(path.join(s.root, 'release.pub'), 'utf8').trim(), KEY.pem.trim(), 'the stamped key is pinned');
});

test('INSTALL-14: a desktop installer that does not match the signed SHA256SUMS is not run', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i14-desktop'); t.after(() => s.cleanup());
  const SETUP = 'Pixel.Office_1.0.0_x64-setup.exe';
  const rel = release('1.0.0', { extra: { [SETUP]: [`#!/bin/sh\nprintf 'setup.exe\\t%s\\n' "$*" >>"$AT_TEST_CTL/calls.log"\n`, 0o755] } });
  fs.appendFileSync(path.join(rel.dir, SETUP), `# ${crypto.randomUUID()}\n`);
  const r = await s.installSh(rel, ['--yes', '--gui', 'yes', '--launch', 'no', '--port', String(s.port)], { defaults: false });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /desktop app not installed: .*SHA-256 does not match the signed SHA256SUMS; not run/);
  // P7 (one host per Windows user) asks cmd.exe for %LOCALAPPDATA% to find a Windows-side install: not the installer.
  const hostLookup = (c) => c[0] === 'cmd.exe' && /\becho %LOCALAPPDATA%/.test(c.slice(1).join(' '));
  assert.equal(s.calls().filter((c) => (c[0] === 'setup.exe' || c[0] === 'cmd.exe') && !hostLookup(c)).length, 0, 'the installer never ran');
  assert.equal((await s.health())?.version, '1.0.0', 'the daemon is installed all the same');
});
