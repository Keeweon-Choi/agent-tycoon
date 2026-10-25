#!/usr/bin/env node
// Verify a daemon bundle before it is used (P1; the manager and install scripts reuse this).
//
//   node verify.mjs <bundle> <SHA256SUMS> <SHA256SUMS.sig> <public key> [--os <os>] [--arch <arch>] [--extract <dir>]
//
// Signature format (sign.mjs writes it): a detached Ed25519 signature, the raw 64 bytes,
// over the exact bytes of SHA256SUMS, made with Node's crypto.sign(null, data, key). The
// public key is an SPKI PEM file. Not minisign: one format on every build host, with no
// external tool. The same signature checks with OpenSSL 3:
//   openssl pkeyutl -verify -pubin -inkey agent-tycoon-release.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
//
// Refuses (exit 1) unless: the signature is valid for that key, the bundle's file name is
// listed exactly once in SHA256SUMS, its SHA-256 matches, and the os/arch in its name
// match this machine (or --os/--arch). --extract <dir> then unpacks it into an empty dir
// and checks every file against the bundle's manifest.json.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const BUNDLE_RE =
  /^agent-tycoon-daemon-(.+)-(linux|darwin|win)-(x64|arm64)\.(tar\.zst|tar\.gz)$/;

export const currentOs = () => (process.platform === 'win32' ? 'win' : process.platform);

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;)
      hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** The signature check alone (update --check reads SHA256SUMS only after it); returns its bytes. */
export function verifySums({ sums, sig, pubkey }) {
  const key = crypto.createPublicKey(fs.readFileSync(pubkey));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('public key is not Ed25519');
  const sumsBuf = fs.readFileSync(sums);
  const sigBuf = fs.readFileSync(sig);
  if (sigBuf.length !== 64 || !crypto.verify(null, sumsBuf, key, sigBuf)) {
    throw new Error('SHA256SUMS signature is not valid for this key');
  }
  return sumsBuf;
}

/** Throws an Error naming the reason; returns { version, os, arch } when the bundle is good. */
export function verifyBundle({ bundle, sums, sig, pubkey, os = currentOs(), arch = process.arch }) {
  const sumsBuf = verifySums({ sums, sig, pubkey });

  const name = path.basename(bundle);
  const entries = sumsBuf
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
      if (!m) throw new Error(`malformed SHA256SUMS line: ${JSON.stringify(line)}`);
      return { hash: m[1], file: m[2] };
    })
    .filter((e) => e.file === name);
  if (entries.length !== 1) throw new Error('not listed exactly once in SHA256SUMS');
  if (sha256File(bundle) !== entries[0].hash) throw new Error('SHA-256 does not match SHA256SUMS');

  const m = BUNDLE_RE.exec(name);
  if (!m) throw new Error('not a daemon bundle file name');
  if (m[2] !== os || m[3] !== arch)
    throw new Error(`built for ${m[2]}-${m[3]}, this machine is ${os}-${arch}`);
  return { version: m[1], os: m[2], arch: m[3] };
}

/** Unpack a VERIFIED bundle into an empty dir, then check it against its manifest.json. */
export function extractBundle(bundle, dest, expect) {
  fs.mkdirSync(dest, { recursive: true });
  if (fs.readdirSync(dest).length) throw new Error(`${dest} is not empty`);
  const packed = fs.readFileSync(bundle);
  const tar = bundle.endsWith('.tar.zst')
    ? zlib.zstdDecompressSync(packed)
    : zlib.gunzipSync(packed);
  const tmp = path.join(dest, '.bundle.tar');
  fs.writeFileSync(tmp, tar);
  // Relative paths only: GNU tar (Git Bash on Windows) reads "C:\..." as a remote host.
  const r = spawnSync('tar', ['-xf', '.bundle.tar'], { cwd: dest, stdio: 'inherit' });
  fs.rmSync(tmp);
  if (r.status !== 0) throw new Error(`tar -xf failed (${r.error?.message ?? `exit ${r.status}`})`);

  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
  if (
    manifest.version !== expect.version ||
    manifest.os !== expect.os ||
    manifest.arch !== expect.arch
  ) {
    throw new Error(
      `manifest.json says ${manifest.version} ${manifest.os}-${manifest.arch}, the file name does not`,
    );
  }
  for (const [rel, hash] of Object.entries(manifest.files)) {
    if (sha256File(path.join(dest, rel)) !== hash)
      throw new Error(`${rel}: hash does not match manifest.json`);
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const os = opt('--os');
  const arch = opt('--arch');
  const extract = opt('--extract');
  const [bundle, sums, sig, pubkey] = args;
  if (!pubkey) {
    console.error(
      'usage: verify.mjs <bundle> <SHA256SUMS> <sig> <pubkey> [--os os] [--arch arch] [--extract dir]',
    );
    process.exit(2);
  }
  try {
    const ok = verifyBundle({ bundle, sums, sig, pubkey, os, arch });
    console.log(
      `OK ${path.basename(bundle)}: signature, SHA-256 and ${ok.os}-${ok.arch} match (version ${ok.version})`,
    );
    if (extract) {
      const manifest = extractBundle(bundle, extract, ok);
      console.log(
        `OK extracted to ${extract}: ${Object.keys(manifest.files).length} files match manifest.json`,
      );
    }
  } catch (err) {
    console.error(`REFUSED ${path.basename(bundle)}: ${err.message}`);
    process.exit(1);
  }
}
