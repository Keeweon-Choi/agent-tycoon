// node --test cld/install/update.test.mjs  (P3, H §6: temp dirs, signed fake bundles, a fake service
// manager, fake health and a fake engine socket; no real service, kill, network or HOME is touched)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { PUB, SIG, SUMS, writeSumsAndSign } from '../release/bundle/sign.mjs';
import { currentOs, sha256File } from '../release/bundle/verify.mjs';
import { install, installStatus, main, readCurrent, readRecord, realDeps, servicePlan, serviceRunning, uninstall, versionDir, writeRecord } from './manager.mjs';
import { compareVersions, compatibility, rollback, stopOld, update } from './update.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `update-${name}-`));
const key = crypto.generateKeyPairSync('ed25519').privateKey;
const OS = currentOs();
const ARCH = process.arch;
const OTHER_ARCH = ARCH === 'x64' ? 'arm64' : 'x64';

/** A signed release folder holding one tiny bundle (stub node and daemon; the fake runner never runs them). */
function makeRelease(version, { dataSchema = { 'projects.json': 1 }, protocol = 1, arch = ARCH, signWith = key } = {}) {
  const stage = tmp('stage');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true }); fs.writeFileSync(path.join(stage, rel), text); };
  write('node/bin/node', '#!/bin/sh\n');
  write('dist/cli.js', `// ${version}\n`);
  write('cld/bin/cld-gui', '// cli\n');
  const files = Object.fromEntries(['node/bin/node', 'dist/cli.js', 'cld/bin/cld-gui'].map((rel) => [rel, sha256File(path.join(stage, rel))]));
  write('manifest.json', JSON.stringify({ version, protocol, dataSchema, minApp: '0.1.0', maxApp: null, os: OS, arch, node: { path: 'node/bin/node' }, entry: 'dist/cli.js', files }));
  const dir = tmp('release');
  const name = `agent-tycoon-daemon-${version}-${OS}-${arch}.tar.gz`;
  assert.equal(spawnSync('tar', ['-cf', path.join(dir, 'b.tar'), '-C', stage, '.']).status, 0);
  fs.writeFileSync(path.join(dir, name), zlib.gzipSync(fs.readFileSync(path.join(dir, 'b.tar'))));
  fs.rmSync(path.join(dir, 'b.tar'));
  writeSumsAndSign(dir, [name], signWith);
  fs.rmSync(path.join(dir, PUB)); // the trusted key is the one pinned at install, never the release's own
  return { dir, bundle: path.join(dir, name), name };
}

/**
 * A fake host: systemctl stop/restart flip whether the daemon runs; a started daemon "migrates" by
 * writing its manifest's dataSchema into ~/.config/agent-tycoon/schema.json; health and the engine socket
 * answer from the version `current` points at (unless it is in `bad`). Every engine command is recorded.
 */
function fakeHost(home, root, { badTest = [], bad = [], sessions = ['alpha', 'beta'] } = {}) {
  const host = { calls: [], printed: [], control: [], running: true, badTest, bad };
  const version = () => readCurrent(root, 'linux');
  host.deps = {
    platform: 'linux', home, env: { PATH: '/usr/bin:/bin' }, uid: 1000, sleep: async () => {}, tcpFree: async () => true,
    print: (line) => host.printed.push(String(line)),
    run: async (cmd) => {
      const line = cmd.join(' ');
      host.calls.push(line);
      if (cmd.includes('--self-test')) return { ok: !host.badTest.some((v) => cmd[0].includes(`/versions/${v}/`)), stdout: 'self-test', stderr: '' };
      if (line === 'systemctl --user stop agent-tycoon') host.running = false;
      if (line === 'systemctl --user restart agent-tycoon') {
        // A daemon migrates older data up to its own format and cannot read a newer one (it then fails health).
        host.running = true;
        const m = JSON.parse(fs.readFileSync(path.join(root, 'current', 'manifest.json'), 'utf8'));
        const file = path.join(home, '.config', 'agent-tycoon', 'schema.json');
        const there = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
        host.unreadable = Object.entries(there).some(([f, v]) => v > (m.dataSchema?.[f] ?? 0));
        if (!host.unreadable) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(m.dataSchema ?? {})); }
      }
      return { ok: true, stdout: '', stderr: '' };
    },
    health: async () => { const v = await version(); return host.running && !host.unreadable && v && !host.bad.includes(v) ? { service: 'cld-gui', version: v, protocol: 1 } : null; },
    control: async (cmd) => {
      host.control.push(cmd);
      const v = await version();
      if (!host.running || host.unreadable || host.bad.includes(v)) return null;
      return { ok: true, projects: sessions.map((name) => ({ name, state: 'on' })), jobs: [], tasks: [], daemon: { pid: 1, port: 18257, entry: path.join(root, 'current', 'dist', 'cli.js') } };
    },
    confirm: async () => true,
  };
  return host;
}

