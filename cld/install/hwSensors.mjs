/**
 * T-0030: the installer's --hw-sensors step. Windows and WSL get LibreHardwareMonitor
 * (LHM) with its web server, unless an LHM already answers; Linux reads sysfs and
 * macOS has nothing to install. Renderers and the plan are pure (tests); detection
 * only reads (tasklist, schtasks /Query, netsh http show, GET /data.json).
 * Research and sources: cld/tasks/progress/T-0030.md.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Pinned downloads. The SHA-256s are GitHub's release digests, the same in winget's manifests. */
export const LHM = Object.freeze({
  version: '0.9.6',
  url: 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v0.9.6/LibreHardwareMonitor.zip',
  sha256: '086D9F1B5A99E643EDC2CFAAAC16051685B551E4C5AC0B32A57C58C0E529C001',
  port: 8085, // LHM's own default
  task: 'cld-gui-lhm',
  firewallRule: 'cld-gui: LHM local only',
});
export const PAWNIO = Object.freeze({
  version: '2.2.0',
  url: 'https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe',
  sha256: '1F519A22E47187F70A1379A48CA604981C4FCF694F4E65B734AAA74A9FBA3032',
});
/** Program Files, not the user's app data: an elevated logon task must not run files the user's
 *  own processes can swap (a folder under %LOCALAPPDATA% can always be renamed away). */
const ROOT = String.raw`C:\Program Files\cld-gui`;
const CPU_CHIPS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'];

const psq = (s) => `'${String(s).replaceAll("'", "''")}'`;
export const encodePowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** LHM's settings file (LibreHardwareMonitor.config next to the exe): web server on, start in the tray. */
export function renderLhmConfig(port) {
  const keys = { startMinMenuItem: 'true', minTrayMenuItem: 'true', minCloseMenuItem: 'true', runWebServerMenuItem: 'true', listenerPort: String(port) };
  return `<?xml version="1.0" encoding="utf-8"?><configuration><appSettings>${Object.entries(keys).map(([k, v]) => `<add key="${k}" value="${v}" />`).join('')}</appSettings></configuration>`;
}

const ADMIN_HEAD = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $env:ProgramFiles 'cld-gui'
$dir = Join-Path $root 'LibreHardwareMonitor'
$exe = Join-Path $dir 'LibreHardwareMonitor.exe'
$log = Join-Path $root 'setup.log'`;

/** The elevated part of the install, all of it under the one UAC prompt. */
export function renderLhmAdminScript(port) {
  return `${ADMIN_HEAD}
$user = '@USER@'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Get-Verified([string]$url, [string]$file, [string]$sha) {
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash -ne $sha) { Remove-Item -LiteralPath $file -Force; throw "checksum mismatch: $url" }
}
try {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Set-Content -LiteralPath $log -Value "cld-gui sensor setup $(Get-Date -Format s)"
  Get-Process -Name LibreHardwareMonitor -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
  $zip = Join-Path $root 'lhm.zip'
  Get-Verified ${psq(LHM.url)} $zip ${psq(LHM.sha256)}
  Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
  Remove-Item -LiteralPath $zip -Force
  Add-Content -LiteralPath $log -Value 'LibreHardwareMonitor ${LHM.version}: SHA-256 ok, extracted'
  $key = Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PawnIO' -ErrorAction SilentlyContinue
  $v = $null
  if (-not ($key -and [version]::TryParse([string]$key.DisplayVersion, [ref]$v) -and $v -ge [version]'2.0')) {
    $setup = Join-Path $root 'PawnIO_setup.exe'
    Get-Verified ${psq(PAWNIO.url)} $setup ${psq(PAWNIO.sha256)}
    $p = Start-Process -FilePath $setup -ArgumentList '-install', '-silent' -Wait -PassThru
    Remove-Item -LiteralPath $setup -Force
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "PawnIO setup exit code $($p.ExitCode)" }
    Set-Content -LiteralPath (Join-Path $root 'pawnio-installed-by-cld-gui') -Value 'PawnIO ${PAWNIO.version}'
    Add-Content -LiteralPath $log -Value 'PawnIO ${PAWNIO.version}: installed'
  }
  Set-Content -LiteralPath (Join-Path $dir 'LibreHardwareMonitor.config') -Encoding UTF8 -Value ${psq(renderLhmConfig(port))}
  $action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName '${LHM.task}' -Description 'cld-gui: LibreHardwareMonitor at logon, for the office HW panel' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName '${LHM.task}'
  Add-Content -LiteralPath $log -Value 'task ${LHM.task}: registered and started'
  # LHM's web server listens on every interface with no auth (fan control by GET); hosts with a public IP on the NIC would expose it to the internet.
  # Windows Firewall does not filter loopback, so localhost readers keep working.
  Get-NetFirewallRule -DisplayName '${LHM.firewallRule}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName '${LHM.firewallRule}' -Description 'cld-gui: block inbound to the LibreHardwareMonitor web server from the network; loopback stays allowed' -Direction Inbound -Action Block -Protocol TCP -LocalPort ${port} -Profile Any | Out-Null
  Add-Content -LiteralPath $log -Value 'firewall: inbound TCP ${port} blocked (loopback still allowed)'
} catch {
  Add-Content -LiteralPath $log -Value "failed: $_"
  exit 1
}`;
}

/** The elevated part of the uninstall: our task (when it runs our copy), our copy, nothing else. */
export function renderLhmUninstallAdminScript() {
  return `${ADMIN_HEAD}
