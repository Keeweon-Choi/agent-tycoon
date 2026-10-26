import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const maintenance = require('./cld-gui-maintenance.js');

import { fileURLToPath } from 'node:url';
const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const home = '/tmp/cld-maintenance-home';
const config = JSON.stringify({ port: 18255, lhmPort: 8085, connector: 'tailscale' });

function commandFixture(calls, brokenClaude = false) {
  return (command) => {
    calls.push(command);
    const line = command.join(' ');
    if (line.includes('command -v claude')) return { ok: !brokenClaude, stdout: brokenClaude ? '' : '/usr/bin/claude\n' };
    if (line === '/usr/bin/claude --version') return { ok: true, stdout: '2.0.1\n' };
    if (line === 'which git') return { ok: true, stdout: '/usr/bin/git\n' };
    if (line === 'which tailscale' || line === 'which cloudflared') return { ok: false, stdout: '' };
    if (line === 'systemctl --user is-enabled cld-gui' || line === 'systemctl --user is-active cld-gui') return { ok: true, stdout: 'active\n' };
    if (command[0] === '/mnt/c/Windows/System32/curl.exe') return { ok: true, stdout: '{}' };
    return { ok: true, stdout: '' };
  };
}

test('doctor emits healthy Korean check lines with injected WSL commands', async () => {
  const calls = [];
  const result = await maintenance.doctor({
    platform: 'wsl', home, node: '22.14.0', command: commandFixture(calls), exists: (file) => file.startsWith('/usr/bin/'),
    readFile: () => config, writable: () => true, disk: () => 0.45, health: async () => true,
  });
  assert.equal(result.ok, true);
  assert.equal(maintenance.doctorExitCode(result), 0);
  const lines = maintenance.doctorLines(result).join('\n');
  assert.match(lines, /✔ Claude CLI: \/usr\/bin\/claude \(로그인 셸\) · 2\.0\.1/);
  assert.match(lines, /✔ LibreHardwareMonitor: 8085 포트 응답/);
  assert.equal(calls.filter((command) => command.join(' ').includes('command -v claude')).length, 1);
  assert.ok(calls.some((command) => command.join(' ') === 'systemctl --user is-active cld-gui'));
  assert.ok(calls.some((command) => command[0] === '/mnt/c/Windows/System32/curl.exe'));
});

test('doctor shows the WSL state apart from the daemon, and the start policy with its logon task (R1/P6)', async () => {
  const calls = [];
  const record = JSON.stringify({ startPolicy: 'always', logonTask: { name: 'agent-tycoon-wsl-Ubuntu-Test' }, linger: { user: 'owner' } });
  const fixture = commandFixture(calls);
  const result = await maintenance.doctor({
    platform: 'wsl', home, node: '22.14.0', env: { WSL_DISTRO_NAME: 'Ubuntu-Test' },
    command: (command) => (command[0] === 'schtasks.exe' ? (calls.push(command), { ok: false, stdout: '' }) : fixture(command)),
    exists: (file) => file.startsWith('/usr/bin/') || file === '/run/systemd/system',
    readFile: (file) => (file.endsWith('install.json') ? record : config), writable: () => true, disk: () => 0.45, health: async () => true,
  });
  const lines = maintenance.doctorLines(result).join('\n');
  assert.match(lines, /ℹ WSL: 배포판 Ubuntu-Test 실행 중 · systemd 켜짐/);
  assert.match(lines, /✔ HTTP 상태: \/api\/health 응답/); // the daemon, on its own line
  assert.match(lines, /⚠ 시작 정책: always · Windows 로그온 작업 없음 · linger\(owner\)\n  고치기: agty start-policy always/);
  assert.deepEqual(calls.filter((c) => c[0] === 'schtasks.exe'), [['schtasks.exe', '/Query', '/TN', 'agent-tycoon-wsl-Ubuntu-Test']]); // read-only
  assert.equal(result.ok, true); // a warning, not a failure
});

test('doctor makes missing Claude a failure and gives a fix', async () => {
  const result = await maintenance.doctor({
    platform: 'linux', home, node: '22.0.0', command: commandFixture([], true),
    readFile: () => config, writable: () => true, disk: () => 0.5, health: async () => true,
  });
  assert.equal(result.ok, false);
  assert.equal(maintenance.doctorExitCode(result), 1);
  const lines = maintenance.doctorLines(result).join('\n');
  assert.match(lines, /✖ Claude CLI: 찾지 못했습니다/);
  assert.match(lines, /고치기: Claude Code를 설치/);
});

