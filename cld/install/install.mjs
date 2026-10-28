#!/usr/bin/env node
/** A dependency-free installer for cld-gui.  The exported helpers are pure. */
import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { createHash } from 'node:crypto';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import configPathModule from '../../core/src/cld/configPath.cjs';
import { addEntry, badLedgerPath, emptyLedger, EXPOSURE_FILE, parseLedger, unwantedEntries } from '../../core/src/exposureLedger.mjs';
import { gpuRule, gpuRuleLines, gpuStep, gpuTotalMib, nvidiaSmiOptIn } from './gpuPolicy.mjs';
import { hwSensorsStep } from './hwSensors.mjs';
import { CONNECTORS, defaultConnector, realDeps, remoteSetup, revertExposures, SETUP_CHOICES, setupLines } from './remote.mjs';

const { CLI_NAME, LEGACY_CLI_NAME } = createRequire(import.meta.url)('../bin/cld-brand.js');
export const { configDirectory, legacyConfigDirectory } = configPathModule;
const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../..');
export const defaults = Object.freeze({ port: 18240, readOnly: true, chat: false, allowTerminal: false, funnel: false, engine: 'auto', allowApprovalRequests: false, allowedHosts: [] });
// Smaller V8 young generation: idle daemon RSS 95 -> 84 MB at no measurable CPU cost (T-0013 measurement); RAM budget is below a VS Code SSH session.
export const NODE_FLAGS = Object.freeze(['--max-semi-space-size=1']);

export function detectPlatform(platform = process.platform, procVersion = '') {
  if (platform === 'linux' && /microsoft/i.test(procVersion)) return 'wsl';
  return ['linux', 'darwin', 'win32'].includes(platform) ? platform : platform;
}

export function mergeConfig(existing = {}, supplied = {}) {
  const config = { ...defaults, ...existing };
  if (!Array.isArray(config.allowedHosts)) config.allowedHosts = [];
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) config.port = defaults.port;
  delete config.office; // an older config.json may still carry it: dropped when the file is written
  delete config.tailscaleUsers;
  delete config.trustedTailscaleUsers;
  if (typeof config.readOnly !== 'boolean') config.readOnly = defaults.readOnly;
  if (typeof config.chat !== 'boolean') config.chat = defaults.chat;
  if (typeof config.allowTerminal !== 'boolean') config.allowTerminal = defaults.allowTerminal;
  if (!['auto', 'on', 'off'].includes(config.engine)) config.engine = defaults.engine;
  if (typeof config.allowApprovalRequests !== 'boolean') config.allowApprovalRequests = defaults.allowApprovalRequests;
  // T-0030: unset hwSensors = on; lhmPort only once an LHM answered or was set up; nvidiaSmi only when asked for.
  for (const key of ['hwSensors', 'nvidiaSmi']) if (config[key] !== undefined && typeof config[key] !== 'boolean') delete config[key];
  if (config.lhmPort !== undefined && !(Number.isInteger(config.lhmPort) && config.lhmPort >= 1 && config.lhmPort <= 65535)) delete config.lhmPort;
  // T-0024: the daemon reads `connector` (and directPort, lanIp) from this file itself, so the
  // app can switch it at runtime; unset = tailscale for a Tailscale set-up, local otherwise.
  if (!CONNECTORS.includes(config.connector)) config.connector = defaultConnector(existing);
  if (config.directPort !== undefined && !(Number.isInteger(config.directPort) && config.directPort >= 1 && config.directPort <= 65535)) delete config.directPort;
  return { ...config, ...Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== undefined)) };
}

export function daemonArgs(config) {
  const args = ['--port', String(config.port), '--no-terminal'];
  args.push(config.readOnly ? '--read-only' : '--allow-actions');
  if (config.chat) args.push('--allow-chat');
  if (config.allowTerminal) args.push('--allow-terminal');
  if (config.allowApprovalRequests) args.push('--allow-approval-requests');
  if (Number.isInteger(config.chatAttaches) && config.chatAttaches !== 1) args.push('--chat-attaches', String(config.chatAttaches));
  args.push('--engine', config.engine);
  if (Number.isInteger(config.lhmPort)) args.push('--lhm-port', String(config.lhmPort));
  if (config.nvidiaSmi === true) args.push('--nvidia-smi');
  for (const host of config.allowedHosts) args.push('--allowed-host', host);
  return args;
}

export function shellQuote(value) { return /^[A-Za-z0-9_./:=,@+-]+$/.test(value) ? value : `'${String(value).replaceAll("'", "'\\''")}'`; }
function xml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

/**
 * `pathNodeDir`: the Node folder (or folders, in order) put on the service PATH (claude/codex installed with that Node's npm -g
 * are found there). Default: the daemon's own Node, as before; the manager passes the user's Node folder
 * (or null) instead, so a private runtime never becomes the `node` of the user's agents (H §3.3).
 */
