// node --test cld/install/manager.test.mjs  (no real service manager, daemon or HOME is touched)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { PUB, SIG, SUMS, writeSumsAndSign } from '../release/bundle/sign.mjs';
import { currentOs, sha256File } from '../release/bundle/verify.mjs';
import { acquireLock, desktopApp, endDaemonCommand, inside, install, launchers, newRecord, readCurrent, readRecord, realDeps, renderService, repairCliLinks, revertAdoption, serviceNodeDirs, serviceOp, switchCurrent, uninstall, update, userNodeDir, versionDir, writeRecord } from './manager.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `manager-${name}-`));
const key = crypto.generateKeyPairSync('ed25519').privateKey;

/** A tiny signed bundle: manifest.json + stub node and dist/cli.js (the fake runner never executes them). */
function makeBundle(version) {
  const stage = tmp('stage');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true }); fs.writeFileSync(path.join(stage, rel), text); };
  write('node/bin/node', '#!/bin/sh\n');
  write('dist/cli.js', `// ${version}\n`);
  write('cld/bin/cld-gui', '// cli\n');
  const files = Object.fromEntries(['node/bin/node', 'dist/cli.js', 'cld/bin/cld-gui'].map((rel) => [rel, sha256File(path.join(stage, rel))]));
  write('manifest.json', JSON.stringify({ version, protocol: 1, dataSchema: {}, os: currentOs(), arch: process.arch, node: { path: 'node/bin/node' }, entry: 'dist/cli.js', files }));
  const out = tmp('bundle');
  const name = `agent-tycoon-daemon-${version}-${currentOs()}-${process.arch}.tar.gz`;
  assert.equal(spawnSync('tar', ['-cf', path.join(out, 'b.tar'), '-C', stage, '.']).status, 0);
  fs.writeFileSync(path.join(out, name), zlib.gzipSync(fs.readFileSync(path.join(out, 'b.tar'))));
  fs.rmSync(path.join(out, 'b.tar'));
  writeSumsAndSign(out, [name], key);
  return { from: path.join(out, name), sums: path.join(out, SUMS), sig: path.join(out, SIG), pub: path.join(out, PUB) };
}

/** Fake effects: commands are recorded, self-test fails for `badTest`, health answers the version `current` points at unless it is `badHealth` or the service was stopped. */
function fakeDeps({ home, root, badTest = [], badHealth = [] }) {
  const calls = [];
  let stopped = false;
  const deps = {
    platform: 'linux', home, env: { PATH: '/usr/bin:/bin' }, uid: 1000, print: () => {},
    run: async (cmd) => {
      calls.push(cmd.join(' '));
      if (cmd.includes('--self-test')) return { ok: !badTest.some((v) => cmd[0].includes(`/versions/${v}/`)), stdout: 'self-test', stderr: '' };
      if (cmd.join(' ') === 'systemctl --user stop agent-tycoon') stopped = true;
      if (cmd.join(' ') === 'systemctl --user restart agent-tycoon') stopped = false;
      return { ok: true, stdout: '', stderr: '' };
    },
    health: async () => { const v = await readCurrent(root, 'linux'); return !stopped && v && !badHealth.includes(v) ? { service: 'cld-gui', version: v, protocol: 1 } : null; },
    tcpFree: async () => true, sleep: async () => {},
  };
  return { deps, calls };
}

test('install record: absent -> null, atomic 0600 write, a broken record is refused and left alone', async () => {
  const root = tmp('record');
  assert.equal(await readRecord(root), null);
  const record = newRecord({ root, installedBy: 'gui', platform: 'wsl', env: { WSL_DISTRO_NAME: 'Ubuntu' } });
  assert.equal(record.wslDistro, 'Ubuntu');
  await writeRecord(root, record);
  assert.equal(fs.statSync(path.join(root, 'install.json')).mode & 0o777, 0o600);
  assert.deepEqual(await readRecord(root), record);
  assert.deepEqual(fs.readdirSync(root), ['install.json']); // no temp file left
  fs.writeFileSync(path.join(root, 'install.json'), '{broken');
  await assert.rejects(readRecord(root), /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(root, 'install.json'), 'utf8'), '{broken');
  assert.throws(() => newRecord({ root, installedBy: 'npm' }), /installed-by/);
});

test('manager lock: one holder, the second reports or waits, a dead holder is taken over', async () => {
  const root = tmp('lock');
  const release = await acquireLock(root, 'install');
  await assert.rejects(acquireLock(root, 'update'), (e) => e.code === 'LOCKED' && /install/.test(e.message) && e.holder.pid === process.pid);
  let waited = 0;
  const second = acquireLock(root, 'update', { wait: 5000, sleep: async () => { waited += 1; await release(); } });
  await (await second)();
  assert.equal(waited, 1);
  fs.writeFileSync(path.join(root, 'manager.lock'), JSON.stringify({ pid: 999999999, op: 'install' }));
  const again = await acquireLock(root, 'update', { alive: () => false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'manager.lock'), 'utf8')).op, 'update');
  await again();
  assert.equal(fs.existsSync(path.join(root, 'manager.lock')), false);
});

test('current pointer: a relative symlink switched atomically (POSIX), a pointer file (Windows)', async () => {
  const root = tmp('pointer');
  const record = newRecord({ root, platform: 'linux' });
  for (const v of ['1.0.0', '1.1.0']) fs.mkdirSync(versionDir(root, v), { recursive: true });
  await switchCurrent(root, '1.0.0', 'linux', record);
  await switchCurrent(root, '1.1.0', 'linux', record);
  assert.equal(fs.readlinkSync(path.join(root, 'current')), path.join('versions', '1.1.0'));
  assert.equal(await readCurrent(root, 'linux'), '1.1.0');
  assert.equal(record.files[path.join(root, 'current')], `symlink:${path.join('versions', '1.1.0')}`);
  await switchCurrent(root, '1.0.0', 'win32', record);
  assert.equal(await readCurrent(root, 'win32'), '1.0.0');
  await assert.rejects(switchCurrent(root, '9.9.9', 'linux', record), /missing/);
});