/** HOME with user data (a 0600 secret), and 1.0.0 installed from a release whose key gets pinned. */
async function installed(name, { dataSchema = { 'projects.json': 1 }, ...opts } = {}) {
  const home = tmp(name); const root = path.join(home, 'root');
  const data = path.join(home, '.config', 'agent-tycoon');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(data, 'projects.json'), '{"v":1,"projects":[]}', { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'devices.json'), 'secret-device-keys', { mode: 0o600 });
  const host = fakeHost(home, root, opts);
  const r = makeRelease('1.0.0', { dataSchema });
  await install({ from: r.bundle, pub: path.join(writeKey(), PUB), root, service: 'systemd', port: 18257 }, host.deps);
  host.calls.length = 0;
  return { home, root, data, host, o: { root } };
}
function writeKey() { const dir = tmp('key'); fs.writeFileSync(path.join(dir, PUB), crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' })); return dir; }
const stops = (host) => host.calls.filter((c) => c === 'systemctl --user stop agent-tycoon').length;
const noAgentStop = (host) => assert.equal(host.control.includes('stop-agents'), false, 'an update must never stop agent sessions');

test('compatibility: protocol warns, an older data format refuses, any data change asks for a snapshot', () => {
  assert.deepEqual(compatibility({ protocol: 1, dataSchema: { a: 1 } }, { version: '2', protocol: 1, dataSchema: { a: 1 } }), { errors: [], warnings: [], dataChanges: false });
  const up = compatibility({ protocol: 1, dataSchema: { a: 1 } }, { version: '2', protocol: 2, dataSchema: { a: 2, b: 1 } });
  assert.equal(up.errors.length, 0); assert.match(up.warnings[0], /protocol 1 -> 2/); assert.equal(up.dataChanges, true);
  assert.match(compatibility({ protocol: 1, dataSchema: { a: 2 } }, { version: '2', protocol: 1, dataSchema: { a: 1 } }).errors[0], /reads older data formats \(a 2 -> 1\)/);
  assert.match(compatibility({ protocol: 1 }, { version: '2' }).errors[0], /no protocol/);
});

test('update from a release folder: stop, snapshot (secrets, modes), switch, health, takeover; sessions never stopped', async () => {
  const { home, root, data, host, o } = await installed('ok');
  const r = makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } });
  await update({ ...o, from: r.dir }, host.deps);
  const record = await readRecord(root);
  assert.deepEqual([record.current, record.previous, record.update], ['2.0.0', '1.0.0', null]);
  assert.equal(await readCurrent(root, 'linux'), '2.0.0');
  const snap = record.versions['2.0.0'].snapshot;
  assert.ok(snap.startsWith(path.join(root, 'snapshots')));
  assert.equal(fs.readFileSync(path.join(snap, 'devices.json'), 'utf8'), 'secret-device-keys');
  assert.equal(fs.statSync(path.join(snap, 'devices.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(snap).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(data, 'schema.json'), 'utf8'), '{"projects.json":2}'); // the new daemon migrated
  const stop = host.calls.indexOf('systemctl --user stop agent-tycoon');
  assert.ok(stop >= 0 && stop < host.calls.indexOf('systemctl --user restart agent-tycoon'));
  assert.equal(record.versions['2.0.0'].from, '1.0.0');
  noAgentStop(host);
});

test('update --check reads the release without unpacking; a URL is downloaded, verified with the pinned key and cleaned up', async () => {
  const { root, host, o } = await installed('url');
  const r = makeRelease('2.0.0');
  const fetched = [];
  host.deps.fetch = async (url) => { fetched.push(url); const file = path.join(r.dir, url.slice('https://rel.example/v2/'.length)); return fs.existsSync(file) ? { ok: true, arrayBuffer: async () => fs.readFileSync(file) } : { ok: false, status: 404 }; };
  const check = await update({ ...o, from: 'https://rel.example/v2', check: true }, host.deps);
  assert.equal(check.available, '2.0.0');
  assert.ok(host.printed.some((l) => l.includes('2.0.0 is available (installed 1.0.0)')));
  assert.equal(fetched.some((u) => u.endsWith('.tar.gz')), false);
  assert.equal(fs.existsSync(versionDir(root, '2.0.0')), false);
  await update({ ...o, from: 'https://rel.example/v2' }, host.deps);
  assert.equal((await readRecord(root)).current, '2.0.0');
  assert.deepEqual(fs.readdirSync(path.join(root, 'downloads')), []);
});

test('network error: the partial download is deleted and nothing installed changes', async () => {
  const { root, host, o } = await installed('net');
  const before = fs.readFileSync(path.join(root, 'install.json'), 'utf8');
  host.deps.fetch = async (url) => { if (url.endsWith('.sig')) throw new TypeError('fetch failed'); return { ok: true, arrayBuffer: async () => Buffer.from('x') }; };
  await assert.rejects(update({ ...o, from: 'https://rel.example/v2/' }, host.deps), /download failed \(fetch failed\).*nothing installed was changed; try again/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'downloads')), []);
  assert.equal(fs.readFileSync(path.join(root, 'install.json'), 'utf8'), before);
  assert.equal(stops(host), 0);
});

test('signature or hash mismatch: stop, delete the download, warn about the supply chain', async () => {
  const { root, host, o } = await installed('sig');
  const serve = (dir) => async (url) => ({ ok: true, arrayBuffer: async () => fs.readFileSync(path.join(dir, path.posix.basename(url))) });
  const forged = makeRelease('2.0.0', { signWith: crypto.generateKeyPairSync('ed25519').privateKey }); // a key we never pinned
  host.deps.fetch = serve(forged.dir);
  await assert.rejects(update({ ...o, from: 'https://rel.example/v2' }, host.deps), /signature is not valid[\s\S]*supply-chain risk[\s\S]*download was deleted/);
  const corrupt = makeRelease('2.0.0');
  const bytes = fs.readFileSync(corrupt.bundle); bytes[50] ^= 1; fs.writeFileSync(corrupt.bundle, bytes);
  host.deps.fetch = serve(corrupt.dir);
  await assert.rejects(update({ ...o, from: 'https://rel.example/v2' }, host.deps), /SHA-256 does not match[\s\S]*supply-chain risk/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'downloads')), []);
  // a local tampered bundle is refused the same way (and, not being ours, not deleted)
  await assert.rejects(update({ ...o, from: corrupt.bundle }, host.deps), /SHA-256 does not match/);
  assert.ok(fs.existsSync(corrupt.bundle));
  assert.equal(fs.existsSync(versionDir(root, '2.0.0')), false);
  assert.equal((await readRecord(root)).current, '1.0.0');
  assert.equal(stops(host), 0);
});

