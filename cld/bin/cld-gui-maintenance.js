'use strict';

// Read-only service diagnostics and the small OS-specific maintenance plans.
// Keeping the effects behind `deps` makes this safe to exercise without a real
// daemon or service manager.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { dataSizes, sizeLines } = require('./cld-gui-sizes');
const { CLI_NAME, LEGACY_CLI_NAME } = require('./cld-brand');
const { configDirectory } = require('../../core/src/cld/configPath.cjs');

const DEFAULT_PORT = 18240;
const SERVICE = 'cld-gui';
const LABEL = 'dev.cld-gui.daemon';

function configFile(home) { return path.join(configDirectory(home), 'config.json'); }
function logFile(home) { return path.join(configDirectory(home), 'daemon.log'); }
function pushFile(home) { return path.join(configDirectory(home), 'push.json'); }
function remoteTestFile(home) { return path.join(configDirectory(home), 'remote-test.json'); }
/** The LaunchAgent label of a service name (the old cld-gui one keeps its historical label). */
function launchLabel(name = SERVICE) { return name === SERVICE ? LABEL : `dev.${name}.daemon`; }
function serviceFile(platform, home, name = SERVICE) {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', `${launchLabel(name)}.plist`);
  if (platform === 'win32') return null;
  return path.join(home, '.config', 'systemd', 'user', `${name}.service`);
}

/**
 * Agent Tycoon's install root (H §2.1): versions/, current, bin/, install.json. AGENT_TYCOON_ROOT
 * overrides it (tests, and a WSL distro driven from Windows).
 */
function installRoot(platform = process.platform, home = os.homedir(), env = process.env) {
  if (env.AGENT_TYCOON_ROOT) return path.resolve(env.AGENT_TYCOON_ROOT);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'AgentTycoon');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'AgentTycoon');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'agent-tycoon');
}

/** The service the manager recorded (install.json), else the source installer's `cld-gui`. */
function installedService(platform, home, env = process.env) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(installRoot(platform === 'wsl' ? 'linux' : platform, home, env), 'install.json'), 'utf8'));
    if (typeof record.service?.name === 'string' && /^[a-z0-9-]+$/.test(record.service.name)) return record.service.name;
  } catch { /* no manager install */ }
  return SERVICE;
}

function serviceCommands(platform, uid, name = SERVICE) {
  if (platform === 'darwin') return {
    installed: null,
    active: ['launchctl', 'print', `gui/${uid}/${launchLabel(name)}`],
    restart: ['launchctl', 'kickstart', '-k', `gui/${uid}/${launchLabel(name)}`],
  };
  if (platform === 'win32') return {
    installed: ['schtasks', '/Query', '/TN', name],
    active: ['schtasks', '/Query', '/TN', name],
    restart: ['schtasks', '/Run', '/TN', name],
  };
  return {
    installed: ['systemctl', '--user', 'is-enabled', name],
    active: ['systemctl', '--user', 'is-active', name],
    restart: ['systemctl', '--user', 'restart', name],
  };
}

function logsCommand(platform, home, n, follow, name = SERVICE) {
  if (platform === 'darwin') return ['tail', '-n', String(n), ...(follow ? ['-f'] : []), logFile(home)];
  if (platform === 'win32') {
    const wait = follow ? ' -Wait' : '';
    return ['powershell', '-NoProfile', '-Command', `Get-Content -LiteralPath '${logFile(home).replaceAll("'", "''")}' -Tail ${n}${wait}`];
  }
  return ['journalctl', '--user', '-u', name, '-n', String(n), '--no-pager', ...(follow ? ['-f'] : [])];
}