try {
  $task = Get-ScheduledTask -TaskName '${LHM.task}' -ErrorAction SilentlyContinue
  if ($task -and @($task.Actions | Where-Object { $_.Execute -eq $exe }).Count) { Unregister-ScheduledTask -TaskName '${LHM.task}' -Confirm:$false }
  Get-Process -Name LibreHardwareMonitor -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  Get-NetFirewallRule -DisplayName '${LHM.firewallRule}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
} catch {
  if (Test-Path -LiteralPath $root) { Add-Content -LiteralPath $log -Value "uninstall failed: $_" }
  exit 1
}`;
}

/** Runs `admin` elevated: the one UAC prompt. Exit 1223 when the user says no; prints the log. */
function elevate(admin, before = '') {
  return `$ErrorActionPreference = 'Stop'
${before}$admin = @'
${admin}
'@
$admin = $admin.Replace('@USER@', [Security.Principal.WindowsIdentity]::GetCurrent().Name.Replace("'", "''"))
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($admin))
$log = Join-Path $env:ProgramFiles 'cld-gui\\setup.log'
try {
  $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc
} catch { exit 1223 }
if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log }
exit $p.ExitCode`;
}

export const renderLhmInstallScript = (port) => elevate(renderLhmAdminScript(port));
export const renderLhmUninstallScript = () =>
  elevate(renderLhmUninstallAdminScript(), `if (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'cld-gui\\pawnio-installed-by-cld-gui')) { 'PAWNIO-BY-CLD-GUI' }\n`);

/** `tasklist /FO CSV /NH` -> pids. */
export function parseTasklist(csv) {
  return [...String(csv).matchAll(/^"[^"]*","(\d+)"/gm)].map((m) => Number(m[1]));
}

/** `netsh http show servicestate view=requestq` -> {pid, port} per registered URL. The text is
 *  localized, so only its shape is read: a request queue starts at column 0, a line holding only
 *  a number is a process id, and URLs look like `HTTP://+:18085/`. */