test('a downloaded release needs a key it did not bring', async () => {
  const { root, host, o } = await installed('nokey');
  fs.rmSync(path.join(root, 'release.pub'));
  await assert.rejects(update({ ...o, from: 'https://rel.example/v2' }, host.deps), /no release key is pinned.*pass --pub/);
});

test('OS/CPU mismatch stops and names the right bundle', async () => {
  const { root, host, o } = await installed('arch');
  const other = makeRelease('2.0.0', { arch: OTHER_ARCH });
  await assert.rejects(update({ ...o, from: other.dir }, host.deps), new RegExp(`no bundle for this machine.*needs agent-tycoon-daemon-2\\.0\\.0-${OS}-${ARCH}\\.tar\\.gz`));
  await assert.rejects(update({ ...o, from: other.bundle }, host.deps), new RegExp(`built for ${OS}-${OTHER_ARCH}.*needs agent-tycoon-daemon-2\\.0\\.0-${OS}-${ARCH}`));
  assert.equal(fs.existsSync(versionDir(root, '2.0.0')), false);
});

test('pre-test failure: nothing stops, the old version continues, the version is marked failed', async () => {
  const { root, host, o } = await installed('selftest', { badTest: ['2.0.0'] });
  await assert.rejects(update({ ...o, from: makeRelease('2.0.0').dir }, host.deps), /self-test of 2\.0\.0 failed; still on 1\.0\.0/);
  const record = await readRecord(root);
  assert.deepEqual([record.current, record.failedVersions, record.update], ['1.0.0', ['2.0.0'], null]);
  assert.equal(fs.existsSync(versionDir(root, '2.0.0')), false);
  assert.equal(stops(host), 0);
});

test('an older data format is refused before anything stops', async () => {
  const { root, host, o } = await installed('older', { dataSchema: { 'projects.json': 2 } });
  await assert.rejects(update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 1 } }).dir }, host.deps), /reads older data formats.*agty rollback/);
  assert.equal(fs.existsSync(versionDir(root, '2.0.0')), false);
  assert.equal(stops(host), 0);
});

test('migration/start failure: pointer back, snapshot restored, old started, failed and never retried automatically', async () => {
  const { root, data, host, o } = await installed('migrate', { bad: ['2.0.0'] });
  const r = makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } });
  await assert.rejects(update({ ...o, from: r.dir }, host.deps), /failed health.*back on 1\.0\.0 \(healthy\); data restored from the snapshot/);
  const record = await readRecord(root);
  assert.deepEqual([record.current, record.update, record.failedVersions], ['1.0.0', null, ['2.0.0']]);
  assert.equal(await readCurrent(root, 'linux'), '1.0.0');
  // the 2.0.0 migration was undone: the data is the snapshot (old schema written by the restarted 1.0.0), secrets and modes intact
  assert.equal(fs.readFileSync(path.join(data, 'schema.json'), 'utf8'), '{"projects.json":1}');
  assert.equal(fs.readFileSync(path.join(data, 'devices.json'), 'utf8'), 'secret-device-keys');
  assert.equal(fs.statSync(path.join(data, 'devices.json')).mode & 0o777, 0o600);
  const aside = fs.readdirSync(path.dirname(data)).find((n) => n.startsWith('agent-tycoon.replaced-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(data), aside, 'schema.json'), 'utf8'), '{"projects.json":2}'); // kept, not deleted
  assert.equal(host.running, true);
  noAgentStop(host);
  host.calls.length = 0;
  await assert.rejects(update({ ...o, from: r.dir }, host.deps), /2\.0\.0 failed before; pass --force/);
  assert.equal(stops(host), 0);
});

test('start failure without a data change: pointer back, no snapshot, old started', async () => {
  const { root, host, o } = await installed('start', { bad: ['2.0.0'] });
  await assert.rejects(update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 1 } }).dir }, host.deps), /back on 1\.0\.0 \(healthy\)/);
  const record = await readRecord(root);
  assert.equal(record.current, '1.0.0');
  assert.deepEqual(record.snapshots, []);
  assert.equal(fs.existsSync(path.join(root, 'snapshots')), false);
});

test('another daemon on the port or the engine socket: no switch, explained', async () => {
  const { root, host, o } = await installed('dup');
  const r = makeRelease('2.0.0');
  const health = host.deps.health;
  host.deps.health = async () => ({ service: 'cld-gui', version: '0.9.0-source', protocol: 1 });
  await assert.rejects(update({ ...o, from: r.dir }, host.deps), /port 18257 answers as cld-gui 0\.9\.0-source.*not switching/);
  host.deps.health = health;
  const other = path.join(tmp('src'), 'dist', 'cli.js'); fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, '//');
  host.deps.control = async () => ({ ok: true, projects: [], jobs: [], tasks: [], daemon: { pid: 9, port: 18257, entry: other } });
  await assert.rejects(update({ ...o, from: r.dir }, host.deps), /engine socket is held by another daemon.*not switching/);
  assert.equal((await readRecord(root)).current, '1.0.0');
  assert.equal(fs.existsSync(versionDir(root, '2.0.0')), false);
  assert.equal(stops(host), 0);
});

