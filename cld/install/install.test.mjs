import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CLI_MARK, clientPlan, daemonArgs, defaults, detectPlatform, findFreePort, installCli, installPlan, loginBase,
  exposurePath, mergeConfig, nameTaken, parseArgs, parseRegPath, pathExport, pathWith, pathWithout, recordExposure, remoteRequest,
  removeCli, renderLaunchAgent, renderSchtasksCommand, renderSystemdUnit, revertLedger, rotateLog, winCliCmd,
} from './install.mjs';
import { derivedGpuPolicy, detectVramMib, gpuJsonPath, gpuRule, gpuRuleLines, gpuStep, gpuTotalMib, nvidiaSmiOptIn } from './gpuPolicy.mjs';
import {
  encodePowerShell, hwSensorsPlan, LHM, linuxSensors, parseHttpServiceState, parseTasklist, PAWNIO,
  renderLhmAdminScript, renderLhmUninstallAdminScript, renderLhmConfig, renderLhmInstallScript, renderLhmUninstallScript,
} from './hwSensors.mjs';

const repo = '/absolute/project';
const home = '/absolute/home';
const node = '/absolute/node/bin/node';
const config = { ...defaults, port: 18255, allowedHosts: ['office.ts.net'] };

test('detects native platforms and the WSL proc-version fixture', () => {
  assert.equal(detectPlatform('linux', 'Linux version 5.15.90.1-microsoft-standard-WSL2'), 'wsl');
  assert.equal(detectPlatform('linux', 'Linux version 6.8.0-generic'), 'linux');
  assert.equal(detectPlatform('darwin'), 'darwin');
  assert.equal(detectPlatform('win32'), 'win32');
});

test('--remote takes an explicit choice and rejects an unknown one', () => {
  assert.equal(parseArgs(['--remote']).remoteChoice, undefined);
  for (const choice of ['local', 'lan', 'direct', 'ssh', 'duckdns', 'tailscale', 'tunnel'])
    assert.equal(parseArgs(['--remote', choice]).remoteChoice, choice);
  assert.throws(() => parseArgs(['--remote', 'permanent']), /--remote/);
});

test('config merge preserves user values while filling defaults; old office and Tailscale trust keys are dropped', () => {
  const merged = mergeConfig({ port: 19000, office: 'off', readOnly: false, allowedHosts: ['saved.host'], tailscaleUsers: ['me@localhost'], trustedTailscaleUsers: ['old@example.com'], extra: 'keep' });
  assert.deepEqual(merged, { port: 19000, readOnly: false, chat: false, allowTerminal: false, funnel: false, engine: 'auto', allowApprovalRequests: false, allowedHosts: ['saved.host'], extra: 'keep', connector: 'local' });
  assert.equal(mergeConfig({ port: 19000, office: 'on' }, { port: undefined }).port, 19000);
  assert.equal('office' in mergeConfig({ office: 'auto' }), false);
});

test('daemon flags include only active access controls', () => {
  assert.deepEqual(daemonArgs({ ...config, tailscaleUsers: ['me@localhost'] }), ['--port', '18255', '--no-terminal', '--read-only', '--engine', 'auto', '--allowed-host', 'office.ts.net']);
  assert.equal(parseArgs(['--trust-tailscale-user', 'me@localhost']).legacyTailscaleTrust, true);
});

test('trusted-device terminal opt-in is saved and passed to the daemon', () => {
  assert.equal(mergeConfig({}).allowTerminal, false);
  assert.equal(parseArgs(['--allow-terminal']).allowTerminal, true);
  assert.equal(parseArgs(['--allow-terminal', '--no-terminal']).allowTerminal, false);
  assert.equal(mergeConfig({ allowTerminal: true }, {}).allowTerminal, true);
  assert.ok(daemonArgs({ ...config, allowTerminal: true }).includes('--allow-terminal'));
});

test('--engine is stored and reaches the daemon; a bad value is refused', () => {
  assert.equal(parseArgs([]).engine, undefined);
  assert.equal(parseArgs(['--engine', 'on']).engine, 'on');
  assert.throws(() => parseArgs(['--engine', 'maybe']), /--engine/);
  assert.equal(mergeConfig({ engine: 'on' }, { engine: undefined }).engine, 'on'); // rerun keeps it
  assert.equal(mergeConfig({ engine: 'nope' }).engine, 'auto');
  assert.match(renderSystemdUnit({ repo, home, node, config: { ...config, engine: 'on' } }), /--engine on/);
});

test('--allow-actions stores readOnly:false and the daemon gets --allow-actions; the last flag wins', () => {
  assert.equal(parseArgs([]).readOnly, undefined);
  assert.equal(parseArgs(['--allow-actions']).readOnly, false);
  assert.equal(parseArgs(['--allow-actions', '--read-only']).readOnly, true);
  assert.equal(mergeConfig({ readOnly: true }, { readOnly: false }).readOnly, false);
  assert.equal(mergeConfig({ readOnly: false }, { readOnly: undefined }).readOnly, false); // rerun keeps it
  const args = daemonArgs({ ...config, readOnly: false });
  assert.ok(args.includes('--allow-actions') && !args.includes('--read-only'));
  assert.match(renderSystemdUnit({ repo, home, node, config: { ...config, readOnly: false } }), /--allow-actions/);
});

