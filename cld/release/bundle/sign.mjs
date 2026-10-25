#!/usr/bin/env node
// Write SHA256SUMS for daemon bundles and sign it (format: see verify.mjs).
//
//   node sign.mjs <dir> [--key <private key PEM file>]
//
// Signs every agent-tycoon-daemon-* bundle in <dir> (the release job, after the matrix
// builds). The key is PKCS#8 PEM Ed25519, from $AGENT_TYCOON_SIGNING_KEY (CI secret) or
// --key. Writes SHA256SUMS, SHA256SUMS.sig and agent-tycoon-release.pub into <dir>.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLE_RE, sha256File } from './verify.mjs';

export const SUMS = 'SHA256SUMS';
export const SIG = 'SHA256SUMS.sig';
export const PUB = 'agent-tycoon-release.pub';

/** The release key from $AGENT_TYCOON_SIGNING_KEY or a PEM file; null when neither is set. */
export function loadSigningKey(keyFile) {
  const pem = process.env.AGENT_TYCOON_SIGNING_KEY || (keyFile && fs.readFileSync(keyFile, 'utf8'));
  if (!pem) return null;
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('signing key is not Ed25519');
  return key;
}

/** A throwaway key for local builds, kept beside the build output (never committed). */
export function devSigningKey(dir) {
  const file = path.join(dir, 'dev-signing-key.pem');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return crypto.createPrivateKey(fs.readFileSync(file));
}

export function writeSumsAndSign(dir, names, key) {
  const sums = [...names]
    .sort()
    .map((name) => `${sha256File(path.join(dir, name))}  ${name}\n`)
    .join('');
  fs.writeFileSync(path.join(dir, SUMS), sums);
  fs.writeFileSync(path.join(dir, SIG), crypto.sign(null, Buffer.from(sums), key));
  fs.writeFileSync(
    path.join(dir, PUB),
    crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--key');
  const keyFile = i < 0 ? undefined : args.splice(i, 2)[1];
  const [dir] = args;
  const key = dir && loadSigningKey(keyFile);
  if (!key) {
    console.error('usage: sign.mjs <dir> [--key file] (or $AGENT_TYCOON_SIGNING_KEY)');
    process.exit(2);
  }
  const names = fs.readdirSync(dir).filter((n) => BUNDLE_RE.test(n));
  if (!names.length) {
    console.error(`no agent-tycoon-daemon bundles in ${dir}`);
    process.exit(1);
  }
  // A release-notes.txt beside the bundles is signed too: the update notice shows it only when its hash is in the signed list.
  writeSumsAndSign(dir, fs.existsSync(path.join(dir, 'release-notes.txt')) ? [...names, 'release-notes.txt'] : names, key);
  console.log(`signed ${SUMS} for ${names.length} bundle(s): ${names.join(', ')}`);
}