test('engine takeover: a session not back yet is a warning; another daemon on the socket after the start reverts', async () => {
  const { root, host, o } = await installed('takeover');
  const control = host.deps.control;
  host.deps.control = async (cmd) => { const s = await control(cmd); return s && (await readCurrent(root, 'linux')) === '2.0.0' ? { ...s, projects: [{ name: 'alpha', state: 'on' }] } : s; };
  await update({ ...o, from: makeRelease('2.0.0').dir }, host.deps);
  assert.ok(host.printed.some((l) => l.includes('has not taken over beta yet')));
  assert.equal((await readRecord(root)).current, '2.0.0');
  const other = path.join(tmp('src'), 'dist', 'cli.js'); fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, '//');
  host.deps.control = async (cmd) => { const s = await control(cmd); return s && (await readCurrent(root, 'linux')) === '3.0.0' ? { ...s, daemon: { ...s.daemon, entry: other } } : s; };
  await assert.rejects(update({ ...o, from: makeRelease('3.0.0').dir }, host.deps), /engine socket answers from another daemon.*back on 2\.0\.0/);
  assert.equal((await readRecord(root)).current, '2.0.0');
  noAgentStop(host);
});

// A power loss right after each recorded step (and once while the new daemon is starting); the next
// `agty update` finishes or reverts. A crash before the pointer moved is not the version's fault.
for (const [at, opts, expect] of [
  ['unpacked', {}, { current: '1.0.0', failed: [], staged: false }],
  ['stopping', {}, { current: '1.0.0', failed: [], staged: false }],
  ['snapshot', {}, { current: '1.0.0', failed: [], staged: false }],
  ['switching', {}, { current: '1.0.0', failed: [], staged: false }],
  ['starting', {}, { current: '2.0.0', failed: [], staged: true }],
  ['starting', { bad: ['2.0.0'] }, { current: '1.0.0', failed: ['2.0.0'], staged: true }],
  ['reverting', { bad: ['2.0.0'] }, { current: '1.0.0', failed: ['2.0.0'], staged: true }],
]) {
  test(`an update interrupted at '${at}'${opts.bad ? ' (new version broken)' : ''} is ${expect.current === '2.0.0' ? 'finished' : 'reverted'} by the next run`, async () => {
    const { root, data, host, o } = await installed(`crash-${at}`, opts);
    const crash = () => { throw new Error('power loss'); };
    const health = host.deps.health;
    host.deps.afterStep = (name) => { if (name === at) crash(); };
    if (at === 'starting') host.deps.health = async (port) => ((await readCurrent(root, 'linux')) === '2.0.0' ? crash() : health(port));
    await assert.rejects(update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps), /power loss/);
    const step = (await readRecord(root)).update.step;
    assert.equal(step, at === 'starting' ? 'switching' : at);
    // reboot: the service manager starts whatever `current` points at
    host.deps.afterStep = undefined; host.deps.health = health;
    await host.deps.run(['systemctl', '--user', 'restart', 'agent-tycoon']);
    assert.equal((await installStatus({ ...host.deps, env: { ...host.deps.env, AGENT_TYCOON_ROOT: root } })).pendingUpdate.step, step);
    const result = await update(o, host.deps);
    assert.equal(result.recovered, expect.current === '2.0.0' ? 'finished' : 'reverted');
    const record = await readRecord(root);
    assert.deepEqual([record.current, record.update, record.failedVersions], [expect.current, null, expect.failed]);
    assert.equal(await readCurrent(root, 'linux'), expect.current);
    assert.equal(fs.existsSync(versionDir(root, '2.0.0')), expect.staged);
    assert.equal(fs.readFileSync(path.join(data, 'schema.json'), 'utf8'), expect.current === '2.0.0' ? '{"projects.json":2}' : '{"projects.json":1}');
    assert.equal(fs.readFileSync(path.join(data, 'devices.json'), 'utf8'), 'secret-device-keys');
    assert.equal(host.running, true);
    if (expect.current === '1.0.0') assert.deepEqual(record.snapshots, []);
    noAgentStop(host);
  });
}

test('keeps two old versions; older ones go by P2b rules (a user-changed file and its version stay)', async () => {
  const { root, host, o } = await installed('prune');
  for (const v of ['2.0.0', '3.0.0', '4.0.0']) await update({ ...o, from: makeRelease(v).dir }, host.deps);
  let record = await readRecord(root);
  assert.deepEqual(Object.keys(record.versions).sort(), ['2.0.0', '3.0.0', '4.0.0']);
  assert.equal(fs.existsSync(versionDir(root, '1.0.0')), false);
  fs.appendFileSync(path.join(versionDir(root, '2.0.0'), 'dist', 'cli.js'), '// edited by the user\n');
  await update({ ...o, from: makeRelease('5.0.0').dir }, host.deps);
  record = await readRecord(root);
  assert.deepEqual(Object.keys(record.versions).sort(), ['2.0.0', '3.0.0', '4.0.0', '5.0.0']);
  assert.ok(fs.existsSync(path.join(versionDir(root, '2.0.0'), 'dist', 'cli.js')));
  assert.equal(fs.existsSync(path.join(versionDir(root, '2.0.0'), 'cld', 'bin', 'cld-gui')), false); // unchanged files went
  assert.ok(host.printed.some((l) => l.startsWith('남김(직접 고친 파일)')));
});

test('rollback without a data change: back to previous, data untouched', async () => {
  const { root, data, host, o } = await installed('rb');
  await update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 1 } }).dir }, host.deps);
  fs.writeFileSync(path.join(data, 'after-update.json'), 'kept');
  host.calls.length = 0;
  assert.equal(await main(['rollback', '--root', root], host.deps), 0);
  const record = await readRecord(root);
  assert.deepEqual([record.current, record.previous], ['1.0.0', null]);
  assert.equal(fs.readFileSync(path.join(data, 'after-update.json'), 'utf8'), 'kept');
  assert.ok(stops(host) === 1);
  await assert.rejects(rollback(o, host.deps), /no previous version/);
  noAgentStop(host);
});