const servicePath = (home, nodeDir, extra = []) => [path.join(home, '.local/bin'), ...[nodeDir].flat(), ...extra, '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
export function renderSystemdUnit({ repo = repoRoot, node = process.execPath, home = os.homedir(), config, name = 'cld-gui', pathNodeDir = path.dirname(node) }) {
  const command = [node, ...NODE_FLAGS, path.join(repo, 'dist/cli.js'), ...daemonArgs(config)].map(shellQuote).join(' ');
  return `[Unit]\nDescription=${name} host service\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${repo}\nEnvironment=PATH=${servicePath(home, pathNodeDir)}\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\nNice=5\nKillMode=process\n\n[Install]\nWantedBy=default.target\n`;
}

export function renderLaunchAgent({ repo = repoRoot, node = process.execPath, home = os.homedir(), config, label = 'dev.cld-gui.daemon', pathNodeDir = path.dirname(node) }) {
  const args = [node, ...NODE_FLAGS, path.join(repo, 'dist/cli.js'), ...daemonArgs(config)].map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  const log = path.join(configDirectory(home), 'daemon.log');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(label)}</string>\n  <key>ProgramArguments</key><array>\n${args}\n  </array>\n  <key>WorkingDirectory</key><string>${xml(repo)}</string>\n  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(servicePath(home, pathNodeDir, ['/opt/homebrew/bin']))}</string><key>LANG</key><string>en_US.UTF-8</string></dict>\n  <key>StandardOutPath</key><string>${xml(log)}</string>\n  <key>StandardErrorPath</key><string>${xml(log)}</string>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict></plist>\n`;
}

export function renderSchtasksCommand({ repo = repoRoot, node = process.execPath, home = os.homedir(), config, name = 'cld-gui' }) {
  const daemon = [node, ...NODE_FLAGS, path.join(repo, 'dist/cli.js'), ...daemonArgs(config)].map((item) => `"${String(item).replaceAll('"', '\\"')}"`).join(' ');
  const log = path.join(configDirectory(home), 'daemon.log').replaceAll('"', '\\"');
  const command = `cmd.exe /d /s /c "${daemon} >> \"${log}\" 2>&1"`;
  return ['schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/TN', name, '/TR', command];
}

export function clientPlan({ platform, repo = repoRoot, target, sshPort = 2233 }) {
  if (platform === 'win32') return [{ kind: 'command', command: ['powershell', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'cld/scripts/connect.ps1'), '-Target', target, '-SshPort', String(sshPort), '-CreateShortcut'] }];
  return [{ kind: 'command', command: [path.join(repo, 'cld/scripts/connect.sh'), '-t', target, '-s', String(sshPort)] }];
}

export function installPlan({ platform, repo = repoRoot, home = os.homedir(), node = process.execPath, config, uninstall = false, purge = false, uid = typeof process.getuid === 'function' ? process.getuid() : 0 }) {
  // --purge: the config, and the direct connector's keys, certificate, secret path and DuckDNS token (T-0024).
  const forget = purge ? [{ kind: 'remove', file: configPath(home) }, { kind: 'remove', file: path.join(path.dirname(configPath(home)), 'tls'), recursive: true }] : [];
  const daemon = [node, ...NODE_FLAGS, path.join(repo, 'dist/cli.js'), ...daemonArgs(config)];
  if (platform === 'linux' || platform === 'wsl') {
    const unit = path.join(home, '.config/systemd/user/cld-gui.service');
    if (uninstall) return [{ kind: 'command', command: ['systemctl', '--user', 'disable', '--now', 'cld-gui'], optional: true }, { kind: 'remove', file: unit }, { kind: 'command', command: ['systemctl', '--user', 'daemon-reload'] }, ...forget];
    return [{ kind: 'file', file: unit, content: renderSystemdUnit({ repo, node, home, config }) }, { kind: 'command', command: ['systemctl', '--user', 'daemon-reload'] }, { kind: 'command', command: ['systemctl', '--user', 'enable', '--now', 'cld-gui'] }, { kind: 'fallback', command: ['nohup', ...daemon] }];
  }
  if (platform === 'darwin') {
    const plist = path.join(home, 'Library/LaunchAgents/dev.cld-gui.daemon.plist');
    if (uninstall) return [{ kind: 'command', command: ['launchctl', 'bootout', `gui/${uid}`, plist], optional: true }, { kind: 'remove', file: plist }, ...forget];
    return [{ kind: 'file', file: plist, content: renderLaunchAgent({ repo, node, home, config }) }, { kind: 'command', command: ['launchctl', 'bootout', `gui/${uid}`, plist], optional: true }, { kind: 'command', command: ['launchctl', 'bootstrap', `gui/${uid}`, plist] }];
  }
  const create = renderSchtasksCommand({ repo, node, home, config });
  if (uninstall) return [{ kind: 'command', command: ['schtasks', '/Delete', '/F', '/TN', 'cld-gui'], optional: true }, ...forget];
  return [{ kind: 'command', command: create }, { kind: 'command', command: ['schtasks', '/End', '/TN', 'cld-gui'], optional: true }, { kind: 'command', command: ['schtasks', '/Run', '/TN', 'cld-gui'] }];
}

export function configPath(home = os.homedir()) { return path.join(configDirectory(home), 'config.json'); }
export function exposurePath(home = os.homedir()) { return path.join(path.dirname(configPath(home)), EXPOSURE_FILE); }
/**
 * What remote.mjs is asked for (S6): --connector tailscale is Serve, funnel is Funnel; an install
 * that already has Funnel (config funnel: true) keeps it on update, so nobody's exposure changes silently.
 */
export function remoteRequest(connector, config) {
  if (connector === 'direct') return 'direct';
  if (connector === 'funnel' || (connector === 'tailscale' && config.funnel === true)) return 'funnel';
  return connector === 'tailscale' ? 'tailscale' : undefined;
}
const readLedgerText = (file) => fs.readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
/** What to check by hand when a ledger this version cannot read is found. */
const badLedgerAdvice = (file) => `  그 파일이 기록한 것(Tailscale Serve/Funnel: tailscale serve status, 임시 주소: cloudflared 프로세스, Windows 포트 전달: netsh interface portproxy show v4tov4)을 확인해 직접 되돌리세요: ${file}`;
/** One exposure-ledger entry (0600, temp file + rename), next to config.json. */
export async function recordExposure(home, entry, print = console.log) {
  const file = exposurePath(home);
  let current = parseLedger(await readLedgerText(file));
  if (!current) {
    // Broken, newer or unknown: it may record a live exposure, so it is moved aside, never overwritten.
    const aside = badLedgerPath(file);
    await fs.rename(file, aside);
    print(`! 노출 장부를 읽지 못해 옆으로 옮겼어요: ${aside}\n${badLedgerAdvice(aside)}`);
    current = emptyLedger();
  }
  const ledger = addEntry(current, entry);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}
/** --uninstall (S6, T10): undo what the exposure ledger recorded, then remove it. */
export async function revertLedger(home, { dryRun = false, deps }) {
  const file = exposurePath(home);
  if (!fssync.existsSync(file)) return { ok: true, file, entries: [] };
  const ledger = parseLedger(await readLedgerText(file));
  if (!ledger) {
    // Never deleted: it may be the only record of a live Serve/Funnel, tunnel or portproxy.
    (deps?.print ?? console.log)(`! 노출 장부를 이 버전이 읽지 못해 그대로 뒀어요 (지우지 않았어요): ${file}\n${badLedgerAdvice(file)}`);
    return { ok: false, unreadable: true, file, entries: [] };
  }
  const entries = unwantedEntries(ledger, null);
  if (dryRun) {
    (deps?.print ?? console.log)(`DRY-RUN: 노출 장부 되돌리기 (${entries.map((e) => e.kind).join(', ') || '비어 있음'}), ${file} 삭제`);
    return { ok: true, dryRun: true, file, entries };
  }
  await revertExposures(entries, deps);
  await fs.rm(file, { force: true });
  return { ok: true, file, entries };
}
export function findFreePort(start, isFree, end = 18299) { for (let port = start; port <= end; port += 1) if (isFree(port)) return port; return null; }

function usage() { return '사용법: node cld/install/install.mjs [--check|--uninstall [--purge]] [--dry-run] [--remote <local|lan|direct|ssh|duckdns|tailscale|tunnel>] [--client --target user@host] [--ssh-port 2233] [--port 18240] [--engine auto|on|off] [--allow-actions|--read-only] [--allow-chat|--no-chat] [--allow-terminal|--no-terminal] [--chat-attaches 1] [--allow-approval-requests|--no-approval-requests] [--hw-sensors|--no-hw-sensors] [--lhm-port 8085] [--nvidia-smi|--no-nvidia-smi] [--connector local|lan|tailscale|funnel|direct] [--manual-forward] [--ddns name.duckdns.org --ddns-token-file <파일>] [--add-path]'; }
export function parseArgs(argv) {
  const out = { dryRun: false, check: false, uninstall: false, purge: false, remote: false, remoteChoice: undefined, client: false, port: undefined, readOnly: undefined, engine: undefined, chat: undefined, allowTerminal: undefined, chatAttaches: undefined, funnel: undefined, allowApprovalRequests: undefined, hwSensors: undefined, lhmPort: undefined, nvidiaSmi: undefined, connector: undefined, manualForward: false, ddns: undefined, ddnsTokenFile: undefined, target: undefined, sshPort: 2233, legacyTailscaleTrust: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]; const take = () => { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`${flag} 값이 필요합니다`); return value; };
    if (flag === '--dry-run') out.dryRun = true; else if (flag === '--check') out.check = true; else if (flag === '--uninstall') out.uninstall = true; else if (flag === '--purge') out.purge = true; else if (flag === '--remote') { out.remote = true; if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.remoteChoice = argv[++i]; } else if (flag === '--client') out.client = true;
    else if (flag === '--target') out.target = take(); else if (flag === '--ssh-port') out.sshPort = Number(take()); else if (flag === '--port') out.port = Number(take()); else if (flag === '--engine') out.engine = take(); else if (flag === '--allow-actions') out.readOnly = false; else if (flag === '--read-only') out.readOnly = true; else if (flag === '--allow-chat') out.chat = true; else if (flag === '--no-chat') out.chat = false; else if (flag === '--allow-terminal') out.allowTerminal = true; else if (flag === '--no-terminal') out.allowTerminal = false; else if (flag === '--funnel') out.funnel = true; else if (flag === '--no-funnel') out.funnel = false; else if (flag === '--chat-attaches') out.chatAttaches = Number(take()); else if (flag === '--allow-approval-requests') out.allowApprovalRequests = true; else if (flag === '--no-approval-requests') out.allowApprovalRequests = false; else if (flag === '--hw-sensors') out.hwSensors = true; else if (flag === '--no-hw-sensors') out.hwSensors = false; else if (flag === '--lhm-port') out.lhmPort = Number(take()); else if (flag === '--nvidia-smi') out.nvidiaSmi = true; else if (flag === '--no-nvidia-smi') out.nvidiaSmi = false; else if (flag === '--trust-tailscale-user') { out.legacyTailscaleTrust = true; if (argv[i + 1] && !argv[i + 1].startsWith('--')) i += 1; } else if (flag === '--connector') out.connector = take(); else if (flag === '--manual-forward') out.manualForward = true; else if (flag === '--ddns') out.ddns = take(); else if (flag === '--ddns-token-file') out.ddnsTokenFile = take(); else if (flag === '--add-path') out.addPath = true; else if (flag === '--help' || flag === '-h') out.help = true; else throw new Error(`알 수 없는 옵션: ${flag}`);
  }
  if (out.client && !out.target) throw new Error('--client에는 --target user@host가 필요합니다');
  if (!Number.isInteger(out.sshPort) || out.sshPort < 1 || out.sshPort > 65535) throw new Error('올바른 SSH 포트가 아닙니다');
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) throw new Error('올바른 포트가 아닙니다');
  if (out.chatAttaches !== undefined && !(Number.isInteger(out.chatAttaches) && out.chatAttaches >= 1 && out.chatAttaches <= 10)) throw new Error('--chat-attaches는 1에서 10 사이의 정수입니다');
  if (out.engine !== undefined && !['auto', 'on', 'off'].includes(out.engine)) throw new Error('--engine은 auto, on, off 중 하나입니다');
  if (out.lhmPort !== undefined && !(Number.isInteger(out.lhmPort) && out.lhmPort >= 1 && out.lhmPort <= 65535)) throw new Error('올바른 --lhm-port가 아닙니다');
  if (out.connector !== undefined && !CONNECTORS.includes(out.connector) && out.connector !== 'funnel') throw new Error('--connector는 local, lan, tailscale, funnel, direct 중 하나입니다');
  if (out.remoteChoice !== undefined && !SETUP_CHOICES.includes(out.remoteChoice)) throw new Error(`--remote는 ${SETUP_CHOICES.join(', ')} 중 하나를 골라 주세요`);
  if (out.ddns !== undefined && (!/^[a-z0-9-]+\.duckdns\.org$/i.test(out.ddns) || !out.ddnsTokenFile)) throw new Error('--ddns는 <이름>.duckdns.org 와 --ddns-token-file 이 필요합니다');
  return out;
}

const npm = (...args) => (process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'npm', ...args] : ['npm', ...args]);
async function readJson(file, fallback = {}) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }
async function command(command, { dryRun = false, optional = false, env, timeout = 0 } = {}) {
  if (dryRun) { printPlan({ kind: 'command', command, optional }); return { stdout: '' }; }
  try { return await execFile(command[0], command.slice(1), { encoding: 'utf8', timeout, env: env ? { ...process.env, ...env } : process.env }); } catch (error) { if (optional) return { stdout: '', error }; throw error; }
}
function printPlan(action) {
  if (action.kind === 'file') console.log(`DRY-RUN file ${action.file}:\n${action.content}`);
  else if (action.kind === 'remove') console.log(`DRY-RUN remove ${action.file}`);
  else console.log(`DRY-RUN${action.optional ? ' (ignore errors)' : ''}: ${action.command.map(shellQuote).join(' ')}`);
}
async function applyPlan(actions, dryRun) {
  for (const action of actions) {
    if (dryRun) { if (action.kind !== 'fallback') printPlan(action); else console.log(`DRY-RUN fallback when systemctl user service is unavailable: ${action.command.map(shellQuote).join(' ')}`); continue; }
    if (action.kind === 'file') { await fs.mkdir(path.dirname(action.file), { recursive: true }); await fs.writeFile(action.file, action.content, 'utf8'); }
    else if (action.kind === 'remove') await fs.rm(action.file, { force: true, recursive: action.recursive === true });
    else if (action.kind === 'command') await command(action.command, action);
  }
}
async function pathHas(name) { try { await command(process.platform === 'win32' ? ['where', name] : ['which', name]); return true; } catch { return false; } }
async function tcpFree(port) { return new Promise((resolve) => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); }); }
async function fetchJson(url, options = {}) { const response = await fetch(url, options); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function hostToken(home = os.homedir()) {
  try {
    const server = JSON.parse(await fs.readFile(path.join(home, '.pixel-agents/server.json'), 'utf8'));
    if (typeof server.token === 'string' && server.token) return server.token;
  } catch {
    // An older daemon only has the persistent standalone token.
  }
  return (await fs.readFile(path.join(home, '.pixel-agents/standalone-token'), 'utf8')).trim();
}
async function ours(port) {
  let pid; try { pid = (await fetchJson(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${await hostToken()}` } })).pid; } catch { return false; }
  if (process.platform !== 'linux') return true; // ponytail: darwin/win32 trust any healthy responder; compare launchctl/schtasks PID if it bites
  const main = await command(['systemctl', '--user', 'show', '-p', 'MainPID', '--value', 'cld-gui'], { optional: true });
  return pid > 0 && (Number(main.stdout) === pid || await detachedPid(os.homedir()) === pid);
}
// Without systemctl --user (e.g. WSL without dbus-user-session) the daemon runs detached; daemon.pid lets a rerun replace it.
const pidFile = (home) => path.join(path.dirname(configPath(home)), 'daemon.pid');
async function detachedPid(home) {
  const pid = Number((await fs.readFile(pidFile(home), 'utf8').catch(() => '')).trim());
  const cmdline = pid > 0 ? await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '') : '';
  return cmdline.includes('dist/cli.js') ? pid : 0; // a reused PID is never ours
}
async function stopDetached(home) {
  const pid = await detachedPid(home);
  if (pid) { process.kill(pid); for (let i = 0; i < 20 && fssync.existsSync(`/proc/${pid}`); i += 1) await delay(500); }
  await fs.rm(pidFile(home), { force: true });
}
/** At each start a log over `max` bytes becomes `<log>.1`, replacing the older one. */
export function rotateLog(file, max = 5 * 1024 * 1024) { try { if (fssync.statSync(file).size > max) fssync.renameSync(file, `${file}.1`); } catch { /* no log yet */ } }
async function startDetached(config, home) {
  await stopDetached(home);
  const log = path.join(path.dirname(configPath(home)), 'daemon.log'); rotateLog(log); const out = fssync.openSync(log, 'a');
  const child = spawnChild('nohup', [process.execPath, ...NODE_FLAGS, path.join(repoRoot, 'dist/cli.js'), ...daemonArgs(config)], { cwd: repoRoot, detached: true, stdio: ['ignore', out, out] });
  child.unref(); fssync.closeSync(out); await fs.writeFile(pidFile(home), `${child.pid}\n`);
  console.log(`! systemctl --user를 사용할 수 없어 백그라운드로 시작했습니다(로그 ${log}). 재부팅 뒤에는 설치를 다시 실행하세요.`);
}
async function linkLogin(home, dryRun) {
  const link = path.join(home, '.local/bin/cld-gui-login'); const target = path.join(repoRoot, 'cld/bin/cld-gui-login');
  if (dryRun) { console.log(`DRY-RUN: ln -sf ${target} ${link}`); return; }
  const stat = await fs.lstat(link).catch(() => null);
  if (stat && !stat.isSymbolicLink()) { console.log(`! ${link} 파일이 이미 있어 그대로 둡니다`); return; }
  await fs.mkdir(path.dirname(link), { recursive: true }); await fs.rm(link, { force: true }); await fs.symlink(target, link);
}