function parseNumber(value, fallback) {
  return /^\d+$/.test(String(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function parseMaintenanceArgs(argv) {
  const got = { json: false, follow: false, n: 200 };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    if (a === '--json') got.json = true;
    else if (a === '-f' || a === '--follow') got.follow = true;
    else if (a === '-n') {
      if (!args.length || !/^\d+$/.test(args[0]) || Number(args[0]) < 1)
        return { error: '-n 은 1 이상의 정수예요' };
      got.n = Number(args.shift());
    } else return { error: `알 수 없는 옵션: ${a}` };
  }
  return got;
}

function realCommand(command, options = {}) {
  const r = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8', timeout: options.timeout ?? 3000, windowsHide: true,
  });
  return { ok: !r.error && r.status === 0, code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function realDeps(overrides = {}) {
  const home = overrides.home ?? os.homedir();
  const platform = overrides.platform ?? (process.platform === 'linux' && /microsoft/i.test(os.release()) ? 'wsl' : process.platform);
  return {
    platform,
    home,
    service: installedService(platform, home),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    node: process.versions.node,
    command: realCommand,
    exists: fs.existsSync,
    readdir: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } },
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    realpath: (file) => { try { return fs.realpathSync(file); } catch { return file; } },
    writable: (file) => { try { fs.accessSync(file, fs.constants.W_OK); return true; } catch { return false; } },
    disk: () => {
      try { const s = fs.statfsSync(home); return s.blocks ? s.bavail / s.blocks : null; } catch { return null; }
    },
    health: async (port) => realCommand(['curl', '-fsS', '--max-time', '2', `http://127.0.0.1:${port}/api/health`]).ok,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    repairCli: async (record, root) => {
      const manager = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'install', 'manager.mjs')).href);
      return manager.repairCliLinks(record, root, {});
    },
    ...overrides,
  };
}

function check(name, ok, detail, fix = null, level = 'check') { return { name, ok, detail, fix, level }; }
function commandOk(deps, command) { return deps.command(command).ok; }
function commandText(result) { return String(result.stdout || result.stderr || '').trim().split('\n')[0]; }

