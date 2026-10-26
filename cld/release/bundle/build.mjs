#!/usr/bin/env node
// Build a self-contained daemon bundle (P1, F-21/F-22/F-25), for this platform or, with --target, another one.
//
//   node cld/release/bundle/build.mjs [--target <os>-<arch>] [--out <dir>] [--key <private key PEM>] [--skip-build]
//
// --target (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win-x64) cross-builds: the target's official Node
// goes in unrun, npm runs with this machine's Node and installs the target's prebuilt @lydell/node-pty
// (--os/--cpu), and the zip of a Windows Node is unpacked with `unzip` off Windows.
//
// Output in <dir> (default cld/release/bundle/out, git-ignored):
//   agent-tycoon-daemon-<version>-<os>-<arch>.tar.gz  (gzip: the install scripts unpack it with the system tar)
//   SHA256SUMS, SHA256SUMS.sig, agent-tycoon-release.pub   (format: verify.mjs)
// Bundle root: node/ (official Node, checked against nodejs.org SHASUMS256 and the hash
// pinned below), dist/, cld/bin/, cld/rules/ (the default agent rules), cld/install/ + verify.mjs + two core/src modules (the manager),
// cld/release/version.json, package.json, production
// node_modules/ (with this platform's @lydell/node-pty), manifest.json.
// Key: $AGENT_TYCOON_SIGNING_KEY or --key; neither -> a throwaway dev key in <dir>/dev-key/.
// Node downloads are cached in $AGENT_TYCOON_DOWNLOADS (default <dir>/downloads).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { devSigningKey, loadSigningKey, PUB, SIG, SUMS, writeSumsAndSign } from './sign.mjs';
import { currentOs, sha256File } from './verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NODE_VERSION = '22.23.4';
/** From https://nodejs.org/dist/v22.23.4/SHASUMS256.txt (fetched 2026-10-23). */
const NODE_SHA256 = {
  'linux-x64': [
    'node-v22.23.4-linux-x64.tar.xz',
    '1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce',
  ],
  'linux-arm64': [
    'node-v22.23.4-linux-arm64.tar.xz',
    '6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b',
  ],
  'darwin-x64': [
    'node-v22.23.4-darwin-x64.tar.gz',
    'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
  ],
  'darwin-arm64': [
    'node-v22.23.4-darwin-arm64.tar.gz',
    'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
  ],
  'win-x64': [
    'node-v22.23.4-win-x64.zip',
    'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20',
  ],
};

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const HOST = `${currentOs()}-${process.arch}`;
const TARGET = opt('--target') ?? HOST;
if (!NODE_SHA256[TARGET]) throw new Error(`--target ${TARGET}: one of ${Object.keys(NODE_SHA256).join(', ')}`);
const [OS, ARCH] = TARGET.split('-');
const WIN = OS === 'win';
const CROSS = TARGET !== HOST;
const OUT = path.resolve(opt('--out') ?? path.join(ROOT, 'cld', 'release', 'bundle', 'out'));
const DOWNLOADS = path.resolve(process.env.AGENT_TYCOON_DOWNLOADS || path.join(OUT, 'downloads'));

function run(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(' ')}`);
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.error?.message ?? `exit ${r.status}`})`);
}

async function download(url, dest) {
  if (fs.existsSync(dest)) return;
  console.log(`download ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${dest}.part`, dest);
}

/** Official Node for this platform, verified, unpacked into work/; returns its root dir. */
async function fetchNode(work) {
  const pinned = NODE_SHA256[TARGET];
  if (!pinned) throw new Error(`no pinned Node build for ${TARGET}`);
  const [file, sha] = pinned;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const archive = path.join(DOWNLOADS, file);
  const sums = path.join(DOWNLOADS, `SHASUMS256-v${NODE_VERSION}.txt`);
  await download(`${base}/SHASUMS256.txt`, sums);
  await download(`${base}/${file}`, archive);
  const listed = fs
    .readFileSync(sums, 'utf8')
    .split('\n')
    .find((l) => l.endsWith(`  ${file}`))
    ?.split(' ')[0];
  const actual = sha256File(archive);
  if (actual !== sha || listed !== sha) {
    fs.rmSync(archive); // a bad download is not kept for the next run
    throw new Error(`${file}: sha256 ${actual}, SHASUMS256 ${listed}, pinned ${sha}`);
  }
  console.log(`✓ ${file} matches SHASUMS256 and the pinned hash`);
  fs.mkdirSync(work, { recursive: true });
  if (WIN && process.platform !== 'win32') {
    run('unzip', ['-q', archive, '-d', work]);
  } else if (WIN) {
    run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${work}' -Force`,
    ]);
  } else {
    // Relative paths only, as when packing: GNU tar on Windows reads "D:" as a host name.
    run('tar', ['-xf', path.relative(work, archive).split(path.sep).join('/')], { cwd: work });
  }
  return path.join(work, file.replace(/\.(tar\.xz|tar\.gz|zip)$/, ''));
}