// ── The agent CLI on PATH (T-0019, cld/docs/design/cld-cli.md §2): `agty` is the
// default and `cld-gui` the backward-compatible name; the short `cld` is added only
// when nothing else answers to that name. Never over a foreign file.
export const CLI_MARK = 'rem cld-gui: written by cld/install/install.mjs';
const RC_MARK = '# cld-gui';
/** The Windows launcher for the repo's script (ours: it carries CLI_MARK). */
export function winCliCmd(repo = repoRoot) { return `@echo off\r\n${CLI_MARK}\r\nnode "${path.win32.join(repo, 'cld', 'bin', 'cld-gui')}" %*\r\n`; }
const pathKey = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
/** `value` (a Windows Path) with `dir` at its end, once (case and a trailing \ do not count). */
export function pathWith(value, dir, sep = ';') { const parts = (value ?? '').split(sep).filter(Boolean); return parts.some((p) => pathKey(p) === pathKey(dir)) ? value : [...parts, dir].join(sep); }
export function pathWithout(value, dir, sep = ';') { return (value ?? '').split(sep).filter((p) => p && pathKey(p) !== pathKey(dir)).join(sep); }
/** `reg query HKCU\Environment /v Path` -> its type and value (none yet: an empty REG_EXPAND_SZ). */
export function parseRegPath(stdout) { const m = /^\s*Path\s+(REG_(?:EXPAND_)?SZ)\s+(.*?)\s*$/im.exec(stdout ?? ''); return m ? { type: m[1].toUpperCase(), value: m[2] } : { type: 'REG_EXPAND_SZ', value: '' }; }
/** The shell rc file and the line that puts ~/.local/bin on PATH (macOS). */
export function pathExport(shell = '', home = os.homedir()) { return { rc: path.join(home, /zsh$/.test(shell) ? '.zshrc' : '.bash_profile'), line: `export PATH="$HOME/.local/bin:$PATH" ${RC_MARK}` }; }
const onPath = (dir, envPath = '') => envPath.split(path.delimiter).some((p) => path.resolve(p || '.') === dir);
/** Something already answers to `name`: a command on PATH, or an alias or function of the user's interactive shell. */
export async function nameTaken(name, platform, shell = process.env.SHELL ?? '') {
  if (platform === 'win32') return !(await command(['where', name], { optional: true })).error;
  // A shell that fails or hangs cannot tell: then the name counts as taken (never shadow a user's cld).
  const ask = async (argv) => { const r = await command(argv, { optional: true, timeout: 5000 }); return r.error ? '?' : /<([^>]*)>\s*$/.exec(r.stdout ?? '')?.[1].trim() ?? '?'; };
  if (await ask(['sh', '-c', `printf '<%s>' "$(command -v ${name})"`])) return true;
  if (await ask(['bash', '-ic', `printf '<%s>' "$(type -t ${name})"`])) return true;
  if (/zsh$/.test(shell)) { const w = await ask(['zsh', '-ic', `printf '<%s>' "$(whence -w ${name})"`]); if (w && !/:\s*none$/.test(w)) return true; }
  return false;
}
export async function ourLink(link, target) { const to = await fs.readlink(link).catch(() => null); return to !== null && path.resolve(path.dirname(link), to) === target; }
/** A symlink at `link` (a symlink elsewhere is replaced only with `replace`); false when something else is there. */
async function linkInto(link, target, replace) {
  const stat = await fs.lstat(link).catch(() => null);
  if (stat && (!stat.isSymbolicLink() || (!replace && !(await ourLink(link, target))))) return false;
  await fs.mkdir(path.dirname(link), { recursive: true }); await fs.rm(link, { force: true }); await fs.symlink(target, link); return true;
}
const winBin = (home, env) => path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cld-gui', 'bin');
const BROADCAST = "Add-Type -Namespace CldGui -Name Env -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\", CharSet = System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint m, System.UIntPtr w, string l, uint f, uint t, out System.UIntPtr r);'; $r = [System.UIntPtr]::Zero; [void][CldGui.Env]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)";
export async function winPath(update, dryRun) {
  // The whole key, not /v Path: that fails both when Path is unset and when reg itself fails, and
  // reading a failure as "no Path" would write the user's Path back as our folder alone.
  // Returns 'written', 'same' (nothing to change) or 'skipped' (left alone: unreadable, or not plain ASCII).
  const q = await command(['reg', 'query', 'HKCU\\Environment'], { optional: true });
  if (q.error && !dryRun) { console.log('! 사용자 Path 를 읽지 못해 그대로 둡니다(cld-gui 폴더를 직접 넣어 주세요)'); return 'skipped'; }
  const now = parseRegPath(q.stdout);
  // reg.exe prints in the console code page, read here as UTF-8: a non-ASCII entry (a Korean folder) would be written back garbled.
  if (/[^\x20-\x7e]/.test(now.value)) { console.log('! 사용자 Path 에 ASCII 가 아닌 글자가 있어 그대로 둡니다(폴더를 직접 넣거나 빼 주세요)'); return 'skipped'; }
  const next = update(now.value); if (next === now.value) return 'same';
  await command(['reg', 'add', 'HKCU\\Environment', '/v', 'Path', '/t', now.type, '/d', next, '/f'], { dryRun });
  await command(['powershell', '-NoProfile', '-NonInteractive', '-Command', BROADCAST], { dryRun, optional: true, timeout: 10000 }); // WM_SETTINGCHANGE: new terminals see it
  return 'written';
}
const cliBusy = () => `${CLI_NAME} 이름은 이미 다른 프로그램이 쓰고 있어 만들지 않았습니다. ${LEGACY_CLI_NAME} 를 쓰세요`;
/** Install `agty` and `cld-gui` (and `cld` when free). `taken` is injectable for tests. */
export async function installCli({ platform, home = os.homedir(), dryRun = false, addPath = false, env = process.env, repo = repoRoot, taken = (name) => nameTaken(name, platform, env.SHELL) }) {
  const busy = 'cld 이름은 이미 쓰고 있어 cld-gui로만 설치했습니다';
  if (platform === 'win32') {
    const dir = winBin(home, env); const content = winCliCmd(repo);
    const write = async (name) => { const file = path.join(dir, name); const old = await fs.readFile(file, 'utf8').catch(() => null); if (old !== null && !old.includes(CLI_MARK)) return false; if (dryRun) console.log(`DRY-RUN file ${file}`); else { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(file, content); } return true; };
    if (!(await write('cld-gui.cmd'))) console.log(`! ${path.join(dir, 'cld-gui.cmd')} 파일이 이미 있어 그대로 둡니다`);
    {
      const file = path.join(dir, `${CLI_NAME}.cmd`);
      const ours = (await fs.readFile(file, 'utf8').catch(() => '')).includes(CLI_MARK);
      if (!ours) { if ((await fs.lstat(file).catch(() => null)) || (await taken(CLI_NAME))) console.log(cliBusy()); else await write(`${CLI_NAME}.cmd`); }
    }
    const shortOurs = (await fs.readFile(path.join(dir, 'cld.cmd'), 'utf8').catch(() => '')).includes(CLI_MARK);
    if (shortOurs || !(await taken('cld'))) await write('cld.cmd'); else console.log(busy);
    await winPath((value) => pathWith(value, dir), dryRun); console.log(`✔ ${CLI_NAME} (${dir}): 별칭 ${LEGACY_CLI_NAME} (cld는 비어 있을 때)`); return;
  }
  const bin = path.join(home, '.local', 'bin'); const target = path.join(repo, 'cld', 'bin', 'cld-gui');
  if (dryRun) { console.log(`DRY-RUN: ln -s ${target} ${path.join(bin, CLI_NAME)}; ln -s ${target} ${path.join(bin, 'cld-gui')}; ln -s ${target} ${path.join(bin, 'cld')} (그 이름이 비어 있을 때만)`); return; }
  if (!(await linkInto(path.join(bin, 'cld-gui'), target, true))) console.log(`! ${path.join(bin, 'cld-gui')} 파일이 이미 있어 그대로 둡니다`);
  {
    const link = path.join(bin, CLI_NAME);
    if (!(await ourLink(link, target))) {
      if ((await fs.lstat(link).catch(() => null)) || (await taken(CLI_NAME))) console.log(cliBusy());
      else await linkInto(link, target, false);
    }
  }
  const short = path.join(bin, 'cld');
  if (!(await ourLink(short, target))) { if ((await fs.lstat(short).catch(() => null)) || (await taken('cld'))) console.log(busy); else await linkInto(short, target, false); }
  if (platform === 'darwin' && !onPath(bin, env.PATH)) {
    const { rc, line } = pathExport(env.SHELL, home);
    if (!addPath) console.log(`! ~/.local/bin 이 PATH 에 없습니다. 이 한 줄을 셸 설정에 넣거나 설치에 --add-path 를 주세요:\n  echo '${line}' >> ${rc}`);
    else if (!(await fs.readFile(rc, 'utf8').catch(() => '')).split('\n').includes(line)) { await fs.appendFile(rc, `\n${line}\n`); console.log(`✔ ${rc} 에 PATH 줄을 넣었습니다(새 터미널부터)`); }
  }
}
/** --uninstall: only what installCli made (our links, our .cmd files, our Path entry and rc line). */
// `agent-tycoon` is no longer installed; a link of ours left by an earlier build is still removed.
export async function removeCli({ platform, home = os.homedir(), dryRun = false, env = process.env, repo = repoRoot }) {
  if (platform === 'win32') {
    const dir = winBin(home, env);
    for (const name of ['agty.cmd', 'agent-tycoon.cmd', 'cld-gui.cmd', 'cld.cmd']) { const file = path.join(dir, name); if ((await fs.readFile(file, 'utf8').catch(() => '')).includes(CLI_MARK)) { if (dryRun) console.log(`DRY-RUN remove ${file}`); else await fs.rm(file, { force: true }); } }
    await winPath((value) => pathWithout(value, dir), dryRun); return;
  }
  const target = path.join(repo, 'cld', 'bin', 'cld-gui');
  for (const name of ['agty', 'agent-tycoon', 'cld-gui', 'cld']) { const link = path.join(home, '.local', 'bin', name); if (await ourLink(link, target)) { if (dryRun) console.log(`DRY-RUN remove ${link}`); else await fs.rm(link, { force: true }); } }
  if (platform === 'darwin') { const { rc, line } = pathExport(env.SHELL, home); const text = await fs.readFile(rc, 'utf8').catch(() => null); if (text?.includes(line) && !dryRun) await fs.writeFile(rc, text.split('\n').filter((l) => l !== line).join('\n')); }
}

