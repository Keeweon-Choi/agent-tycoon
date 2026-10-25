import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundleTable, RELEASE_BASE_URL, stampInstallers, TARGETS } from './stamp-installers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SH = fs.readFileSync(path.join(ROOT, 'cld', 'install', 'install.sh'), 'utf8');
const PS1 = fs.readFileSync(path.join(ROOT, 'cld', 'install', 'install.ps1'), 'utf8');
const VERSION = '1.2.3-rc.1';
const pubPem = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sums = (version = VERSION, targets = TARGETS) => targets.map((t) => `${hash(t)}  agent-tycoon-daemon-${version}-${t}.tar.gz\n`).join('');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-test-'));

test('stamping fills every placeholder of both scripts and leaves none', () => {
  assert.match(SH, /@@BUNDLES@@/); assert.match(PS1, /@@INSTALL_SH_SHA256@@/);
  const extra = `${'f'.repeat(64)}  agent-tycoon-daemon-0.9.0-linux-x64.tar.gz\n${'e'.repeat(64)}  pixel-office_1.2.3_amd64.AppImage\n`;
  const { sh, ps1 } = stampInstallers({ sh: SH, ps1: PS1, version: VERSION, pubPem, sumsText: extra + sums() });
  for (const out of [sh, ps1]) {
    assert.doesNotMatch(out, /@@[A-Z0-9_]+@@/);
    assert.ok(out.includes(RELEASE_BASE_URL.replace('{version}', VERSION)));
    assert.ok(out.includes(pubPem.trim()));
    for (const t of TARGETS) assert.ok(out.includes(`${hash(t)}  agent-tycoon-daemon-${VERSION}-${t}.tar.gz`), t);
    assert.ok(!out.includes('0.9.0'), 'only this version\'s bundles');
    assert.ok(!out.includes('AppImage'), 'desktop artifacts are checked by the wizard against the signed list');
  }
  assert.doesNotMatch(PS1 + ps1, /[^\x00-\x7F]/, 'install.ps1 stays ASCII: Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page');
  assert.match(sh, /^AT_STAMPED='1'$/m);
  assert.match(ps1, /\$stamped = '1' -eq '1'/);
  assert.match(PS1, /^& \{$/m); assert.match(PS1, /\n\} @args\s*$/, 'one script block: nothing stays in the caller\'s session after irm | iex');
  assert.ok(ps1.includes(`'${hash(sh)}'`), 'install.ps1 carries the hash of the install.sh it runs in WSL');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'install.sh'), sh);
  assert.equal(spawnSync('sh', ['-n', path.join(dir, 'install.sh')]).status, 0);
});

test('stamping refuses a SHA256SUMS without the bundles it needs, a non-https URL, and a key that is not Ed25519', () => {
  assert.throws(() => bundleTable(sums(VERSION, ['linux-x64']), VERSION), /0 bundles for linux-arm64 of 1\.2\.3-rc\.1/);
  assert.throws(() => bundleTable(sums('1.0.0'), VERSION), /0 bundles for linux-x64/);
  assert.throws(() => bundleTable(sums() + `${'0'.repeat(64)}  agent-tycoon-daemon-${VERSION}-win-x64.tar.zst\n`, VERSION), /2 bundles for win-x64/);
  assert.equal(bundleTable(sums(VERSION, ['linux-x64']), VERSION, ['linux-x64']).split('\n').length, 1);
  const base = { sh: SH, ps1: PS1, version: VERSION, pubPem, sumsText: sums() };
  assert.throws(() => stampInstallers({ ...base, baseUrl: 'http://example.com/r' }), /must be https/);
  assert.throws(() => stampInstallers({ ...base, baseUrl: "https://example.com/r'; rm -rf ~; '" }), /must be https and plain/);
  assert.throws(() => stampInstallers({ ...base, pubPem: crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }) }), /not Ed25519/);
  assert.throws(() => stampInstallers({ ...base, sh: `${SH}@@NEW_THING@@` }), /no value for @@NEW_THING@@/);
});

