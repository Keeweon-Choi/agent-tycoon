#!/usr/bin/env node
// Stamp the one-line installers for a release (P4; trust model: cld/INSTALL.md, H §5.4).
//
//   node cld/release/stamp-installers.mjs --release <dir> [--out <dir>] [--base-url <url>] [--targets linux-x64,...] [--version <v>]
//
// cld/install/install.sh and install.ps1 are templates. This fills in the version, the release base URL,
// the release public key (<dir>/agent-tycoon-release.pub) and the SHA-256 of every daemon bundle of that
// version listed in <dir>/SHA256SUMS; install.ps1 also gets the SHA-256 of the stamped install.sh (what it
// runs inside a WSL distro). The scripts check the bundle against this table before unpacking anything,
// so the trust root is the script itself, not the download. Writes <out>/install.sh and <out>/install.ps1.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLE_RE } from './bundle/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** ponytail: placeholder until the public repository exists (P9); the one place the release URL is set. */
export const RELEASE_BASE_URL = 'https://github.com/agent-tycoon/agent-tycoon/releases/download/v{version}';
export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win-x64'];
const PLACEHOLDER = /@@[A-Z0-9_]+@@/g;

/** The SHA256SUMS lines of `version`'s bundles, exactly one per target; throws naming what is missing. */
export function bundleTable(sumsText, version, targets = TARGETS) {
  const lines = sumsText.split('\n').filter(Boolean);
  const table = [];
  for (const target of targets) {
    const found = lines.filter((line) => {
      const m = /^[0-9a-f]{64} {2}(\S+)$/.exec(line);
      const b = m && BUNDLE_RE.exec(m[1]);
      return b && b[1] === version && `${b[2]}-${b[3]}` === target;
    });
    if (found.length !== 1) throw new Error(`SHA256SUMS lists ${found.length} bundles for ${target} of ${version}; needs exactly one (agent-tycoon-daemon-${version}-${target}.tar.gz)`);
    table.push(found[0]);
  }
  return table.join('\n');
}

const fill = (template, values) => {
  const out = template.replace(PLACEHOLDER, (p) => { if (!(p in values)) throw new Error(`no value for ${p}`); return values[p]; });
  const left = out.match(PLACEHOLDER);
  if (left) throw new Error(`placeholders left: ${left.join(', ')}`);
  return out;
};

/** { sh, ps1 } stamped for one release. Pure apart from parsing the key. */
export function stampInstallers({ sh, ps1, version, baseUrl = RELEASE_BASE_URL.replace('{version}', version), pubPem, sumsText, targets = TARGETS }) {
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`not a version: ${version}`);
  if (!/^https:\/\/[^\s'"`$\\]+$/.test(baseUrl)) throw new Error(`the release base URL must be https and plain: ${baseUrl}`);
  const key = crypto.createPublicKey(pubPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the release key is not Ed25519');
  const values = {
    '@@STAMPED@@': '1',
    '@@VERSION@@': version,
    '@@BASE_URL@@': baseUrl.replace(/\/+$/, ''),
    '@@BUNDLES@@': bundleTable(sumsText, version, targets),
    '@@PUBKEY@@': key.export({ type: 'spki', format: 'pem' }).trim(),
  };
  const stampedSh = fill(sh, values);
  values['@@INSTALL_SH_SHA256@@'] = crypto.createHash('sha256').update(stampedSh).digest('hex');
  return { sh: stampedSh, ps1: fill(ps1, values) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const release = opt('--release');
  if (!release) { console.error('usage: stamp-installers.mjs --release <dir> [--out <dir>] [--base-url <url>] [--targets a,b] [--version <v>]'); process.exit(2); }
  try {
    const version = opt('--version') ?? JSON.parse(fs.readFileSync(path.join(ROOT, 'cld', 'release', 'version.json'), 'utf8')).version;
    const out = path.resolve(opt('--out') ?? release);
    const stamped = stampInstallers({
      sh: fs.readFileSync(path.join(ROOT, 'cld', 'install', 'install.sh'), 'utf8'),
      ps1: fs.readFileSync(path.join(ROOT, 'cld', 'install', 'install.ps1'), 'utf8'),
      version,
      baseUrl: opt('--base-url'),
      pubPem: fs.readFileSync(path.join(release, 'agent-tycoon-release.pub'), 'utf8'),
      sumsText: fs.readFileSync(path.join(release, 'SHA256SUMS'), 'utf8'),
      targets: opt('--targets')?.split(','),
    });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'install.sh'), stamped.sh, { mode: 0o755 });
    fs.writeFileSync(path.join(out, 'install.ps1'), stamped.ps1);
    console.log(`stamped install.sh and install.ps1 for ${version} in ${out}`);
  } catch (error) {
    console.error(`stamp failed: ${error.message}`);
    process.exit(1);
  }
}