async function health(port) { try { await fetchJson(`http://127.0.0.1:${port}/api/health`); return true; } catch { return false; } }
async function fileHash(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }

async function prerequisites(platform, dryRun = false) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (dryRun) {
    console.log(`Node ${process.versions.node} ${nodeMajor >= 22 ? '✔' : '✖'}`);
    console.log(`DRY-RUN: command -v npm; command -v git; command -v claude (플랫폼 ${platform})`);
    if (nodeMajor < 22) throw new Error('Node 22 이상이 필요합니다');
    return;
  }
  const npm = await pathHas('npm'); const git = await pathHas('git'); const claude = await pathHas('claude');
  console.log(`Node ${process.versions.node} ${nodeMajor >= 22 ? '✔' : '✖'}`);
  console.log(`npm ${npm ? '✔' : '✖'}, git ${git ? '✔' : '✖'}, 플랫폼 ${platform}`);
  if (!claude) console.log('! claude CLI가 없습니다. 설치는 계속할 수 있습니다.');
  if (nodeMajor < 22 || !npm || !git) throw new Error('Node 22 이상, npm, git이 필요합니다');
}

async function installDependencies(dryRun) {
  const lock = path.join(repoRoot, 'package-lock.json'); const stateFile = path.join(repoRoot, '.cld-install-state.json');
  const lockHash = await fileHash(lock); const state = await readJson(stateFile); const modules = path.join(repoRoot, 'node_modules');
  if (state.lockHash === lockHash && fssync.existsSync(modules)) { console.log('✔ 의존성 설치 건너뜀'); return; }
  console.log('… 의존성 설치 중');
  if (dryRun) console.log('DRY-RUN: HUSKY=0 npm ci --no-audit --no-fund'); else { await command(npm('ci', '--no-audit', '--no-fund'), { env: { HUSKY: '0' } }); await fs.writeFile(stateFile, `${JSON.stringify({ lockHash }, null, 2)}\n`); }
  console.log('✔ 의존성 설치');
}
async function build(dryRun) {
  console.log('… 빌드 중');
  if (dryRun) { console.log('DRY-RUN: npm run asyncapi:generate'); console.log('DRY-RUN: node esbuild.js'); console.log('DRY-RUN: npm run build:webview'); }
  else { await command(npm('run', 'asyncapi:generate')); await command([process.execPath, 'esbuild.js']); await command(npm('run', 'build:webview')); }
  console.log('✔ 빌드');
}
async function loadConfig(home, supplied, create = true, dryRun = false) {
  const file = configPath(home); const existing = await readJson(file); const config = mergeConfig(existing, supplied);
  if (create) { if (dryRun) console.log(`DRY-RUN file ${file}:\n${JSON.stringify(config, null, 2)}`); else { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`); } }
  return config;
}
async function resolvePort(config, dryRun) {
  if (dryRun) return config;
  if (await tcpFree(config.port) || await ours(config.port)) return config;
  let found = null; for (let port = Math.max(18240, config.port + 1); port <= 18299; port += 1) if (await tcpFree(port)) { found = port; break; }
  if (!found) throw new Error('18240–18299에서 사용 가능한 포트를 찾지 못했습니다');
  console.log(`! 포트 ${config.port} 사용 중: ${found}(으)로 변경합니다`);
  return { ...config, port: found };
}
async function startService(platform, config, home, options) {
  const plan = installPlan({ platform, config, home });
  if ((platform === 'linux' || platform === 'wsl') && !options.dryRun) {
    const unit = plan[0]; await applyPlan([unit], false);
    try {
      await command(['systemctl', '--user', 'daemon-reload']);
      // A daemon started detached while systemd was down still holds the port; the service would fail to bind (10-22).
      await stopDetached(home);
      const enabled = await command(['systemctl', '--user', 'is-enabled', 'cld-gui'], { optional: true });
      if (enabled.stdout?.trim() === 'enabled') await command(['systemctl', '--user', 'restart', 'cld-gui']); else await command(['systemctl', '--user', 'enable', '--now', 'cld-gui']);
      console.log('✔ systemd 사용자 서비스'); return;
    } catch {
      await startDetached(config, home); return;
    }
  }
  await applyPlan(plan, options.dryRun);
}
async function waitHealthy(port, dryRun) { if (dryRun) { console.log(`DRY-RUN: 최대 30초 동안 http://127.0.0.1:${port}/api/health 대기`); return true; } for (let i = 0; i < 30; i += 1) { if (await health(port)) return true; await delay(1000); } throw new Error('30초 안에 서비스 상태 점검에 실패했습니다'); }
/** The first device's link (T-0022): a 10-minute QR code on the canonical address the daemon names (T-0024). */
export function loginBase(config) { return config.allowedHosts?.[0] ? `https://${config.allowedHosts[0]}` : `http://localhost:${config.port}`; }
async function loginUrl(config, dryRun) {
  if (dryRun) return `${loginBase(config)}/login?code=DRY_RUN_CODE`;
  const result = await fetchJson(`http://127.0.0.1:${config.port}/api/login-code`, { method: 'POST', headers: { Authorization: `Bearer ${await hostToken()}`, 'Content-Type': 'application/json' }, body: '{"qr":true}' });
  if (!result.code) throw new Error('로그인 코드를 받지 못했습니다'); return `${result.url ?? loginBase(config)}/login?code=${encodeURIComponent(result.code)}`;
}
/** Terminal QR (cld/bin/cld-gui-qr.mjs, uqr); nothing when it can't draw one. */
async function printQr(url, dryRun) { if (dryRun) return; try { console.log((await execFile(process.execPath, [path.join(repoRoot, 'cld/bin/cld-gui-qr.mjs'), url])).stdout); } catch { /* the link below still works */ } }
/**
 * --remote / --connector direct|tailscale (T-0024, cld/install/remote.mjs): the outside path in the
 * user's order. The daemon runs the direct steps itself and writes `connector`; a Tailscale path that
 * changed something needs the service to restart with the new --allowed-host flags.
 */
async function remoteStep(config, platform, home, options) {
  if (options.remoteChoice) {
    if (options.dryRun) { console.log(`DRY-RUN: POST /api/cld/connector/setup {"choice":"${options.remoteChoice}"}`); return config; }
    const deps = realDeps({ port: config.port, token: hostToken });
    const result = await deps.daemon('/api/cld/connector/setup', { choice: options.remoteChoice });
    for (const line of setupLines(result)) console.log(line);
    const updated = mergeConfig(await readJson(configPath(home)));
    if (result.connector === 'tailscale' && JSON.stringify(updated) !== JSON.stringify(config)) {
      await startService(platform, updated, home, options);
      await waitHealthy(updated.port, false);
    }
    return updated;
  }
  if (options.remote && !options.connector) {
    if (options.dryRun) { console.log('DRY-RUN: POST /api/cld/connector/setup {"choice":"permanent"} → 공유기·Tailscale 진단, 바깥 주소 자기 점검'); return config; }
    const deps = realDeps({ port: config.port, token: hostToken });
    const result = await deps.daemon('/api/cld/connector/setup', { choice: 'permanent' });
    for (const line of setupLines(result)) console.log(line);
    const updated = mergeConfig(await readJson(configPath(home)));
    if (result.connector === 'tailscale' && JSON.stringify(updated) !== JSON.stringify(config)) {
      await startService(platform, updated, home, options);
      await waitHealthy(updated.port, false);
    }
    return updated;
  }
  const requested = remoteRequest(options.connector, config);
  const deps = { ...realDeps({ port: config.port, token: hostToken, qr: (url) => printQr(url, false) }), record: (entry) => recordExposure(home, entry) };
  const result = await remoteSetup({ platform, port: config.port, requested, dryRun: options.dryRun, manualForward: options.manualForward, funnel: options.funnel, sshPorts: [...new Set([22, options.sshPort])], deps });
  if (result.connector === 'direct' && !options.dryRun) return mergeConfig(await readJson(configPath(home)));
  if (result.connector !== 'tailscale') return config;
  if (!options.dryRun) await recordExposure(home, { kind: 'tailscale', host: result.host, port: config.port, funnel: result.funnel === true, by: 'installer', at: Date.now() });
  const updated = { ...config, connector: 'tailscale', funnel: result.funnel === true, allowedHosts: [...new Set([...config.allowedHosts, result.host])] };
  if (JSON.stringify(updated) === JSON.stringify(config)) return config;
  await loadConfig(home, updated, true, options.dryRun);
  if (!options.dryRun) { await startService(platform, updated, home, options); await waitHealthy(updated.port, false); }
  return updated;
}
/** Uninstall, before the daemon stops: it closes the router's 443 (a permanent lease outlives it) and its HTTPS listener. */
async function closeDirect(config, dryRun) {
  if (config.connector !== 'direct') return;
  if (dryRun) { console.log('DRY-RUN: POST /api/cld/connector/enable {"connector":"local"} → 공유기의 외부 443 연결과 HTTPS 대기를 닫습니다'); return; }
  try {
    if (!(await ours(config.port))) throw new Error('데몬이 응답하지 않아요');
    const result = await fetchJson(`http://127.0.0.1:${config.port}/api/cld/connector/enable`, { method: 'POST', headers: { Authorization: `Bearer ${await hostToken()}`, 'Content-Type': 'application/json' }, body: '{"connector":"local"}', signal: AbortSignal.timeout(30_000) });
    if (result.ok) { console.log('✔ 바깥 직접 연결을 닫았어요 (공유기 443, HTTPS 대기)'); return; }
  } catch { /* below */ }
  console.log('! 공유기의 외부 443 연결을 닫지 못했어요: 공유기 관리 화면의 UPnP/포트포워드에서 "cld-gui" 항목을 지우세요');
}
/** WSL in NAT mode: the LAN (and the router) can't see the daemon until Windows does one admin step; the daemon words it. */
async function wslNote(config, dryRun) {
  if (dryRun) { console.log('DRY-RUN: WSL NAT 모드면 GET /api/cld/connector 의 Windows 쪽 단계(.wslconfig mirrored, 방화벽 규칙)를 보여 줍니다'); return; }
  try {
    const status = await fetchJson(`http://127.0.0.1:${config.port}/api/cld/connector`, { headers: { Authorization: `Bearer ${await hostToken()}` } });
    for (const line of status.wsl?.steps ?? []) console.log(`! ${line}`);
  } catch { /* an older daemon */ }
}
/** DuckDNS name + token for the direct connector (tls/ddns.json, 0600; the token never goes in config.json). */
async function writeDdns(home, options) {
  const file = path.join(path.dirname(configPath(home)), 'tls', 'ddns.json');
  if (options.dryRun) { console.log(`DRY-RUN file ${file} (0600): {"name":"${options.ddns}","token":"<${options.ddnsTokenFile}>"}`); return; }
  const token = (await fs.readFile(options.ddnsTokenFile, 'utf8')).trim();
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error('DuckDNS 토큰 형식이 아닙니다 (UUID)');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify({ name: options.ddns, token })}\n`, { mode: 0o600 });
  console.log(`✔ DuckDNS 이름 ${options.ddns} (토큰은 ${file})`);
}
async function status(platform, home, config) {
  console.log(`설치: ${fssync.existsSync(path.join(repoRoot, 'dist/cli.js')) ? '예' : '아니오'}`); if (platform === 'linux' || platform === 'wsl') { const result = await command(['systemctl', '--user', 'is-active', 'cld-gui'], { optional: true }); console.log(`서비스: ${result.stdout?.trim() || '없음'}`); }
  const mine = await ours(config.port); console.log(`상태 점검(포트 ${config.port}): ${mine ? '정상' : await health(config.port) ? '다른 프로그램이 사용 중' : '응답 없음'}`);
  if (!mine) return;
  try {
    const remote = await fetchJson(`http://127.0.0.1:${config.port}/api/cld/connector`, { headers: { Authorization: `Bearer ${await hostToken()}` } });
    console.log(`연결 방식: ${remote.connector} · 주소: ${remote.canonicalUrl}`);
    const cert = remote.direct?.certificate; if (remote.direct?.enabled && cert) console.log(`인증서: ${new Date(cert.notAfter).toLocaleString('ko-KR', { hour12: false })}까지, ${new Date(cert.renewAt).toLocaleString('ko-KR', { hour12: false })}에 자동 갱신`);
  } catch { /* an older daemon without the connector API */ }
}

async function main() {
  let options; try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`✖ 실패: ${error.message}\n${usage()}`); process.exitCode = 2; return; }
  if (options.legacyTailscaleTrust) console.warn('Tailscale 헤더 자동 로그인은 없앴어요 — 기기 키·패스키·초대 코드로 로그인하세요');
  if (options.help) { console.log(usage()); return; }
  if (options.remote && !options.remoteChoice && !options.connector) {
    console.log(`바깥 접속 방식: ${SETUP_CHOICES.join(', ')}\n예: node cld/install/install.mjs --remote tailscale`);
    return;
  }
  const platform = detectPlatform(process.platform, process.platform === 'linux' ? await fs.readFile('/proc/version', 'utf8').catch(() => '') : ''); const home = os.homedir();
  try {
    if (options.client) { await applyPlan(clientPlan({ platform, target: options.target, sshPort: options.sshPort }), options.dryRun); console.log('✔ 노트북 연결 설정 계획 완료'); return; }
    await prerequisites(platform, options.dryRun);
    let config = await loadConfig(home, { port: options.port, readOnly: options.readOnly, chat: options.chat, allowTerminal: options.allowTerminal, chatAttaches: options.chatAttaches, funnel: options.funnel, engine: options.engine, allowApprovalRequests: options.allowApprovalRequests, hwSensors: options.hwSensors, lhmPort: options.lhmPort, nvidiaSmi: options.nvidiaSmi, connector: options.connector === 'lan' || options.connector === 'local' ? options.connector : undefined }, !options.check && !options.uninstall, options.dryRun);
    if (options.check) { await status(platform, home, config); for (const line of gpuRuleLines(gpuRule(home, await gpuTotalMib(home, { nvidiaSmi: nvidiaSmiOptIn(home, config) })))) console.log(line); return; }
    if (options.uninstall) {
      await closeDirect(config, options.dryRun);
      await revertLedger(home, { dryRun: options.dryRun, deps: realDeps({ port: config.port, token: hostToken }) });
      if ((platform === 'linux' || platform === 'wsl') && !options.dryRun) { await stopDetached(home); await fs.rm(path.join(home, '.local/bin/cld-gui-login'), { force: true }); }
      await removeCli({ platform, home, dryRun: options.dryRun });
      await hwSensorsStep(platform, config, { dryRun: options.dryRun, uninstall: true });
      await applyPlan(installPlan({ platform, home, config, uninstall: true, purge: options.purge }), options.dryRun); console.log('✔ 제거 완료'); return;
    }
    await installDependencies(options.dryRun); await build(options.dryRun); config = await resolvePort(config, options.dryRun);
    config = await hwSensorsStep(platform, config, { dryRun: options.dryRun }); await loadConfig(home, config, true, options.dryRun);
    await gpuStep(home, { dryRun: options.dryRun, detect: () => gpuTotalMib(home, { nvidiaSmi: nvidiaSmiOptIn(home, config) }) });
    if (platform !== 'win32') await linkLogin(home, options.dryRun);
    if (options.ddns) await writeDdns(home, options);
    await installCli({ platform, home, dryRun: options.dryRun, addPath: options.addPath === true });
    await startService(platform, config, home, options); await waitHealthy(config.port, options.dryRun);
    if (options.remote || options.connector === 'direct' || options.connector === 'tailscale' || options.connector === 'funnel') { console.log('\n=== 밖에서도 접속하기 ==='); config = await remoteStep(config, platform, home, options); }
    if (platform === 'wsl' && (config.connector === 'lan' || config.connector === 'direct')) await wslNote(config, options.dryRun);
    const url = await loginUrl(config, options.dryRun); console.log('\n=== cld-gui 준비 완료 ==='); await printQr(url, options.dryRun);
    console.log(`첫 기기: 휴대폰 카메라로 QR을 찍거나 이 주소를 여세요 (10분 동안 한 번)\n${url}\n아이폰: 연 다음 공유 → "홈 화면에 추가", 그 앱 안에서 8자리 코드를 넣으세요. 한 번 붙은 기기는 다음부터 저절로 들어와요(기기 키).\n다른 기기: 로그인한 기기의 "기기 추가"(주소 + 8자리 코드 + QR, 어디서든), 또는 ${platform === 'win32' ? 'cld/bin/cld-gui-login' : '~/.local/bin/cld-gui-login'} 이 주는 코드\n`);
  } catch (error) { console.error(`✖ 실패: ${error.message}`); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
