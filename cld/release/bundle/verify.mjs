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
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const BUNDLE_RE =
  /^agent-tycoon-daemon-(.+)-(linux|darwin|win)-(x64|arm64)\.(tar\.zst|tar\.gz)$/;

// Stable manager-to-GUI progress protocol. Keep this Korean, line-oriented shape: the
// desktop installer parses it while `tar -xvf` and manifest hashing are in progress.
export const BUNDLE_PROGRESS_RE = /^… (풀기|확인) (\d+)\/(\d+) \((\d+)%\)$/;

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

/** The entries `tar -xvf` lists, counted directly from the uncompressed tar headers. */
export function tarEntryCount(tar) {
  let count = 0;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('malformed tar header');
    // PAX and GNU metadata headers describe the following path but are not printed by -v.
    if (!['g', 'x', 'L', 'K'].includes(header.subarray(156, 157).toString('ascii'))) count += 1;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return count;
}

/** Prints a progress line at roughly 2% intervals and always once at completion. */
export function bundleProgress(phase, total, print = console.log) {
  let last = -2;
  return (done) => {
    const percent = total === 0 ? 100 : Math.floor((done * 100) / total);
    if ((percent === 100 && last !== 100) || percent - last >= 2) {
      print(`… ${phase} ${done}/${total} (${percent}%)`);
      last = percent;
    }
  };
}

/** Unpack a VERIFIED bundle into an empty dir, then check it against its manifest.json. */
export async function extractBundle(bundle, dest, expect, { print = console.log } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  if (fs.readdirSync(dest).length) throw new Error(`${dest} is not empty`);
  const packed = fs.readFileSync(bundle);
  const tar = bundle.endsWith('.tar.zst')
    ? zlib.zstdDecompressSync(packed)
    : zlib.gunzipSync(packed);
  const tmp = path.join(dest, '.bundle.tar');
  fs.writeFileSync(tmp, tar);
  // Relative paths only: GNU tar (Git Bash on Windows) reads "C:\\..." as a remote host.
  const entryCount = tarEntryCount(tar);
  const extracted = bundleProgress('풀기', entryCount, print);
  try {
    await new Promise((resolve, reject) => {
      // GNU tar lists -v names on stdout, bsdtar (Windows tar.exe, macOS) on stderr: count both
      // (measured on Windows 11: stdout empty, stderr "x a/one.txt"), and keep stderr's tail for an error.
      const child = spawn('tar', ['-xvf', '.bundle.tar'], { cwd: dest, stdio: ['ignore', 'pipe', 'pipe'] });
      let extractedCount = 0;
      const tail = [];
      const counter = () => {
        let pending = '';
        return {
          data: (chunk) => {
            pending += chunk;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();
            for (const line of lines) if (line) count(line);
          },
          end: () => { if (pending) count(pending); pending = ''; },
        };
      };
      const count = (line) => {
        tail.push(line);
        if (tail.length > 20) tail.shift();
        extracted(Math.min(++extractedCount, entryCount));
      };
      const out = counter();
      const err = counter();
      child.stdout.on('data', out.data);
      child.stderr.on('data', err.data);
      child.on('error', reject);
      child.on('close', (status) => {
        out.end();
        err.end();
        if (status === 0) { extracted(entryCount); resolve(); }
        else reject(new Error(`tar -xf failed (exit ${status}): ${tail.slice(-5).join(' | ')}`));
      });
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }

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
  const files = Object.entries(manifest.files);
  const checked = bundleProgress('확인', files.length, print);
  for (const [index, [rel, hash]] of files.entries()) {
    if (sha256File(path.join(dest, rel)) !== hash)
      throw new Error(`${rel}: hash does not match manifest.json`);
    checked(index + 1);
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
      const manifest = await extractBundle(bundle, extract, ok);
      console.log(
        `OK extracted to ${extract}: ${Object.keys(manifest.files).length} files match manifest.json`,
      );
    }
  } catch (err) {
    console.error(`REFUSED ${path.basename(bundle)}: ${err.message}`);
    process.exit(1);
  }
}
