// node --test cld/release/bundle/verify.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { PUB, SIG, SUMS, writeSumsAndSign } from './sign.mjs';
import { BUNDLE_PROGRESS_RE, extractBundle, sha256File, verifyBundle } from './verify.mjs';

test('verifyBundle accepts a signed bundle and refuses tampering, a wrong key and a wrong platform', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-verify-'));
  const name = 'agent-tycoon-daemon-0.1.0-rc.1-linux-x64.tar.zst';
  const bundle = path.join(dir, name);
  fs.writeFileSync(bundle, crypto.randomBytes(4096));
  writeSumsAndSign(dir, [name], crypto.generateKeyPairSync('ed25519').privateKey);
  const files = {
    bundle,
    sums: path.join(dir, SUMS),
    sig: path.join(dir, SIG),
    pubkey: path.join(dir, PUB),
  };

  assert.deepEqual(verifyBundle({ ...files, os: 'linux', arch: 'x64' }), {
    version: '0.1.0-rc.1',
    os: 'linux',
    arch: 'x64',
  });
  assert.throws(() => verifyBundle({ ...files, os: 'darwin', arch: 'x64' }), /built for linux-x64/);

  const wrongPub = path.join(dir, 'wrong.pub');
  fs.writeFileSync(
    wrongPub,
    crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }),
  );
  assert.throws(
    () => verifyBundle({ ...files, pubkey: wrongPub, os: 'linux', arch: 'x64' }),
    /signature/,
  );

  const sums = fs.readFileSync(files.sums, 'utf8');
  fs.writeFileSync(
    files.sums,
    sums.replace(/^./, (c) => (c === '0' ? '1' : '0')),
  );
  assert.throws(() => verifyBundle({ ...files, os: 'linux', arch: 'x64' }), /signature/);
  fs.writeFileSync(files.sums, sums);

  const bytes = fs.readFileSync(bundle);
  bytes[100] ^= 1;
  fs.writeFileSync(bundle, bytes);
  assert.throws(
    () => verifyBundle({ ...files, os: 'linux', arch: 'x64' }),
    /SHA-256 does not match/,
  );
  fs.rmSync(dir, { recursive: true });
});

test('extractBundle reports unpacking and manifest checks in the stable progress shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-extract-'));
  const stage = path.join(dir, 'stage');
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'bin', 'daemon'), 'daemon');
  fs.writeFileSync(path.join(stage, 'README'), 'small bundle');
  const files = Object.fromEntries(['bin/daemon', 'README'].map((rel) => [rel, sha256File(path.join(stage, rel))]));
  const expect = { version: '0.1.0', os: 'linux', arch: 'x64' };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ ...expect, files }));
  const tar = path.join(dir, 'bundle.tar');
  assert.equal(spawnSync('tar', ['-cf', tar, '-C', stage, '.']).status, 0);
  const bundle = path.join(dir, 'bundle.tar.gz');
  fs.writeFileSync(bundle, zlib.gzipSync(fs.readFileSync(tar)));

  const lines = [];
  const dest = path.join(dir, 'dest');
  const manifest = await extractBundle(bundle, dest, expect, { print: (line) => lines.push(line) });
  const unpacked = lines.filter((line) => line.includes(' 풀기 '));
  const checked = lines.filter((line) => line.includes(' 확인 '));
  assert.ok(unpacked.length > 0);
  assert.ok(checked.length > 0);
  assert.match(unpacked.at(-1), /풀기 \d+\/\d+ \(100%\)$/);
  assert.match(checked.at(-1), /확인 2\/2 \(100%\)$/);
  assert.deepEqual(lines.map((line) => BUNDLE_PROGRESS_RE.test(line)), Array(lines.length).fill(true));
  assert.ok(lines.indexOf(unpacked.at(-1)) < lines.indexOf(checked[0]));
  assert.deepEqual(manifest.files, files);
  assert.equal(fs.readFileSync(path.join(dest, 'bin', 'daemon'), 'utf8'), 'daemon');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractBundle counts a listing on stderr too (Windows tar.exe and macOS bsdtar list -v names there)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-stderr-'));
  const stage = path.join(dir, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  const names = Array.from({ length: 60 }, (_, i) => `f${i}.txt`);
  for (const name of names) fs.writeFileSync(path.join(stage, name), name);
  const expect = { version: '0.1.0', os: 'linux', arch: 'x64' };
  const files = Object.fromEntries(names.map((name) => [name, sha256File(path.join(stage, name))]));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ ...expect, files }));
  const tar = path.join(dir, 'bundle.tar');
  assert.equal(spawnSync('tar', ['-cf', tar, '-C', stage, '.']).status, 0);
  const bundle = path.join(dir, 'bundle.tar.gz');
  fs.writeFileSync(bundle, zlib.gzipSync(fs.readFileSync(tar)));
  // a tar that lists on stderr, as bsdtar does
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'tar'), `#!/bin/sh\n"${realTar}" "$@" 1>&2\n`, { mode: 0o755 });
  const keep = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${keep}`;
  const lines = [];
  try {
    await extractBundle(bundle, path.join(dir, 'dest'), expect, { print: (line) => lines.push(line) });
  } finally {
    process.env.PATH = keep;
  }
  const before = lines.filter((line) => line.includes(' 풀기 ') && !line.endsWith('(100%)'));
  assert.ok(before.length >= 3, `unpacking moved before the end:\n${lines.join('\n')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