test('rollback with a data change restores the snapshot taken before the update; without one it refuses', async () => {
  const { root, data, host, o } = await installed('rbdata');
  await update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps);
  fs.writeFileSync(path.join(data, 'made-on-2.json'), 'x');
  host.deps.confirm = async () => false;
  assert.equal((await rollback(o, host.deps)).ok, false); // asked, declined: nothing changed
  assert.equal((await readRecord(root)).current, '2.0.0');
  await rollback({ ...o, yes: true }, host.deps);
  let record = await readRecord(root);
  assert.deepEqual([record.current, record.previous], ['1.0.0', null]);
  assert.equal(fs.existsSync(path.join(data, 'made-on-2.json')), false);
  assert.equal(fs.readFileSync(path.join(data, 'schema.json'), 'utf8'), '{"projects.json":1}');
  assert.equal(fs.readFileSync(path.join(data, 'devices.json'), 'utf8'), 'secret-device-keys');

  // forward again, then lose the snapshot: rollback must not hand 1.0.0 data it cannot read
  host.deps.confirm = async () => true;
  record.previous = '2.0.0'; await writeRecord(root, record);
  await update({ ...o, from: makeRelease('3.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps);
  record = await readRecord(root);
  fs.rmSync(record.versions['3.0.0'].snapshot, { recursive: true });
  await assert.rejects(rollback({ ...o, yes: true }, host.deps), /the snapshot .* is missing or incomplete \(the folder\).*this stays on 3\.0\.0/);
  assert.equal((await readRecord(root)).current, '3.0.0');
  noAgentStop(host);
});

test('a failed rollback start puts the newer version and its data back', async () => {
  const { root, data, host, o } = await installed('rbfail');
  await update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps);
  fs.writeFileSync(path.join(data, 'made-on-2.json'), 'x');
  host.bad.push('1.0.0');
  await assert.rejects(rollback({ ...o, yes: true }, host.deps), /rollback to 1\.0\.0 failed.*back on 2\.0\.0 \(healthy\)/);
  assert.equal((await readRecord(root)).current, '2.0.0');
  assert.equal(fs.readFileSync(path.join(data, 'made-on-2.json'), 'utf8'), 'x');
});

test('uninstall removes the rollback snapshots (copies with secrets)', async () => {
  const { root, host, o } = await installed('uninst');
  await update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps);
  const snap = (await readRecord(root)).versions['2.0.0'].snapshot;
  host.running = false;
  const deps = { ...host.deps, env: { PATH: '' }, socketExists: () => false, serviceActive: async () => false, control: async () => ({ ok: true, projects: [], jobs: [], tasks: [], daemon: { pid: 1, port: 18257, entry: path.join(root, 'current', 'dist', 'cli.js') } }), revertLedger: async () => ({ ok: true, entries: [] }) };
  assert.equal((await uninstall({ program: true, yes: true, root }, deps)).code, 0);
  assert.equal(fs.existsSync(snap), false);
});

// ── Review fixes (P3) ────────────────────────────────────────────────────────

const uninstallFake = (host, root) => ({ ...host.deps, env: { PATH: '' }, socketExists: () => false, serviceActive: async () => false, control: async () => ({ ok: true, projects: [], jobs: [], tasks: [], daemon: { pid: 1, port: 18257, entry: path.join(root, 'current', 'dist', 'cli.js') } }), revertLedger: async () => ({ ok: true, entries: [] }) });

test('version order: pre-releases below their release, numeric parts as numbers', () => {
  for (const [a, b] of [['0.1.0-rc.1', '0.1.0'], ['0.1.0-rc.2', '0.1.0-rc.10'], ['1.9.0', '1.10.0'], ['1.0.0-alpha', '1.0.0-beta'], ['1.0.0-rc.1', '1.0.0-rc.1.1']]) {
    assert.ok(compareVersions(a, b) < 0 && compareVersions(b, a) > 0, `${a} < ${b}`);
  }
  assert.equal(compareVersions('1.2.0', '1.2.0+build.5'), 0);
});

test('the same version is a no-op and an older one is refused (rollback named) unless --force; --check reports only newer', async () => {
  const { root, host, o } = await installed('down');
  await update({ ...o, from: makeRelease('2.0.0').dir }, host.deps);
  host.calls.length = 0;
  assert.equal((await update({ ...o, from: makeRelease('2.0.0').dir }, host.deps)).unchanged, true);
  await assert.rejects(update({ ...o, from: makeRelease('1.5.0').dir }, host.deps), /1\.5\.0 is older than the installed 2\.0\.0: to go back use agty rollback/);
  assert.equal(stops(host), 0);
  assert.equal(fs.existsSync(versionDir(root, '1.5.0')), false);
  const check = await update({ ...o, from: makeRelease('1.5.0').dir, check: true }, host.deps);
  assert.equal(check.available, null);
  assert.ok(host.printed.includes('up to date (installed 2.0.0; the release has 1.5.0)'));
  await update({ ...o, from: makeRelease('1.5.0').dir, force: true }, host.deps);
  assert.equal((await readRecord(root)).current, '1.5.0');
});

test('trust: no pinned key -> a local release is refused without --pub; --pub works and is pinned', async () => {
  const { root, host, o } = await installed('pin');
  fs.rmSync(path.join(root, 'release.pub'));
  const r = makeRelease('2.0.0');
  fs.writeFileSync(path.join(r.dir, PUB), crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' })); // even the right key, shipped beside
  await assert.rejects(update({ ...o, from: r.dir }, host.deps), /no release key is pinned.*pass --pub/);
  assert.equal(fs.existsSync(versionDir(root, '2.0.0')), false);
  await update({ ...o, from: r.dir, pub: path.join(writeKey(), PUB) }, host.deps);
  assert.equal(fs.readFileSync(path.join(root, 'release.pub'), 'utf8'), crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }));
  assert.ok((await readRecord(root)).files[path.join(root, 'release.pub')]);
});