const outsideTools = [
  ['git', 'worktree 기능', 'git'], ['tmux', '브라우저 터미널 셸', 'tmux'],
  ['bash', '로그인 스크립트', 'bash'], ['python3', '로그인 스크립트', 'python3'],
  ['systemd-run', '선택', 'systemd'],
];
function installHint(platform, pkg) {
  if (platform === 'win32') return 'Windows에서는 WSL 안에서 실행하세요.';
  return platform === 'darwin' ? `brew install ${pkg}` : `sudo apt install ${pkg}`;
}
function commandPath(deps, command, args = []) {
  const r = deps.command(command, { timeout: 3000 });
  if (!r.ok) return null;
  const found = String(r.stdout || r.stderr || '').trim().split(/\r?\n/).map((line) => line.trim()).reverse()
    .find((line) => (path.isAbsolute(line) || path.win32.isAbsolute(line)) && deps.exists(line));
  return found ? { path: found, args } : null;
}
// The launcher texts the installers write (cld/install/install.mjs CLI_MARK, manager.mjs LAUNCHER_MARK).
const OUR_LAUNCHER_MARKS = ['rem cld-gui: written by cld/install/install.mjs', 'Agent Tycoon launcher, written by the manager'];
/** Where `name` resolves on PATH: ours (this CLI or a launcher an installer wrote), something else, or nothing. */
function cliNameStatus(deps, name, platform = deps.platform) {
  const found = commandPath(deps, [platform === 'win32' ? 'where' : 'which', platform === 'win32' ? `${name}.cmd` : name])
    ?? (platform === 'win32' ? commandPath(deps, ['where', name]) : null);
  if (!found) return { name, state: 'none', path: null };
  const real = deps.realpath ? deps.realpath(found.path) : found.path;
  let text = '';
  try { text = String(deps.readFile(found.path)); } catch { /* unreadable: not ours */ }
  const ours = real === deps.realpath?.(path.join(__dirname, LEGACY_CLI_NAME)) || OUR_LAUNCHER_MARKS.some((mark) => text.includes(mark));
  return { name, state: ours ? 'ours' : 'other', path: found.path };
}
function cliNameCheck(deps) {
  const r = cliNameStatus(deps, CLI_NAME);
  if (r.state === 'ours') return check(CLI_NAME, true, `${r.path} 가 이 도구를 실행합니다`, null, 'info');
  if (r.state === 'other') return check(CLI_NAME, true, `${r.path} 는 다른 프로그램입니다 — ${LEGACY_CLI_NAME} 를 쓰세요`, `${LEGACY_CLI_NAME} 로 실행하거나 그 프로그램의 이름을 바꾼 뒤 설치기를 다시 실행하세요.`, 'warning');
  return check(CLI_NAME, true, `PATH 에 없습니다 — ${LEGACY_CLI_NAME} 를 쓰세요`, '설치기(node cld/install/install.mjs)를 다시 실행하면 PATH 에 놓입니다.', 'warning');
}
function agentCli(deps, name, platform, home) {
  if (platform === 'win32') {
    const found = commandPath(deps, ['where', `${name}.cmd`]) ?? commandPath(deps, ['where', name]);
    return found ? { ...found, how: 'Windows PATH' } : null;
  }
  const shell = deps.shell || process.env.SHELL || '/bin/sh';
  let found = commandPath(deps, [shell, '-lc', `command -v ${name}`]);
  if (found) return { ...found, how: '로그인 셸' };
  found = commandPath(deps, [shell, '-lic', `command -v ${name}`]);
  if (found) return { ...found, how: '대화형 셸에서만 보임' };
  const known = [path.join(home, '.local', 'bin', name)];
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  for (const v of deps.readdir(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) known.push(path.join(nvm, v, 'bin', name));
  known.push(path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', name));
  known.push(path.join(home, '.fnm', 'aliases', 'default', 'bin', name));
  known.push(path.join(home, '.volta', 'bin', name));
  const prefix = commandPath(deps, [shell, '-lc', 'npm config get prefix'])?.path;
  if (prefix) known.push(path.join(prefix, 'bin', name));
  for (const candidate of known) if (deps.exists(candidate)) return { path: candidate, how: '알려진 설치 위치' };
  return null;
}

async function safeFix(deps, checks) {
  const repairs = [];
  const installed = checks.find((c) => c.name === '서비스 설치')?.ok;
  const active = checks.find((c) => c.name === '서비스 실행')?.ok;
  if (installed && !active) {
    const r = await restart(deps);
    repairs.push({ name: '서비스 재시작', ok: r.ok, detail: r.ok ? '다시 시작했습니다' : '다시 시작하지 못했습니다' });
  }
  let record;
  try { record = JSON.parse(deps.readFile(path.join(installRoot(deps.platform === 'wsl' ? 'linux' : deps.platform, deps.home, deps.env), 'install.json'))); } catch { record = null; }
  if (record?.cli?.links?.length) {
    const result = await deps.repairCli(record, record.root || installRoot(deps.platform, deps.home, deps.env));
    const repaired = Array.isArray(result) ? result : result.repaired;
    const kept = Array.isArray(result) ? [] : result.kept;
    if (result.busy) repairs.push({ name: 'CLI 링크', ok: false, detail: `다른 관리자 작업이 실행 중이라 건드리지 않았습니다 (${result.busy})` });
    else repairs.push({ name: 'CLI 링크', ok: true, detail: repaired.length ? `다시 연결: ${repaired.join(', ')}` : kept.length ? `사용자 파일 유지: ${kept.join(', ')}` : '바꿀 것이 없습니다' });
  }
  return repairs;
}

async function doctor(dependencies = {}, options = {}) {
  const deps = realDeps(dependencies);
  const platform = deps.platform;
  const home = deps.home;
  let config = {};
  let configOk = true;
  try { config = JSON.parse(deps.readFile(configFile(home))); } catch { configOk = false; }
  const port = Number.isInteger(config.port) ? config.port : DEFAULT_PORT;
  const checks = [];
  const nodeMajor = Number(String(deps.node).split('.')[0]);
  checks.push(check('Node.js', nodeMajor >= 22, `v${deps.node}`, 'Node.js 22 이상을 설치하세요.'));

  const which = platform === 'win32' ? 'where' : 'which';
  const claudeAt = agentCli(deps, 'claude', platform, home);
  if (!claudeAt) checks.push(check('Claude CLI', false, '찾지 못했습니다', 'Claude Code를 설치하고 로그인 셸에서 claude --version 을 확인하세요.'));
  else {
    const version = deps.command([claudeAt.path, '--version']);
    checks.push(check('Claude CLI', version.ok, version.ok ? `${claudeAt.path} (${claudeAt.how}) · ${commandText(version) || '설치됨'}` : `${claudeAt.path} (버전을 읽지 못했습니다)`, 'claude --version 이 동작하도록 Claude Code를 다시 설치하세요.'));
  }

  const services = serviceCommands(platform, deps.uid, deps.service);
  const unit = serviceFile(platform, home, deps.service);
  const installed = platform === 'darwin' ? deps.exists(unit) : commandOk(deps, services.installed);
  checks.push(check('서비스 설치', installed, installed ? '등록됨' : '등록되지 않았습니다', 'node cld/install/install.mjs 를 실행하세요.'));
  const active = installed && commandOk(deps, services.active);
  checks.push(check('서비스 실행', active, active ? '실행 중' : '실행 중이 아닙니다', `${CLI_NAME} restart 를 실행하세요.`));

  checks.push(cliNameCheck(deps));
  const health = await deps.health(port);
  checks.push(check('HTTP 상태', health, health ? `/api/health 응답 (${port})` : `/api/health 응답 없음 (${port})`, `${CLI_NAME} restart 를 실행한 뒤 ${CLI_NAME} logs 를 보세요.`));
  checks.push(check('설정 파일', configOk, configOk ? '읽을 수 있는 JSON' : '읽을 수 없거나 JSON이 아닙니다', `${configFile(home)} 를 올바른 JSON으로 고치세요.`));
  checks.push(check('~/.claude', deps.writable(path.join(home, '.claude')), deps.writable(path.join(home, '.claude')) ? '쓸 수 있습니다' : '쓸 수 없습니다', '폴더를 만들고 현재 사용자에게 쓰기 권한을 주세요.'));

  const free = deps.disk();
  if (typeof free === 'number' && free < 0.1)
    checks.push(check('디스크 여유', true, `여유 ${Math.round(free * 100)}%`, '디스크 공간을 비우세요.', 'warning'));
  else checks.push(check('디스크 여유', true, typeof free === 'number' ? `여유 ${Math.round(free * 100)}%` : '확인하지 못함', null, 'info'));

  // Count only: push.json also holds the VAPID key and capability URLs, which are never shown.
  let pushDevices = 0;
  let pushStats = {};
  try {
    const file = JSON.parse(deps.readFile(pushFile(home)));
    pushDevices = Array.isArray(file.subscriptions) ? file.subscriptions.length : 0;
    if (file.stats && typeof file.stats === 'object') pushStats = file.stats; // U-49: the daemon's counters (numbers only)
  } catch { /* no file: none */ }
  // U-49: what the daemon sent and left out (counts since its first push; they are saved about once a minute).
  const total = (prefix) => Object.entries(pushStats).filter(([k, v]) => k.startsWith(prefix) && typeof v === 'number').reduce((n, [, v]) => n + v, 0);
  const pushLog = total('sent.') + total('failed.') + total('skipped.') > 0
    ? ` · 보냄 ${total('sent.')}건 (메시지 ${total('sent.reply')}건), 실패 ${total('failed.')}건, 보내지 않음 ${total('skipped.')}건 (화면을 보는 중 ${total('skipped.reply.device-looking') + total('skipped.turnEnd.device-looking')}건 포함)`
    : '';
  checks.push(pushDevices > 0
    ? check('알림', true, `알림 받을 기기 ${pushDevices}대${pushLog}`, null, 'info')
    : check('알림', true, '알림 받을 기기 0대 — 알림을 받을 기기에서 사무실을 열고 "알림 받기"를 켜세요 (iPhone은 홈 화면에 추가한 앱에서)', null, 'warning'));

  const versionArgs = { git: ['--version'], tmux: ['-V'], bash: ['--version'], python3: ['--version'], 'systemd-run': ['--version'] };
  for (const [name, need, pkg] of outsideTools) {
    if (name === 'systemd-run' && !['linux', 'wsl'].includes(platform)) continue;
    const found = deps.command([which, platform === 'win32' ? `${name}.exe` : name]);
    const version = found.ok ? deps.command([name, ...versionArgs[name]]) : null;
    checks.push(check(name, !!found.ok, found.ok ? commandText(version) || '설치됨' : `찾지 못했습니다 (${need})`, `${need}에 필요: ${installHint(platform, pkg)}`, found.ok ? 'check' : 'warning'));
  }
  for (const name of ['codex']) {
    const found = agentCli(deps, name, platform, home);
    const version = found ? deps.command([found.path, '--version']) : null;
    checks.push(check('Codex CLI', !!found, found ? `${found.path} (${found.how}) · ${commandText(version) || '설치됨'}` : '찾지 못했습니다', 'Codex CLI를 설치하고 로그인 셸에서 codex --version 을 확인하세요.', found ? 'check' : 'warning'));
  }

  // H §4.4: the WSL state apart from the daemon state (서비스 실행, HTTP 상태 above), and the start policy (R1/P6).
  let record = null;
  try { record = JSON.parse(deps.readFile(path.join(installRoot(platform === 'wsl' ? 'linux' : platform, home, deps.env), 'install.json'))); } catch { /* a source install has none */ }
  if (platform === 'wsl')
    checks.push(check('WSL', true, `배포판 ${(deps.env ?? process.env).WSL_DISTRO_NAME || '알 수 없음'} 실행 중 · systemd ${deps.exists('/run/systemd/system') ? '켜짐' : '꺼짐 (데몬은 감독 프로세스로)'}`, null, 'info'));
  if (record && ['linux', 'wsl'].includes(platform)) {
    const policy = ['on-demand', 'always', 'manual'].includes(record.startPolicy) ? record.startPolicy : 'on-demand';
    const task = record.logonTask ? deps.command(['schtasks.exe', '/Query', '/TN', record.logonTask.name]).ok : null; // read-only
    const missing = policy === 'always' && platform === 'wsl' && !task;
    checks.push(check('시작 정책', !missing, `${policy}${task === null ? '' : task ? ` · Windows 로그온 작업 ${record.logonTask.name} 있음` : ' · Windows 로그온 작업 없음'}${record.linger ? ` · linger(${record.linger.user})` : ''}`, `${CLI_NAME} start-policy always 를 다시 실행하세요.`, missing ? 'warning' : 'info'));
  }
  if (platform === 'wsl') {
    const lhmPort = Number.isInteger(config.lhmPort) ? config.lhmPort : 8085;
    const lhm = deps.command(['/mnt/c/Windows/System32/curl.exe', '-fsS', '--max-time', '2', `http://127.0.0.1:${lhmPort}/data.json`]);
    checks.push(check('LibreHardwareMonitor', lhm.ok, lhm.ok ? `${lhmPort} 포트 응답` : `${lhmPort} 포트 응답 없음`, 'Windows에서 LibreHardwareMonitor 웹 서버를 켜거나 설치기를 --hw-sensors로 다시 실행하세요.'));
  }
  for (const name of ['tailscale', 'cloudflared']) {
    const found = deps.command([which, platform === 'win32' ? `${name}.exe` : name]).ok;
    checks.push(check(name, true, found ? '설치됨' : '설치되지 않음', null, 'info'));
  }
  const repairs = options.fix ? await safeFix(deps, checks) : [];
  return { ok: checks.filter((c) => c.level === 'check').every((c) => c.ok), checks, port, repairs, sizes: dataSizes(home, platform === 'win32' ? 'win32' : 'linux') };
}

function doctorLines(result) {
  return result.checks.flatMap((item) => {
    const mark = item.level === 'warning' ? '⚠' : item.level === 'info' ? 'ℹ' : item.ok ? '✔' : '✖';
    return [`${mark} ${item.name}: ${item.detail}`, ...(!item.ok && item.fix ? [`  고치기: ${item.fix}`] : [])];
  }).concat((result.repairs ?? []).map((r) => `${r.ok ? '✔' : '✖'} 고치기 ${r.name}: ${r.detail}`), result.sizes ? sizeLines(result.sizes) : []);
}

function doctorExitCode(result) { return result.ok ? 0 : 1; }

function statusLines(result) {
  if (!result.daemon.up)
    return ['✖ 데몬: 꺼짐', `다음: ${result.next}`];
  const projects = result.projects ?? [];
  const group = (state, label) => {
    const names = projects.filter((p) => p.state === state).map((p) => p.name);
    return `${label} ${names.length}${names.length ? ` (${names.join(', ')})` : ''}`;
  };
  const tasks = (result.tasks ?? []).filter((task) => ['running', 'working'].includes(task.state));
  const jobs = (result.jobs ?? []).filter((job) => !job.ended && !job.exit);
  const remote = result.connector ?? {};
  const last = remote.checkedAt ? new Date(remote.checkedAt).toLocaleString('ko-KR') : '없음';
  return [
    `✔ 데몬: 실행 중 · ${result.daemon.version ?? '버전 알 수 없음'} · 포트 ${result.daemon.port} · ${result.daemon.uptime ?? '?'}초`,
    `엔진 프로젝트: ${group('on', '켜짐')} · ${group('rest', '쉬는 중')} · ${group('off', '꺼짐')}`,
    `실행 중 작업: Codex ${tasks.length}${tasks.length ? ` (${tasks.map((t) => t.id).join(', ')})` : ''} · 작업 ${jobs.length}${jobs.length ? ` (${jobs.map((j) => j.id ?? j.pid).join(', ')})` : ''}`,
    `원격 연결: ${remote.connector ?? 'local'} · 바깥 접속 확인됨: ${last}`,
    result.hwLine || 'HW: 아직 측정값이 없습니다',
  ];
}

async function status(dependencies = {}) {
  const deps = realDeps(dependencies);
  const config = dependencies.config ?? (() => { try { return JSON.parse(deps.readFile(configFile(deps.home))); } catch { return {}; } })();
  const snapshot = await deps.request('status', {});
  if (snapshot === null || !snapshot.ok)
    return { ok: false, daemon: { up: false, port: config.port ?? DEFAULT_PORT }, next: `${CLI_NAME} restart`, projects: [], jobs: [], tasks: [], connector: { connector: config.connector ?? 'local' } };
  const health = await deps.health(config.port ?? DEFAULT_PORT);
  let remote = null;
  try { remote = JSON.parse(deps.readFile(remoteTestFile(deps.home))); } catch { /* no outside test yet */ }
  return {
    ok: health,
    daemon: { up: health, version: deps.version ?? null, port: config.port ?? DEFAULT_PORT, uptime: health && typeof deps.healthInfo === 'function' ? (await deps.healthInfo(config.port ?? DEFAULT_PORT)).uptime : null },
    next: health ? null : `${CLI_NAME} doctor`,
    projects: snapshot.projects ?? [], jobs: snapshot.jobs ?? [], tasks: snapshot.tasks ?? [],
    connector: { connector: config.connector ?? 'local', checkedAt: remote?.ok ? remote.checkedAt : null },
    hwLine: snapshot.hwLine ?? (snapshot.hw && typeof deps.hwLine === 'function' ? deps.hwLine(snapshot.hw) : null),
  };
}

async function restart(dependencies = {}) {
  const deps = realDeps(dependencies);
  const config = dependencies.config ?? (() => { try { return JSON.parse(deps.readFile(configFile(deps.home))); } catch { return {}; } })();
  const command = serviceCommands(deps.platform, deps.uid, deps.service).restart;
  const started = deps.command(command).ok;
  const port = config.port ?? DEFAULT_PORT;
  if (!started) return { ok: false, command, port, waited: false };
  for (let waited = 0; waited < 20_000; waited += 500) {
    if (await deps.health(port)) return { ok: true, command, port, waited: true };
    await deps.sleep(500);
  }
  return { ok: false, command, port, waited: true };
}

function logs(dependencies = {}, { n = 200, follow = false } = {}) {
  const deps = realDeps(dependencies);
  return { command: logsCommand(deps.platform, deps.home, n, follow, deps.service), follow };
}

function followLogs(command) { return spawn(command[0], command.slice(1), { stdio: 'inherit', windowsHide: true }); }

module.exports = {
  DEFAULT_PORT, agentCli, configFile, doctor, installRoot, installedService, launchLabel, doctorExitCode, doctorLines, logs, logsCommand, logFile, parseMaintenanceArgs,
  realDeps, restart, cliNameStatus, serviceCommands, serviceFile, status, statusLines, followLogs,
};