test('chat is off by default; --allow-chat stores chat: true and starts the daemon with it', () => {
  assert.equal(mergeConfig({}).chat, false);
  assert.equal(mergeConfig({ chat: 'yes' }).chat, false);
  assert.equal(parseArgs([]).chat, undefined); // keeps the saved choice
  assert.equal(parseArgs(['--allow-chat']).chat, true);
  assert.equal(parseArgs(['--allow-chat', '--no-chat']).chat, false);
  const chat = mergeConfig({ chat: false }, { chat: true });
  assert.equal(chat.chat, true);
  assert.ok(daemonArgs(chat).includes('--allow-chat'));
  assert.ok(!daemonArgs(mergeConfig({ chat: true }, { chat: false })).includes('--allow-chat'));
  assert.match(renderSystemdUnit({ repo, home, node, config: chat }), /--allow-chat/);
  assert.ok(!daemonArgs(chat).includes('--chat-attaches')); // default 1
  assert.equal(parseArgs(['--chat-attaches', '2']).chatAttaches, 2);
  assert.throws(() => parseArgs(['--chat-attaches', '0']));
  const two = mergeConfig({ chat: true }, { chatAttaches: 2 });
  const args = daemonArgs(two);
  assert.equal(args[args.indexOf('--chat-attaches') + 1], '2');
});

test('approval requests are off by default; the flag turns them on (T-0022)', () => {
  assert.equal(mergeConfig({}).allowApprovalRequests, false);
  assert.equal(mergeConfig({ allowApprovalRequests: 'yes' }).allowApprovalRequests, false);
  assert.equal(parseArgs([]).allowApprovalRequests, undefined); // keeps the saved choice
  assert.equal(parseArgs(['--allow-approval-requests']).allowApprovalRequests, true);
  assert.equal(parseArgs(['--allow-approval-requests', '--no-approval-requests']).allowApprovalRequests, false);
  assert.ok(!daemonArgs(mergeConfig({})).includes('--allow-approval-requests'));
  const on = mergeConfig({}, { allowApprovalRequests: true });
  assert.ok(daemonArgs(on).includes('--allow-approval-requests'));
  assert.match(renderSystemdUnit({ repo, home, node, config: on }), /--allow-approval-requests/);
});

test('the first-device link uses the Tailscale name when there is one (T-0022)', () => {
  assert.equal(loginBase({ ...defaults, port: 18255, allowedHosts: ['office.ts.net'] }), 'https://office.ts.net');
  assert.equal(loginBase({ ...defaults, port: 18255 }), 'http://localhost:18255');
});

test('systemd unit has absolute paths and all daemon flags', () => {
  const unit = renderSystemdUnit({ repo, home, node, config });
  assert.match(unit, /WorkingDirectory=\/absolute\/project/);
  assert.match(unit, /ExecStart=\/absolute\/node\/bin\/node --max-semi-space-size=1 \/absolute\/project\/dist\/cli\.js --port 18255/);
  assert.match(unit, /--allowed-host office\.ts\.net/);
  assert.match(unit, /Environment=PATH=\/absolute\/home\/\.local\/bin:\/absolute\/node\/bin/);
  assert.match(unit, /^Restart=on-failure$/m); // a crash or kill -9 comes back; a clean exit (stop, a future idle exit) stays down
  assert.match(unit, /^KillMode=process$/m); // claude daemon and bg sessions started by us must survive a cld-gui restart (ops OQ-14 §0-3)
  assert.match(unit, /^Nice=5$/m);
});

test('launch agent and scheduled-task commands use absolute paths and flags', () => {
  const plist = renderLaunchAgent({ repo, node, home, config });
  assert.match(plist, /<string>\/absolute\/node\/bin\/node<\/string>/);
  assert.doesNotMatch(plist, /trust-tailscale-user/);
  assert.match(plist, /<key>PATH<\/key><string>\/absolute\/home\/\.local\/bin:\/absolute\/node\/bin:/);
  assert.deepEqual(installPlan({ platform: 'win32', repo, home, node, config }).map((a) => a.command[1]), ['/Create', '/End', '/Run']);
  const task = renderSchtasksCommand({ repo, node, config });
  assert.deepEqual(task.slice(0, 7), ['schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/TN', 'cld-gui']);
  assert.match(task.at(-1), /"\/absolute\/project\/dist\/cli\.js"/);
  assert.match(task.at(-1), /--engine" "auto/);
});

test('port fallback returns the first available port or null', () => {
  assert.equal(findFreePort(18240, (port) => port === 18243), 18243);
  assert.equal(findFreePort(18240, () => false, 18242), null);
});

test('dry-run-ready plans cover service actions on every platform', () => {
  for (const platform of ['linux', 'wsl', 'darwin', 'win32']) {
    const plan = installPlan({ platform, repo, home, node, config });
    assert.ok(plan.length >= 2, platform);
    assert.ok(plan.some((action) => action.kind === 'file' || action.command?.[0] === 'schtasks'), platform);
  }
  assert.match(installPlan({ platform: 'linux', repo, home, node, config })[0].file, /cld-gui\.service$/);
});