test('trust: a stranger key beside a local bundle is never used when a key is pinned', async () => {
  const { root, host, o } = await installed('foreign');
  const stranger = crypto.generateKeyPairSync('ed25519').privateKey;
  const r = makeRelease('2.0.0', { signWith: stranger });
  fs.writeFileSync(path.join(r.dir, PUB), crypto.createPublicKey(stranger).export({ type: 'spki', format: 'pem' }));
  await assert.rejects(update({ ...o, from: r.dir }, host.deps), /signature is not valid for this key/);
  await assert.rejects(update({ ...o, from: r.bundle }, host.deps), /signature is not valid for this key/);
  await assert.rejects(update({ ...o, from: r.dir, check: true }, host.deps), /refused SHA256SUMS: SHA256SUMS signature is not valid/);
  assert.equal(fs.existsSync(versionDir(root, '2.0.0')), false);
});

test('trust: a URL download never fetches or uses a key from the server', async () => {
  const { root, host, o } = await installed('urlkey');
  const stranger = crypto.generateKeyPairSync('ed25519').privateKey;
  const r = makeRelease('2.0.0', { signWith: stranger });
  fs.writeFileSync(path.join(r.dir, PUB), crypto.createPublicKey(stranger).export({ type: 'spki', format: 'pem' }));
  const fetched = [];
  host.deps.fetch = async (url) => { fetched.push(url); return { ok: true, arrayBuffer: async () => fs.readFileSync(path.join(r.dir, path.posix.basename(url))) }; };
  await assert.rejects(update({ ...o, from: 'https://rel.example/v2' }, host.deps), /signature is not valid for this key[\s\S]*download was deleted/);
  await assert.rejects(update({ ...o, from: 'https://rel.example/v2', check: true }, host.deps), /signature is not valid/);
  assert.equal(fetched.some((u) => u.endsWith('.pub')), false);
  assert.equal((await readRecord(root)).current, '1.0.0');
});

test('restore leaves no unrecorded secret copy: the aside folder is recorded, named, and removed by uninstall --reset (owned ones only)', async () => {
  const { home, root, host, o } = await installed('aside', { bad: ['2.0.0'] });
  await assert.rejects(update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps), (e) => /kept in \S+agent-tycoon\.replaced-\d+; agty uninstall --reset removes them/.test(e.message));
  const record = await readRecord(root);
  assert.equal(record.replaced.length, 1);
  const aside = record.replaced[0];
  assert.equal(fs.readFileSync(path.join(aside, 'devices.json'), 'utf8'), 'secret-device-keys');
  // decoys: an unrecorded look-alike, and a recorded entry that became a link to somewhere else
  const decoy = path.join(home, '.config', 'agent-tycoon.replaced-1'); fs.mkdirSync(decoy);
  const outside = tmp('outside'); const linked = path.join(home, '.config', 'agent-tycoon.replaced-2'); fs.symlinkSync(outside, linked);
  record.replaced.push(linked); await writeRecord(root, record);
  host.running = false;
  const deps = uninstallFake(host, root);
  const dry = await uninstall({ reset: true, dryRun: true, root }, deps);
  assert.deepEqual(dry.plan.replaced, [aside]);
  assert.ok(host.printed.some((l) => l.startsWith('5. 완전 초기화:') && l.includes(aside)));
  assert.equal((await uninstall({ reset: true, yes: true, root }, deps)).code, 0);
  assert.equal(fs.existsSync(aside), false);
  assert.ok(fs.existsSync(decoy) && fs.existsSync(outside) && fs.lstatSync(linked).isSymbolicLink());
});

test('--check never recovers; a switched-but-silent update is not reverted without a yes (--yes refuses and says what it would do)', async () => {
  const { root, data, host, o } = await installed('ask');
  const health = host.deps.health;
  host.deps.health = async (port) => { if ((await readCurrent(root, 'linux')) === '2.0.0') throw new Error('power loss'); return health(port); };
  await assert.rejects(update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps), /power loss/);
  host.deps.health = health;
  host.bad.push('2.0.0'); // after the reboot 2.0.0 does not answer (it ran and migrated)
  await host.deps.run(['systemctl', '--user', 'restart', 'agent-tycoon']);
  const pending = JSON.stringify((await readRecord(root)).update);

  await update({ ...o, from: makeRelease('3.0.0').dir, check: true }, host.deps);
  assert.equal(JSON.stringify((await readRecord(root)).update), pending);
  assert.ok(host.printed.some((l) => l.includes('is pending')));

  await assert.rejects(update({ ...o, yes: true }, host.deps), (e) => e.code === 'CANCELLED' && /not reverting under --yes: reverting would stop 2\.0\.0.*snapshot/.test(e.message));
  host.deps.confirm = async () => false;
  assert.equal(await main(['update', '--root', root], host.deps), 3);
  assert.equal(JSON.stringify((await readRecord(root)).update), pending);
  assert.equal(await readCurrent(root, 'linux'), '2.0.0');
  assert.equal(fs.readFileSync(path.join(data, 'schema.json'), 'utf8'), '{"projects.json":2}');

  host.deps.confirm = async () => true;
  assert.equal((await update(o, host.deps)).recovered, 'reverted');
  assert.equal((await readRecord(root)).current, '1.0.0');
});