test('status reports a down daemon and the next recovery command', async () => {
  const result = await maintenance.status({
    platform: 'linux', home, config: { port: 18255, connector: 'local' }, request: async () => null,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(maintenance.statusLines(result), ['✖ 데몬: 꺼짐', '다음: agty restart']);
});

test('logs plans use the service-specific command on every OS', () => {
  assert.deepEqual(maintenance.logs({ platform: 'linux', home }, { n: 12 }).command, ['journalctl', '--user', '-u', 'cld-gui', '-n', '12', '--no-pager']);
  assert.deepEqual(maintenance.logs({ platform: 'darwin', home }, { n: 12, follow: true }).command, ['tail', '-n', '12', '-f', `${home}/.config/agent-tycoon/daemon.log`]);
  const windows = maintenance.logs({ platform: 'win32', home }, { n: 12, follow: true }).command;
  assert.equal(windows[0], 'powershell');
  assert.match(windows.at(-1), /Get-Content .* -Tail 12 -Wait/);
});

test('restart plans use the platform service manager and wait for health', async () => {
  const expected = {
    linux: ['systemctl', '--user', 'restart', 'cld-gui'],
    darwin: ['launchctl', 'kickstart', '-k', 'gui/99/dev.cld-gui.daemon'],
    win32: ['schtasks', '/Run', '/TN', 'cld-gui'],
  };
  for (const [platform, command] of Object.entries(expected)) {
    const calls = [];
    const result = await maintenance.restart({
      platform, home, uid: 99, config: { port: 18255 },
      command: (got) => { calls.push(got); return { ok: true, stdout: '' }; },
      health: async (port) => port === 18255,
      sleep: async () => undefined,
    });
    assert.equal(result.ok, true, platform);
    assert.deepEqual(calls, [command], platform);
  }
});

test('doctor counts the devices that get notifications, and never prints a key or endpoint', async () => {
  const base = { platform: 'wsl', home, node: '22.14.0', command: commandFixture([]), exists: (file) => file.startsWith('/usr/bin/'), writable: () => true, disk: () => 0.45, health: async () => true };
  const pushJson = JSON.stringify({ vapid: { privateKey: { d: 'SECRET' } }, subscriptions: [{ device: 'a', endpoint: 'https://push.example/SECRET' }, { device: 'b', endpoint: 'https://push.example/SECRET2' }] });
  const some = maintenance.doctorLines(await maintenance.doctor({ ...base, readFile: (f) => (f.endsWith('push.json') ? pushJson : config) })).join('\n');
  assert.match(some, /ℹ 알림: 알림 받을 기기 2대/);
  assert.doesNotMatch(some, /SECRET/);
  // U-49: the daemon's counters, numbers only.
  const counted = JSON.stringify({ ...JSON.parse(pushJson), stats: { 'sent.reply': 5, 'sent.turnEnd': 1, 'failed.reply': 1, 'skipped.reply.device-looking': 3, 'skipped.reply.cooldown': 2, text: 'ignored' } });
  const withStats = maintenance.doctorLines(await maintenance.doctor({ ...base, readFile: (f) => (f.endsWith('push.json') ? counted : config) })).join('\n');
  assert.match(withStats, /보냄 6건 \(메시지 5건\), 실패 1건, 보내지 않음 5건 \(화면을 보는 중 3건 포함\)/);
  const none = await maintenance.doctor({ ...base, readFile: (f) => { if (f.endsWith('push.json')) throw new Error('ENOENT'); return config; } });
  assert.match(maintenance.doctorLines(none).join('\n'), /⚠ 알림: 알림 받을 기기 0대/);
  assert.equal(none.ok, true); // a warning, not a failure
});

test('doctor treats a missing tmux as a warning and distinguishes an interactive-shell Claude', async () => {
  const result = await maintenance.doctor({
    platform: 'linux', home, node: '22.0.0', readFile: () => config, writable: () => true, disk: () => 0.5, health: async () => true, exists: (file) => file === '/nvm/claude',
    command: (cmd) => {
      const line = cmd.join(' ');
      if (line.includes('-lc command -v claude')) return { ok: false, stdout: '' };
      if (line.includes('-lic command -v claude')) return { ok: true, stdout: '/nvm/claude\n' };
      if (line === '/nvm/claude --version') return { ok: true, stdout: 'Claude 1\n' };
      if (line === 'which tmux') return { ok: false, stdout: '' };
      if (line.startsWith('which ')) return { ok: true, stdout: `/usr/bin/${cmd[1]}\n` };
      if (line.endsWith('--version')) return { ok: true, stdout: 'tool 1.0\n' };
      if (line.includes('systemctl --user')) return { ok: true, stdout: '' };
      return { ok: false, stdout: '' };
    },
  });
  const claude = result.checks.find((c) => c.name === 'Claude CLI');
  const tmux = result.checks.find((c) => c.name === 'tmux');
  assert.match(claude.detail, /대화형 셸에서만 보임/);
  assert.deepEqual({ ok: tmux.ok, level: tmux.level }, { ok: false, level: 'warning' });
  assert.equal(result.ok, true);
});

test('doctor finds Claude on a native Windows PATH', async () => {
  const result = await maintenance.doctor({
    platform: 'win32', home: 'C:\\Users\\Kim', node: '22.0.0', readFile: () => config, writable: () => true, disk: () => 0.5, health: async () => true,
    exists: (file) => file === 'C:\\Tools\\claude.cmd',
    command: (cmd) => {
      if (cmd.join(' ') === 'where claude.cmd') return { ok: true, stdout: 'startup text\nC:\\Tools\\claude.cmd\n' };
      if (cmd.join(' ') === 'C:\\Tools\\claude.cmd --version') return { ok: true, stdout: 'Claude 1\n' };
      if (cmd[0] === 'where') return { ok: false, stdout: '' };
      return { ok: true, stdout: 'tool 1\n' };
    },
  });
  assert.match(result.checks.find((c) => c.name === 'Claude CLI').detail, /Windows PATH/);
});

test('doctor discovers Claude in nvm and --fix restores only a recorded missing CLI link', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-fix-'));
  try {
    const nvmClaude = path.join(h, '.nvm/versions/node/v22.1.0/bin/claude');
    fs.mkdirSync(path.dirname(nvmClaude), { recursive: true }); fs.writeFileSync(nvmClaude, '');
    const root = path.join(h, 'install'); const link = path.join(h, '.local/bin/cld-gui'); const target = path.join(root, 'bin/cld-gui');
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'launcher');
    const manager = await import('../install/manager.mjs');
    const record = manager.newRecord({ root, platform: 'linux' });
    record.cli.links = [link]; record.files[link] = `symlink:${target}`;
    await manager.writeRecord(root, record);
    const result = await maintenance.doctor({
      platform: 'linux', home: h, env: { AGENT_TYCOON_ROOT: root }, node: '22.0.0', readFile: (file) => file.endsWith('install.json') ? fs.readFileSync(file, 'utf8') : config,
      writable: () => true, disk: () => 0.5, health: async () => true, exists: fs.existsSync, readdir: (dir) => fs.readdirSync(dir),
      repairCli: (r, rroot) => manager.repairCliLinks(r, rroot, {}),
      command: (cmd) => {
        const line = cmd.join(' ');
        if (line.includes('command -v claude')) return { ok: false, stdout: '' };
        if (line === `${nvmClaude} --version`) return { ok: true, stdout: 'Claude nvm\n' };
        if (line.startsWith('which ')) return { ok: true, stdout: `/usr/bin/${cmd[1]}\n` };
        if (line.endsWith('--version')) return { ok: true, stdout: 'tool 1\n' };
        if (line.includes('systemctl --user')) return { ok: true, stdout: '' };
        return { ok: false, stdout: '' };
      },
    }, { fix: true });
    assert.match(result.checks.find((c) => c.name === 'Claude CLI').detail, /v22\.1\.0/);
    assert.equal(fs.readlinkSync(link), target);
    assert.match(result.repairs.find((r) => r.name === 'CLI 링크').detail, /다시 연결/);
    fs.rmSync(link); fs.writeFileSync(link, 'user replacement');
    const kept = await maintenance.doctor({
      platform: 'linux', home: h, env: { AGENT_TYCOON_ROOT: root }, node: '22.0.0', readFile: (file) => file.endsWith('install.json') ? fs.readFileSync(file, 'utf8') : config,
      writable: () => true, disk: () => 0.5, health: async () => true, exists: fs.existsSync, readdir: (dir) => fs.readdirSync(dir),
      repairCli: (r, rroot) => manager.repairCliLinks(r, rroot, {}), command: () => ({ ok: true, stdout: '/usr/bin/tool\n' }),
    }, { fix: true });
    assert.equal(fs.readFileSync(link, 'utf8'), 'user replacement');
    assert.match(kept.repairs.find((r) => r.name === 'CLI 링크').detail, /사용자 파일 유지/);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('doctor shows a found Codex CLI as OK and a missing one as a warning', async () => {
  const run = (codexAt) => maintenance.doctor({
    platform: 'linux', home, node: '22.0.0', readFile: () => config, writable: () => true, disk: () => 0.5, health: async () => true,
    exists: (file) => file.startsWith('/usr/bin/'),
    command: (cmd) => {
      const line = cmd.join(' ');
      if (line.includes('command -v codex')) return codexAt ? { ok: true, stdout: `${codexAt}\n` } : { ok: false, stdout: '' };
      if (line.includes('command -v claude')) return { ok: true, stdout: '/usr/bin/claude\n' };
      if (line.startsWith('which ')) return { ok: true, stdout: `/usr/bin/${cmd[1]}\n` };
      return { ok: true, stdout: 'tool 1\n' };
    },
  });
  const found = await run('/usr/bin/codex');
  assert.match(maintenance.doctorLines(found).join('\n'), /✔ Codex CLI: \/usr\/bin\/codex/);
  assert.equal(found.checks.find((c) => c.name === 'Codex CLI').level, 'check');
  const missing = await run(null);
  assert.match(maintenance.doctorLines(missing).join('\n'), /⚠ Codex CLI: 찾지 못했습니다/);
  assert.equal(missing.ok, true);
});

test('doctor prints the data sizes and the rule per category, reading only', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-sizes-'));
  try {
    const put = (rel, bytes) => { const f = path.join(h, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'.repeat(bytes)); };
    put('.local/state/cld-gui/jobs/1001-000001-a.log', 3 * 1024 * 1024);
    put('.local/state/cld-gui/codex/1001-000001-a.jsonl', 2048);
    put('.config/agent-tycoon/events.jsonl', 1024);
    put('.config/agent-tycoon/events.jsonl.1', 1024);
    put('.config/agent-tycoon/daemon.log', 512);
    put('.config/agent-tycoon/inbox/a.json', 4096);
    const before = fs.readdirSync(path.join(h, '.local/state/cld-gui/jobs')).length;
    const result = await maintenance.doctor({
      platform: 'linux', home: h, node: '22.14.0', command: commandFixture([]), exists: () => true,
      readFile: () => config, writable: () => true, disk: () => 0.45, health: async () => true,
    }, { fix: false });
    const lines = maintenance.doctorLines(result).join('\n');
    assert.match(lines, /데이터 크기:/);
    assert.match(lines, /작업 로그: 3\.0 MB · 끝난 것은 30일 뒤, 폴더가 1 GiB 를 넘으면/);
    assert.match(lines, /Codex 로그: 2 KB/);
    assert.match(lines, /이벤트 기록: 2 KB · 5 MB 에서 순환/);
    assert.match(lines, /대화·받은편지·에이전트·설정: 4 KB · .*자동으로 지우지 않는다/);
    assert.match(lines, /H\/W 모니터링 기록: 0 B · 디스크에 쓰지 않는다/);
    assert.equal(fs.readdirSync(path.join(h, '.local/state/cld-gui/jobs')).length, before);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('cliNameStatus tells our agty from another program and from nothing', () => {
  const at = (name, files) => maintenance.cliNameStatus({
    platform: 'linux', realpath: (f) => f, exists: () => true, readFile: (f) => { if (f in files) return files[f]; throw new Error('ENOENT'); },
    command: (c) => (c[1] === name && files.where ? { ok: true, stdout: `${files.where}\n` } : { ok: false, stdout: '' }),
  }, name);
  assert.deepEqual(at('agty', {}), { name: 'agty', state: 'none', path: null });
  assert.equal(at('agty', { where: '/usr/bin/agty', '/usr/bin/agty': '#!/bin/sh\necho other\n' }).state, 'other');
  assert.equal(at('agty', { where: '/h/.local/share/at/bin/agty', '/h/.local/share/at/bin/agty': '#!/bin/sh\n# Agent Tycoon launcher, written by the manager: x\n' }).state, 'ours');
  // a symlink to our script resolves to it
  const mine = maintenance.cliNameStatus({ platform: 'linux', exists: () => true, readFile: () => '', realpath: (f) => (f === '/h/.local/bin/agty' ? path.join(__dirname_, 'cld-gui') : f), command: () => ({ ok: true, stdout: '/h/.local/bin/agty\n' }) }, 'agty');
  assert.equal(mine.state, 'ours');
});

test('doctor reports a foreign agty as a warning that points to cld-gui, never as a failure', async () => {
  const calls = [];
  const base = commandFixture(calls);
  const result = await maintenance.doctor({
    platform: 'wsl', home, node: '22.14.0', exists: (file) => file.startsWith('/usr/bin/'), readFile: () => config, realpath: (f) => f,
    command: (c) => (c.join(' ') === 'which agty' ? { ok: true, stdout: '/usr/bin/agty\n' } : base(c)),
    writable: () => true, disk: () => 0.45, health: async () => true,
  });
  assert.equal(result.ok, true);
  assert.match(maintenance.doctorLines(result).join('\n'), /⚠ agty: \/usr\/bin\/agty 는 다른 프로그램입니다 — cld-gui 를 쓰세요/);
});