function walk(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => ({
      e,
      rel: path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'),
    }));
}

/** Drop what a runtime never needs: workspace links, .bin shims, empty dirs. */
function pruneNodeModules(dir) {
  for (const { e, rel } of walk(dir)) {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full) && !e.isSymbolicLink()) continue; // under a removed dir
    if (e.isSymbolicLink() || (e.isDirectory() && e.name === '.bin'))
      fs.rmSync(full, { recursive: true, force: true });
  }
  const removeEmpty = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) removeEmpty(full);
    }
    if (!fs.readdirSync(d).length) fs.rmdirSync(d);
  };
  removeEmpty(dir);
}

async function main() {
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'cld', 'release', 'version.json'), 'utf8'),
  );
  const protocol = Number(
    /SERVER_HEALTH_PROTOCOL_VERSION = (\d+)/.exec(
      fs.readFileSync(path.join(ROOT, 'server', 'src', 'constants.ts'), 'utf8'),
    )?.[1],
  );
  if (!protocol)
    throw new Error('SERVER_HEALTH_PROTOCOL_VERSION not found in server/src/constants.ts');

  const work = path.join(OUT, 'work', TARGET);
  const stage = path.join(OUT, 'stage', TARGET);
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(stage, { recursive: true, force: true });

  // 1. Official Node.
  const nodeSrc = await fetchNode(work);
  const nodeRel = WIN ? 'node/node.exe' : 'node/bin/node';
  fs.mkdirSync(path.dirname(path.join(stage, nodeRel)), { recursive: true });
  fs.copyFileSync(path.join(nodeSrc, WIN ? 'node.exe' : 'bin/node'), path.join(stage, nodeRel));
  fs.chmodSync(path.join(stage, nodeRel), 0o755);
  fs.copyFileSync(path.join(nodeSrc, 'LICENSE'), path.join(stage, 'node', 'LICENSE'));
  const pinnedNode = path.join(stage, nodeRel);
  const npmCli = path.join(
    nodeSrc,
    WIN ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js',
  );

  // 2. The daemon (dev dependencies of the checkout build it; they are not shipped).
  if (!args.includes('--skip-build')) {
    run(process.execPath, ['esbuild.js', '--production'], { cwd: ROOT });
    run(process.execPath, [npmCli, 'run', 'build:webview'], { cwd: ROOT });
  }
  fs.cpSync(path.join(ROOT, 'dist'), path.join(stage, 'dist'), {
    recursive: true,
    filter: (src) => !/[\\/]dist[\\/](extension|uninstall)\.js$|\.map$/.test(src),
  });
  fs.cpSync(path.join(ROOT, 'cld', 'bin'), path.join(stage, 'cld', 'bin'), {
    recursive: true,
    filter: (src) => !src.endsWith('.test.mjs'),
  });
  fs.cpSync(path.join(ROOT, 'cld', 'rules'), path.join(stage, 'cld', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'cld', 'release'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'cld', 'release', 'version.json'),
    path.join(stage, 'cld', 'release', 'version.json'),
  );
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(stage, 'package.json'));
  // The manager (P2, H §2.1) runs from the installed version with the private Node: cld/install
  // plus the dependency-free core modules it and cld/bin import, and the bundle verifier for updates.
  const manager = [
    ...fs
      .readdirSync(path.join(ROOT, 'cld', 'install'))
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
      .map((f) => `cld/install/${f}`),
    'cld/release/bundle/verify.mjs',
    'core/src/exposureLedger.mjs',
    'core/src/remoteSetupPlan.mjs',
    'core/src/cld/configPath.cjs',
  ];
  for (const rel of manager) {
    fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(stage, rel));
  }

  // 3. Production node_modules, exact versions from the lockfile, with the pinned Node's npm.
  //    The server workspace carries acme-client; its manifest is only needed for the install.
  const installOnly = ['package-lock.json', 'server/package.json', 'webview-ui/package.json'];
  for (const rel of installOnly) {
    fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(stage, rel));
  }
  // Cross: the target's Node cannot run here, so this machine's runs the target's npm; --os/--cpu pick
  // the target's optional prebuilds (@lydell/node-pty-<os>-<cpu>).
  run(
    CROSS ? process.execPath : pinnedNode,
    [
      npmCli,
      'ci',
      ...(CROSS ? [`--os=${WIN ? 'win32' : OS}`, `--cpu=${ARCH}`] : []),
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--workspace',
      'server',
      '--include-workspace-root',
    ],
    { cwd: stage, env: { ...process.env, HUSKY: '0' } },
  );
  for (const rel of ['package-lock.json', 'server', 'webview-ui'])
    fs.rmSync(path.join(stage, rel), { recursive: true });
  pruneNodeModules(path.join(stage, 'node_modules'));
  const pty = `node_modules/@lydell/node-pty-${WIN ? 'win32' : OS}-${ARCH}`;
  if (!fs.existsSync(path.join(stage, pty)))
    throw new Error(`${pty} missing: the bundle would have no terminal`);

  // 4. manifest.json: what this is, and the hash of every file.
  const files = {};
  for (const { e, rel } of walk(stage).sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    if (e.isSymbolicLink()) throw new Error(`symlink in bundle: ${rel}`);
    if (e.isFile()) files[rel] = sha256File(path.join(stage, rel));
  }
  const manifest = {
    name: 'agent-tycoon-daemon',
    version: version.version,
    protocol,
    dataSchema: version.dataSchema,
    minApp: version.minApp,
    maxApp: version.maxApp,
    os: OS,
    arch: ARCH,
    node: { version: NODE_VERSION, path: nodeRel },
    entry: 'dist/cli.js',
    files,
  };
  fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // 5. Pack. Relative paths only (GNU tar on Windows reads "C:" as a host name).
  const base = `agent-tycoon-daemon-${version.version}-${TARGET}`;
  const tarRel = path.join('..', '..', `${base}.tar`);
  // pax: names travel as UTF-8 in extended headers. The default GNU format writes raw bytes, which
  // Windows tar.exe reads in the ANSI code page: on a Korean Windows a dependency's "snow ☃" fixture
  // came out as "snow __" and the install stopped (owner's laptop 10-26; reproduced, pax extracts it).
  run('tar', ['--format=pax', '-cf', tarRel, ...fs.readdirSync(stage).sort()], { cwd: stage });
  const tarFile = path.join(OUT, `${base}.tar`);
  const tar = fs.readFileSync(tarFile);
  fs.rmSync(tarFile);
  // gzip, not zstd: the one-line installers (install.sh, install.ps1) unpack the bundle's Node with
  // the system tar before any Node exists, and Windows tar.exe and macOS tar have no zstd (P4).
  const name = `${base}.tar.gz`;
  const packed = zlib.gzipSync(tar, { level: 9 });
  for (const old of [`${base}.tar.zst`, `${base}.tar.gz`])
    fs.rmSync(path.join(OUT, old), { force: true });
  fs.writeFileSync(path.join(OUT, name), packed);

  // 6. SHA256SUMS + Ed25519 signature.
  let key = loadSigningKey(opt('--key'));
  if (!key) {
    key = devSigningKey(path.join(OUT, 'dev-key'));
    console.warn(
      `signed with a throwaway DEV key (${path.join(OUT, 'dev-key')}); set AGENT_TYCOON_SIGNING_KEY for a release`,
    );
  }
  writeSumsAndSign(OUT, [name], key);

  const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
  const unpacked = Object.keys(files).reduce(
    (sum, rel) => sum + fs.statSync(path.join(stage, rel)).size,
    0,
  );
  console.log(`\n✓ ${path.join(OUT, name)}`);
  console.log(
    `  ${mb(packed.length)} packed, ${mb(unpacked)} unpacked, ${Object.keys(files).length} files, node ${NODE_VERSION}`,
  );
  console.log(`  ${SUMS}, ${SIG} (raw Ed25519 over ${SUMS}), ${PUB}`);
}

main().catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exit(1);
});