export function parseHttpServiceState(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n(?=\S)/)) {
    const pids = [...block.matchAll(/^\s+(\d+)\s*$/gm)].map((m) => Number(m[1]));
    const ports = [...block.matchAll(/https?:\/\/[^\s/]*:(\d+)\//gi)].map((m) => Number(m[1]));
    for (const pid of pids) for (const port of ports) out.push({ pid, port });
  }
  return out;
}

const UAC_ONCE = '  곧 Windows 관리자 확인 창(UAC)이 한 번 뜹니다. "예"를 누르세요. "아니요"면 센서 없이 계속합니다.';

/** What the step does, per OS and what detection found. `script` runs elevated-once PowerShell;
 *  `lhmPort` goes to the config (and the daemon's --lhm-port); `waitPort` is polled after `script`. */
export function hwSensorsPlan({ platform, enabled = true, uninstall = false, detection = null, linux = null, port = LHM.port, nvidiaSmi = false }) {
  if (platform === 'win32' || platform === 'wsl') {
    if (uninstall) {
      if (!detection?.ours) return { lines: ['✔ cld-gui가 설치한 센서 도구 없음(다른 LibreHardwareMonitor는 건드리지 않음)'] };
      return { lines: [`… cld-gui가 설치한 센서 도구를 지웁니다: 예약 작업 ${LHM.task}과 ${ROOT}`, '  곧 Windows 관리자 확인 창(UAC)이 한 번 뜹니다. PawnIO 드라이버는 다른 프로그램도 쓸 수 있어 남겨 둡니다.'], script: renderLhmUninstallScript() };
    }
    if (!enabled) return { lines: ['… H/W 센서 도구 건너뜀(--no-hw-sensors). 켜려면 --hw-sensors'] };
    if (detection?.state === 'running') return { lines: [`✔ LibreHardwareMonitor 이미 실행 중(:${detection.port}) → 설치 건너뜀, 그 값을 읽습니다`], lhmPort: detection.port };
    if (detection?.state === 'no-web')
      return { lines: ['! LibreHardwareMonitor가 실행 중이지만 웹 서버가 꺼져 있어 온도를 읽지 못합니다. 그 LHM은 그대로 둡니다.', '  LHM의 Options → Remote Web Server → Run을 켜고 설치를 다시 실행하세요(다른 포트면 --lhm-port <포트>).'] };
    return {
      lines: [
        `… H/W 센서 도구를 설치합니다: LibreHardwareMonitor ${LHM.version} (MPL-2.0)`,
        `  - ${ROOT}\\LibreHardwareMonitor 에 받아 SHA-256을 확인합니다.`,
        `  - 온도 드라이버 PawnIO ${PAWNIO.version}(서명된 드라이버)가 없으면 함께 설치합니다. 지울 때는 Windows 설정 → 앱.`,
        `  - 웹 서버 :${port}, 트레이로 시작, 로그인할 때 관리자 권한으로 켜는 예약 작업 ${LHM.task}.`,
        UAC_ONCE,
        '  건너뛰려면 --no-hw-sensors.',
      ],
      script: renderLhmInstallScript(port),
      waitPort: port,
    };
  }
  if (uninstall || !enabled) return { lines: [] };
  if (platform === 'linux') {
    const lines = [linux?.cpuTemp ? '✔ 센서: Linux hwmon에서 온도를 읽습니다(설치할 것 없음)' : linux?.sensors ? '! CPU 온도 센서를 찾지 못했습니다(가상 머신이면 정상입니다)' : '! CPU 온도 센서를 찾지 못했습니다. 선택: sudo apt install lm-sensors && sudo sensors-detect'];
    if (linux?.nvidiaSmi && !nvidiaSmi) lines.push('  NVIDIA GPU 값은 --nvidia-smi로 켭니다(멈춘 조회가 있으면 건너뜁니다).');
    return { lines };
  }
  if (platform === 'darwin') return { lines: ['… macOS: 설치할 것 없음. CPU 사용률, 메모리, 디스크를 보여 줍니다(온도와 전력은 관리자 권한이나 별도 프로그램이 필요합니다).'] };
  return { lines: [] };
}

// ── Detection and execution (read-only until the plan runs) ──

/** A Windows program, from WSL by absolute path when the default C: mount has it. */
function winExe(platform, rel) {
  if (platform !== 'wsl') return path.win32.basename(rel);
  const abs = `/mnt/c/Windows/System32/${rel}`;
  return fs.existsSync(abs) ? abs : path.posix.basename(rel); // ponytail: another automount root needs Windows dirs on PATH
}
function run(file, args, timeout = 20_000) {
  return new Promise((resolve) => execFile(file, args, { encoding: 'latin1', timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout ?? '' })));
}
const isLhmTree = (json) => {
  const stack = [json];
  while (stack.length) { const n = stack.pop(); if (n && typeof n === 'object') { if (typeof n.SensorId === 'string') return true; if (Array.isArray(n.Children)) stack.push(...n.Children); } }
  return false;
};
/** Does LHM's web server answer on `port`? 127.0.0.1 (Windows, or WSL in mirrored mode), else Windows' curl.exe from WSL. */
export async function lhmAnswers(platform, port) {
  try { const res = await fetch(`http://127.0.0.1:${port}/data.json`, { signal: AbortSignal.timeout(1500) }); if (res.ok && isLhmTree(await res.json())) return true; } catch { /* next */ }
  if (platform !== 'wsl') return false;
  const r = await run(winExe(platform, 'curl.exe'), ['-s', '-m', '2', `http://localhost:${port}/data.json`]);
  try { return r.code === 0 && isLhmTree(JSON.parse(r.stdout)); } catch { return false; }
}
async function ours(platform) {
  const task = (await run(winExe(platform, 'schtasks.exe'), ['/Query', '/TN', LHM.task])).code === 0;
  const dir = platform === 'wsl' ? '/mnt/c/Program Files/cld-gui' : path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'cld-gui');
  return task || fs.existsSync(dir);
}
/** {state: running|no-web|missing, port?, ours}. A running LHM without a web server that is not ours stays alone. */
export async function detectLhm(platform, port, { uninstall = false } = {}) {
  const mine = await ours(platform);
  if (uninstall) return { ours: mine };
  if (await lhmAnswers(platform, port)) return { state: 'running', port, ours: mine };
  const pids = parseTasklist((await run(winExe(platform, 'tasklist.exe'), ['/FI', 'IMAGENAME eq LibreHardwareMonitor.exe', '/FO', 'CSV', '/NH'])).stdout);
  if (!pids.length) return { state: 'missing', ours: mine };
  const urls = parseHttpServiceState((await run(winExe(platform, 'netsh.exe'), ['http', 'show', 'servicestate', 'view=requestq'])).stdout);
  for (const { pid, port: p } of urls) if (pids.includes(pid) && p !== port && (await lhmAnswers(platform, p))) return { state: 'running', port: p, ours: mine };
  return { state: mine ? 'missing' : 'no-web', ours: mine }; // our own copy without its server: set it up again
}
export function linuxSensors(sys = '/sys', envPath = process.env.PATH ?? '') {
  const names = (() => { try { return fs.readdirSync(`${sys}/class/hwmon`).map((c) => { try { return fs.readFileSync(`${sys}/class/hwmon/${c}/name`, 'utf8').trim(); } catch { return ''; } }); } catch { return []; } })();
  const onPath = (cmd) => envPath.split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, cmd)));
  return { cpuTemp: names.some((n) => CPU_CHIPS.includes(n)), sensors: onPath('sensors'), nvidiaSmi: onPath('nvidia-smi') };
}
function runPowerShell(platform, script) {
  return run(winExe(platform, 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)], 15 * 60_000);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastLine = (text) => String(text).trim().split(/\r?\n/).at(-1) ?? '';