test('a crash inside the restore of a revert still names the folder holding the real data', async () => {
  const { root, data, host, o } = await installed('restorecrash', { bad: ['2.0.0'] });
  host.deps.afterStep = (name) => { if (name === 'restore-moved') throw new Error('power loss'); };
  await assert.rejects(update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps), /power loss/);
  const record = await readRecord(root);
  const aside = record.update.asides[0];
  assert.deepEqual(record.replaced, [aside]);
  assert.equal(fs.existsSync(data), false);
  assert.equal(fs.readFileSync(path.join(aside, 'schema.json'), 'utf8'), '{"projects.json":2}'); // the real (migrated) data
  host.deps.afterStep = undefined;
  await update(o, host.deps);
  assert.ok(host.printed.some((l) => l.includes(`the data it replaced is kept in ${aside}`)));
  assert.equal(fs.readFileSync(path.join(data, 'devices.json'), 'utf8'), 'secret-device-keys');
  assert.equal((await readRecord(root)).current, '1.0.0');
});

test('a missing snapshot moves nothing: the data folder stays and the failure says it cannot be undone', async () => {
  const { root, data, host, o } = await installed('nosnap', { bad: ['2.0.0'] });
  host.deps.afterStep = async (name) => { if (name === 'switching') fs.rmSync((await readRecord(root)).update.snapshot, { recursive: true }); };
  await assert.rejects(update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps), /cannot be undone: the snapshot .* missing or incomplete.*nothing was moved/);
  assert.equal(fs.readFileSync(path.join(data, 'devices.json'), 'utf8'), 'secret-device-keys');
  assert.equal(fs.readFileSync(path.join(data, 'schema.json'), 'utf8'), '{"projects.json":2}');
  const record = await readRecord(root);
  assert.equal(record.replaced, undefined);
  assert.ok(record.update); // still pending, for status
});

test('a snapshot that lost a file is refused before anything moves', async () => {
  const { root, data, host, o } = await installed('partial', { bad: ['2.0.0'] });
  host.deps.afterStep = async (name) => { if (name === 'switching') fs.rmSync(path.join((await readRecord(root)).update.snapshot, 'devices.json')); };
  await assert.rejects(update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps), /missing or incomplete \(devices\.json\)/);
  assert.equal(fs.readFileSync(path.join(data, 'devices.json'), 'utf8'), 'secret-device-keys');
});

test('the snapshot is taken after the old daemon stopped; a stop error with the daemon still up stops the update before any snapshot', async () => {
  const { root, host, o } = await installed('order');
  let runningAtSnapshot = null;
  host.deps.afterStep = (name) => { if (name === 'snapshot') runningAtSnapshot = host.running; };
  await update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps);
  assert.equal(runningAtSnapshot, false);

  const run = host.deps.run;
  host.deps.run = async (cmd) => { if (cmd.join(' ') === 'systemctl --user stop agent-tycoon') throw new Error('Access denied'); return run(cmd); };
  await assert.rejects(update({ ...o, from: makeRelease('3.0.0', { dataSchema: { 'projects.json': 3 } }).dir }, host.deps), /2\.0\.0 is still running after the stop \(Access denied\)/);
  const record = await readRecord(root);
  assert.equal(record.current, '2.0.0');
  assert.equal(record.snapshots.length, 1); // only 2.0.0's own
  // the same error with the daemon already down is not a reason to stop
  host.running = false;
  await update({ ...o, from: makeRelease('3.0.0', { dataSchema: { 'projects.json': 3 } }).dir }, host.deps);
  assert.equal((await readRecord(root)).current, '3.0.0');
  for (const kind of ['systemd', 'launchd', 'schtasks']) assert.equal(servicePlan(kind, 'stop', { name: 'agent-tycoon', file: '/x' }).every((s) => !s.optional), true);
});

test('a cancelled rollback exits 3', async () => {
  const { root, host } = await installed('rbcancel');
  await update({ root, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps);
  host.deps.confirm = async () => false;
  assert.equal(await main(['rollback', '--root', root], host.deps), 3);
  assert.equal((await readRecord(root)).current, '2.0.0');
});

test('uninstall keeps a recorded snapshot whose snapshots folder became a link outside the root', async () => {
  const { root, host, o } = await installed('snaplink');
  await update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps);
  const snap = (await readRecord(root)).versions['2.0.0'].snapshot;
  const outside = tmp('outside-snap'); fs.cpSync(path.dirname(snap), outside, { recursive: true });
  fs.rmSync(path.dirname(snap), { recursive: true }); fs.symlinkSync(outside, path.dirname(snap));
  host.running = false;
  await uninstall({ program: true, yes: true, root }, uninstallFake(host, root));
  assert.ok(fs.existsSync(path.join(outside, path.basename(snap), 'devices.json')));
});

// ── Re-review fixes (P3) ─────────────────────────────────────────────────────

test('Task Scheduler: the stop wait reads the task state, not its registration (a registered, Ready task is down)', async () => {
  const states = { value: 'Ready' };
  const calls = [];
  const run = async (cmd) => { calls.push(cmd.join(' ')); return { ok: true, stdout: cmd[0] === 'powershell.exe' ? `${states.value}\r\n` : '', stderr: '' }; };
  const deps = realDeps({ home: tmp('win'), run, health: async () => null, sleep: async () => {} });
  const record = { current: '1.0.0', port: 18257, service: { kind: 'schtasks', name: 'agent-tycoon' } };
  await stopOld(record, deps);
  assert.ok(calls.includes('schtasks /End /TN agent-tycoon'));
  assert.ok(calls.some((c) => c.startsWith('powershell.exe') && c.includes("(Get-ScheduledTask -TaskName 'agent-tycoon').State")));
  states.value = 'Running';
  await assert.rejects(stopOld(record, deps), /1\.0\.0 is still running after the stop/);
  assert.equal(await serviceRunning({ kind: 'schtasks', name: 'x' }, async () => ({ ok: false, stdout: '', stderr: 'no task' })), false);
});