test('uninstall plans remove service registration and optionally config', () => {
  for (const platform of ['linux', 'wsl', 'darwin', 'win32']) {
    const plan = installPlan({ platform, repo, home, node, config, uninstall: true, purge: true });
    assert.ok(plan.some((action) => action.kind === 'remove' && action.file.endsWith('config.json')), platform);
    assert.ok(plan.some((action) => action.kind === 'remove' && action.recursive && action.file === path.join(home, '.config', 'cld-gui', 'tls')), platform);
  }
  assert.deepEqual(installPlan({ platform: 'win32', repo, home, node, config, uninstall: true })[0].command, ['schtasks', '/Delete', '/F', '/TN', 'cld-gui']);
  const linux = installPlan({ platform: 'linux', repo, home, node, config, uninstall: true });
  assert.equal(linux[0].optional, true);
  assert.ok(linux.some((a) => a.kind === 'remove' && a.file.endsWith('cld-gui.service')));
  assert.ok(!linux.some((a) => a.kind === 'remove' && a.file.endsWith('tls')), 'keys stay without --purge');
});

test('client plans select the PowerShell or shell connector without executing it', () => {
  const windows = clientPlan({ platform: 'win32', repo, target: 'u@h', sshPort: 2233 })[0].command;
  assert.deepEqual(windows.slice(0, 4), ['powershell', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.ok(windows.includes('-CreateShortcut'));
  const unix = clientPlan({ platform: 'darwin', repo, target: 'u@h', sshPort: 2234 })[0].command;
  assert.deepEqual(unix, ['/absolute/project/cld/scripts/connect.sh', '-t', 'u@h', '-s', '2234']);
});

test('the daemon log rotates past its limit at start, keeping one old file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-log-'));
  const log = path.join(dir, 'daemon.log');
  try {
    rotateLog(log, 10); // no log yet
    fs.writeFileSync(log, 'a'.repeat(10));
    rotateLog(log, 10);
    assert.equal(fs.existsSync(`${log}.1`), false); // not over the limit
    fs.writeFileSync(log, 'b'.repeat(11));
    rotateLog(log, 10);
    assert.equal(fs.readFileSync(`${log}.1`, 'utf8'), 'b'.repeat(11));
    assert.equal(fs.existsSync(log), false);
    fs.writeFileSync(log, 'c'.repeat(11));
    rotateLog(log, 10);
    assert.equal(fs.readFileSync(`${log}.1`, 'utf8'), 'c'.repeat(11)); // the older one is gone
    assert.deepEqual(fs.readdirSync(dir).sort(), ['daemon.log.1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--funnel keeps Tailscale Funnel on across redeploys; default leaves it unset', () => {
  assert.equal(parseArgs([]).funnel, undefined);
  assert.equal(parseArgs(['--funnel']).funnel, true);
  assert.equal(parseArgs(['--funnel', '--no-funnel']).funnel, false);
  assert.equal(mergeConfig({ funnel: true }).funnel, true);
});

test('T-0019: Windows user Path gets the cld-gui folder once, and loses only it on uninstall', () => {
  const dir = 'C:\\Users\\Kim\\AppData\\Local\\cld-gui\\bin';
  assert.equal(pathWith('', dir), dir);
  assert.equal(pathWith('C:\\a;%USERPROFILE%\\b', dir), `C:\\a;%USERPROFILE%\\b;${dir}`);
  assert.equal(pathWith(`C:\\a;${dir.toUpperCase()}\\`, dir), `C:\\a;${dir.toUpperCase()}\\`);
  assert.equal(pathWithout(`C:\\a;${dir};%USERPROFILE%\\b`, dir), 'C:\\a;%USERPROFILE%\\b');
  assert.deepEqual(parseRegPath('\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\x;C:\\y\r\n'), { type: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\x;C:\\y' });
  assert.deepEqual(parseRegPath(''), { type: 'REG_EXPAND_SZ', value: '' });
  // The whole key (winPath reads it so a failed query is not mistaken for an unset Path).
  assert.deepEqual(parseRegPath('\r\nHKEY_CURRENT_USER\\Environment\r\n    OneDrive    REG_EXPAND_SZ    C:\\o\r\n    Path    REG_SZ    C:\\y\r\n    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\t\r\n'), { type: 'REG_SZ', value: 'C:\\y' });
  const cmd = winCliCmd('C:\\work\\cld-gui');
  assert.ok(cmd.includes(CLI_MARK));
  assert.ok(cmd.includes('node "C:\\work\\cld-gui\\cld\\bin\\cld-gui" %*'));
  assert.deepEqual(parseArgs(['--add-path']).addPath, true);
});

test('T-0019: agty and cld-gui are linked; cld only when free; foreign commands survive', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-inst-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-repo-'));
  const target = path.join(repo, 'cld', 'bin', 'cld-gui');
  const bin = path.join(h, '.local', 'bin');
  const lines = []; const log = console.log; console.log = (l) => lines.push(String(l));
  try {
    await installCli({ platform: 'linux', home: h, repo, taken: async () => false, env: { PATH: bin } });
    assert.equal(fs.readlinkSync(path.join(bin, 'agty')), target);
    assert.equal(fs.readlinkSync(path.join(bin, 'cld-gui')), target);
    assert.equal(fs.readlinkSync(path.join(bin, 'cld')), target);
    await installCli({ platform: 'linux', home: h, repo, taken: async () => true, env: { PATH: bin } }); // rerun: ours stays
    assert.equal(fs.readlinkSync(path.join(bin, 'agty')), target);
    assert.equal(fs.readlinkSync(path.join(bin, 'cld')), target);
    await removeCli({ platform: 'linux', home: h, repo });
    assert.equal(fs.existsSync(path.join(bin, 'agty')), false);
    assert.equal(fs.existsSync(path.join(bin, 'agent-tycoon')), false); // never installed any more
    assert.equal(fs.existsSync(path.join(bin, 'cld-gui')), false);
    // The name answers to something else (an alias): cld-gui only.
    await installCli({ platform: 'linux', home: h, repo, taken: async (n) => n === 'cld', env: { PATH: bin } });
    assert.equal(fs.existsSync(path.join(bin, 'cld')), false);
    assert.ok(lines.includes('cld 이름은 이미 쓰고 있어 cld-gui로만 설치했습니다'));
    await removeCli({ platform: 'linux', home: h, repo });
    fs.writeFileSync(path.join(bin, 'agty'), '#!/bin/sh\nexec another "$@"\n');
    await installCli({ platform: 'linux', home: h, repo, taken: async (n) => n === 'agty', env: { PATH: bin } });
    assert.equal(fs.readFileSync(path.join(bin, 'agty'), 'utf8'), '#!/bin/sh\nexec another "$@"\n');
    assert.equal(fs.readlinkSync(path.join(bin, 'cld-gui')), target);
    assert.ok(lines.includes('agty 이름은 이미 다른 프로그램이 쓰고 있어 만들지 않았습니다. cld-gui 를 쓰세요'));
    assert.ok(!lines.some((l) => l.includes('agent-tycoon')));
    await removeCli({ platform: 'linux', home: h, repo });
    assert.ok(fs.existsSync(path.join(bin, 'agty')));
    fs.rmSync(path.join(bin, 'agty'));
    // A foreign file and a foreign link under that name are left alone, also by uninstall.
    fs.writeFileSync(path.join(bin, 'cld'), '#!/bin/sh\nexec claude "$@"\n');
    await installCli({ platform: 'linux', home: h, repo, taken: async () => false, env: { PATH: bin } });
    assert.equal(fs.readFileSync(path.join(bin, 'cld'), 'utf8'), '#!/bin/sh\nexec claude "$@"\n');
    await removeCli({ platform: 'linux', home: h, repo });
    assert.ok(fs.existsSync(path.join(bin, 'cld')));
    fs.rmSync(path.join(bin, 'cld')); fs.symlinkSync('/usr/bin/claude', path.join(bin, 'cld'));
    await installCli({ platform: 'linux', home: h, repo, taken: async () => false, env: { PATH: bin } });
    assert.equal(fs.readlinkSync(path.join(bin, 'cld')), '/usr/bin/claude');
  } finally { console.log = log; fs.rmSync(h, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('T-0019: Windows writes all owned command files and leaves a foreign agty alone', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-win-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-repo-'));
  const env = { LOCALAPPDATA: path.join(h, 'AppData', 'Local'), PATH: '' };
  const bin = path.join(env.LOCALAPPDATA, 'cld-gui', 'bin');
  const lines = []; const log = console.log; console.log = (l) => lines.push(String(l));
  try {
    await installCli({ platform: 'win32', home: h, repo, env, taken: async () => false });
    for (const name of ['agty.cmd', 'cld-gui.cmd', 'cld.cmd']) assert.ok(fs.readFileSync(path.join(bin, name), 'utf8').includes(CLI_MARK));
    assert.equal(fs.existsSync(path.join(bin, 'agent-tycoon.cmd')), false);
    await installCli({ platform: 'win32', home: h, repo, env, taken: async () => true });
    assert.ok(fs.readFileSync(path.join(bin, 'agty.cmd'), 'utf8').includes(CLI_MARK));
    await removeCli({ platform: 'win32', home: h, repo, env });
    fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'agty.cmd'), '@echo foreign\r\n');
    await installCli({ platform: 'win32', home: h, repo, env, taken: async (n) => n === 'agty' });
    assert.equal(fs.readFileSync(path.join(bin, 'agty.cmd'), 'utf8'), '@echo foreign\r\n');
    assert.ok(fs.readFileSync(path.join(bin, 'cld-gui.cmd'), 'utf8').includes(CLI_MARK));
    assert.ok(lines.includes('agty 이름은 이미 다른 프로그램이 쓰고 있어 만들지 않았습니다. cld-gui 를 쓰세요'));
    await removeCli({ platform: 'win32', home: h, repo, env });
    assert.ok(fs.existsSync(path.join(bin, 'agty.cmd')));
  } finally { console.log = log; fs.rmSync(h, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('T-0019: macOS without ~/.local/bin on PATH: the line to add; written only with --add-path, removed on uninstall', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-mac-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-repo-'));
  const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' };
  const { rc, line } = pathExport('/bin/zsh', h);
  assert.equal(rc, path.join(h, '.zshrc'));
  assert.equal(line, 'export PATH="$HOME/.local/bin:$PATH" # cld-gui');
  const lines = []; const log = console.log; console.log = (l) => lines.push(String(l));
  try {
    await installCli({ platform: 'darwin', home: h, repo, env, taken: async () => false });
    assert.ok(lines.some((l) => l.includes(`echo '${line}' >> ${rc}`)));
    assert.equal(fs.existsSync(rc), false);
    fs.writeFileSync(rc, 'alias ll="ls -l"\n');
    await installCli({ platform: 'darwin', home: h, repo, env, addPath: true, taken: async () => false });
    await installCli({ platform: 'darwin', home: h, repo, env, addPath: true, taken: async () => false });
    assert.equal(fs.readFileSync(rc, 'utf8').split('\n').filter((l) => l === line).length, 1);
    await removeCli({ platform: 'darwin', home: h, repo, env });
    assert.equal(fs.readFileSync(rc, 'utf8').includes(line), false);
    assert.ok(fs.readFileSync(rc, 'utf8').includes('alias ll="ls -l"'));
  } finally { console.log = log; fs.rmSync(h, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

// ── T-0030 H/W sensors ──

test('--hw-sensors is on unless --no-hw-sensors; --lhm-port and --nvidia-smi reach the daemon only when set', () => {
  assert.equal(parseArgs([]).hwSensors, undefined); // unset = on
  assert.equal(parseArgs(['--no-hw-sensors']).hwSensors, false);
  assert.equal(parseArgs(['--no-hw-sensors', '--hw-sensors']).hwSensors, true);
  assert.equal(parseArgs(['--lhm-port', '18085']).lhmPort, 18085);
  assert.throws(() => parseArgs(['--lhm-port', '0']));
  assert.equal(parseArgs(['--nvidia-smi', '--no-nvidia-smi']).nvidiaSmi, false);
  assert.deepEqual(mergeConfig({ lhmPort: 'x', nvidiaSmi: 'yes', hwSensors: 1 }), mergeConfig({ connector: 'local' })); // an existing config: T-0024 keeps it on loopback
  const plain = daemonArgs(config);
  assert.ok(!plain.includes('--lhm-port') && !plain.includes('--nvidia-smi')); // nvidia-smi is never on by default
  const set = daemonArgs({ ...config, lhmPort: 18085, nvidiaSmi: true });
  assert.equal(set[set.indexOf('--lhm-port') + 1], '18085');
  assert.ok(set.includes('--nvidia-smi'));
  assert.match(renderSystemdUnit({ repo, home, node, config: { ...config, lhmPort: 8085 } }), /--lhm-port 8085/);
});

/** `netsh http show servicestate view=requestq` on this PC (Korean Windows), read only. */
const NETSH_KO = `HTTP 서비스 상태의 스냅숏(요청 큐 보기):
-----------------------------------------------------

요청 큐 이름: 요청 큐에 이름을 지정하지 않았습니다.
    버전: 2.0
    상태: Active
    최대 요청: 1000
    연결된 활성 프로세스 수: 1
    프로세스 ID:
        4288
    URL 그룹:
    URL 그룹 ID: FF00000040000001
            등록된 URL 수: 1
            등록된 URL:
                HTTP://*:5357/695704E3-2EB8-429F-892D-BAACF0BB8697/
요청 큐 이름: 요청 큐에 이름을 지정하지 않았습니다.
    버전: 2.0
    상태: Active
    최대 요청: 1000
    연결된 활성 프로세스 수: 1
    프로세스 ID:
        11196
    URL 그룹:
    URL 그룹 ID: FE00001340000001
            등록된 URL 수: 1
            등록된 URL:
                HTTP://+:18085/
`;

test('finds LHM by its process and the http.sys URL it registered (localized output, shape only)', () => {
  assert.deepEqual(parseTasklist('"LibreHardwareMonitor.exe","11196","Console","1","52,120 K"\r\n'), [11196]);
  assert.deepEqual(parseTasklist('정보: 지정된 조건에 일치하는 작업이 없습니다.\r\n'), []);
  assert.deepEqual(parseHttpServiceState(NETSH_KO), [{ pid: 4288, port: 5357 }, { pid: 11196, port: 18085 }]);
  const en = NETSH_KO.replace(/프로세스 ID:/g, 'Process IDs:').replace(/등록된 URL:/g, 'Registered URLs:').replace(/\n/g, '\r\n');
  assert.deepEqual(parseHttpServiceState(en), [{ pid: 4288, port: 5357 }, { pid: 11196, port: 18085 }]);
});

test('Windows/WSL plan: an LHM that answers is only used (this PC: :18085), never reinstalled', () => {
  for (const platform of ['wsl', 'win32']) {
    const plan = hwSensorsPlan({ platform, detection: { state: 'running', port: 18085, ours: false } });
    assert.equal(plan.script, undefined, platform);
    assert.equal(plan.lhmPort, 18085);
    assert.match(plan.lines.join('\n'), /LibreHardwareMonitor 이미 실행 중\(:18085\) → 설치 건너뜀/);
  }
  const noWeb = hwSensorsPlan({ platform: 'wsl', detection: { state: 'no-web', ours: false } });
  assert.equal(noWeb.script, undefined); // someone else's LHM without its web server: hint only
  assert.match(noWeb.lines.join('\n'), /Remote Web Server/);
  assert.match(hwSensorsPlan({ platform: 'win32', enabled: false, detection: null }).lines[0], /--no-hw-sensors/);
});

test('Windows/WSL plan when LHM is missing: pinned, checksummed, one UAC prompt explained first', () => {
  const plan = hwSensorsPlan({ platform: 'wsl', detection: { state: 'missing', ours: false }, port: 8085 });
  const uac = plan.lines.findIndex((l) => l.includes('UAC'));
  assert.ok(uac > 0, 'the UAC prompt is explained before it appears');
  assert.equal(plan.waitPort, 8085);
  const script = plan.script;
  assert.equal(script.match(/-Verb RunAs/g).length, 1); // one elevation for everything
  const admin = renderLhmAdminScript(8085);
  for (const s of [LHM.url, LHM.sha256, PAWNIO.url, PAWNIO.sha256]) assert.ok(admin.includes(s), s);
  assert.match(admin, /Get-FileHash -Algorithm SHA256/);
  assert.match(admin, /'-install', '-silent'/); // PawnIO only when missing or older than 2.0
  assert.match(admin, /\[version\]'2\.0'/);
  assert.match(admin, /-AtLogOn -User \$user/);
  assert.match(admin, /-RunLevel Highest/);
  assert.match(admin, /Register-ScheduledTask -TaskName 'cld-gui-lhm'/);
  assert.match(admin, /Join-Path \$env:ProgramFiles 'cld-gui'/); // admin-only folder: the elevated task's files cannot be swapped
  assert.ok(!/LOCALAPPDATA|AppData/i.test(admin));
  assert.match(admin, /New-NetFirewallRule -DisplayName 'cld-gui: LHM local only' .*-Direction Inbound -Action Block -Protocol TCP -LocalPort 8085/); // LHM's web server is unauthenticated and binds every interface
  assert.match(renderLhmUninstallAdminScript(), /Get-NetFirewallRule -DisplayName 'cld-gui: LHM local only' .*Remove-NetFirewallRule/);
  const cfg = renderLhmConfig(8085);
  for (const key of ['runWebServerMenuItem" value="true', 'listenerPort" value="8085', 'startMinMenuItem" value="true', 'minTrayMenuItem" value="true'])
    assert.ok(cfg.includes(key), key);
  // The admin part rides inside the wrapper; both fit Windows' 32767-character command line.
  assert.equal(script, renderLhmInstallScript(8085));
  assert.ok(script.includes(admin));
  assert.ok(encodePowerShell(script).length < 30000);
  assert.equal(Buffer.from(encodePowerShell('é'), 'base64').toString('utf16le'), 'é');
});

test('uninstall removes only our task and our copy; PawnIO and any other LHM stay', () => {
  const none = hwSensorsPlan({ platform: 'wsl', uninstall: true, detection: { ours: false } });
  assert.equal(none.script, undefined);
  assert.match(none.lines[0], /없음/);
  const plan = hwSensorsPlan({ platform: 'win32', uninstall: true, detection: { ours: true } });
  const script = renderLhmUninstallScript();
  assert.equal(plan.script, script);
  assert.equal(script.match(/-Verb RunAs/g).length, 1);
  assert.match(script, /Unregister-ScheduledTask -TaskName 'cld-gui-lhm'/);
  assert.match(script, /Where-Object \{ \$_\.Execute -eq \$exe \}/); // only when the task runs our copy
  assert.match(script, /Where-Object \{ \$_\.Path -eq \$exe \}/); // only our process
  assert.ok(!/-uninstall|PawnIO_setup|TaskName 'LibreHardwareMonitor'/.test(script));
  assert.ok(!/AppData|C:\\Tools/i.test(script));
});

test('Linux and macOS plans install nothing', () => {
  const sys = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-sys-'));
  try {
    fs.mkdirSync(path.join(sys, 'class/hwmon/hwmon0'), { recursive: true });
    fs.writeFileSync(path.join(sys, 'class/hwmon/hwmon0/name'), 'k10temp\n');
    assert.deepEqual(linuxSensors(sys, ''), { cpuTemp: true, sensors: false, nvidiaSmi: false });
    assert.deepEqual(linuxSensors(path.join(sys, 'none'), '').cpuTemp, false);
  } finally {
    fs.rmSync(sys, { recursive: true, force: true });
  }
  const ok = hwSensorsPlan({ platform: 'linux', linux: { cpuTemp: true, sensors: false, nvidiaSmi: true } });
  assert.equal(ok.script, undefined);
  assert.match(ok.lines.join('\n'), /설치할 것 없음[\s\S]*--nvidia-smi/);
  assert.match(hwSensorsPlan({ platform: 'linux', linux: { cpuTemp: false, sensors: false } }).lines[0], /sudo apt install lm-sensors/);
  assert.doesNotMatch(hwSensorsPlan({ platform: 'linux', linux: { cpuTemp: false, sensors: true } }).lines[0], /apt/);
  assert.ok(!hwSensorsPlan({ platform: 'linux', linux: { cpuTemp: true, nvidiaSmi: true }, nvidiaSmi: true }).lines.join('').includes('--nvidia-smi'));
  const mac = hwSensorsPlan({ platform: 'darwin' });
  assert.equal(mac.script, undefined);
  assert.match(mac.lines[0], /macOS: 설치할 것 없음/);
  assert.deepEqual(hwSensorsPlan({ platform: 'linux', uninstall: true }).lines, []);
});

test('T-0019: the short name: taken when on PATH, free when not, taken when the shells cannot tell', { skip: process.platform === 'win32' }, async () => {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-name-'));
  try {
    process.env.HOME = h; // no user rc files
    const bin = path.join(h, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'cld'), '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    assert.equal(await nameTaken('cld', 'linux', ''), true);
    process.env.PATH = '/usr/bin:/bin';
    assert.equal(await nameTaken('cld', 'linux', ''), false);
    process.env.PATH = path.join(h, 'empty'); // no sh, no bash: unknown counts as taken
    assert.equal(await nameTaken('cld', 'linux', ''), true);
  } finally {
    Object.assign(process.env, saved);
    fs.rmSync(h, { recursive: true, force: true });
  }
});

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cld-gpuinst-'));
const quiet = () => { const lines = []; return { lines, log: (l) => lines.push(l) }; };

test('T-0094: the default thresholds are the same shares as the runtime, rounded to 0.5 GiB (8, 12, 24 GiB)', () => {
  assert.deepEqual(derivedGpuPolicy(8192), { exclusiveGib: 4.5, sharedBudgetGib: 4.5, liveLimitGib: 6 });
  assert.deepEqual(derivedGpuPolicy(12288), { exclusiveGib: 6.5, sharedBudgetGib: 6.5, liveLimitGib: 9 });
  assert.deepEqual(derivedGpuPolicy(24576), { exclusiveGib: 13, sharedBudgetGib: 13, liveLimitGib: 18 });
  assert.equal(derivedGpuPolicy(null), null);
  assert.equal(derivedGpuPolicy(0), null);
});

test('T-0094: gpu.json is written once when missing, 0600, from the detected VRAM', async () => {
  const home = tmpHome();
  try {
    const { lines, log } = quiet();
    const rule = await gpuStep(home, { detect: async () => 8192, log });
    const file = gpuJsonPath(home);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { exclusiveGib: 4.5, sharedBudgetGib: 4.5, liveLimitGib: 6 });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(rule.rule, 'file'); // now the user's file is what decides
    assert.ok(lines.some((l) => l.includes('gpu.json')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('T-0094: an existing gpu.json is never overwritten (thresholds, none, or broken)', async () => {
  for (const body of ['{"exclusiveGib":3,"sharedBudgetGib":3}', '{"nvidiaSmi":true}', '{"exclusiveGib":']) {
    const home = tmpHome();
    try {
      const file = gpuJsonPath(home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      await gpuStep(home, { detect: async () => 8192, log: () => {} });
      assert.equal(fs.readFileSync(file, 'utf8'), body);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('T-0094: unknown VRAM writes nothing and says one at a time; a dry run writes nothing either', async () => {
  const home = tmpHome();
  try {
    const { lines, log } = quiet();
    const rule = await gpuStep(home, { detect: async () => null, log });
    assert.equal(fs.existsSync(gpuJsonPath(home)), false);
    assert.equal(rule.rule, 'unknown');
    assert.ok(lines.join('\n').includes('한 번에 하나'));
    await gpuStep(home, { dryRun: true, detect: async () => 8192, log: () => {} });
    assert.equal(fs.existsSync(gpuJsonPath(home)), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('T-0094: --check reports the values in force for each case', () => {
  const home = tmpHome();
  try {
    assert.match(gpuRuleLines(gpuRule(home, null))[0], /GPU 크기를 몰라 한 번에 하나/);
    const derived = gpuRuleLines(gpuRule(home, 8192))[0];
    assert.match(derived, /GPU 크기에서 정한 기본값/);
    assert.match(derived, /혼자 4\.5 · 함께 4\.5 · 실제 6 GiB/);
    fs.mkdirSync(path.dirname(gpuJsonPath(home)), { recursive: true });
    fs.writeFileSync(gpuJsonPath(home), '{"exclusiveGib":3,"sharedBudgetGib":5}');
    assert.equal(gpuRuleLines(gpuRule(home, 8192))[0], 'GPU 예약 문턱: gpu.json (혼자 3 · 함께 5 · 실제 없음 GiB)');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('T-0094: detectVramMib reads the first GPU from nvidia-smi, and null when there is none', { skip: process.platform === 'win32' }, async () => {
  const dir = tmpHome();
  try {
    const smi = path.join(dir, 'nvidia-smi');
    fs.writeFileSync(smi, '#!/bin/sh\necho 8188\necho 4096\n', { mode: 0o755 });
    assert.equal(await detectVramMib([smi]), 8188);
    assert.equal(await detectVramMib([path.join(dir, 'nope')]), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('T-0094: the installer reads the GPU size from a hw.json, and calls nvidia-smi only on the opt-in (CON-005)', async () => {
  const home = tmpHome();
  try {
    let calls = 0;
    const smi = async () => { calls += 1; return 8192; };
    assert.equal(await gpuTotalMib(home, { smi }), null);
    assert.equal(calls, 0);
    assert.equal(nvidiaSmiOptIn(home, {}), false);
    assert.equal(await gpuTotalMib(home, { nvidiaSmi: nvidiaSmiOptIn(home, { nvidiaSmi: true }), smi }), 8192);
    assert.equal(calls, 1);
    fs.mkdirSync(path.dirname(gpuJsonPath(home)), { recursive: true });
    fs.writeFileSync(gpuJsonPath(home), '{"nvidiaSmi":true}');
    assert.equal(nvidiaSmiOptIn(home, {}), true);
    const hw = path.join(home, '.local/share/cld-gui/hw.json');
    fs.mkdirSync(path.dirname(hw), { recursive: true });
    fs.writeFileSync(hw, JSON.stringify({ ts: '2020-01-01T00:00:00Z', gpu: { vram_total_mib: 12288 } }));
    assert.equal(await gpuTotalMib(home, { nvidiaSmi: true, smi }), 12288); // the daemon's file first, even opted in
    assert.equal(calls, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('S6: --connector tailscale is Serve, funnel is Funnel; an install that has Funnel keeps it', () => {
  assert.equal(parseArgs(['--connector', 'funnel']).connector, 'funnel');
  assert.equal(remoteRequest('tailscale', { funnel: false }), 'tailscale');
  assert.equal(remoteRequest('funnel', { funnel: false }), 'funnel');
  assert.equal(remoteRequest('tailscale', { funnel: true }), 'funnel');
  assert.equal(remoteRequest('direct', { funnel: true }), 'direct');
  assert.equal(remoteRequest(undefined, {}), undefined);
});

test('S6: uninstall reverts the exposure ledger and removes it; foreign serve and non-cloudflared pids are left alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-ledger-'));
  try {
    await recordExposure(dir, { kind: 'tailscale', host: 'office.ts.net', port: 18255, funnel: false, by: 'installer', at: 1 });
    await recordExposure(dir, { kind: 'tunnel', url: 'https://a.trycloudflare.com/s/', pid: 111, localPort: 40001, startTime: '987654', by: 'daemon', at: 2 });
    await recordExposure(dir, { kind: 'portproxy', externalPort: 443, directPort: 18443, by: 'user', at: 3 });
    assert.equal(fs.statSync(exposurePath(dir)).mode & 0o777, 0o600);
    const stat = (start) => `111 (cloudflared) S 1 111 111 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 9 0 ${start} 123456 789`;
    const fake = (servePort, cmdline, start = 987654) => {
      const calls = { run: [], killed: [], printed: [] };
      const deps = {
        run: async (command) => {
          calls.run.push(command.join(' '));
          const status = { Web: { 'office.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${servePort}` } } } } };
          return { code: 0, stdout: command.includes('status') ? JSON.stringify(status) : '', stderr: '' };
        },
        procFile: async (_pid, file) => (file === 'stat' ? stat(start) : cmdline),
        kill: (pid) => void calls.killed.push(pid),
        print: (line) => void calls.printed.push(line),
      };
      return { deps, calls };
    };
    // ours: serve to our port goes off, the cloudflared pid is killed, the portproxy is explained
    const ours = fake(18255, 'cloudflared\0tunnel\0--no-autoupdate\0--url\0http://127.0.0.1:40001\0');
    await revertLedger(dir, { deps: ours.deps });
    assert.deepEqual(ours.calls.run, ['tailscale serve status --json', 'tailscale serve --https=443 off']);
    assert.deepEqual(ours.calls.killed, [111]);
    assert.match(ours.calls.printed.join('\n'), /netsh interface portproxy delete v4tov4 listenaddress=0\.0\.0\.0 listenport=443/);
    assert.equal(fs.existsSync(exposurePath(dir)), false);
    // someone else's: serve points elsewhere; the pid was reused (another start time), or is
    // another cloudflared (the person's named tunnel), or the entry predates start times
    const tunnelEntry = { kind: 'tunnel', url: 'https://a.trycloudflare.com/s/', pid: 111, localPort: 40001, startTime: '987654', by: 'daemon', at: 2 };
    const cases = [
      ['reused pid', { ...tunnelEntry }, 'cloudflared\0tunnel\0--no-autoupdate\0--url\0http://127.0.0.1:40001\0', 555],
      ['other argv', { ...tunnelEntry }, 'cloudflared\0tunnel\0run\0my-named-tunnel\0', 987654],
      ['no start time', { kind: 'tunnel', url: tunnelEntry.url, pid: 111, by: 'daemon', at: 2 }, 'cloudflared\0tunnel\0--no-autoupdate\0--url\0http://127.0.0.1:40001\0', 987654],
    ];
    for (const [name, entry, cmdline, start] of cases) {
      await recordExposure(dir, { kind: 'tailscale', host: 'office.ts.net', port: 18255, funnel: true, by: 'installer', at: 1 });
      await recordExposure(dir, entry);
      const foreign = fake(9999, cmdline, start);
      await revertLedger(dir, { deps: foreign.deps });
      assert.deepEqual(foreign.calls.run, ['tailscale serve status --json'], name);
      assert.deepEqual(foreign.calls.killed, [], name);
      assert.equal(fs.existsSync(exposurePath(dir)), false, name);
    }
    // nothing recorded: nothing asked
    const none = fake(18255, 'cloudflared');
    await revertLedger(dir, { deps: none.deps });
    assert.deepEqual(none.calls.run, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S6: a broken or newer exposure ledger is never overwritten or deleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-ledger-bad-'));
  try {
    const file = exposurePath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = { kind: 'tailscale', host: 'office.ts.net', port: 18255, funnel: false, by: 'installer', at: 1 };
    for (const old of ['{"v":1,"entries":[{"kind":"tail', JSON.stringify({ v: 2, entries: [{ kind: 'tailscale', host: 'office.ts.net', port: 18255, funnel: true, live: true }] })]) {
      // record: the old file is moved aside with its content, the new one holds only the new entry
      fs.writeFileSync(file, old);
      const printed = [];
      await recordExposure(dir, entry, (line) => printed.push(line));
      const aside = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('exposure.json.bad-'));
      assert.equal(aside.length, 1);
      assert.equal(fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf8'), old);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).entries, [entry]);
      assert.match(printed.join('\n'), /exposure\.json\.bad-/);
      fs.rmSync(path.join(path.dirname(file), aside[0]));
      // uninstall: kept, nothing run, where it is and what to check is printed
      fs.writeFileSync(file, old);
      const calls = [];
      await revertLedger(dir, { deps: { run: async (c) => void calls.push(c), print: (line) => calls.push(line) } });
      assert.equal(fs.readFileSync(file, 'utf8'), old);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /그대로 뒀어요.*exposure\.json[\s\S]*tailscale serve status/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
