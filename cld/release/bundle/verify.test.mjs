// node --test cld/release/bundle/verify.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PUB, SIG, SUMS, writeSumsAndSign } from './sign.mjs';
import { verifyBundle } from './verify.mjs';

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