test("a power loss inside the revert's restore is carried on automatically, even under --yes with no terminal", async () => {
  const { root, data, host, o } = await installed('revertcrash', { bad: ['2.0.0'] });
  host.deps.afterStep = (name) => { if (name === 'restore-moved') throw new Error('power loss'); };
  await assert.rejects(update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps), /power loss/);
  let record = await readRecord(root);
  const real = record.update.asides[0];
  assert.equal(record.update.step, 'reverting');
  assert.equal(await readCurrent(root, 'linux'), '2.0.0');
  // reboot: the broken version starts and makes itself a fresh, empty data folder
  host.deps.afterStep = undefined;
  await host.deps.run(['systemctl', '--user', 'restart', 'agent-tycoon']);
  host.deps.confirm = async () => { throw new Error('must not ask'); };
  const result = await update({ ...o, yes: true }, host.deps);
  assert.equal(result.recovered, 'reverted');
  record = await readRecord(root);
  assert.deepEqual([record.current, record.update, record.failedVersions], ['1.0.0', null, ['2.0.0']]);
  assert.equal(await readCurrent(root, 'linux'), '1.0.0');
  assert.equal(fs.readFileSync(path.join(data, 'devices.json'), 'utf8'), 'secret-device-keys');
  assert.equal(fs.readFileSync(path.join(data, 'schema.json'), 'utf8'), '{"projects.json":1}');
  assert.equal(fs.readFileSync(path.join(real, 'schema.json'), 'utf8'), '{"projects.json":2}');
  assert.ok(host.printed.some((l) => l.includes(`the data it replaced is kept in ${real};`) && l.includes('partial copies')));
  assert.equal(host.running, true);
});

test('uninstall --program keeps a small install.json while .replaced-* copies exist; a later --reset removes them', async () => {
  const { root, host, o } = await installed('leftover', { bad: ['2.0.0'] });
  await assert.rejects(update({ ...o, from: makeRelease('2.0.0', { dataSchema: { 'projects.json': 2 } }).dir }, host.deps));
  const aside = (await readRecord(root)).replaced[0];
  host.running = false;
  const deps = uninstallFake(host, root);
  assert.equal((await uninstall({ program: true, yes: true, root }, deps)).code, 0);
  const left = await readRecord(root);
  assert.deepEqual([left.replaced, left.current, left.service, Object.keys(left.versions)], [[aside], null, null, []]);
  assert.ok(fs.existsSync(aside));
  assert.ok(host.printed.some((l) => l.includes('uninstall --reset 이 지웁니다')));
  // the program is gone: no daemon answers any more
  assert.equal((await uninstall({ reset: true, yes: true, root }, { ...deps, control: async () => null })).code, 0);
  assert.equal(fs.existsSync(aside), false);
  assert.equal(fs.existsSync(path.join(root, 'install.json')), false);
});

test('--check with a URL naming a bundle file refuses a name the signed SHA256SUMS does not list', async () => {
  const { host, o } = await installed('named');
  const r = makeRelease('2.0.0');
  host.deps.fetch = async (url) => ({ ok: true, arrayBuffer: async () => fs.readFileSync(path.join(r.dir, path.posix.basename(url))) });
  const named = `https://rel.example/v2/agent-tycoon-daemon-9.9.9-${OS}-${ARCH}.tar.gz`;
  await assert.rejects(update({ ...o, from: named, check: true }, host.deps), /agent-tycoon-daemon-9\.9\.9-\S+ is not listed in the signed SHA256SUMS/);
  assert.equal((await update({ ...o, from: `https://rel.example/v2/${r.name}`, check: true }, host.deps)).available, '2.0.0');
});

test('compatibility: a data file new in the target (assignments.json) is a data change, not an error', () => {
  const c = compatibility({ protocol: 1, dataSchema: { 'projects.json': 1, 'host.json': 1 } }, { version: '2', protocol: 1, dataSchema: { 'projects.json': 2, 'assignments.json': 1, 'host.json': 1 } });
  assert.deepEqual([c.errors, c.dataChanges], [[], true]);
});

test('update --check: release notes show only when the signed SHA256SUMS lists them with a matching hash; --json prints one line (P3a)', async () => {
  const { host, o } = await installed('notes');
  const r = makeRelease('2.0.0');
  fs.writeFileSync(path.join(r.dir, 'release-notes.txt'), '- 새 기능 하나\n');
  writeSumsAndSign(r.dir, [r.name, 'release-notes.txt'], key);
  fs.rmSync(path.join(r.dir, PUB));
  host.deps.fetch = async (url) => { const file = path.join(r.dir, path.posix.basename(url)); return fs.existsSync(file) ? { ok: true, arrayBuffer: async () => fs.readFileSync(file) } : { ok: false, status: 404 }; };
  const from = 'https://rel.example/v2';
  const checked = await update({ ...o, from, check: true }, host.deps);
  assert.deepEqual([checked.available, checked.notes, checked.bundle], ['2.0.0', '- 새 기능 하나\n', r.name]);
  // the notes file swapped after signing: dropped (the release itself is still reported)
  const swapped = async (url) => (url.endsWith('release-notes.txt') ? { ok: true, arrayBuffer: async () => Buffer.from('<script>x</script>') } : host.deps.fetch(url));
  assert.equal((await update({ ...o, from, check: true }, { ...host.deps, fetch: swapped })).notes, null);
  // no notes listed: none
  const plain = makeRelease('2.0.0');
  assert.equal((await update({ ...o, from: plain.dir, check: true }, host.deps)).notes, null);
  // --check --json: exactly one JSON line, nothing else printed
  host.printed.length = 0;
  assert.equal(await main(['update', '--check', '--json', '--root', o.root, '--from', from], host.deps), 0);
  assert.equal(host.printed.length, 1);
  assert.deepEqual(JSON.parse(host.printed[0]), { v: 1, current: '1.0.0', available: '2.0.0', failed: false, bundle: r.name, notes: '- 새 기능 하나\n' });
});