test('service and launchers run the private Node of current; PATH carries the user Node, never ours', () => {
  const root = '/home/u/.local/share/agent-tycoon';
  const manifest = { node: { path: 'node/bin/node' }, entry: 'dist/cli.js' };
  const s = renderService({ platform: 'linux', home: '/home/u', root, version: '1.0.0', manifest, config: { port: 18257, readOnly: true, engine: 'off', allowedHosts: [], tailscaleUsers: [] }, pathNodeDir: '/home/u/.nvm/versions/node/v22/bin' });
  assert.equal(s.file, '/home/u/.config/systemd/user/agent-tycoon.service');
  assert.match(s.content, /ExecStart=\/home\/u\/.local\/share\/agent-tycoon\/current\/node\/bin\/node --max-semi-space-size=1 \/home\/u\/.local\/share\/agent-tycoon\/current\/dist\/cli.js --port 18257/);
  assert.match(s.content, /Environment=PATH=\/home\/u\/.local\/bin:\/home\/u\/.nvm\/versions\/node\/v22\/bin:\/usr\/local\/bin/);
  assert.doesNotMatch(s.content, /current\/node\/bin:/);
  const win = (startPolicy) => renderService({ platform: 'win32', home: 'C:\\Users\\u', root: 'C:\\AT', version: '1.0.0', manifest: { node: { path: 'node/node.exe' } }, config: { port: 1, readOnly: true, engine: 'off', allowedHosts: [], tailscaleUsers: [] }, startPolicy });
  // R5: a per-user task (Register-ScheduledTask, no admin) runs our VBS hidden. Only always starts it at logon.
  for (const [policy, triggered] of [['on-demand', false], ['always', true], ['manual', false]]) {
    const script = Buffer.from(win(policy).create.at(-1), 'base64').toString('utf16le');
    assert.match(script, /New-ScheduledTaskAction -Execute 'wscript\.exe' -Argument '\/\/B \/\/Nologo "C:\\AT.bin.agent-tycoon-daemon\.vbs"'/);
    assert.equal(script.includes('-AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"'), triggered, policy);
    assert.equal(script.includes('Register-ScheduledTask -TaskName \'agent-tycoon\' -Action $a -Trigger $t'), triggered, policy);
    assert.match(script, /-RestartCount 3 .*-ExecutionTimeLimit \(\[TimeSpan\]::Zero\) -MultipleInstances IgnoreNew/);
  }
  const windowsService = win('on-demand');
  const script = Buffer.from(windowsService.create.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Register-ScheduledTask -TaskName 'agent-tycoon' .* -Force/);
  assert.match(windowsService.file, /agent-tycoon-daemon\.vbs$/);
  assert.deepEqual([...windowsService.content.subarray(0, 2)], [0xff, 0xfe]);
  const vbs = windowsService.content.subarray(2).toString('utf16le');
  assert.ok(vbs.includes('WScript.Quit sh.Run("%SystemRoot%\\System32\\cmd.exe /d /v:off /s /c """"C:\\AT'), vbs);
  assert.match(vbs, /versions.1\.0\.0.node.node\.exe"" ""--max-semi-space-size=1""/);
  assert.match(vbs, /daemon\.log"" 2>&1""", 0, True\)/);
  assert.throws(() => renderService({ platform: 'win32', home: 'C:\\Users\\100%', root: 'C:\\AT', version: '1.0.0', manifest: { node: { path: 'node/node.exe' } }, config: { port: 1, readOnly: true, engine: 'off', allowedHosts: [] } }), /cannot go in the Windows service/);
  const sh = launchers('/Users/u/Library/Application Support/AgentTycoon', 'darwin', manifest);
  assert.match(sh['agty'], /root='\/Users\/u\/Library\/Application Support\/AgentTycoon'\nexec "\$root\/current\/node\/bin\/node" "\$root\/current\/cld\/bin\/cld-gui" "\$@"/);
  assert.match(launchers('C:\\AT', 'win32', { node: { path: 'node/node.exe' } })['cld-gui.cmd'], /versions\\%AT_VERSION%\\node\\node\.exe/);
  // the user's node is found on PATH, our own install root is skipped
  const bin = tmp('bin'); fs.writeFileSync(path.join(bin, 'node'), '', { mode: 0o755 });
  const ours = path.join(bin, 'root', 'current', 'node', 'bin'); fs.mkdirSync(ours, { recursive: true }); fs.writeFileSync(path.join(ours, 'node'), '', { mode: 0o755 });
  assert.equal(userNodeDir(`${ours}:${bin}`, path.join(bin, 'root'), 'linux'), bin);
});

test('install -> update -> failed health switches back -> failed self-test never switches', async () => {
  const home = tmp('home'); const root = path.join(home, 'root');
  const { deps, calls } = fakeDeps({ home, root, badTest: ['1.3.0'], badHealth: ['1.2.0'] });
  await install({ ...makeBundle('1.0.0'), root, service: 'systemd', port: 18257 }, deps);
  let record = await readRecord(root);
  assert.equal(record.current, '1.0.0');
  assert.equal(fs.readlinkSync(path.join(root, 'current')), path.join('versions', '1.0.0'));
  const unit = path.join(home, '.config/systemd/user/agent-tycoon.service');
  assert.equal(record.service.file, unit);
  assert.equal(record.files[unit], crypto.createHash('sha256').update(fs.readFileSync(unit)).digest('hex'));
  for (const name of ['agty', 'cld-gui']) {
    const file = path.join(root, 'bin', name);
    assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    assert.ok(record.files[file]);
  }
  assert.ok(calls.includes('systemctl --user enable agent-tycoon') && calls.includes('systemctl --user restart agent-tycoon'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.config/cld-gui/config.json'), 'utf8')).port, 18257);
  assert.equal(fs.existsSync(path.join(root, 'manager.lock')), false);

  await update(makeBundle('1.1.0'), { ...deps, env: { ...deps.env, AGENT_TYCOON_ROOT: root } });
  record = await readRecord(root);
  assert.deepEqual([record.current, record.previous], ['1.1.0', '1.0.0']);

  await assert.rejects(update(makeBundle('1.2.0'), { ...deps, env: { ...deps.env, AGENT_TYCOON_ROOT: root } }), /failed health: 1\.2\.0 did not answer on port 18257\); back on 1\.1\.0 \(healthy\)/);
  record = await readRecord(root);
  assert.equal(record.current, '1.1.0');
  assert.equal(await readCurrent(root, 'linux'), '1.1.0');
  assert.deepEqual(record.failedVersions, ['1.2.0']);
  await assert.rejects(update(makeBundle('1.2.0'), { ...deps, env: { ...deps.env, AGENT_TYCOON_ROOT: root } }), /failed before; pass --force/);

  await assert.rejects(update(makeBundle('1.3.0'), { ...deps, env: { ...deps.env, AGENT_TYCOON_ROOT: root } }), /self-test of 1\.3\.0 failed; still on 1\.1\.0/);
  assert.equal(await readCurrent(root, 'linux'), '1.1.0');
  assert.equal(fs.existsSync(versionDir(root, '1.3.0')), false);
  assert.equal((await readRecord(root)).versions['1.3.0'], undefined);
});

test('a tampered bundle is refused before anything is unpacked', async () => {
  const home = tmp('home'); const root = path.join(home, 'root');
  const b = makeBundle('1.0.0');
  fs.appendFileSync(b.from, 'x');
  await assert.rejects(install({ ...b, root, service: 'none' }, fakeDeps({ home, root }).deps), /SHA-256 does not match/);
  assert.equal(fs.existsSync(path.join(root, 'versions')), false);
});

test('adopting the source install: service switched, links retargeted, data untouched; revert puts it all back', async () => {
  const home = tmp('home'); const root = path.join(home, 'root');
  const repo = path.join(home, 'src', 'cld-gui');
  const oldUnit = path.join(home, '.config/systemd/user/cld-gui.service');
  const oldText = `[Service]\nWorkingDirectory=${repo}\nExecStart=/usr/bin/node ${repo}/dist/cli.js --port 18240\n`;
  fs.mkdirSync(path.dirname(oldUnit), { recursive: true }); fs.writeFileSync(oldUnit, oldText);
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'cld/bin/cld-gui'), path.join(home, '.local/bin/cld-gui'));
  fs.symlinkSync('/usr/bin/true', path.join(home, '.local/bin/cld')); // someone else's: left alone
  fs.mkdirSync(path.join(home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/cld-gui/projects.json'), '{"keep":true}');
  const { deps, calls } = fakeDeps({ home, root });

  await install({ ...makeBundle('1.0.0'), root, service: 'systemd' }, deps);
  const record = await readRecord(root);
  assert.equal(fs.existsSync(oldUnit), false);
  assert.equal(fs.readFileSync(record.adopted.service.backup, 'utf8'), oldText);
  assert.ok(calls.indexOf('systemctl --user disable --now cld-gui') < calls.indexOf('systemctl --user enable agent-tycoon'));
  assert.equal(fs.readlinkSync(path.join(home, '.local/bin/cld-gui')), path.join(root, 'bin', 'cld-gui'));
  assert.equal(fs.readlinkSync(path.join(home, '.local/bin/cld')), '/usr/bin/true');
  assert.equal(record.adopted.from, 'source');
  assert.equal(record.port, 18240); // the old config's port (default), data dir untouched
  assert.equal(fs.readFileSync(path.join(home, '.config/cld-gui/projects.json'), 'utf8'), '{"keep":true}');
  // a second install does not adopt again
  await install({ ...makeBundle('1.0.0'), root, service: 'systemd' }, deps);
  assert.equal((await readRecord(root)).adopted.at, record.adopted.at);

  const again = await readRecord(root);
  await revertAdoption({ root, record: again, deps });
  assert.equal(fs.readFileSync(oldUnit, 'utf8'), oldText);
  assert.equal(fs.existsSync(path.join(home, '.config/systemd/user/agent-tycoon.service')), false);
  assert.equal(fs.readlinkSync(path.join(home, '.local/bin/cld-gui')), path.join(repo, 'cld/bin/cld-gui'));
  assert.ok(calls.at(-1) === 'systemctl --user restart cld-gui' && calls.includes('systemctl --user disable --now agent-tycoon'));
  assert.equal(again.adopted, null);
});

test('P7 test mode: a test host beside the live one never adopts the old service and asks health only on its own port', async () => {
  const home = tmp('home'); const root = path.join(home, 'root');
  const oldUnit = path.join(home, '.config/systemd/user/cld-gui.service');
  const oldText = `[Service]\nWorkingDirectory=/src/cld-gui\nExecStart=/usr/bin/node /src/cld-gui/dist/cli.js --port 18240\n`;
  fs.mkdirSync(path.dirname(oldUnit), { recursive: true }); fs.writeFileSync(oldUnit, oldText);
  const { deps, calls } = fakeDeps({ home, root });
  const ports = [];
  const health = deps.health;
  deps.platform = 'wsl';
  deps.health = async (port) => { ports.push(port); return health(port); };
  deps.sideRecords = async () => { throw new Error('test mode read the other side'); };
  await install({ ...makeBundle('1.0.0'), root, service: 'systemd', port: 18250, allowSecondHost: true }, deps);
  assert.equal((await readRecord(root)).adopted, null);
  assert.equal(fs.readFileSync(oldUnit, 'utf8'), oldText);
  assert.ok(!calls.some((c) => c.includes('cld-gui.service') || c.includes(' cld-gui')));
  assert.deepEqual([...new Set(ports)], [18250]);
});

test('a foreign cld-gui.service is not adopted', async () => {
  const home = tmp('home'); const root = path.join(home, 'root');
  const unit = path.join(home, '.config/systemd/user/cld-gui.service');
  fs.mkdirSync(path.dirname(unit), { recursive: true }); fs.writeFileSync(unit, '[Service]\nExecStart=/opt/other\n');
  await install({ ...makeBundle('1.0.0'), root, service: 'dry-run' }, fakeDeps({ home, root }).deps);
  assert.equal(fs.readFileSync(unit, 'utf8'), '[Service]\nExecStart=/opt/other\n');
  assert.equal((await readRecord(root)).adopted, null);
});

function daemonFor(home) {
  return { pid: 1234, port: 18257, entry: path.join(home, 'install', 'versions', '1.0.0', 'dist', 'cli.js') };
}
function ownStatus(home, status) {
  return status && { ...status, daemon: status.daemon ?? daemonFor(home) };
}
function uninstallDeps(home, status = { ok: true, projects: [], jobs: [], tasks: [] }) {
  const calls = [];
  const controlCalls = [];
  return {
    calls, controlCalls,
    platform: 'linux', home, env: { PATH: '', AGENT_TYCOON_ROOT: path.join(home, 'install') }, uid: 1000, print: (line) => calls.push(String(line)),
    run: async () => ({ ok: true, stdout: '', stderr: '' }), sleep: async () => {},
    control: async (cmd) => { controlCalls.push(cmd); return cmd === 'stop-agents' ? { ok: true, stopped: [], left: [] } : ownStatus(home, status); },
    confirm: async () => true, chooseAgents: async () => 'stop',
    revertLedger: async (_targetHome, { dryRun = false } = {}) => {
      calls.push(dryRun ? 'ledger-plan' : 'ledger');
      return { ok: true, file: path.join(home, '.config', 'cld-gui', 'exposure.json'), entries: [] };
    },
  };
}

async function managerRecord(home) {
  const root = path.join(home, 'install');
  fs.mkdirSync(root, { recursive: true });
  const owned = path.join(root, 'owned'); const changed = path.join(root, 'changed');
  fs.writeFileSync(owned, 'ours'); fs.writeFileSync(changed, 'changed by user');
  const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const record = newRecord({ root, platform: 'linux' });
  record.service = { name: 'agent-tycoon', kind: 'none', file: null };
  record.port = 18257; record.current = '1.0.0';
  const version = path.join(root, 'versions', '1.0.0');
  fs.mkdirSync(path.join(version, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(version, 'dist', 'cli.js'), '// installed daemon\n');
  record.versions['1.0.0'] = { dir: version, manifestSha256: 'not-used-in-this-fixture' };
  record.files = { [owned]: digest('ours'), [changed]: digest('original') };
  await writeRecord(root, record);
  return { root, owned, changed };
}

test('uninstall --if-installed-by only removes the matching manager install', async () => {
  const guiHome = tmp('uninstall-owned-by-gui'); const { root: guiRoot } = await completeInstall(guiHome);
  const guiRecord = await readRecord(guiRoot); guiRecord.installedBy = 'gui'; await writeRecord(guiRoot, guiRecord);
  const gui = uninstallDeps(guiHome);
  assert.equal((await uninstall({ program: true, yes: true, ifInstalledBy: 'gui' }, gui)).code, 0);
  assert.equal(fs.existsSync(path.join(guiRoot, 'install.json')), false);

  const cliHome = tmp('uninstall-owned-by-cli'); const { root: cliRoot } = await completeInstall(cliHome);
  const cli = uninstallDeps(cliHome);
  assert.equal((await uninstall({ program: true, yes: true, ifInstalledBy: 'gui' }, cli)).code, 0);
  assert.equal((await readRecord(cliRoot)).installedBy, 'cli');
  assert.deepEqual(cli.calls, ['설치 기록이 없거나 gui 설치가 아니어서 제거하지 않았습니다']);

  const absentHome = tmp('uninstall-without-record'); const absent = uninstallDeps(absentHome);
  assert.equal((await uninstall({ program: true, yes: true, ifInstalledBy: 'gui' }, absent)).code, 0);
  assert.equal(fs.existsSync(path.join(absentHome, 'install')), false);
  assert.deepEqual(absent.calls, ['설치 기록이 없거나 gui 설치가 아니어서 제거하지 않았습니다']);
});

async function recordedVersion(root, text = '// untouched\n') {
  const dir = path.join(root, 'versions', '1.0.0');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  const entry = path.join(dir, 'dist', 'cli.js'); fs.writeFileSync(entry, text);
  const manifest = { files: { 'dist/cli.js': sha256File(entry) } };
  const manifestFile = path.join(dir, 'manifest.json'); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const record = await readRecord(root);
  record.versions = { '1.0.0': { dir, manifestSha256: sha256File(manifestFile) } };
  await writeRecord(root, record);
  return { dir, entry };
}

test('uninstall program removes only recorded, unchanged files', async () => {
  const home = tmp('uninstall-program'); const { root, owned, changed } = await managerRecord(home);
  const nextDoor = path.join(root, 'next-door'); fs.writeFileSync(nextDoor, 'keep');
  const result = await uninstall({ program: true, yes: true }, uninstallDeps(home));
  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.readFileSync(changed, 'utf8'), 'changed by user');
  assert.equal(fs.readFileSync(nextDoor, 'utf8'), 'keep');
  const left = await readRecord(root);
  assert.deepEqual(left.files, { [changed]: crypto.createHash('sha256').update('original').digest('hex') });
  assert.ok(left.versions['1.0.0']);
  assert.ok(result);
});

test('uninstall removes the Windows logon task and the linger we turned on (R1/P6)', async () => {
  const home = tmp('uninstall-autostart'); const { root } = await managerRecord(home);
  const record = await readRecord(root);
  record.wslDistro = 'Ubuntu-Test'; record.startPolicy = 'always';
  record.logonTask = { name: 'agent-tycoon-wsl-Ubuntu-Test', distro: 'Ubuntu-Test' }; record.linger = { user: 'owner', distro: 'Ubuntu-Test' };
  await writeRecord(root, record);
  const fake = uninstallDeps(home); fake.platform = 'wsl';
  const runs = []; fake.run = async (cmd) => { runs.push(cmd.join(' ')); return { ok: true, stdout: '', stderr: '' }; };
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.equal(runs.length, 2);
  assert.match(Buffer.from(runs[0].split(' ').at(-1), 'base64').toString('utf16le'), /Unregister-ScheduledTask -TaskName 'agent-tycoon-wsl-Ubuntu-Test'[\s\S]*hold-Ubuntu-Test\.vbs/); // the task and its holder script
  assert.equal(runs[1], 'wsl.exe -d Ubuntu-Test -u root --exec loginctl disable-linger owner');
  assert.ok(fake.calls.some((line) => line.includes('Windows 로그온 작업 agent-tycoon-wsl-Ubuntu-Test과 홀더 스크립트 삭제') && line.includes('우리가 켠 linger(owner) 끄기')));
});

test('uninstall leaves a linger it did not turn on', async () => {
  const home = tmp('uninstall-foreign-linger'); await managerRecord(home);
  const fake = uninstallDeps(home);
  const runs = []; fake.run = async (cmd) => { runs.push(cmd.join(' ')); return { ok: true, stdout: '', stderr: '' }; };
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.deepEqual(runs, []);
});

test('an agent session cannot uninstall', async () => {
  const home = tmp('uninstall-agent'); const { owned } = await managerRecord(home);
  const fake = uninstallDeps(home);
  fake.env.CLD_AGENT_TOKEN = 'agent-token';
  const result = await uninstall({ program: true, yes: true }, fake);
  assert.equal(result.code, 2);
  assert.equal(fs.existsSync(owned), true);
  assert.ok(fake.calls.some((line) => line.includes('에이전트 세션 안에서는 제거할 수 없어요')));
});

test('uninstall --yes cancels when a possibly live daemon will not answer status', async () => {
  const home = tmp('uninstall-unknown'); const { owned } = await managerRecord(home);
  const fake = uninstallDeps(home, null);
  fake.socketExists = () => true;
  fake.control = async () => null;
  const result = await uninstall({ program: true, yes: true }, fake);
  assert.equal(result.code, 3);
  assert.equal(fs.existsSync(owned), true);
  assert.ok(fake.calls.includes('1. 실행 중 에이전트: 확인하지 못함 (데몬이 응답하지 않음)'));
});

test('uninstall refuses a socket daemon belonging to another install', async () => {
  const home = tmp('uninstall-other-daemon'); const { owned } = await managerRecord(home);
  const other = path.join(home, 'other', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, '// source daemon\n');
  const fake = uninstallDeps(home, { ok: true, projects: [], jobs: [], tasks: [], daemon: { pid: 22, port: 18257, entry: other } });
  const result = await uninstall({ program: true, yes: true, stopAgents: true }, fake);
  assert.equal(result.code, 3);
  assert.equal(fs.existsSync(owned), true);
  assert.equal(fake.controlCalls.includes('stop-agents'), false);
  assert.ok(fake.calls.some((line) => line.includes(`포트 18257, 엔트리 ${other}`)));
});

test('uninstall keeps a recorded file when its install-root parent became a symlink', async () => {
  const home = tmp('uninstall-symlink-parent'); const { root } = await managerRecord(home);
  const outside = tmp('outside-bin'); const redirected = path.join(outside, 'agent-tycoon');
  fs.writeFileSync(redirected, 'ours');
  fs.symlinkSync(outside, path.join(root, 'bin'));
  const record = await readRecord(root);
  record.files[path.join(root, 'bin', 'agent-tycoon')] = crypto.createHash('sha256').update('ours').digest('hex');
  await writeRecord(root, record);
  const fake = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.equal(fs.readFileSync(redirected, 'utf8'), 'ours');
  assert.ok(fake.calls.includes(`   남김(설치 폴더 밖을 가리킴): ${path.join(root, 'bin', 'agent-tycoon')}`));
});

test('uninstall keeps a recorded version replaced by an outside symlink', async () => {
  const home = tmp('uninstall-version-symlink'); const { root } = await managerRecord(home);
  const outside = tmp('outside-version'); const entry = path.join(outside, 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '// ours\n');
  const manifest = path.join(outside, 'manifest.json'); fs.writeFileSync(manifest, JSON.stringify({ files: { 'dist/cli.js': sha256File(entry) } }));
  const logical = path.join(root, 'versions', '1.0.0'); fs.rmSync(logical, { recursive: true, force: true }); fs.symlinkSync(outside, logical);
  const record = await readRecord(root); record.versions = { '1.0.0': { dir: logical, manifestSha256: sha256File(manifest) } }; await writeRecord(root, record);
  const fake = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 3); // the same outside daemon cannot be trusted
  assert.equal(fs.readFileSync(entry, 'utf8'), '// ours\n');
  assert.ok(fake.calls.includes(`   남김(설치 폴더 밖을 가리킴): ${logical}`));
});

/** A complete install: a version folder (manifest + dist/cli.js + two more files) and the `current` pointer, nothing else. */
async function completeInstall(home, root = path.join(home, 'install')) {
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, 'versions', '1.0.0');
  const rels = ['dist/cli.js', 'lib/a.js', 'lib/b.js'];
  for (const rel of rels) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), `// ${rel}\n`); }
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ files: Object.fromEntries(rels.map((rel) => [rel, sha256File(path.join(dir, rel))])) }));
  const record = newRecord({ root, platform: 'linux' });
  record.service = { name: 'agent-tycoon', kind: 'none', file: null };
  record.port = 18257; record.current = '1.0.0';
  record.versions['1.0.0'] = { dir, manifestSha256: sha256File(manifestFile) };
  await switchCurrent(root, '1.0.0', 'linux', record);
  await writeRecord(root, record);
  return { root, dir, rels };
}

test('uninstall --program removes a complete, unchanged version folder, the pointer and the record', async () => {
  const home = tmp('uninstall-complete'); const { root, dir } = await completeInstall(home);
  const fake = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(path.join(root, 'versions')), false);
  assert.equal(fs.lstatSync(path.join(root, 'current'), { throwIfNoEntry: false }), undefined);
  assert.equal(fs.existsSync(path.join(root, 'install.json')), false);
  assert.equal(fs.existsSync(root), false); // the lock is released first, so the empty root goes too
  assert.ok(fake.calls.includes('✔ 프로그램 제거 완료'));
});

test('uninstall keeps a changed file in a version folder with its manifest, deletes the rest, and a second run reports it again', async () => {
  const home = tmp('uninstall-version-changed'); const { root, dir } = await completeInstall(home);
  fs.writeFileSync(path.join(dir, 'lib', 'b.js'), '// changed by user\n');
  const fake = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['lib', 'manifest.json']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'lib')), ['b.js']);
  assert.equal(fs.readFileSync(path.join(dir, 'lib', 'b.js'), 'utf8'), '// changed by user\n');
  assert.ok(fake.calls.includes(`   남김(직접 고친 파일): ${path.join(dir, 'lib', 'b.js')}`));
  const left = await readRecord(root);
  assert.deepEqual(Object.keys(left.versions), ['1.0.0']);
  assert.deepEqual(left.files, {});
  assert.equal(left.current, null); // the `current` link was deleted, so the record no longer names a current version
  assert.equal(fs.lstatSync(path.join(root, 'current'), { throwIfNoEntry: false }), undefined);
  const again = uninstallDeps(home, null);
  assert.equal((await uninstall({ program: true, yes: true }, again)).code, 0);
  assert.ok(again.calls.includes(`   남김(직접 고친 파일): ${path.join(dir, 'lib', 'b.js')}`));
  assert.equal(fs.readFileSync(path.join(dir, 'lib', 'b.js'), 'utf8'), '// changed by user\n');
  assert.deepEqual(Object.keys((await readRecord(root)).versions), ['1.0.0']);
});

test('a symlinked install root is resolved once: versions are removed, then the emptied target and its link', async () => {
  const home = tmp('uninstall-symlink-root'); const real = path.join(home, 'real-install'); const link = path.join(home, 'install');
  fs.mkdirSync(real); fs.symlinkSync(real, link);
  const { dir } = await completeInstall(home, link);
  const fake = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.equal(fs.existsSync(path.join(real, 'versions')), false);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(real), false);
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
  assert.ok(fake.calls.includes('✔ 프로그램 제거 완료'));
});

test('a symlinked install root that still holds something is left, said so, and nothing throws', async () => {
  const home = tmp('uninstall-symlink-root-left'); const real = path.join(home, 'real-install'); const link = path.join(home, 'install');
  fs.mkdirSync(real); fs.symlinkSync(real, link);
  await completeInstall(home, link);
  fs.writeFileSync(path.join(real, 'someone-elses'), 'keep');
  const fake = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.equal(fs.readFileSync(path.join(real, 'someone-elses'), 'utf8'), 'keep');
  assert.equal(fs.readlinkSync(link), real);
  assert.ok(fake.calls.some((line) => line.startsWith('설치 폴더 링크를 그대로 뒀습니다')));
  assert.equal(fs.existsSync(path.join(real, 'manager.lock')), false);
});

test('uninstall stops before files when the service remains active after deactivation', async () => {
  const home = tmp('uninstall-service-still-live'); const { root, owned } = await managerRecord(home);
  const record = await readRecord(root); record.service = { name: 'agent-tycoon', kind: 'systemd', file: null }; await writeRecord(root, record);
  const fake = uninstallDeps(home);
  fake.health = async () => ({ service: 'cld-gui' });
  fake.serviceActive = async () => true;
  const result = await uninstall({ program: true, yes: true }, fake);
  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(owned), true);
  assert.ok(fake.calls.some((line) => line.includes('아직 실행 중이라 제거를 멈췄습니다')));
});

test('an unreadable exposure ledger stops uninstall unless --yes explicitly ignores it', async () => {
  const home = tmp('uninstall-bad-ledger'); const { owned } = await managerRecord(home);
  const ledger = path.join(home, '.config', 'cld-gui', 'exposure.json');
  const fake = uninstallDeps(home);
  fake.revertLedger = async () => ({ ok: false, unreadable: true, file: ledger, entries: [] });
  const blocked = await uninstall({ program: true, yes: true }, fake);
  assert.equal(blocked.code, 1);
  assert.equal(fs.existsSync(owned), true);
  assert.ok(fake.calls.includes(`⚠ 바깥 노출 기록을 읽지 못했어요: ${ledger}`));
  const allowed = uninstallDeps(home);
  allowed.revertLedger = async () => ({ ok: false, unreadable: true, file: ledger, entries: [] });
  assert.equal((await uninstall({ program: true, yes: true, ignoreExposure: true }, allowed)).code, 0);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(allowed.calls.includes('✔ 바깥 노출을 닫았습니다'), false);
});

test('the uninstall plan names the recorded exposures', async () => {
  const home = tmp('uninstall-exposure-plan'); await managerRecord(home);
  const fake = uninstallDeps(home);
  fake.revertLedger = async () => ({ ok: true, file: 'ledger', entries: [{ kind: 'tailscale' }, { kind: 'tunnel' }] });
  await uninstall({ program: true, dryRun: true }, fake);
  assert.ok(fake.calls.includes('2. 바깥 노출: tailscale, tunnel'));
});

test('the ledger plan is quiet in a real run; its DRY-RUN line belongs to --dry-run only', async (t) => {
  const home = tmp('uninstall-ledger-quiet'); await managerRecord(home);
  const asked = [];
  for (const dryRun of [false, true]) {
    const fake = uninstallDeps(home);
    fake.revertLedger = async (_home, opts = {}) => { if (opts.dryRun) asked.push([dryRun, opts.quiet]); return { ok: true, file: 'ledger', entries: [] }; };
    await uninstall({ program: true, dryRun, yes: true }, fake);
  }
  assert.deepEqual(asked, [[false, true], [true, false]]); // [--dry-run?, quiet?] of the plan's ledger question
  // the real ledger code honours it
  const file = path.join(home, '.config', 'cld-gui', 'exposure.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, entries: [{ kind: 'portproxy', externalPort: 1, directPort: 2 }] }));
  const log = t.mock.method(console, 'log', () => {});
  const real = realDeps({ home });
  assert.equal((await real.revertLedger(home, { dryRun: true, quiet: true })).entries.length, 1);
  assert.equal(log.mock.callCount(), 0);
  await real.revertLedger(home, { dryRun: true });
  assert.match(String(log.mock.calls[0].arguments[0]), /^DRY-RUN: 노출 장부 되돌리기 \(portproxy\)/);
  assert.equal(fs.existsSync(file), true);
});

test('the plan says whether no daemon answered or another install\'s daemon did', async () => {
  const home = tmp('uninstall-line1'); await managerRecord(home);
  const none = uninstallDeps(home, null); none.socketExists = () => true; none.control = async () => null;
  await uninstall({ program: true, dryRun: true }, none);
  assert.ok(none.calls.includes('1. 실행 중 에이전트: 확인하지 못함 (데몬이 응답하지 않음)'));
  const other = uninstallDeps(home, { ok: true, projects: [], jobs: [], tasks: [], daemon: { pid: 9, port: 18999, entry: '/elsewhere/dist/cli.js' } });
  await uninstall({ program: true, dryRun: true }, other);
  assert.ok(other.calls.includes('1. 실행 중 에이전트: 확인하지 못함 (다른 설치의 데몬이 응답함: 포트 18999, 엔트리 /elsewhere/dist/cli.js)'));
  assert.equal(other.calls.some((line) => line.includes('응답하지 않음')), false);
});

test('uninstall reset removes only our data, never Claude/Codex or projects', async () => {
  const home = tmp('uninstall-reset'); await managerRecord(home);
  fs.mkdirSync(path.join(home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/cld-gui', 'data'), 'ours');
  fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pixel-agents', 'standalone-state.json'), '{}');
  fs.writeFileSync(path.join(home, '.pixel-agents', 'standalone-token'), 'token');
  fs.writeFileSync(path.join(home, '.pixel-agents', 'server.json'), JSON.stringify({ port: null }));
  fs.mkdirSync(path.join(home, '.pixel-agents', 'servers'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pixel-agents', 'servers', '111-18257.json'), '{}');
  fs.writeFileSync(path.join(home, '.pixel-agents', 'servers', '222-18258.json'), '{}');
  fs.writeFileSync(path.join(home, '.pixel-agents', 'layout.json'), '{}');
  for (const dir of ['.claude', '.codex', 'project']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const result = await uninstall({ reset: true, yes: true }, uninstallDeps(home));
  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(path.join(home, '.config/cld-gui')), false);
  assert.equal(fs.existsSync(path.join(home, '.pixel-agents', 'standalone-state.json')), false);
  assert.equal(fs.existsSync(path.join(home, '.pixel-agents', 'server.json')), true); // null is never our numeric port
  assert.equal(fs.existsSync(path.join(home, '.pixel-agents', 'servers', '111-18257.json')), false);
  assert.equal(fs.existsSync(path.join(home, '.pixel-agents', 'servers', '222-18258.json')), true);
  assert.equal(fs.existsSync(path.join(home, '.pixel-agents', 'layout.json')), true);
  for (const dir of ['.claude', '.codex', 'project']) assert.equal(fs.existsSync(path.join(home, dir)), true);
});

test('uninstall continues reset and records a file Windows still holds', async () => {
  const home = tmp('uninstall-held-file'); const { root, owned } = await managerRecord(home);
  const resetData = path.join(home, '.config', 'cld-gui');
  fs.mkdirSync(resetData, { recursive: true }); fs.writeFileSync(path.join(resetData, 'data'), 'ours');
  const fake = uninstallDeps(home);
  fake.rm = async (file) => {
    if (file === owned) { const error = new Error('busy'); error.code = 'EPERM'; throw error; }
    await fs.promises.rm(file, { force: true });
  };
  const result = await uninstall({ reset: true, yes: true }, fake);
  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(resetData), false);
  assert.equal(fs.existsSync(owned), true);
  assert.ok(fake.calls.includes(`⚠ 삭제하지 못한 파일(${owned}: EPERM)은 실행 중이거나 권한이 없어 남았습니다`));
  assert.equal((await readRecord(root)).files[owned], crypto.createHash('sha256').update('ours').digest('hex'));
});

test('Windows uninstall defers its version and cmd launchers until after reset', async () => {
  const home = tmp('uninstall-windows-helper'); const { root, dir, rels } = await completeInstall(home, path.join(home, "install's"));
  const node = path.join(dir, 'node', 'node.exe'); const manager = path.join(dir, 'cld', 'install', 'manager.mjs');
  const launcher = path.join(root, 'bin', 'agty.cmd');
  for (const [file, content] of [[node, 'node'], [manager, 'manager'], [launcher, '@echo off']]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const file of [node, manager]) manifest.files[path.relative(dir, file)] = sha256File(file);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const record = await readRecord(root); record.versions['1.0.0'].manifestSha256 = sha256File(manifestFile);
  record.files[launcher] = sha256File(launcher); await writeRecord(root, record);
  const resetData = path.join(home, '.config', 'cld-gui'); fs.mkdirSync(resetData, { recursive: true });
  const fake = uninstallDeps(home); fake.platform = 'win32'; fake.execPath = node; fake.managerPath = manager; fake.pid = 4455; fake.systemRoot = 'C:\\Windows';
  fake.control = async () => ({ ok: true, projects: [], jobs: [], tasks: [], daemon: { pid: 1234, port: 18257, entry: path.join(dir, 'dist', 'cli.js') } });
  const removed = []; const spawned = []; let unref = false;
  fake.rm = async (file) => { removed.push(file); await fs.promises.rm(file, { force: true }); };
  fake.spawn = (command, args, options) => {
    assert.equal(fs.existsSync(resetData), false);
    spawned.push({ command, args, options });
    return { unref: () => { unref = true; } };
  };
  const result = await uninstall({ reset: true, yes: true, root }, fake);
  assert.equal(result.code, 0);
  assert.deepEqual(removed.filter((file) => inside(dir, file) || file === launcher), []);
  assert.deepEqual(spawned, [{
    command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoProfile', '-Command', `Wait-Process -Id 4455 -Timeout 60 -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '${root.replaceAll("'", "''")}' -Recurse -Force -ErrorAction SilentlyContinue`],
    options: { detached: true, stdio: 'ignore', windowsHide: true },
  }]);
  assert.equal(unref, true);
  assert.ok(fake.calls.includes('✔ 이 창이 닫히면 나머지 프로그램 파일을 제거합니다'));
  assert.equal(fs.existsSync(resetData), false);
  assert.equal(fs.existsSync(path.join(dir, rels[0])), true);
});

test('non-Windows uninstall does not start the Windows removal helper', async () => {
  const home = tmp('uninstall-no-windows-helper'); await managerRecord(home);
  const fake = uninstallDeps(home); let spawned = false;
  fake.spawn = () => { spawned = true; return { unref: () => {} }; };
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.equal(spawned, false);
});

test('uninstall running agents require --stop-agents and poll until none remain', async () => {
  const active = { ok: true, projects: [{ name: 'alpha', state: 'on' }], jobs: [], tasks: [] };
  const home = tmp('uninstall-running'); const { owned } = await managerRecord(home);
  const withoutStop = uninstallDeps(home, active);
  assert.equal((await uninstall({ program: true, yes: true }, withoutStop)).code, 3);
  assert.equal(withoutStop.controlCalls.includes('stop-agents'), false);
  assert.equal(fs.existsSync(owned), true);
  assert.equal((await uninstall({ program: true, yes: true, stopAgents: true }, uninstallDeps(home, active))).code, 3);
  assert.equal(fs.existsSync(owned), true);
  const stopping = { ok: true, projects: [], jobs: [], tasks: [] };
  assert.equal((await uninstall({ program: true, yes: true, stopAgents: true }, uninstallDeps(home, stopping))).code, 0);
  assert.equal(fs.existsSync(owned), false);
});

test('a stale Codex task record does not block uninstall', async () => {
  const home = tmp('uninstall-stale-codex'); const { owned } = await managerRecord(home);
  const stale = { ok: true, projects: [], jobs: [], tasks: [{ id: 'old-task', state: 'running', pid: 999999999 }] };
  const fake = uninstallDeps(home, stale);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.equal(fs.existsSync(owned), false);
  assert.ok(fake.calls.includes('1. 실행 중 에이전트: 없음 · codex:old-task 멈춘 기록(프로세스 없음)'));
});

test('a Codex task that just started (running, pid not saved yet) counts as running', async () => {
  const fresh = { ok: true, projects: [], jobs: [], tasks: [{ id: 'new-task', state: 'running', pid: null }] };
  const home = tmp('uninstall-fresh-codex'); const { owned } = await managerRecord(home);
  const fake = uninstallDeps(home, fresh);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 3);
  assert.equal(fs.existsSync(owned), true);
  assert.ok(fake.calls.some((line) => line.startsWith('1. 실행 중 에이전트: codex:new-task')));
  assert.equal(fake.calls.some((line) => line.includes('멈춘 기록')), false);
});

test('uninstall keeps files when agent replies disappear after an active plan', async () => {
  const active = { ok: true, projects: [{ name: 'alpha', state: 'on' }], jobs: [], tasks: [] };
  const home = tmp('uninstall-lost-after-active'); const { owned } = await managerRecord(home);
  const fake = uninstallDeps(home, active);
  let first = true;
  fake.control = async (cmd) => {
    if (cmd === 'status' && first) { first = false; return ownStatus(home, active); }
    return null;
  };
  const result = await uninstall({ program: true, yes: true, stopAgents: true }, fake);
  assert.equal(result.code, 3);
  assert.equal(fs.existsSync(owned), true);
});

test('uninstall source install and dry run change nothing', async () => {
  const home = tmp('uninstall-source'); const deps = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, deps)).code, 2);
  assert.equal(fs.existsSync(path.join(home, 'install')), false);
  const state = await managerRecord(home);
  assert.equal((await uninstall({ program: true, dryRun: true }, uninstallDeps(home))).code, 0);
  assert.equal(fs.existsSync(state.owned), true);
});

async function linkedRecord(name) {
  const root = tmp(name); const link = path.join(root, 'home-bin', 'cld-gui'); const target = path.join(root, 'bin', 'cld-gui');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'launcher');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const record = newRecord({ root, platform: 'linux' });
  record.cli.links = [link]; record.files[link] = `symlink:${target}`;
  await writeRecord(root, record);
  return { root, link, target, record };
}

test('doctor --fix waits for a running manager operation, then repairs; it never throws LOCKED', async () => {
  const { root, link, target, record } = await linkedRecord('repair-lock');
  const release = await acquireLock(root, 'update');
  const printed = [];
  const waited = await repairCliLinks(record, root, { print: (l) => printed.push(l), sleep: async () => { await release(); } });
  assert.deepEqual(waited.repaired, [link]);
  assert.equal(fs.readlinkSync(link), target);
  fs.rmSync(link);
  const held = await acquireLock(root, 'update');
  const busy = await repairCliLinks(record, root, { lockWait: 0 });
  assert.match(busy.busy, /another manager operation is running: update/);
  assert.deepEqual(busy.repaired, []);
  assert.equal(fs.existsSync(link), false);
  await held();
});

test('doctor --fix reports a folder at the link path as kept instead of throwing', async () => {
  const { root, link, record } = await linkedRecord('repair-folder');
  fs.mkdirSync(path.join(link, 'inner'), { recursive: true });
  const printed = [];
  const result = await repairCliLinks(record, root, { print: (l) => printed.push(l) });
  assert.deepEqual(result, { repaired: [], kept: [link] });
  assert.ok(fs.statSync(path.join(link, 'inner')).isDirectory());
  assert.ok(printed.some((l) => l.includes('a folder')));
  assert.equal(fs.existsSync(path.join(root, 'manager.lock')), false);
});

test('the manager forwards CLD_AGENT_TOKEN in its control request', async () => {
  const home = tmp('control-token'); const socket = path.join(home, '.config', 'cld-gui', 'engine.sock');
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  const seen = [];
  const server = net.createServer((conn) => {
    let text = '';
    conn.on('data', (d) => { text += d; if (text.includes('\n')) { seen.push(JSON.parse(text)); conn.write(`${JSON.stringify({ ok: true })}\n`); } });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  try {
    assert.deepEqual(await realDeps({ home, env: { CLD_AGENT_TOKEN: 'agent-token-1' } }).control('status'), { ok: true });
    assert.deepEqual(await realDeps({ home, env: {} }).control('status'), { ok: true });
  } finally { server.close(); }
  assert.equal(seen[0].token, 'agent-token-1');
  assert.equal(seen[0].cmd, 'status');
  assert.equal(seen[1].token, undefined);
});

test('uninstall cancels when only the status poll after stop-agents goes unanswered', async () => {
  const active = { ok: true, projects: [{ name: 'alpha', state: 'on' }], jobs: [], tasks: [] };
  const home = tmp('uninstall-poll-lost'); const { owned } = await managerRecord(home);
  const fake = uninstallDeps(home, active);
  let statuses = 0;
  fake.control = async (cmd) => {
    fake.controlCalls.push(cmd);
    if (cmd === 'stop-agents') return { ok: true, stopped: [{ kind: 'session', name: 'alpha' }], left: [] };
    statuses += 1;
    return statuses === 1 ? ownStatus(home, active) : null; // the plan sees it; the poll after the stop does not
  };
  const result = await uninstall({ program: true, yes: true, stopAgents: true }, fake);
  assert.equal(result.code, 3);
  assert.deepEqual(fake.controlCalls, ['status', 'stop-agents', 'status']);
  assert.equal(fs.existsSync(owned), true);
  assert.ok(fake.calls.includes('에이전트 중지를 확인하지 못해 제거를 취소했습니다'));
});

test('a version folder recorded through another path to the install root is kept (plain-path check)', async () => {
  const home = tmp('uninstall-version-alias'); const { root, dir, rels } = await completeInstall(home);
  const alias = path.join(home, 'alias'); fs.symlinkSync(root, alias);
  const aliased = path.join(alias, 'versions', '1.0.0');
  const record = await readRecord(root); record.versions['1.0.0'].dir = aliased; await writeRecord(root, record);
  const fake = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  for (const rel of rels) assert.equal(fs.existsSync(path.join(dir, rel)), true);
  assert.ok(fake.calls.includes(`   남김(설치 폴더 밖을 가리킴): ${aliased}`));
});

/** Rewrites a complete install's manifest with `extra` entries (and records its new hash). */
async function withManifest(root, dir, extra) {
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  Object.assign(manifest.files, extra);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const record = await readRecord(root); record.versions['1.0.0'].manifestSha256 = sha256File(manifestFile); await writeRecord(root, record);
}

test('manifest entries that reach outside the version folder are kept, whatever their hashes; the rest goes', async () => {
  const home = tmp('uninstall-escaping-manifest'); const { root, dir, rels } = await completeInstall(home);
  const victim = path.join(home, 'victim'); fs.writeFileSync(victim, 'not ours');
  const outside = tmp('outside-folder'); fs.writeFileSync(path.join(outside, 'f'), 'not ours either');
  fs.symlinkSync(outside, path.join(dir, 'link'));
  await withManifest(root, dir, { '../../../victim': sha256File(victim), 'link/f': sha256File(path.join(outside, 'f')) });
  const fake = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'not ours');
  assert.equal(fs.readFileSync(path.join(outside, 'f'), 'utf8'), 'not ours either');
  assert.ok(fake.calls.includes(`   남김(설치 폴더 밖을 가리킴): ${victim}`));
  assert.ok(fake.calls.includes(`   남김(설치 폴더 밖을 가리킴): ${path.join(dir, 'link', 'f')}`));
  for (const rel of rels) assert.equal(fs.existsSync(path.join(dir, rel)), false);
});

test('a manifest that no longer matches its recorded hash is not trusted: the whole version stays', async () => {
  const home = tmp('uninstall-manifest-changed'); const { root, dir, rels } = await completeInstall(home);
  const stray = path.join(dir, 'notes.txt'); fs.writeFileSync(stray, 'written later');
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); manifest.files['notes.txt'] = sha256File(stray);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest)); // the record still holds the old manifest hash
  const fake = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  for (const rel of [...rels, 'notes.txt', 'manifest.json']) assert.equal(fs.existsSync(path.join(dir, rel)), true);
  assert.ok(fake.calls.includes(`   남김(직접 고친 파일): ${dir}`));
  assert.deepEqual(Object.keys((await readRecord(root)).versions), ['1.0.0']);
});

test('manifest.json is deleted last: a delete that fails midway leaves it, and a re-run finishes', async () => {
  const home = tmp('uninstall-manifest-last'); const { root, dir } = await completeInstall(home);
  const failing = uninstallDeps(home);
  let inVersion = 0;
  failing.rm = async (file) => {
    if (file.startsWith(dir) && (inVersion += 1) === 2) throw new Error('disk error');
    fs.rmSync(file, { force: true });
  };
  await assert.rejects(uninstall({ program: true, yes: true }, failing), /disk error/);
  assert.equal(fs.existsSync(path.join(dir, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'install.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'manager.lock')), false);
  assert.equal((await uninstall({ program: true, yes: true }, uninstallDeps(home, null))).code, 0);
  assert.equal(fs.existsSync(root), false);
});

test('files the manifest does not list are named, not silently left behind', async () => {
  const home = tmp('uninstall-unlisted'); const { root, dir } = await completeInstall(home);
  const runtime = path.join(dir, 'runtime.log'); fs.writeFileSync(runtime, 'written while running');
  const fake = uninstallDeps(home);
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.equal(fs.readFileSync(runtime, 'utf8'), 'written while running');
  assert.ok(fake.calls.includes(`남은 파일(직접 만들어졌거나 목록에 없어서 지우지 않았어요): ${runtime}`));
  assert.equal(fs.existsSync(path.join(root, 'install.json')), false); // nothing recorded remains
  // a clean run says nothing of the kind
  const home2 = tmp('uninstall-unlisted-none'); await completeInstall(home2);
  const quiet = uninstallDeps(home2);
  await uninstall({ program: true, yes: true }, quiet);
  assert.equal(quiet.calls.some((line) => line.startsWith('남은 파일')), false);
});

test('service PATH Node folders: the record first, the updater\'s own added, an older record read from its unit, a folder without agents kept and named', () => {
  const home = tmp('nodedirs');
  const nvm = path.join(home, '.nvm/versions/node/v20/bin'); const fnm = path.join(home, 'fnm/bin');
  for (const d of [nvm, fnm]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(fnm, 'node'), '', { mode: 0o755 }); fs.writeFileSync(path.join(fnm, 'claude'), '');
  const lines = []; const deps = (PATH) => ({ env: { PATH }, home, platform: 'linux', print: (l) => lines.push(l) });
  assert.deepEqual(serviceNodeDirs({ service: { pathNodeDirs: [nvm] } }, deps('/usr/bin'), '/root'), [nvm], 'a shell without Node keeps the record');
  assert.deepEqual(lines, [`! ${nvm} (recorded at install) has no claude or codex now; kept on the service PATH`]);
  assert.deepEqual(serviceNodeDirs({ service: { pathNodeDirs: [nvm] } }, deps(`${fnm}:/usr/bin`), '/root'), [nvm, fnm], 'merged');
  const unit = path.join(home, 'agent-tycoon.service');
  fs.writeFileSync(unit, `[Service]\nEnvironment=PATH=${home}/.local/bin:${fnm}:/usr/local/bin:/usr/bin:/bin\n`);
  assert.deepEqual(serviceNodeDirs({ service: { file: unit } }, deps('/usr/bin'), '/root'), [fnm], 'an older record: the folders in its unit');
  assert.deepEqual(serviceNodeDirs({ service: null }, deps('/usr/bin'), '/root'), [], 'a first install without Node on PATH');
});

test('R5: stopping the Windows service ends the task, then the daemon itself (its pid from health, only if it runs from versions\\), never its tree', async () => {
  const calls = [];
  let up = true;
  const deps = {
    home: tmp('winstop'), platform: 'win32', print: () => {}, sleep: async () => {},
    healthPid: async () => 4321,
    health: async () => (up ? { service: 'cld-gui' } : null),
    run: async (cmd) => { calls.push(cmd); const stopping = cmd[0] === 'powershell.exe'; if (stopping) up = false; return { ok: true, stdout: stopping ? 'stopped\r\n' : '', stderr: '' }; },
  };
  const s = { name: 'agent-tycoon', cwd: 'C:\\AT\\versions\\1.0.0' };
  await serviceOp('schtasks', 'stop', s, deps);
  assert.deepEqual(calls[0], ['schtasks', '/End', '/TN', 'agent-tycoon']);
  assert.deepEqual(calls[1], endDaemonCommand(4321, 'C:\\AT\\versions'));
  const script = Buffer.from(calls[1].at(-1), 'base64').toString('utf16le');
  assert.match(script, /ProcessId=4321/);
  assert.match(script, /IndexOf\('C:\\AT\\versions\\'/);
  assert.match(script, /Stop-Process -Id 4321 -Force/);
  assert.doesNotMatch(script, /taskkill|\/T/);
  // Not ours (another daemon answering, or a reused pid): left running and said so.
  const lines = []; calls.length = 0; up = true;
  await serviceOp('schtasks', 'stop', s, { ...deps, print: (l) => lines.push(l), run: async (cmd) => { calls.push(cmd); return { ok: true, stdout: cmd[0] === 'powershell.exe' ? 'not ours' : '', stderr: '' }; } });
  assert.match(lines.join('\n'), /pid 4321 .* not this install's daemon; left running/);
  // Nothing answers with our token: only the task is ended.
  calls.length = 0;
  await serviceOp('schtasks', 'deactivate', s, { ...deps, healthPid: async () => null });
  assert.deepEqual(calls.map((c) => c.slice(0, 2).join(' ')), ['schtasks /End', 'schtasks /Delete']);
});

test('R5: uninstall takes our folder (only it) back out of the Windows user Path that --add-path added', async () => {
  const home = tmp('uninstall-path'); const { root } = await managerRecord(home);
  const record = await readRecord(root);
  record.cli.pathAdded = { kind: 'windows-user-path', dir: 'C:\\AT\\bin' };
  await writeRecord(root, record);
  const fake = uninstallDeps(home);
  let userPath = 'C:\\Tools;C:\\AT\\bin;C:\\Users\\u\\AppData\\Roaming\\npm';
  fake.winPath = async (update) => { const next = update(userPath); if (next === userPath) return 'same'; userPath = next; return 'written'; };
  assert.equal((await uninstall({ program: true, yes: true }, fake)).code, 0);
  assert.equal(userPath, 'C:\\Tools;C:\\Users\\u\\AppData\\Roaming\\npm');
  assert.ok(fake.calls.some((line) => line.includes('사용자 Path 에서 C:\\AT\\bin 제거')));
  // A Path winPath leaves alone (unreadable, or not plain ASCII through reg.exe's code page): the user is told to take it out.
  const home2 = tmp('uninstall-path-skip'); const r2 = (await managerRecord(home2)).root;
  const rec2 = await readRecord(r2); rec2.cli.pathAdded = { kind: 'windows-user-path', dir: 'C:\\AT\\bin' }; await writeRecord(r2, rec2);
  const skip = uninstallDeps(home2); skip.winPath = async () => 'skipped';
  assert.equal((await uninstall({ program: true, yes: true }, skip)).code, 0);
  assert.ok(skip.calls.some((line) => line.includes('C:\\AT\\bin 를 직접 빼 주세요')));
});

test('agty open finds the desktop app by its new name (Agent Tycoon) first, the old Pixel Office as a fallback', () => {
  const has = (...files) => (file) => files.includes(file);
  const env = { LOCALAPPDATA: 'C:\\L' };
  const newWin = path.join('C:\\L', 'Agent Tycoon', 'agent-tycoon.exe'); const oldWin = path.join('C:\\L', 'Pixel Office', 'pixel-office.exe');
  assert.deepEqual(desktopApp('win32', env, 'C:\\U', has(newWin, oldWin)), [newWin]);
  assert.deepEqual(desktopApp('win32', env, 'C:\\U', has(oldWin)), [oldWin]);
  assert.deepEqual(desktopApp('darwin', {}, '/Users/u', has('/Applications/Pixel Office.app', '/Users/u/Applications/Agent Tycoon.app')), ['open', '-a', '/Users/u/Applications/Agent Tycoon.app']);
  assert.deepEqual(desktopApp('linux', {}, '/home/u', has('/home/u/.local/bin/pixel-office', '/usr/bin/agent-tycoon')), ['/usr/bin/agent-tycoon']);
  assert.deepEqual(desktopApp('linux', {}, '/home/u', has('/home/u/.local/bin/pixel-office')), ['/home/u/.local/bin/pixel-office']);
  assert.equal(desktopApp('linux', {}, '/home/u', has()), null);
});

test('a first install opens the whole office (actions, messenger, terminal); a config.json already there keeps its choices', async () => {
  const conf = (home) => JSON.parse(fs.readFileSync(path.join(home, '.config/cld-gui/config.json'), 'utf8'));
  const fresh = tmp('home');
  await install({ ...makeBundle('1.0.0'), root: path.join(fresh, 'root'), service: 'systemd' }, fakeDeps({ home: fresh, root: path.join(fresh, 'root') }).deps);
  assert.deepEqual(
    (({ readOnly, chat, allowTerminal }) => ({ readOnly, chat, allowTerminal }))(conf(fresh)),
    { readOnly: false, chat: true, allowTerminal: true },
  );
  const kept = tmp('home');
  fs.mkdirSync(path.join(kept, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(path.join(kept, '.config/cld-gui/config.json'), JSON.stringify({ port: 18240, readOnly: true, chat: false, allowTerminal: false }));
  await install({ ...makeBundle('1.0.0'), root: path.join(kept, 'root'), service: 'systemd' }, fakeDeps({ home: kept, root: path.join(kept, 'root') }).deps);
  assert.deepEqual(
    (({ readOnly, chat, allowTerminal }) => ({ readOnly, chat, allowTerminal }))(conf(kept)),
    { readOnly: true, chat: false, allowTerminal: false },
  );
});