// The shell side of the trust model, without a real bundle: a fake one whose "node" is a shell script.
const machine = `${process.platform}-${{ x64: 'x64', arm64: 'arm64' }[process.arch]}`;
const NAME = `agent-tycoon-daemon-${VERSION}-${machine}.tar.gz`;
const posixOnly = { skip: process.platform === 'win32' };
const opensslEd25519 = spawnSync('sh', ['-c', 'openssl pkeyutl -help 2>&1 | grep -q -- -rawin']).status === 0;
const which = (tool) => spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
const stubDir = (scripts) => {
  const dir = tmp();
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
};
const run = (script, args, { pathPrefix = [], pathOnly = null, tmpdir = tmp(), pipe = null } = {}) => {
  const env = { PATH: pathOnly ?? [...pathPrefix, process.env.PATH].join(':'), HOME: tmp(), TMPDIR: tmpdir };
  if (pipe) return spawnSync('/bin/sh', ['-c', `/bin/sh "$0" "$@" | ${pipe}`, script, ...args], { encoding: 'utf8', stdin: 'ignore', env });
  return spawnSync('/bin/sh', [script, ...args], { encoding: 'utf8', stdin: 'ignore', env });
};
/** A release folder: a fake bundle (its node prints BUNDLE NODE RAN), SHA256SUMS, a signature by `signer`, and `pub` (the key the user trusts). */
function fakeRelease({ signer, trusted = signer, name = NAME, content = null } = {}) {
  const folder = tmp();
  const stage = tmp();
  fs.mkdirSync(path.join(stage, 'node', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'node', 'bin', 'node'), '#!/bin/sh\necho "BUNDLE NODE RAN $*"\n', { mode: 0o755 });
  fs.mkdirSync(path.join(stage, 'cld', 'install'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'cld', 'install', 'wizard.mjs'), '');
  fs.mkdirSync(path.join(stage, 'core'));
  fs.writeFileSync(path.join(stage, 'package.json'), '{}');
  assert.equal(spawnSync('tar', ['-czf', path.join(folder, name), '-C', stage, 'node', 'cld', 'core', 'package.json']).status, 0);
  if (content !== null) fs.writeFileSync(path.join(folder, name), content);
  const sums = `${hash(fs.readFileSync(path.join(folder, name)))}  ${name}\n`;
  fs.writeFileSync(path.join(folder, 'SHA256SUMS'), sums);
  if (signer) fs.writeFileSync(path.join(folder, 'SHA256SUMS.sig'), crypto.sign(null, Buffer.from(sums), signer.privateKey));
  fs.writeFileSync(path.join(folder, 'k.pub'), trusted.publicKey.export({ type: 'spki', format: 'pem' }));
  return { folder, pub: path.join(folder, 'k.pub'), sums };
}
const UNSTAMPED = path.join(ROOT, 'cld', 'install', 'install.sh');
const ed = () => crypto.generateKeyPairSync('ed25519');

test('install.sh: the unstamped copy downloads nothing; a stamped one refuses a bundle that does not match, and plain http', posixOnly, () => {
  let r = run(UNSTAMPED, ['--yes']);
  assert.equal(r.status, 1); assert.match(r.stderr, /not stamped by a release, so it downloads nothing/);
  r = run(UNSTAMPED, ['--base-url', 'https://example.com/r']);
  assert.equal(r.status, 1); assert.match(r.stderr, /downloads nothing/);

  const rel = fakeRelease({ signer: ed() });
  const dir = tmp();
  const { sh } = stampInstallers({ sh: SH, ps1: PS1, version: VERSION, pubPem, sumsText: rel.sums, targets: [machine] });
  fs.writeFileSync(path.join(dir, 'install.sh'), sh);
  fs.appendFileSync(path.join(rel.folder, NAME), 'x'); // one byte more than the stamped table says
  r = run(path.join(dir, 'install.sh'), ['--from', rel.folder]);
  assert.equal(r.status, 1); assert.match(r.stderr, /does not match .*nothing was unpacked/); assert.doesNotMatch(r.stdout, /BUNDLE NODE RAN/);
  r = run(path.join(dir, 'install.sh'), ['--base-url', 'http://example.com/r']);
  assert.equal(r.status, 1); assert.match(r.stderr, /refusing http:\/\/example\.com\/r/);
  r = run(path.join(dir, 'install.sh'), ['--base-url', 'http://127.0.0.1:1']);
  assert.equal(r.status, 1); assert.match(r.stderr, /only to 127\.0\.0\.1\/localhost with --insecure-localhost/);
  r = run(path.join(dir, 'install.sh'), ['--base-url', 'http://127.0.0.1:1@evil.example', '--insecure-localhost']);
  assert.equal(r.status, 1); assert.match(r.stderr, /user info/);
  for (const flag of ['--bundle', '--sums', '--sig', '--wsl-installer']) {
    r = run(path.join(dir, 'install.sh'), [flag, '/tmp/x', '--from', rel.folder]);
    assert.equal(r.status, 1, flag); assert.match(r.stderr, new RegExp(`${flag} is set by install.sh itself`));
  }
});