/** The step: detect, print the plan, and (unless a dry run) run it. Returns the config, with
 *  `lhmPort` when an LHM answers or was just set up. */
export async function hwSensorsStep(platform, config, { dryRun = false, uninstall = false } = {}) {
  const enabled = config.hwSensors !== false;
  const port = config.lhmPort ?? LHM.port;
  const lhmOs = platform === 'win32' || platform === 'wsl';
  const detection = lhmOs && (enabled || uninstall) ? await detectLhm(platform, port, { uninstall }) : null;
  const linux = platform === 'linux' && enabled && !uninstall ? linuxSensors() : null;
  const plan = hwSensorsPlan({ platform, enabled, uninstall, detection, linux, port, nvidiaSmi: config.nvidiaSmi === true });
  for (const line of plan.lines) console.log(line);
  const next = plan.lhmPort ? { ...config, lhmPort: plan.lhmPort } : config;
  if (!plan.script) return next;
  if (dryRun) {
    console.log(`DRY-RUN: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <UTF-16LE base64 of>\n${plan.script}`);
    if (plan.waitPort) console.log(`DRY-RUN: wait up to 60 s for http://127.0.0.1:${plan.waitPort}/data.json, then the daemon gets --lhm-port ${plan.waitPort}`);
    return plan.waitPort ? { ...next, lhmPort: plan.waitPort } : next;
  }
  const r = await runPowerShell(platform, plan.script);
  if (uninstall) {
    if (r.stdout.includes('PAWNIO-BY-CLD-GUI')) console.log('  PawnIO는 cld-gui가 설치했습니다. 지우려면 Windows 설정 → 앱 → PawnIO.');
    console.log(r.code === 0 ? '✔ 센서 도구 제거' : r.code === 1223 ? '! 관리자 확인을 거절해 센서 도구를 남겨 둡니다' : `! 센서 도구를 지우지 못했습니다(코드 ${r.code}): ${lastLine(r.stdout)}`);
    return config;
  }
  if (r.code === 1223) { console.log('! 관리자 확인을 거절해 센서 없이 계속합니다. 나중에: node cld/install/install.mjs --hw-sensors'); return config; }
  if (r.code !== 0) { console.log(`! 센서 도구를 설치하지 못했습니다(코드 ${r.code}): ${lastLine(r.stdout)}`); return config; }
  for (let i = 0; i < 30; i += 1) { if (await lhmAnswers(platform, plan.waitPort)) { console.log(`✔ 센서 도구: LibreHardwareMonitor :${plan.waitPort}`); return { ...next, lhmPort: plan.waitPort }; } await delay(2000); }
  console.log(`! LibreHardwareMonitor가 :${plan.waitPort}에서 아직 응답하지 않습니다(다음 로그인 때 켜집니다). 포트가 예약돼 막혔으면(netsh int ipv4 show excludedportrange protocol=tcp) --lhm-port <다른 포트>로 다시 실행하세요.`);
  return { ...next, lhmPort: plan.waitPort };
}