test('install.sh --from --pub (unstamped): SHA256SUMS.sig is checked with --pub before anything runs; a signed folder is handed over', { skip: posixOnly.skip || !opensslEd25519 }, () => {
  const owner = ed();
  // The verifier's case: a bundle whose own node would run, listed in SHA256SUMS, signed by someone else.
  let rel = fakeRelease({ signer: ed(), trusted: owner });
  let r = run(UNSTAMPED, ['--from', rel.folder, '--pub', rel.pub, '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SHA256SUMS\.sig is not a valid signature by --pub .*nothing was unpacked/);
  assert.doesNotMatch(r.stdout + r.stderr, /BUNDLE NODE RAN/);
  rel = fakeRelease({ signer: null, trusted: owner }); // no signature at all
  r = run(UNSTAMPED, ['--from', rel.folder, '--pub', rel.pub]);
  assert.equal(r.status, 1); assert.match(r.stderr, /SHA256SUMS\.sig is missing/); assert.doesNotMatch(r.stdout, /BUNDLE NODE RAN/);

  rel = fakeRelease({ signer: owner });
  const tmpdir = tmp();
  r = run(UNSTAMPED, ['--from', rel.folder, '--pub', rel.pub, '--yes', '--gui', 'no'], { tmpdir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SHA256SUMS\.sig was checked with --pub/);
  assert.match(r.stdout, new RegExp(`BUNDLE NODE RAN .*--bundle ${rel.folder}/${NAME} --pub ${rel.pub} --yes --gui no`));
  assert.deepEqual(fs.readdirSync(tmpdir), [], 'the temp dir is removed');
});

test('install.sh --from --pub: no openssl (or one without Ed25519) is a refusal, not a silent fallback', posixOnly, () => {
  const bin = tmp();
  for (const tool of ['uname', 'grep', 'cat', 'cut']) fs.symlinkSync(which(tool), path.join(bin, tool));
  const rel = fakeRelease({ signer: ed() });
  let r = run(UNSTAMPED, ['--from', rel.folder, '--pub', rel.pub], { pathOnly: bin });
  assert.equal(r.status, 1); assert.match(r.stderr, /openssl \(OpenSSL 3\) is needed .*nothing was unpacked/); assert.doesNotMatch(r.stdout, /BUNDLE NODE RAN/);
  fs.writeFileSync(path.join(bin, 'openssl'), '#!/bin/sh\necho "LibreSSL 3.3.6"; echo "usage: pkeyutl [-in file]"\n', { mode: 0o755 });
  r = run(UNSTAMPED, ['--from', rel.folder, '--pub', rel.pub], { pathOnly: bin });
  assert.equal(r.status, 1); assert.match(r.stderr, /cannot check Ed25519 signatures/);
});

test('install.sh: output piped into head -1 (SIGPIPE) still removes the temp dir', { skip: posixOnly.skip || !opensslEd25519 }, () => {
  const rel = fakeRelease({ signer: ed() });
  const slow = stubDir({ sha256sum: `sleep 1; exec ${which('sha256sum')} "$@"` }); // head is gone before the next line is written
  const tmpdir = tmp();
  const r = run(UNSTAMPED, ['--from', rel.folder, '--pub', rel.pub], { pathPrefix: [slow], tmpdir, pipe: 'head -1' });
  assert.match(r.stdout, /unstamped install\.sh/);
  assert.deepEqual(fs.readdirSync(tmpdir).filter((n) => n.startsWith('agent-tycoon-install.')), []);
});

test('install.sh on macOS under Rosetta (x86_64 shell, sysctl.proc_translated = 1) takes the arm64 bundle', posixOnly, () => {
  const sumsText = ['darwin-arm64', 'darwin-x64'].map((t) => `${hash(t)}  agent-tycoon-daemon-${VERSION}-${t}.tar.gz\n`).join('');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'install.sh'), stampInstallers({ sh: SH, ps1: PS1, version: VERSION, pubPem, sumsText, targets: ['darwin-arm64', 'darwin-x64'] }).sh);
  const folder = tmp();
  for (const t of ['darwin-arm64', 'darwin-x64']) fs.writeFileSync(path.join(folder, `agent-tycoon-daemon-${VERSION}-${t}.tar.gz`), 'not it');
  const mac = (translated) => stubDir({ uname: 'case $1 in -s) echo Darwin ;; -m) echo x86_64 ;; esac', sysctl: `echo ${translated}` });
  let r = run(path.join(dir, 'install.sh'), ['--from', folder], { pathPrefix: [mac(1)] });
  assert.equal(r.status, 1); assert.match(r.stderr, /refused agent-tycoon-daemon-\S+-darwin-arm64\.tar\.gz: SHA-256/);
  r = run(path.join(dir, 'install.sh'), ['--from', folder], { pathPrefix: [mac(0)] });
  assert.equal(r.status, 1); assert.match(r.stderr, /refused agent-tycoon-daemon-\S+-darwin-x64\.tar\.gz: SHA-256/);
});
