#!/usr/bin/env node
/**
 * The Agent Tycoon manager (H §2, roadmap P2a): installs a verified daemon bundle into the
 * install root, keeps the install record, and is the one place install/update/open run from
 * (the GUI and the CLI are faces in front of it). The source installer (install.mjs) stays for
 * developers; its renderers and helpers are reused here.
 *
 *   <root>/versions/<version>/   unpacked bundle (private Node, dist/, cld/, manifest.json)
 *   <root>/current               -> versions/<version>  (Windows: current.txt holding the version)
 *   <root>/bin/agty              launcher running the private Node of `current` (+ cld-gui, the compatible name)
 *   <root>/install.json          the install record (0600): everything the manager made, with hashes
 *   <root>/manager.lock          one install/update at a time
 *
 * It never touches the user's Node/npm/nvm, PATH entries or shell rc files; the only PATH change
 * is appending our bin, with consent (--add-path).
 */
import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { extractBundle, sha256File, verifyBundle } from '../release/bundle/verify.mjs';
import { encodePowerShell } from './hwSensors.mjs';
import { configPath, daemonArgs, defaults, detectPlatform, exposurePath, hostToken, mergeConfig, NODE_FLAGS, pathWith, pathWithout, renderLaunchAgent, renderSystemdUnit, revertLedger, rotateLog, shellQuote, winPath } from './install.mjs';
import { realDeps as remoteDeps } from './remote.mjs';
import { rollback, update } from './update.mjs';

const require = createRequire(import.meta.url);
const maintenance = require('../bin/cld-gui-maintenance.js');
const { CLI_NAME, LEGACY_CLI_NAME } = require('../bin/cld-brand.js');
const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVICE = 'agent-tycoon';
export const OLD_SERVICE = 'cld-gui';
export const RECORD_SCHEMA = 1;
export const INSTALLED_BY = ['gui', 'cli', 'source'];
/** A first install (no config.json yet) is a person's own computer: the whole office, actions, the
 *  messenger and the terminal (owner's laptop 10-26: the read-only defaults hid both icons). The
 *  daemon listens on this computer only and every action needs its login. */
export const FIRST_INSTALL = Object.freeze({ readOnly: false, chat: true, allowTerminal: true });
export const { installRoot, serviceFile, launchLabel } = maintenance;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const posix = (platform) => platform !== 'win32';
export const rootPlatform = (platform) => (platform === 'wsl' ? 'linux' : platform);
const terminalChoice = (question, yes = 'y') => new Promise((resolve) => {
  if (!process.stdin.isTTY) { resolve(false); return; }
  process.stdout.write(`${question} `);
  process.stdin.resume();
  process.stdin.once('data', (data) => resolve(String(data).trim().toLowerCase() === yes));
});

// ── Install record ───────────────────────────────────────────────────────────

export function newRecord({ root, installedBy = 'cli', platform, env = process.env, now = Date.now }) {
  if (!INSTALLED_BY.includes(installedBy)) throw new Error(`--installed-by must be one of ${INSTALLED_BY.join(', ')}`);
  return {
    schema: RECORD_SCHEMA, id: randomUUID(), root, installedBy, createdAt: new Date(now()).toISOString(),
    current: null, previous: null, versions: {}, failedVersions: [],
    service: null, cli: { links: [], pathAdded: null }, wslDistro: platform === 'wsl' ? env.WSL_DISTRO_NAME ?? null : null,
    port: null, files: {}, adopted: null,
  };
}

/** null when there is none; throws on a record this version can't read (it is never overwritten). */
export async function readRecord(root) {
  let text;
  try { text = await fs.readFile(path.join(root, 'install.json'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let record;
  try { record = JSON.parse(text); } catch { throw new Error(`${path.join(root, 'install.json')} is not valid JSON; left as it is`); }
  if (record?.schema !== RECORD_SCHEMA) throw new Error(`${path.join(root, 'install.json')} has schema ${record?.schema}, this manager reads ${RECORD_SCHEMA}; left as it is`);
  return record;
}

/** Atomic (temp file + rename), 0600. */
export async function writeRecord(root, record) {
  const file = path.join(root, 'install.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

/** Writes `content` to `file` and lists it in the record with its hash (the uninstall ownership check). */
export async function writeOwned(record, file, content, mode = 0o644) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, { mode });
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, file);
  record.files[file] = sha256(content);
}

/** A symlink we made: listed as `symlink:<target>`. */
async function linkOwned(record, link, target) {
  await fs.mkdir(path.dirname(link), { recursive: true });
  const tmp = `${link}.${process.pid}.tmp`;
  await fs.rm(tmp, { force: true });
  await fs.symlink(target, tmp);
  await fs.rename(tmp, link);
  record.files[link] = `symlink:${target}`;
}

// ── Manager lock ─────────────────────────────────────────────────────────────

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * Takes <root>/manager.lock or waits up to `wait` ms; then throws (code LOCKED) naming the running
 * operation. A lock whose pid is gone, or an unreadable one older than a minute, is stale and taken over.
 * ponytail: a reused pid keeps a stale lock alive until that process exits; add a boot id if it bites.
 */
export async function acquireLock(root, op, { wait = 0, sleep = delay, alive = pidAlive, now = Date.now, pid = process.pid } = {}) {
  const file = path.join(root, 'manager.lock');
  await fs.mkdir(root, { recursive: true });
  const started = now();
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid, op, startedAt: new Date(now()).toISOString() }));
      await handle.close();
      return async () => {
        const holder = JSON.parse(await fs.readFile(file, 'utf8').catch(() => 'null'));
        if (holder?.pid === pid) await fs.rm(file, { force: true });
      };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let holder = null;
    try { holder = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* half-written or gone */ }
    const age = now() - ((await fs.stat(file).catch(() => null))?.mtimeMs ?? now());
    if ((holder && !alive(holder.pid)) || (!holder && age > 60_000)) { await fs.rm(file, { force: true }); continue; }
    if (now() - started >= wait) {
      const error = new Error(holder ? `another manager operation is running: ${holder.op} (pid ${holder.pid}, since ${holder.startedAt})` : 'another manager operation is starting');
      error.code = 'LOCKED'; error.holder = holder; throw error;
    }
    await sleep(500);
  }
}

// ── Version folders and the current pointer ──────────────────────────────────

export const versionDir = (root, version) => path.join(root, 'versions', version);

export async function readCurrent(root, platform) {
  if (posix(platform)) { const to = await fs.readlink(path.join(root, 'current')).catch(() => null); return to ? path.basename(to) : null; }
  return (await fs.readFile(path.join(root, 'current.txt'), 'utf8').catch(() => '')).trim() || null;
}

/** Atomic switch: a new symlink renamed over `current` (Windows: current.txt, temp + rename). */
export async function switchCurrent(root, version, platform, record) {
  if (!fssync.existsSync(versionDir(root, version))) throw new Error(`${versionDir(root, version)} is missing`);
  if (posix(platform)) await linkOwned(record, path.join(root, 'current'), path.join('versions', version));
  else await writeOwned(record, path.join(root, 'current.txt'), `${version}\r\n`);
}

/** The runtime the service runs: `current` itself on POSIX (an update needs no new unit); the version folder on Windows. */
export function runtime(root, version, platform, manifest) {
  const dir = posix(platform) ? path.join(root, 'current') : versionDir(root, version);
  return { dir, node: path.join(dir, manifest.node.path), entry: path.join(dir, manifest.entry ?? 'dist/cli.js') };
}

/** Verified bundle -> versions/<version> (via a temp folder; an existing one is reused only when its manifest is the bundle's). */
export async function unpack(root, bundle, verified, record) {
  const dest = versionDir(root, verified.version);
  if (fssync.existsSync(dest)) {
    const known = record.versions[verified.version];
    if (!known) throw new Error(`${dest} exists but is not in install.json; move it away first`);
    if (known.bundleSha256 === sha256File(bundle)) return JSON.parse(await fs.readFile(path.join(dest, 'manifest.json'), 'utf8'));
    await fs.rm(dest, { recursive: true, force: true }); // ours (listed), a different build of the same version
  }
  const tmp = `${dest}.tmp-${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  let manifest;
  try { manifest = extractBundle(bundle, tmp, verified); } catch (error) { await fs.rm(tmp, { recursive: true, force: true }); throw error; }
  await fs.rename(tmp, dest);
  record.versions[verified.version] = {
    dir: dest, bundle: path.basename(bundle), bundleSha256: sha256File(bundle),
    manifestSha256: sha256File(path.join(dest, 'manifest.json')), installedAt: new Date().toISOString(),
  };
  return manifest;
}

// ── Launchers (bin/agty, bin/cld-gui) ────────────────────────────────

export const LAUNCHER_MARK = 'Agent Tycoon launcher, written by the manager';
/** name -> content. They resolve `current` when run, so an update needs no rewrite. */
export function launchers(root, platform, manifest) {
  if (posix(platform)) {
    const body = `#!/bin/sh\n# ${LAUNCHER_MARK}: runs the private Node of the current version, never the user's.\nroot=${shellQuote(root)}\nexec "$root/current/${manifest.node.path}" "$root/current/cld/bin/cld-gui" "$@"\n`;
    return { [CLI_NAME]: body, [LEGACY_CLI_NAME]: body };
  }
  const node = manifest.node.path.replaceAll('/', '\\');
  const body = `@echo off\r\nrem ${LAUNCHER_MARK}\r\nsetlocal\r\nset /p AT_VERSION=<"%~dp0..\\current.txt"\r\n"%~dp0..\\versions\\%AT_VERSION%\\${node}" "%~dp0..\\versions\\%AT_VERSION%\\cld\\bin\\cld-gui" %*\r\n`;
  return { [`${CLI_NAME}.cmd`]: body, [`${LEGACY_CLI_NAME}.cmd`]: body };
}

// ── Services ─────────────────────────────────────────────────────────────────

export const defaultServiceKind = (platform) => (platform === 'darwin' ? 'launchd' : platform === 'win32' ? 'schtasks' : 'systemd');
export const SERVICE_KINDS = ['systemd', 'launchd', 'schtasks', 'detached', 'dry-run', 'none'];

/** The first `node` on PATH outside our install root: the user's, for the service PATH (or null). */
export function userNodeDir(envPath = '', root = '', platform = process.platform) {
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    if (root && path.resolve(dir).startsWith(path.resolve(root))) continue;
    try { fssync.accessSync(path.join(dir, exe), fssync.constants.X_OK); return dir; } catch { /* next */ }
  }
  return null;
}

const AGENT_CLIS = ['claude', 'codex', 'claude.cmd', 'codex.cmd'];
const FIXED_PATH = ['.local/bin', '/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin'];
/**
 * The user's Node folders for the service PATH: the ones the install record holds (record.service.pathNodeDirs; an
 * older record without it: the user folders in its service file's PATH), then the updater's own if it is new. Never
 * fewer: an update from a shell without the user's Node (ssh, cron, the Windows app's wsl.exe --exec) keeps them all.
 * A recorded folder with no claude/codex in it now stays too, and is named in the output.
 */
export function serviceNodeDirs(record, { env, home, platform, print }, root) {
  let recorded = record.service?.pathNodeDirs;
  if (!Array.isArray(recorded)) {
    const text = (record.service?.file && fssync.existsSync(record.service.file)) ? fssync.readFileSync(record.service.file, 'utf8') : '';
    const was = /^Environment=PATH=(.*)$/m.exec(text)?.[1] ?? /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(text)?.[1] ?? '';
    recorded = was.split(':').filter((d) => d && !FIXED_PATH.some((f) => d === f || d === path.join(home, f)));
  }
  const now = userNodeDir(env.PATH, root, platform);
  for (const dir of recorded) if (!AGENT_CLIS.some((n) => fssync.existsSync(path.join(dir, n)))) print(`! ${dir} (recorded at install) has no claude or codex now; kept on the service PATH`);
  return [...new Set([...recorded, ...(now ? [now] : [])])];
}

// ── Windows native service (R5): a per-user logon task running the daemon hidden ─────────────────
// No admin: Register-ScheduledTask for the signed-in user (schtasks.exe /SC ONLOGON wants admin and has no
// restart-on-failure). The task runs wscript.exe with our VBS, which runs `cmd /c node … >> daemon.log` in a
// hidden window and waits. Ending the task does not reliably end the daemon below it, so every stop also ends
// the daemon process itself (endWindowsDaemon), never its tree: agent sessions it started live on.

export const DAEMON_VBS = 'agent-tycoon-daemon.vbs';
const VBS_MARK = 'Agent Tycoon daemon runner, written by the manager';

/** The VBS the logon task runs, UTF-16LE with a BOM (Windows Script Host reads that; a Korean user folder survives). */
export function daemonVbs({ argv, cwd, log }) {
  for (const value of [...argv, cwd, log]) if (/["%\r\n]/.test(value)) throw new Error(`${value} cannot go in the Windows service (" or %)`); // cmd expands %VAR% even in quotes
  // cmd by absolute path (WshShell.Run expands %SystemRoot%), never looked up in the working folder.
  const line = `%SystemRoot%\\System32\\cmd.exe /d /v:off /s /c "${argv.map((a) => `"${a}"`).join(' ')} >> "${log}" 2>&1"`;
  const vb = (text) => `"${text.replaceAll('"', '""')}"`;
  const text = [`' ${VBS_MARK} (R5). The logon task runs it: the daemon hidden (0), waited for (True).`, 'Dim sh', 'Set sh = CreateObject("WScript.Shell")', `sh.CurrentDirectory = ${vb(cwd)}`, `WScript.Quit sh.Run(${vb(line)}, 0, True)`, ''].join('\r\n');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

/** What R1's WSL logon task and the native daemon's task share: this user at logon, restart on failure, no time limit, one instance. */
const TASK_TRIGGER = '$t = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"';
const TASK_SETTINGS = '$s = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable';

/** Registers (or replaces) the daemon's logon task for this user. */
export function daemonTaskCommand({ name, vbs }) {
  return powershell([
    `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psQuote(`//B //Nologo "${vbs}"`)}`,
    TASK_TRIGGER, TASK_SETTINGS,
    `Register-ScheduledTask -TaskName ${psQuote(name)} -Action $a -Trigger $t -Settings $s -Force | Out-Null`,
  ]);
}

/** Stops `pid` only when its command line runs from our versions folder (a reused pid, or another daemon, is left alone). */
export const endDaemonCommand = (pid, versionsDir) => powershell([
  `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'`,
  `if ($p -and $p.CommandLine -and $p.CommandLine.IndexOf(${psQuote(`${versionsDir}\\`)}, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Stop-Process -Id ${Number(pid)} -Force; 'stopped' } else { 'not ours' }`,
]);

/**
 * The daemon below the logon task, ended directly: its pid from /api/health with the host token (so it is this
 * home's daemon), checked to run from <root>\versions (endDaemonCommand), then waited for until health is quiet.
 * Nothing to do when no daemon of ours answers. `s.cwd` is the version folder (renderService).
 */
export async function endWindowsDaemon(s, deps) {
  if (!s?.cwd) return { ended: false };
  const port = mergeConfig(await readConfig(deps.home)).port;
  const pid = await deps.healthPid(port);
  if (!Number.isInteger(pid) || pid <= 0) return { ended: false };
  const r = await deps.run(endDaemonCommand(pid, path.win32.dirname(s.cwd)), { optional: true, timeout: 30_000 });
  if (!/stopped/.test(r?.stdout ?? '')) { deps.print(`! pid ${pid} on port ${port} is not this install's daemon; left running`); return { ended: false }; }
  for (let i = 0; i < 20 && (await deps.health(port)); i += 1) await deps.sleep(500);
  return { ended: true, pid };
}

/** What a service is: its file (none for a scheduled task), rendered content, and the daemon argv. */
export function renderService({ platform, home, root, version, manifest, config, name = SERVICE, pathNodeDir = null }) {
  const run = runtime(root, version, platform, manifest);
  const argv = [run.node, ...NODE_FLAGS, run.entry, ...daemonArgs(config)];
  const common = { repo: run.dir, node: run.node, home, config, pathNodeDir };
  if (platform === 'darwin') return { name, label: launchLabel(name), file: serviceFile('darwin', home, name), content: renderLaunchAgent({ ...common, label: launchLabel(name) }), argv, cwd: run.dir };
  if (platform === 'win32') {
    const file = path.join(root, 'bin', DAEMON_VBS);
    return { name, file, content: daemonVbs({ argv, cwd: run.dir, log: path.join(path.dirname(configPath(home)), 'daemon.log') }), create: daemonTaskCommand({ name, vbs: file }), argv, cwd: run.dir };
  }
  return { name, file: serviceFile('linux', home, name), content: renderSystemdUnit({ ...common, name }), argv, cwd: run.dir };
}

const opt = (cmd) => ({ cmd, optional: true });
const req = (cmd) => ({ cmd, optional: false });
/**
 * The service manager commands for one operation (activate | restart | deactivate | stop: the daemon only, the service stays registered
 * | start: only when it is not running). `s.autostart === false` (start policy manual) keeps activate from enabling the unit.
 */
export function servicePlan(kind, op, s, uid = 0) {
  if (kind === 'systemd') return {
    activate: [req(['systemctl', '--user', 'daemon-reload']), ...(s.autostart === false ? [] : [req(['systemctl', '--user', 'enable', s.name])]), req(['systemctl', '--user', 'restart', s.name])],
    start: [req(['systemctl', '--user', 'start', s.name])],
    restart: [req(['systemctl', '--user', 'restart', s.name])],
    deactivate: [opt(['systemctl', '--user', 'disable', '--now', s.name]), opt(['systemctl', '--user', 'daemon-reload'])],
    stop: [req(['systemctl', '--user', 'stop', s.name])],
  }[op];
  if (kind === 'launchd') return {
    activate: [opt(['launchctl', 'bootout', `gui/${uid}`, s.file]), req(['launchctl', 'bootstrap', `gui/${uid}`, s.file])],
    start: [req(['launchctl', 'kickstart', `gui/${uid}/${s.label ?? launchLabel(s.name)}`])],
    restart: [req(['launchctl', 'kickstart', '-k', `gui/${uid}/${s.label ?? launchLabel(s.name)}`])],
    deactivate: [opt(['launchctl', 'bootout', `gui/${uid}`, s.file])],
    stop: [req(['launchctl', 'bootout', `gui/${uid}`, s.file])],
  }[op];
  // endDaemon: endWindowsDaemon after /End (the task's end does not reliably reach the daemon under it).
  const end = (optional) => ({ cmd: ['Stop-Process', '-Force', '-Id', '<daemon pid from /api/health, if it runs from versions\\>'], optional, endDaemon: true });
  if (kind === 'schtasks') return {
    activate: [req(s.xml ? ['schtasks', '/Create', '/F', '/TN', s.name, '/XML', s.xml] : s.create), opt(['schtasks', '/End', '/TN', s.name]), end(true), req(['schtasks', '/Run', '/TN', s.name])],
    start: [req(['schtasks', '/Run', '/TN', s.name])],
    restart: [opt(['schtasks', '/End', '/TN', s.name]), end(true), req(['schtasks', '/Run', '/TN', s.name])],
    deactivate: [opt(['schtasks', '/End', '/TN', s.name]), end(true), opt(['schtasks', '/Delete', '/F', '/TN', s.name])],
    stop: [req(['schtasks', '/End', '/TN', s.name]), end(false)],
  }[op];
  throw new Error(`no service plan for ${kind}`);
}

// Without a service manager (WSL without systemd, or --service detached) the daemon runs detached
// with its pid in ~/.config/cld-gui/daemon.pid, the same file the source installer uses.
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
async function startDetached(s, home) {
  await stopDetached(home);
  const log = path.join(path.dirname(configPath(home)), 'daemon.log');
  await fs.mkdir(path.dirname(log), { recursive: true });
  rotateLog(log);
  const out = fssync.openSync(log, 'a');
  const child = spawnChild(s.argv[0], s.argv.slice(1), { cwd: s.cwd, detached: true, stdio: ['ignore', out, out] });
  child.unref(); fssync.closeSync(out);
  await fs.writeFile(pidFile(home), `${child.pid}\n`);
}

/** Runs one service operation with the recorded backend. `dry-run` prints what `real` would run. */
export async function serviceOp(kind, op, s, deps) {
  if (kind === 'none') return;
  if (kind === 'detached') { if (op === 'deactivate' || op === 'stop') await stopDetached(deps.home); else await startDetached(s, deps.home); return; }
  const real = kind === 'dry-run' ? defaultServiceKind(deps.platform === 'wsl' ? 'linux' : deps.platform) : kind;
  for (const step of servicePlan(real, op, s, deps.uid)) {
    if (kind === 'dry-run') deps.print(`DRY-RUN service${step.optional ? ' (errors ignored)' : ''}: ${step.cmd.join(' ')}`);
    else if (step.endDaemon) await (deps.endDaemon ?? endWindowsDaemon)(s, deps);
    else await deps.run(step.cmd, { optional: step.optional });
  }
}

// ── Adopting an older cld-gui install (H §2.3) ───────────────────────────────

/** The source installer's service, if there is one and it is the cld-gui daemon. */
export async function detectOld({ platform, home, run }) {
  if (platform === 'win32') {
    const q = await run(['schtasks', '/Query', '/TN', OLD_SERVICE, '/XML'], { optional: true });
    if (!q.ok || !q.stdout.includes('dist')) return null;
    const m = /([^"<>]+)[\\/]dist[\\/]cli\.js/.exec(q.stdout);
    return { name: OLD_SERVICE, file: null, content: q.stdout, sha256: sha256(q.stdout), repo: m ? m[1].trim() : null };
  }
  const file = serviceFile(rootPlatform(platform), home, OLD_SERVICE);
  const content = await fs.readFile(file, 'utf8').catch(() => null);
  if (content === null) return null;
  if (!content.includes('dist/cli.js')) return { foreign: true, file };
  const repo = /^WorkingDirectory=(.+)$/m.exec(content)?.[1] ?? /<key>WorkingDirectory<\/key><string>([^<]+)<\/string>/.exec(content)?.[1] ?? null;
  return { name: OLD_SERVICE, label: launchLabel(OLD_SERVICE), file, content, sha256: sha256(content), repo: repo?.trim() ?? null };
}

/**
 * Takes over the old service once: its file is kept in <root>/adopted/ (for revertAdoption), it is
 * stopped and disabled, its file removed (only if unchanged since read), and ~/.local/bin links that
 * pointed at the repo's cld-gui now point at our launcher. Data (~/.config/cld-gui etc.) is not touched.
 */
export async function adoptOld(old, { root, record, kind, deps }) {
  const backup = path.join(root, 'adopted', old.file ? path.basename(old.file) : `${OLD_SERVICE}.task.xml`);
  await fs.mkdir(path.dirname(backup), { recursive: true });
  await fs.writeFile(backup, old.content, { mode: 0o600 });
  await serviceOp(kind, 'deactivate', old, deps);
  if (old.file && kind !== 'dry-run') {
    const now = await fs.readFile(old.file, 'utf8').catch(() => null);
    if (now !== null && sha256(now) === old.sha256) await fs.rm(old.file);
  }
  const links = [];
  if (old.repo && posix(deps.platform)) {
    const repoCli = path.join(old.repo, 'cld', 'bin', 'cld-gui');
    for (const name of ['cld-gui', 'cld']) {
      const link = path.join(deps.home, '.local', 'bin', name);
      const to = await fs.readlink(link).catch(() => null);
      if (to === null || path.resolve(path.dirname(link), to) !== repoCli) continue;
      await linkOwned(record, link, path.join(root, 'bin', 'cld-gui'));
      links.push({ path: link, previous: to });
    }
  }
  record.adopted = { from: old.repo ? 'source' : 'service', at: new Date().toISOString(), repo: old.repo, service: { name: old.name, file: old.file, sha256: old.sha256, backup }, links };
}

/** Undoes adoptOld: our service off and (if unchanged) removed, the old service file and links back, old service on. */
export async function revertAdoption({ root, record, deps }) {
  const a = record.adopted;
  if (!a) throw new Error('nothing was adopted');
  const kind = record.service?.kind ?? defaultServiceKind(deps.platform);
  if (record.service) {
    await serviceOp(kind, 'deactivate', record.service, deps);
    const file = record.service.file;
    if (file && record.files[file] && sha256((await fs.readFile(file, 'utf8').catch(() => ''))) === record.files[file]) { await fs.rm(file); delete record.files[file]; }
  }
  const content = await fs.readFile(a.service.backup, 'utf8');
  if (a.service.file) {
    const there = await fs.readFile(a.service.file, 'utf8').catch(() => null);
    if (there !== null && there !== content) throw new Error(`${a.service.file} was changed since adoption; restore ${a.service.backup} by hand`);
    await fs.mkdir(path.dirname(a.service.file), { recursive: true });
    await fs.writeFile(a.service.file, content);
  }
  for (const link of a.links) {
    if (record.files[link.path] !== `symlink:${path.join(root, 'bin', 'cld-gui')}`) continue;
    await fs.rm(link.path, { force: true }); await fs.symlink(link.previous, link.path); delete record.files[link.path];
  }
  await serviceOp(kind, 'activate', { name: a.service.name, label: launchLabel(a.service.name), file: a.service.file, xml: a.service.file ? undefined : a.service.backup }, deps);
  record.adopted = null; record.service = null;
}

// ── Health ───────────────────────────────────────────────────────────────────

export async function health(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) }); return r.ok ? await r.json() : null; } catch { return null; }
}
/** Ours and the expected version (when given) answering on `port`. */
export async function waitHealthy(port, version, { check = health, sleep = delay, tries = 30 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const h = await check(port);
    if (h?.service === 'cld-gui' && (!version || h.version === version)) return h;
    await sleep(1000);
  }
  return null;
}
const tcpFree = (port) => new Promise((resolve) => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
async function runCommand(cmd, { optional = false, timeout = 60_000, env, cwd } = {}) {
  try { const r = await execFile(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout, env: env ?? process.env, cwd, maxBuffer: 16 << 20, windowsHide: true }); return { ok: true, stdout: r.stdout, stderr: r.stderr }; }
  catch (error) { if (optional) return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) }; throw new Error(`${cmd.join(' ')}: ${String(error.stderr || error.message).trim()}`); }
}
const controlSocket = (home) => process.platform === 'win32'
  ? `\\\\.\\pipe\\cld-gui-engine-${os.userInfo().username.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`
  : path.join(home, '.config', 'cld-gui', 'engine.sock');

// ── Real effects, injectable ─────────────────────────────────────────────────

/**
 * Is the service's daemon running now (not merely registered)? Task Scheduler keeps a task registered
 * after /End, and `schtasks /Query` prints a localized status, so its State comes from PowerShell's
 * ScheduledTask enum (Running | Ready | Disabled | Queued | Unknown: never translated).
 */
export async function serviceRunning(service, run, uid = 0) {
  if (!service || ['none', 'dry-run', 'detached'].includes(service.kind)) return false;
  if (service.kind === 'schtasks') {
    const r = await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `(Get-ScheduledTask -TaskName '${service.name.replaceAll("'", "''")}').State`], { optional: true, timeout: 10_000 });
    return r.ok && /^\s*(Running|Queued)\s*$/i.test(r.stdout);
  }
  const command = service.kind === 'systemd'
    ? ['systemctl', '--user', 'is-active', service.name]
    : ['launchctl', 'print', `gui/${uid}/${service.label ?? launchLabel(service.name)}`];
  return (await run(command, { optional: true, timeout: 3_000 })).ok;
}

export function realDeps(overrides = {}) {
  const home = overrides.home ?? os.homedir();
  const env = overrides.env ?? process.env;
  const control = async (cmd) => new Promise((resolve) => {
    const socket = controlSocket(home);
    const client = net.createConnection(socket);
    let text = '';
    client.setTimeout(3_000);
    client.setEncoding('utf8');
    client.on('connect', () => client.write(`${JSON.stringify({ v: 1, cmd, cwd: process.cwd(), source: 'manager', token: env.CLD_AGENT_TOKEN || undefined, args: {} })}\n`));
    client.on('data', (data) => {
      text += data;
      const nl = text.indexOf('\n');
      if (nl === -1) return;
      try { resolve(JSON.parse(text.slice(0, nl))); } catch { resolve(null); }
      client.destroy();
    });
    client.on('timeout', () => client.destroy());
    client.on('error', () => resolve(null));
    client.on('close', () => { try { resolve(JSON.parse(text)); } catch { resolve(null); } });
  });
  return {
    platform: detectPlatform(process.platform, process.platform === 'linux' ? fssync.readFileSync('/proc/version', 'utf8') : ''),
    home, env, uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    print: console.log,
    run: runCommand,
    health, tcpFree, sleep: delay, control,
    /** P7: the other side's install records (read only), through the injected run when there is one. */
    sideRecords: async () => (await sideRecordsFor(overrides.platform ?? detectPlatform(process.platform, process.platform === 'linux' ? fssync.readFileSync('/proc/version', 'utf8') : ''))?.(overrides.run ?? runCommand)) ?? [],
    /** The pid /api/health gives the host token of this home (null: none answers, or not ours). */
    healthPid: async (port) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${await hostToken(home)}` }, signal: AbortSignal.timeout(2_000) });
        return r.ok ? ((await r.json()).pid ?? null) : null;
      } catch { return null; }
    },
    socketExists: (socket) => fssync.existsSync(socket),
    serviceActive: (service) => serviceRunning(service, overrides.run ?? runCommand, typeof process.getuid === 'function' ? process.getuid() : 0),
    // A non-interactive manager never assumes consent. Tests may inject these
    // prompts; a terminal gets the explicit Korean choices from H §7.
    confirm: (question = '정말 제거할까요? (y/N)') => terminalChoice(question),
    chooseAgents: async () => (await terminalChoice('실행 중인 작업을 안전하게 끝내고 제거 / 제거 취소 (끝내고 제거하려면 y):')) ? 'stop' : 'cancel',
    confirmUnknownDaemon: () => terminalChoice('데몬이 응답하지 않습니다. 그래도 계속할까요? (y/N)'),
    // `quiet`: the plan asks the ledger what it holds; its own "DRY-RUN:" line belongs to --dry-run only.
    revertLedger: async (targetHome, { dryRun = false, quiet = false } = {}) => revertLedger(targetHome, { dryRun, deps: remoteDeps({ print: quiet ? () => {} : console.log }) }),
    ...overrides,
  };
}

/** `node dist/cli.js --self-test` with the version's own private Node. */
export async function selfTest(dir, manifest, deps) {
  const r = await deps.run([path.join(dir, manifest.node.path), path.join(dir, manifest.entry ?? 'dist/cli.js'), '--self-test'], { optional: true, timeout: 120_000 });
  return { ok: r.ok, output: `${r.stdout}${r.stderr}`.trim() };
}

export async function readConfig(home) { try { return JSON.parse(await fs.readFile(configPath(home), 'utf8')); } catch { return {}; } }
async function writeConfig(home, config) {
  await fs.mkdir(path.dirname(configPath(home)), { recursive: true });
  await fs.writeFile(configPath(home), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** The release key pinned by the first install (TOFU): updates are checked with it, never with a key fetched beside the bundle. */
export const pinnedKey = (root) => path.join(root, 'release.pub');
/** --pub, else the pinned key, else the key beside the bundle (integrity only, with a warning). */
export function releaseKey(o, root, dir) {
  if (o.pub) return { pubkey: path.resolve(o.pub), keyBeside: false };
  if (fssync.existsSync(pinnedKey(root))) return { pubkey: pinnedKey(root), keyBeside: false };
  return { pubkey: path.join(dir, 'agent-tycoon-release.pub'), keyBeside: true };
}
function bundleArgs(o, root) {
  if (!o.from) throw new Error('--from <bundle> is required');
  const dir = path.dirname(path.resolve(o.from));
  return { bundle: path.resolve(o.from), sums: path.resolve(o.sums ?? path.join(dir, 'SHA256SUMS')), sig: path.resolve(o.sig ?? path.join(dir, 'SHA256SUMS.sig')), ...releaseKey(o, root, dir) };
}

/** CLI links (consent: --add-path). ~/.local/bin only when it is already on PATH; Windows appends <root>\bin to the user Path. */
export async function ourLink(link, target) {
  const to = await fs.readlink(link).catch(() => null);
  return to !== null && path.resolve(path.dirname(link), to) === path.resolve(target);
}

async function linkCli(record, root, deps, consent) {
  const bin = path.join(root, 'bin');
  if (!consent) { deps.print(`  CLI: ${path.join(bin, posix(deps.platform) ? CLI_NAME : `${CLI_NAME}.cmd`)} (rerun with --add-path to put it on PATH)`); return; }
  if (!posix(deps.platform)) {
    // Recorded only when we appended it: an entry that was already there, or a Path left alone, is not ours to take out.
    const done = await (deps.winPath ?? winPath)((value) => pathWith(value, bin), false);
    if (done === 'written') { record.cli.pathAdded = { kind: 'windows-user-path', dir: bin }; deps.print(`✔ ${bin} appended to your user Path (new terminals)`); }
    else if (done === 'same') deps.print(`  CLI: ${bin} is already on your user Path`);
    else deps.print(`  CLI: ${path.join(bin, `${CLI_NAME}.cmd`)} (your user Path was left as it is)`);
    return;
  }
  const local = path.join(deps.home, '.local', 'bin');
  if (!(deps.env.PATH ?? '').split(path.delimiter).some((p) => path.resolve(p || '.') === local)) {
    deps.print(`! ${local} is not on PATH; nothing linked. Run it as ${path.join(bin, CLI_NAME)}, or add ${bin} to PATH yourself.`); return;
  }
  for (const name of [CLI_NAME, LEGACY_CLI_NAME]) {
    const link = path.join(local, name); const target = path.join(bin, name);
    const stat = await fs.lstat(link).catch(() => null);
    const mine = record.files[link] === `symlink:${target}`;
    if (stat && !mine) { deps.print(`! ${link} already exists; left as it is`); continue; }
    await linkOwned(record, link, target);
    if (!record.cli.links.includes(link)) record.cli.links.push(link);
  }
  deps.print(`✔ ${CLI_NAME}, ${LEGACY_CLI_NAME} linked in ${local}`);
}

/** `doctor --fix`: restore only links explicitly recorded as ours. */
export async function repairCliLinks(record, root, deps) {
  const repaired = [];
  const kept = [];
  let release;
  try { release = await acquireLock(root, 'doctor --fix', { wait: deps.lockWait ?? 5_000, sleep: deps.sleep }); }
  catch (error) { if (error.code === 'LOCKED') return { repaired, kept, busy: error.message }; throw error; }
  try {
    // Always repair the record protected by this lock, rather than a stale
    // copy read before doctor started.
    const current = await readRecord(root);
    if (!current) return { repaired, kept };
    for (const link of current.cli?.links ?? []) {
      const expected = current.files?.[link];
      if (typeof expected !== 'string' || !expected.startsWith('symlink:')) continue;
      const target = expected.slice('symlink:'.length);
      if (await ourLink(link, target)) continue;
      const stat = await fs.lstat(link).catch(() => null);
      if (stat && !stat.isSymbolicLink()) {
        kept.push(link);
        deps.print?.(`! ${link} is now ${stat.isDirectory() ? 'a folder' : 'a regular file'}; left as it is`);
        continue;
      }
      await linkOwned(current, link, target);
      repaired.push(link);
    }
    if (repaired.length) await writeRecord(root, current);
  } finally {
    await release();
  }
  return { repaired, kept };
}

// ── Start policy (R1 + P6, H §4.3, F-24) ─────────────────────────────────────
// on-demand (default): nothing at logon; `agty open` starts the daemon. always: at Windows logon a per-user
// task holds `agty start --hold` in the distro (WSL), linger with consent (systemd). manual: no auto start.
// Nothing here stops, restarts or `--now`s anything, and `wsl --shutdown` is never run (startPolicy.test.mjs).

export const START_POLICIES = ['on-demand', 'always', 'manual'];
export const startPolicyOf = (record) => (START_POLICIES.includes(record?.startPolicy) ? record.startPolicy : 'on-demand');
export const logonTaskName = (distro) => `${SERVICE}-wsl-${distro}`;
// PowerShell ends a single-quoted string at ' and at the curly quotes U+2018-U+201B too; doubling any of them keeps it open.
const psQuote = (value) => `'${String(value).replace(/['\u2018-\u201B]/g, '$&$&')}'`;

/** The holder script (cld/bin/agent-tycoon-hold.vbs), per distro under %LOCALAPPDATA%\agent-tycoon (a plain Windows path: \\wsl$ is not there before the distro runs). */
export const holderName = (distro) => `hold-${distro}.vbs`;
export const HOLDER_DIR = "(Join-Path $env:LOCALAPPDATA 'agent-tycoon')";
const holderSource = () => fssync.readFileSync(path.join(here, '..', 'bin', 'agent-tycoon-hold.vbs'), 'utf8').replaceAll('\r', '');
/** powershell.exe with the script as -EncodedCommand (UTF-16LE base64): WSL interop and the Windows command line cannot re-quote it. */
const powershell = (lines) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(lines.join('\n'))];

/**
 * The Windows logon task, registered from inside WSL through interop (Register-ScheduledTask: schtasks.exe has no
 * restart-on-failure settings). It runs the hidden holder (wscript.exe + our VBS, no console window), which keeps
 * `wsl.exe -d <distro> --exec agty start --hold` attached: that starts the daemon only if it does not answer, then
 * holds the distro up while it answers. No time limit (the 72 h default would end the holder), never a second instance.
 */
export function logonTaskCommand({ distro, root }) {
  const agty = path.posix.join(root, 'bin', CLI_NAME);
  if (!/^[A-Za-z0-9._-]+$/.test(distro ?? '')) throw new Error(`WSL distro name ${JSON.stringify(distro)} cannot go in a logon task`);
  if (/["\r\n%]/.test(agty)) throw new Error(`${agty} cannot go in a logon task`); // %: Task Scheduler expands %VAR% in arguments
  return powershell([
    `$d = ${HOLDER_DIR}`,
    'New-Item -ItemType Directory -Force -Path $d | Out-Null',
    `$f = Join-Path $d ${psQuote(holderName(distro))}`,
    `Set-Content -LiteralPath $f -Encoding ASCII -NoNewline -Value (${psQuote(holderSource())}).Replace("\`n", "\`r\`n")`,
    `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo "' + $f + '" ' + ${psQuote(`-d ${distro} --exec "${agty}" start --hold`)})`,
    TASK_TRIGGER, TASK_SETTINGS,
    `Register-ScheduledTask -TaskName ${psQuote(logonTaskName(distro))} -Action $a -Trigger $t -Settings $s -Force | Out-Null`,
  ]);
}

/** Removes the logon task and its holder script (the folder too, once empty). */
export const logonTaskRemoveCommand = ({ name, distro }) => powershell([
  `Unregister-ScheduledTask -TaskName ${psQuote(name)} -Confirm:$false -ErrorAction SilentlyContinue`,
  `$d = ${HOLDER_DIR}`,
  `Remove-Item -LiteralPath (Join-Path $d ${psQuote(holderName(distro))}) -Force -ErrorAction SilentlyContinue`,
  'if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force }',
]);

/** loginctl linger for `user`; inside WSL as root through interop (no sudo prompt), H §4.3. */
export const lingerCommand = (platform, distro, user, on) => (platform === 'wsl'
  ? ['wsl.exe', '-d', distro, '-u', 'root', '--exec', 'loginctl', on ? 'enable-linger' : 'disable-linger', user]
  : ['loginctl', on ? 'enable-linger' : 'disable-linger', user]);

/**
 * The steps that put `policy` in place (null: only undo what we made, for uninstall). Pure. A step's `set`
 * is what the record says once it succeeded. `linger`: the user agreed; `lingered`: linger is already on (not ours to undo).
 */
export function startPolicyPlan({ platform, policy, record, kind = record.service?.kind, user, linger = false, lingered = false }) {
  const steps = [];
  if (policy && kind === 'systemd') steps.push(req(['systemctl', '--user', policy === 'manual' ? 'disable' : 'enable', record.service.name]));
  if (policy === 'always' && platform === 'wsl' && kind !== 'none') steps.push({ ...req(logonTaskCommand({ distro: record.wslDistro, root: record.root })), set: { logonTask: { name: logonTaskName(record.wslDistro), distro: record.wslDistro } } });
  else if (record.logonTask) steps.push({ ...opt(logonTaskRemoveCommand(record.logonTask)), set: { logonTask: null } });
  const wantLinger = policy === 'always' && kind === 'systemd';
  if (wantLinger && linger && !record.linger && !lingered) steps.push({ ...opt(lingerCommand(platform, record.wslDistro, user, true)), set: { linger: { user, distro: record.wslDistro } } });
  else if (!wantLinger && record.linger) steps.push({ ...opt(lingerCommand(platform, record.linger.distro, record.linger.user, false)), set: { linger: null } });
  return steps;
}

/** Runs the steps (dry-run prints them), writing the record after each one that succeeded. */
async function runPolicySteps(steps, { root, record, dry, deps }) {
  for (const step of steps) {
    if (dry) { deps.print(`DRY-RUN start policy: ${step.cmd.join(' ')}`); continue; }
    const r = await deps.run(step.cmd, { optional: step.optional });
    if (r?.ok === false) {
      if (!step.optional) throw new Error(`${step.cmd.join(' ')}: ${String(r.stderr).trim()}`);
      deps.print(`! ${step.cmd.slice(0, 2).join(' ')} … 실패: ${String(r.stderr).trim().split('\n')[0]}${step.cmd.includes('enable-linger') ? ` (직접: sudo loginctl enable-linger ${step.set.linger.user})` : ''}`);
      continue;
    }
    if (step.set) { Object.assign(record, step.set); await writeRecord(root, record); }
  }
}

const policyLabel = { 'on-demand': '필요할 때만', always: '항상 실행', manual: '수동' };
/** Applies `policy` to the record under an already held lock. Asks for linger consent only when it is needed and not given. */
async function applyStartPolicy(policy, { root, record, linger, deps }) {
  if (!START_POLICIES.includes(policy)) throw new Error(`start policy must be one of ${START_POLICIES.join(', ')}`);
  if (!['linux', 'wsl'].includes(deps.platform)) throw new Error('start policy: Linux and WSL only (Windows native: the logon task starts the daemon at every sign-in)');
  const dry = record.service?.kind === 'dry-run';
  const kind = dry ? 'systemd' : record.service?.kind;
  const user = deps.env.USER || os.userInfo().username;
  const lingered = (deps.lingered ?? ((u) => fssync.existsSync(path.join('/var/lib/systemd/linger', u))))(user);
  if (policy === 'always' && kind === 'systemd' && !record.linger && !lingered && linger === undefined) {
    deps.print(`'항상 실행'은 로그인하지 않아도 데몬이 돌도록 linger 가 필요해요: ${lingerCommand(deps.platform, record.wslDistro, user, true).join(' ')}`);
    linger = await deps.confirm('linger 를 켤까요? 제거하면 우리가 켠 linger 도 끕니다 (y/N)');
  }
  if (policy === 'always' && kind === 'systemd' && !linger && !record.linger && !lingered) deps.print('! linger 없이: 로그아웃하거나 WSL 세션이 모두 끝나면 데몬도 멈춰요 (나중에: agty start-policy always --linger)');
  await runPolicySteps(startPolicyPlan({ platform: deps.platform, policy, record, kind, user, linger, lingered }), { root, record, dry, deps });
  record.startPolicy = policy;
  if (!dry) await writeRecord(root, record);
  deps.print(`✔ 시작 정책: ${policyLabel[policy]} (${policy})${record.logonTask ? ` · Windows 로그온 작업 ${record.logonTask.name}` : ''}${record.linger ? ` · linger(${record.linger.user})` : ''} · 실행 중인 데몬과 에이전트는 그대로예요`);
}

/** `agty start-policy [on-demand|always|manual] [--linger|--no-linger]`: shows, or changes without stopping anything (INSTALL-16). */
export async function startPolicy(o, deps = realDeps()) {
  const root = o.root ?? installRoot(rootPlatform(deps.platform), deps.home, deps.env);
  if (!o.policy) {
    const record = await readRecord(root);
    if (!record) throw new Error(`no install record in ${root}`);
    deps.print(`시작 정책: ${policyLabel[startPolicyOf(record)]} (${startPolicyOf(record)})${record.logonTask ? ` · Windows 로그온 작업 ${record.logonTask.name}` : ''}${record.linger ? ` · linger(${record.linger.user}, 우리가 켬)` : ''}`);
    return { policy: startPolicyOf(record) };
  }
  if (deps.env.CLD_AGENT_TOKEN) throw new Error('에이전트 세션 안에서는 시작 정책을 바꿀 수 없어요');
  const release = await acquireLock(root, 'start-policy', { wait: o.wait ?? 0 });
  try {
    const record = await readRecord(root);
    if (!record) throw new Error(`no install record in ${root}`);
    await applyStartPolicy(o.policy, { root, record, linger: o.linger, deps });
    return { policy: o.policy };
  } finally { await release(); }
}

/** `agty start`: the logon task's and `open`'s start request. Does nothing when the daemon answers (never a second daemon). */
export async function start(o, deps = realDeps()) {
  const port = o.port ?? mergeConfig(await readConfig(deps.home)).port;
  const root = o.root ?? installRoot(rootPlatform(deps.platform), deps.home, deps.env);
  await assertOneHost({ platform: deps.platform, port, portGiven: false, record: await readRecord(root).catch(() => null), deps });
  if ((await deps.health(port))?.service) { deps.print(`✔ 데몬이 이미 ${port} 에서 응답해요`); return o.hold ? hold(port, deps) : { ok: true, already: true }; }
  const record = await readRecord(root);
  if (!record?.service || ['none', 'dry-run'].includes(record.service.kind)) throw new Error(`no service to start (${root}); agty install first`);
  // From a Windows logon task (`wsl.exe --exec`) there is no login shell: systemctl --user finds the user bus here.
  if (record.service.kind === 'systemd' && !deps.env.XDG_RUNTIME_DIR) deps.env.XDG_RUNTIME_DIR = `/run/user/${deps.uid}`;
  // A detached start replaces the recorded process: one that is alive but not answering yet (booting, busy) is waited for instead.
  if (record.service.kind !== 'detached' || !(await detachedPid(deps.home))) await serviceOp(record.service.kind, 'start', record.service, deps);
  if (!(await waitHealthy(port, null, { check: deps.health, sleep: deps.sleep }))) throw new Error(`started, but /api/health on ${port} did not answer in 30 s (agty logs)`);
  deps.print(`✔ 데몬을 시작했어요 (포트 ${port})`);
  return o.hold ? hold(port, deps) : { ok: true, already: false };
}

export const HOLD_CHECK_MS = 60_000;
export const HOLD_MISSES = 3;
/**
 * `start --hold` (the logon task's holder): stays attached while the daemon answers, so WSL keeps the distro up.
 * Exits 0 once it has not answered for HOLD_MISSES checks in a row (stopped for good: a crash restart or an update
 * comes back well within that), so a user's stop lets WSL idle and the task's restart-on-failure leaves it alone.
 */
async function hold(port, deps) {
  for (let misses = 0; misses < HOLD_MISSES;) {
    await deps.sleep(HOLD_CHECK_MS);
    misses = (await deps.health(port))?.service ? 0 : misses + 1;
  }
  deps.print(`데몬이 ${port} 에서 응답하지 않아 붙잡기를 끝내요 (WSL 은 쉬어도 돼요)`);
  return { ok: true, held: true };
}

/** `agty stop --daemon`: stops the daemon only (agent sessions are their own processes); asks first while agents run. */
export async function stopDaemon(o, deps = realDeps()) {
  if (deps.env.CLD_AGENT_TOKEN) { deps.print('에이전트 세션 안에서는 데몬을 멈출 수 없어요'); return { code: 2 }; }
  const root = o.root ?? installRoot(rootPlatform(deps.platform), deps.home, deps.env);
  const record = await readRecord(root);
  if (!record?.service) throw new Error(`no installed service (${root})`);
  const status = await deps.control('status').catch(() => null);
  const agents = (await daemonIdentity(record, root, status)).matches ? activeAgents(status) : [];
  if (agents.length) {
    deps.print(`⚠ 실행 중 에이전트: ${agents.map((a) => `${a.kind}:${a.name}`).join(', ')}\n  에이전트는 계속 돌지만, 데몬이 꺼진 동안 사무실·휴대폰·메시지 전달이 멈춰요.`);
    if (o.yes !== true && !(await deps.confirm('그래도 데몬을 멈출까요? (y/N)'))) { deps.print('멈추지 않았어요'); return { code: 3 }; }
  }
  await serviceOp(record.service.kind, 'stop', record.service, deps);
  deps.print(`✔ 데몬을 멈췄어요${startPolicyOf(record) === 'manual' ? ' (수동: agty start 로 다시 켜요)' : ''}`);
  return { code: 0 };
}

// ── One local host per Windows user (P7, F-27, H §4.5, INSTALL-11) ───────────
// A Windows user has one active local host: the Windows native daemon or one WSL distro's, never both on the same
// port or the same projects. Installing or starting one side while the other is installed (its install record) or
// answers on the port (/api/health `os`) stops with a message that offers moving instead. For testing side by side,
// --allow-second-host (install.ps1 passes it as AGENT_TYCOON_SECOND_HOST=1) with --port <another port> installs anyway
// without looking at the other side (secondHost) and says so in the record (`besides`).

export const SECOND_HOST_ENV = 'AGENT_TYCOON_SECOND_HOST';
const sideName = (side) => (side.os === 'win32' ? 'Windows' : `WSL${side.distro ? `(${side.distro})` : ''}`);

/** The other side's install record as found: { os, distro?, port, besides } or null. Pure on the parsed record. */
export function sideOf(record, os, distro = null) {
  if (!record || typeof record !== 'object' || !record.current) return null; // no version installed: nothing runs there
  return { os, distro: distro ?? record.wslDistro ?? null, port: Number.isInteger(record.port) ? record.port : null, besides: record.besides ?? null };
}

/** Real lookups of the other side's record (read only). Windows: each WSL distro's through wsl.exe; WSL: the Windows one under /mnt/c. */
export const sideRecords = {
  async win32(run) {
    const { parseWslList } = await import('./wizard.mjs');
    const list = await run(['wsl.exe', '-l', '-q'], { optional: true, timeout: 15_000, env: { ...process.env, WSL_UTF8: '1' } });
    if (!list.ok) return [];
    const out = [];
    for (const distro of parseWslList(list.stdout)) {
      // --exec: no shell re-parses the line; sh inside the distro finds its own install root.
      const r = await run(['wsl.exe', '-d', distro, '--exec', 'sh', '-c', 'cat "${AGENT_TYCOON_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-tycoon}/install.json" 2>/dev/null'], { optional: true, timeout: 30_000 });
      try { const side = sideOf(JSON.parse(r.stdout), 'wsl', distro); if (side) out.push(side); } catch { /* none there */ }
    }
    return out;
  },
  async wsl(run) {
    const local = await run(['cmd.exe', '/d', '/c', 'echo %LOCALAPPDATA%'], { optional: true, timeout: 15_000, cwd: '/mnt/c' });
    const win = local.stdout.trim();
    if (!local.ok || !win || win.includes('%')) return [];
    const unix = await run(['wslpath', '-u', win], { optional: true, timeout: 15_000 });
    if (!unix.ok) return [];
    try { const side = sideOf(JSON.parse(await fs.readFile(path.join(unix.stdout.trim(), 'AgentTycoon', 'install.json'), 'utf8')), 'win32'); return side ? [side] : []; } catch { return []; }
  },
};

const sideRecordsFor = (platform) => sideRecords[platform];

/**
 * The other local host this one must not be installed or started beside (null: none). `port` is the port this side
 * will use. A daemon of the other side answering on that port is always a conflict (same port); an installed other
 * side is one unless one of the two was installed `besides` the other on a different port.
 */
export async function otherLocalHost({ platform, port, record = null, deps }) {
  if (platform !== 'win32' && platform !== 'wsl') return null;
  const h = await deps.health(port);
  // A daemon from before `os` was in health ran on Linux/WSL/macOS only (the Windows native daemon came with it).
  const hOs = h?.os ?? 'wsl';
  if (h?.service === 'cld-gui' && (platform === 'win32' ? hOs !== 'win32' : hOs === 'win32'))
    return { os: hOs, distro: null, port, answering: true, via: `/api/health on 127.0.0.1:${port} (${[hOs, h.os ? '' : 'an older daemon', h.version].filter(Boolean).join(', ')})` };
  for (const side of (await deps.sideRecords?.()) ?? []) {
    const apart = side.besides && side.port !== null && side.port !== port; // the other side is a test host on its own port
    if (!apart) return { ...side, answering: false, via: `install record (port ${side.port ?? '?'})` };
  }
  return null;
}

/** The refusal (Korean, like the manager's other prompts): why, and moving instead of a second host. */
export function oneHostMessage(other, platform) {
  const here = platform === 'win32' ? 'Windows' : 'WSL';
  return [
    `이 Windows 사용자에게는 이미 ${sideName(other)} 쪽 Agent Tycoon 호스트가 있어요 (${other.via}).`,
    `한 사용자에 로컬 호스트는 하나만 둡니다: ${here} 쪽 데몬을 ${other.answering ? '같은 포트에 ' : ''}더 설치하거나 시작하지 않았어요.`,
    `옮기려면: ${sideName(other)} 쪽에서 agty uninstall --program (데이터는 남아요; 소스 설치는 node cld/install/install.mjs --uninstall) 을 실행한 뒤 여기서 다시 설치하고, 프로젝트는 새 호스트에서 다시 가져오세요.`,
    `시험으로 나란히 두려면 (다른 포트, 다른 프로젝트만): --allow-second-host --port <다른 포트> 로 설치하세요 (install.ps1 도 같은 옵션).`,
  ].join('\n');
}

/** Throws (code ONE_HOST) when `otherLocalHost` finds one and the side-by-side test install was not asked for. */
async function assertOneHost({ platform, port, portGiven, record, second = false, deps }) {
  if (platform !== 'win32' && platform !== 'wsl') return null;
  if (second || record?.besides) return secondHost({ platform, port, portGiven, record, deps });
  const other = await otherLocalHost({ platform, port, record, deps });
  if (other) throw Object.assign(new Error(oneHostMessage(other, platform)), { code: 'ONE_HOST' });
  return null;
}

/**
 * The test mode (--allow-second-host, or install.ps1's flag through AGENT_TYCOON_SECOND_HOST=1): a second local
 * host beside the live one, on its own port and under its own install root. It never reads or writes anything of
 * the other side (no wsl.exe, no /mnt/c): it only needs a port other than the default one (where the live host is)
 * that nothing answers on. The record keeps `besides`, so later starts stay in this mode and the other side's
 * manager accepts this host on its different port.
 */
async function secondHost({ platform, port, portGiven, record, deps }) {
  const live = defaults.port;
  if (!record?.besides && (!portGiven || port === live))
    throw Object.assign(new Error(`--allow-second-host 는 시험용이고 다른 포트가 함께 있어야 해요: --port <${live} 가 아닌 포트> (예: --port 18250)`), { code: 'ONE_HOST' });
  const h = await deps.health(port);
  if (h?.service === 'cld-gui' && (h.os ?? 'wsl') !== (platform === 'win32' ? 'win32' : 'wsl'))
    throw Object.assign(new Error(oneHostMessage({ os: h.os ?? 'wsl', port, answering: true, via: `/api/health on 127.0.0.1:${port}` }, platform)), { code: 'ONE_HOST' });
  deps.print(`⚠ 시험 모드 (--allow-second-host): 이 ${platform === 'win32' ? 'Windows' : 'WSL'} 호스트는 포트 ${port} 에서 기본 호스트(포트 ${live}) 옆에 따로 돌아요. 시험용이에요: 같은 프로젝트를 두 호스트에 등록하지 마세요. 다른 쪽(WSL·Windows)의 파일은 읽지도 쓰지도 않아요`);
  return record?.besides ?? { mode: 'test', livePort: live, at: new Date().toISOString() };
}

// ── Commands ─────────────────────────────────────────────────────────────────

/** install --from <bundle>: verify -> unpack -> self-test -> adopt -> current -> launchers -> service -> record -> health. */
export async function install(o, deps = realDeps()) {
  if (o.startPolicy && deps.env.CLD_AGENT_TOKEN) throw new Error('에이전트 세션 안에서는 시작 정책을 바꿀 수 없어요');
  const root = o.root ?? installRoot(rootPlatform(deps.platform), deps.home, deps.env);
  const release = await acquireLock(root, 'install', { wait: o.wait ?? 0 });
  try {
    const record = (await readRecord(root)) ?? newRecord({ root, installedBy: o.installedBy, platform: deps.platform, env: deps.env });
    // P7 first: nothing is unpacked or changed beside another local host (the intended port, before any fallback).
    const besides = await assertOneHost({ platform: deps.platform, port: mergeConfig(await readConfig(deps.home), { port: o.port }).port, portGiven: o.port !== undefined, record, second: o.allowSecondHost === true || deps.env[SECOND_HOST_ENV] === '1', deps });
    const b = bundleArgs(o, root);
    if (b.keyBeside) deps.print(`! public key taken from beside the bundle (${b.pubkey}): proves integrity, not origin; pass --pub with the release key`);
    const verified = verifyBundle(b);
    deps.print(`✔ ${path.basename(b.bundle)}: signature, SHA-256 and ${verified.os}-${verified.arch} match`);
    if (b.pubkey !== pinnedKey(root)) await writeOwned(record, pinnedKey(root), await fs.readFile(b.pubkey, 'utf8'), 0o600);
    const manifest = await unpack(root, b.bundle, verified, record);
    await writeRecord(root, record);
    const test = await selfTest(versionDir(root, verified.version), manifest, deps);
    if (!test.ok) throw new Error(`self-test of ${verified.version} failed:\n${test.output}`);
    deps.print(`✔ self-test ${verified.version}`);

    const kind = o.service ?? record.service?.kind ?? defaultServiceKind(deps.platform);
    if (!SERVICE_KINDS.includes(kind)) throw new Error(`--service must be one of ${SERVICE_KINDS.join(', ')}`);
    // A test host beside the live one (P7 test mode) never takes over another install's service.
    const old = record.adopted || besides ? null : await detectOld(deps);
    if (old?.foreign) deps.print(`! ${old.file} is not the cld-gui daemon; left as it is`);
    else if (old && kind === 'dry-run') deps.print(`DRY-RUN: would adopt the ${old.name} service (${old.file ?? 'scheduled task'})`);
    else if (old) { await adoptOld(old, { root, record, kind, deps }); deps.print(`✔ adopted the ${old.name} service${old.repo ? ` (source install ${old.repo}; the repo is left as it is)` : ''}`); }

    try {
      const existing = await readConfig(deps.home); // a config.json already there keeps its choices
      const config = mergeConfig(Object.keys(existing).length ? existing : FIRST_INSTALL, { port: o.port });
      if (o.port === undefined && !(await deps.tcpFree(config.port)) && config.port !== record.port) {
        let port = config.port + 1; while (port <= 18299 && !(await deps.tcpFree(port))) port += 1;
        if (port > 18299) throw new Error(`no free port in ${config.port}-18299`);
        deps.print(`! port ${config.port} is in use: using ${port}`); config.port = port;
      }
      if (besides) record.besides = besides;
      await writeConfig(deps.home, config);
      record.port = config.port;

      await switchCurrent(root, verified.version, deps.platform, record);
      record.previous = record.current && record.current !== verified.version ? record.current : record.previous;
      record.current = verified.version;
      for (const [name, content] of Object.entries(launchers(root, deps.platform, manifest))) await writeOwned(record, path.join(root, 'bin', name), content, 0o755);
      await linkCli(record, root, deps, o.addPath === true);

      const pathNodeDirs = serviceNodeDirs(record, deps, root);
      const s = renderService({ platform: rootPlatform(deps.platform), home: deps.home, root, version: verified.version, manifest, config, pathNodeDir: pathNodeDirs });
      if (s.file && kind !== 'none') await writeOwned(record, s.file, s.content);
      record.service = { name: s.name, kind, file: s.file, label: s.label ?? null, sha256: sha256(s.content), argv: s.argv, cwd: s.cwd, create: s.create ?? null, pathNodeDirs };
      await writeRecord(root, record);
      await serviceOp(kind, 'activate', { ...s, autostart: (o.startPolicy ?? startPolicyOf(record)) !== 'manual' }, deps);
      if (o.startPolicy) await applyStartPolicy(o.startPolicy, { root, record, linger: o.linger, deps });
    } catch (error) {
      if (record.adopted && old && !old.foreign && kind !== 'dry-run') { deps.print(`✖ ${error.message}\n… putting the ${OLD_SERVICE} service back`); await revertAdoption({ root, record, deps }).catch((e) => deps.print(`! could not restore it: ${e.message}`)); await writeRecord(root, record); }
      throw error;
    }
    if (kind === 'dry-run' || kind === 'none') { deps.print(`  health: not checked (service ${kind}); start the daemon from ${path.join(root, 'current')} and run agty status`); return { ok: true, record }; }
    const h = await waitHealthy(record.port, verified.version, { check: deps.health, sleep: deps.sleep });
    if (!h) throw new Error(`installed, but /api/health on ${record.port} did not answer with ${verified.version} in 30 s (agty status, agty logs)`);
    deps.print(`✔ Agent Tycoon ${verified.version} is running on port ${record.port}`);
    return { ok: true, record };
  } finally { await release(); }
}

// update and rollback (H §6, P3) live in update.mjs; re-exported so callers keep one entry point.
export { compatibility, recoverUpdate, rollback, update } from './update.mjs';

// ── Uninstall (H §7) ───────────────────────────────────────────────────────

export const inside = (root, file) => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const fileDigest = async (file) => {
  if (!(await fs.lstat(file)).isFile()) throw new Error('not a regular file');
  return sha256(await fs.readFile(file));
};

/**
 * A folder we recorded: a real directory (not a link) directly in `parent`, and `parent` really is where it
 * says relative to `anchor` (a `snapshots/` replaced by a link out of the install root does not count).
 */
export async function ownedCopy(parent, dir, anchor = parent) {
  if (!(await fs.lstat(dir).catch(() => null))?.isDirectory() || path.dirname(path.resolve(dir)) !== path.resolve(parent)) return false;
  try { return (await fs.realpath(parent)) === path.join(await fs.realpath(anchor), path.relative(anchor, parent)); } catch { return false; }
}

/** `file` must still be under the real directory we originally meant to own;
 * a replaced `bin/` (or config subdirectory) must not redirect deletion. */
export async function parentInside(allowedRoot, file) {
  if (!allowedRoot || !inside(allowedRoot, file)) return false;
  try {
    return inside(await fs.realpath(allowedRoot), await fs.realpath(path.dirname(file)));
  } catch {
    return false;
  }
}

function recordRoot(file, root, home) {
  if (inside(root, file)) return root;
  // Manager-created service and CLI-link files are user-local too.  Never
  // honour an arbitrary outside path merely because a damaged record names it.
  for (const candidate of [path.join(home, '.config'), path.join(home, '.local'), path.join(home, 'Library')]) {
    if (inside(candidate, file)) return candidate;
  }
  return null;
}

async function ownedFile(file, expected, allowedRoot = null) {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return { owned: true, missing: true };
  if (!(await parentInside(allowedRoot, file))) return { owned: false, missing: false, outside: true };
  if (expected.startsWith('symlink:'))
    return { owned: stat.isSymbolicLink() && (await fs.readlink(file)) === expected.slice('symlink:'.length), missing: false };
  return { owned: stat.isFile() && (await fileDigest(file)) === expected, missing: false };
}

/**
 * One complete verification of a recorded version folder against its manifest, done once (in the plan).
 * `files` = what may be deleted (manifest.json last, and only when nothing else of the version stays);
 * `kept` = what stays (changed, not a regular file, or reaching outside the folder); `outside` ⊆ kept.
 * A file that is already gone is not a problem. No unlisted file and no directory is ever returned.
 */
export async function versionFiles(root, version) {
  const none = { files: [], kept: [], outside: [], manifestHeld: false, gone: false };
  let realRoot;
  let realVersion;
  try {
    realRoot = await fs.realpath(root);
    realVersion = await fs.realpath(version.dir);
  } catch (error) {
    return error.code === 'ENOENT' ? { ...none, gone: true } : { ...none, kept: [version.dir] };
  }
  if (!inside(realRoot, realVersion)) return { ...none, kept: [version.dir], outside: [version.dir] };
  const manifestFile = path.join(version.dir, 'manifest.json');
  let manifest;
  try {
    if ((await fileDigest(manifestFile)) !== version.manifestSha256) throw new Error('manifest changed');
    manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  } catch { return { ...none, kept: [version.dir] }; }
  const out = { ...none, files: [] };
  for (const [rel, hash] of Object.entries(manifest.files ?? {})) {
    const file = path.resolve(version.dir, rel);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat) continue;
    if (!(await parentInside(version.dir, file))) { out.kept.push(file); out.outside.push(file); continue; }
    if (!stat.isFile() || (await fileDigest(file).catch(() => '')) !== hash) out.kept.push(file); else out.files.push(file);
  }
  if (out.kept.length) { out.kept.push(manifestFile); out.manifestHeld = true; } else out.files.push(manifestFile);
  return out;
}

// A task that just started has no pid until its worker saves one: that is running, not stale.
const taskLive = (task) => ['running', 'working', 'limit'].includes(task.state) && (!Number.isInteger(task.pid) || pidAlive(task.pid));

function activeAgents(snapshot) {
  if (!snapshot?.ok) return [];
  return [
    ...(snapshot.projects ?? []).filter((p) => p.state === 'on').map((p) => ({ kind: 'session', name: p.name })),
    ...(snapshot.jobs ?? []).filter((j) => !j.ended && !j.exit).map((j) => ({ kind: 'job', name: j.id ?? String(j.pid) })),
    ...(snapshot.tasks ?? []).filter(taskLive).map((t) => ({ kind: 'codex', name: t.id })),
  ];
}

function staleTasks(snapshot) {
  if (!snapshot?.ok) return [];
  return (snapshot.tasks ?? [])
    .filter((task) => ['running', 'working', 'limit'].includes(task.state) && !taskLive(task))
    .map((task) => task.id);
}

/** The socket is shared with a source checkout, so a successful reply alone is
 * not authority to operate on it.  It must name this installed daemon and its
 * recorded HTTP port. */
export async function daemonIdentity(record, root, status) {
  const daemon = status?.daemon;
  if (!status?.ok || !daemon || !Number.isInteger(daemon.port) || typeof daemon.entry !== 'string')
    return { matches: false, daemon: daemon ?? null };
  if (!Number.isInteger(record.port) || daemon.port !== record.port)
    return { matches: false, daemon };
  try {
    const realRoot = await fs.realpath(root);
    const recorded = record.versions?.[record.current]?.dir ?? versionDir(root, record.current);
    const realVersion = await fs.realpath(recorded);
    const realEntry = await fs.realpath(daemon.entry);
    return { matches: inside(realRoot, realVersion) && inside(realVersion, realEntry), daemon };
  } catch {
    return { matches: false, daemon };
  }
}

async function daemonMayBeRunning(record, deps) {
  const socket = controlSocket(deps.home);
  if (await (deps.socketExists?.(socket) ?? fssync.existsSync(socket))) return true;
  if (Number.isInteger(record.port) && await deps.health?.(record.port)) return true;
  return !!(await deps.serviceActive?.(record.service));
}

/** A read-only, ordered account of precisely what uninstall may touch. */
export async function uninstallPlan(o, deps = realDeps()) {
  const root = o.root ?? installRoot(rootPlatform(deps.platform), deps.home, deps.env);
  const record = await readRecord(root);
  if (!record) return { source: true, root, lines: [`소스 설치입니다: node cld/install/install.mjs --uninstall 이 제거합니다 (${root} 변경 없음)`] };
  const status = await deps.control('status').catch(() => null);
  const identity = await daemonIdentity(record, root, status);
  const statusUnknown = !status?.ok && await daemonMayBeRunning(record, deps);
  const daemonMismatch = !!status?.ok && !identity.matches;
  const agents = identity.matches ? activeAgents(status) : [];
  const stale = identity.matches ? staleTasks(status) : [];
  let exposure;
  try { exposure = await deps.revertLedger(deps.home, { dryRun: true, quiet: !o.dryRun }); } catch { exposure = { ok: false, unreadable: true, file: exposurePath(deps.home), entries: [] }; }
  if (!exposure || typeof exposure !== 'object' || !('ok' in exposure)) exposure = { ok: true, file: exposurePath(deps.home), entries: [] };
  const files = [];
  const kept = [];
  const outside = [];
  for (const [file, hash] of Object.entries(record.files ?? {})) {
    const own = await ownedFile(file, hash, recordRoot(file, root, deps.home));
    if (!own.owned) { kept.push(file); if (own.outside) outside.push(file); } else if (!own.missing) files.push(file);
  }
  const versions = [];
  const versionState = {};
  const manifestHeld = [];
  for (const [name, version] of Object.entries(record.versions ?? {})) {
    // A version folder is spelled under the install root as recorded; another spelling that resolves into it is distrusted.
    const checked = inside(root, version.dir) ? await versionFiles(root, version) : { files: [], kept: [version.dir], outside: [version.dir], manifestHeld: false, gone: false };
    versionState[name] = checked;
    versions.push(...checked.files); kept.push(...checked.kept); outside.push(...checked.outside);
    if (checked.manifestHeld) manifestHeld.push(path.join(version.dir, 'manifest.json'));
  }
  const reset = o.reset ? resetPaths(deps.home, record.port) : { remove: [], keep: [] };
  // Update rollback snapshots (P3) are copies of ~/.config/cld-gui with its secrets, useful only to this install's rollback.
  const snapshots = [];
  for (const dir of record.snapshots ?? []) if (await ownedCopy(path.join(root, 'snapshots'), dir, root)) snapshots.push(dir);
  // Live data a snapshot restore moved aside (~/.config/cld-gui.replaced-<ts>): the user's data, with secrets.
  const replaced = [];
  for (const dir of record.replaced ?? []) if (path.basename(dir).startsWith('cld-gui.replaced-') && await ownedCopy(path.dirname(path.dirname(configPath(deps.home))), dir)) replaced.push(dir);
  return {
    source: false, root, record, status, statusUnknown, daemonMismatch, daemon: identity.daemon, agents, stale, exposure, files: [...new Set([...files, ...versions])], versionState, snapshots, replaced, kept: [...new Set(kept)], outside: [...new Set(outside)], reset,
    lines: [
      `1. 실행 중 에이전트: ${daemonMismatch ? `확인하지 못함 (다른 설치의 데몬이 응답함: 포트 ${identity.daemon?.port ?? '알 수 없음'}, 엔트리 ${identity.daemon?.entry ?? '알 수 없음'})` : statusUnknown ? '확인하지 못함 (데몬이 응답하지 않음)' : `${agents.length ? agents.map((a) => `${a.kind}:${a.name}`).join(', ') : '없음'}${stale.length ? ` · ${stale.map((id) => `codex:${id} 멈춘 기록(프로세스 없음)`).join(', ')}` : ''}`}`,
      `2. 바깥 노출: ${exposure.ok ? (exposure.entries ?? []).map((entry) => entry.kind).join(', ') || '없음' : `⚠ 바깥 노출 기록을 읽지 못했어요: ${exposure.file}`}`,
      `3. 서비스: ${record.service?.name ?? '없음'} 을 중지하고 제거합니다${record.logonTask ? ` · Windows 로그온 작업 ${record.logonTask.name}과 홀더 스크립트 삭제` : ''}${record.linger ? ` · 우리가 켠 linger(${record.linger.user}) 끄기` : ''}`,
      `4. 기록된 파일 삭제: ${files.length + versions.length ? [...new Set([...files, ...versions])].join(', ') : '없음'}`,
      ...(snapshots.length ? [`   업데이트 스냅샷 삭제(비밀 포함 사본): ${snapshots.join(', ')}`] : []),
      ...[...new Set(kept)].map((file) => `   남김(${outside.includes(file) ? '설치 폴더 밖을 가리킴' : manifestHeld.includes(file) ? '남은 파일을 확인하는 데 필요' : '직접 고친 파일'}): ${file}`),
      ...(!o.reset && replaced.length ? [`   남김(업데이트 되돌리기 때 옆으로 옮긴 데이터 사본, 비밀 포함): ${replaced.join(', ')}`] : []),
      ...(o.reset ? [`5. 완전 초기화: ${[...reset.remove, ...replaced].join(', ') || '없음'}`, ...reset.keep.map((file) => `   남김(공유 Pixel Agents 파일): ${file}`)] : []),
      '6. 지우지 않는 것: ~/.claude, ~/.codex, WSL, 프로젝트와 .worktrees/, Node/nvm/fnm, 소스 설치의 소스 체크아웃',
    ],
  };
}

/** The standalone daemon owns only these Pixel Agents files; extension-owned files stay untouched. */
export function resetPaths(home, port) {
  const pixel = path.join(home, '.pixel-agents');
  const server = path.join(pixel, 'server.json');
  const servers = path.join(pixel, 'servers');
  let serverOurs = false;
  try {
    const serverPort = JSON.parse(fssync.readFileSync(server, 'utf8')).port;
    serverOurs = typeof serverPort === 'number' && Number.isFinite(serverPort) && typeof port === 'number' && Number.isFinite(port) && serverPort === port;
  } catch { /* absent or not ours */ }
  const serverFiles = fssync.existsSync(servers)
    ? fssync.readdirSync(servers, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
    : [];
  const ownedServerFiles = serverFiles
    .filter((name) => /^\d+-(\d+)\.json$/.exec(name)?.[1] === String(port))
    .map((name) => path.join(servers, name));
  return {
    remove: [path.join(home, '.config', 'cld-gui'), path.join(pixel, 'standalone-state.json'), path.join(pixel, 'standalone-token'), ...(serverOurs ? [server] : []), ...ownedServerFiles],
    keep: [path.join(pixel, 'layout.json'), path.join(pixel, 'config.json'), path.join(pixel, 'vscode-state.json'), path.join(pixel, 'hooks'), ...(!serverOurs && fssync.existsSync(server) ? [server] : []), ...serverFiles.filter((name) => !ownedServerFiles.includes(path.join(servers, name))).map((name) => path.join(servers, name))],
  };
}

async function removeEmpty(dir) { try { await fs.rmdir(dir); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; } }
/** Files (not folders) still under `dir`, never following a symlink; at most 20 are named. */
async function remainingFiles(dir, limit = 20) {
  const out = [];
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full); else out.push(full);
    }
  };
  await walk(dir);
  return out;
}
/** The install root itself, last, and never an error: an empty folder goes; a symlinked root goes only when what it points to is now empty. */
async function removeRoot(root, print) {
  try {
    const stat = await fs.lstat(root).catch(() => null);
    if (!stat) return;
    if (!stat.isSymbolicLink()) { await removeEmpty(root); return; }
    const real = await fs.realpath(root);
    if ((await fs.readdir(real)).length) { print(`설치 폴더 링크를 그대로 뒀습니다 (가리키는 폴더가 비어 있지 않음): ${root} -> ${real}`); return; }
    await fs.rmdir(real); await fs.unlink(root);
    print(`✔ 비어 있는 설치 폴더와 그 링크를 지웠습니다: ${root} -> ${real}`);
  } catch (error) {
    print(`⚠ 설치 폴더를 정리하지 못했습니다 (${error.code ?? error.message}), 그대로 뒀습니다: ${root}`);
  }
}
export async function pruneEmptyDirs(dir) {
  const stat = await fs.lstat(dir).catch(() => null);
  if (!stat?.isDirectory()) return; // never traverse a symlink
  for (const name of await fs.readdir(dir)) await pruneEmptyDirs(path.join(dir, name));
  await removeEmpty(dir);
}

/** Program removal is deliberately fail-fast: each completed operation is logged before the next. */
export async function uninstall(o, deps = realDeps()) {
  if ((o.program ? 1 : 0) + (o.reset ? 1 : 0) !== 1) throw new Error('uninstall needs exactly one of --program or --reset');
  if (deps.env.CLD_AGENT_TOKEN) {
    deps.print('에이전트 세션 안에서는 제거할 수 없어요. 사람의 터미널에서 실행하세요');
    return { code: 2 };
  }
  const root = o.root ?? installRoot(rootPlatform(deps.platform), deps.home, deps.env);
  // Do not even create a lock directory for a source/no-manager installation.
  if (!(await readRecord(root))) {
    const plan = await uninstallPlan(o, deps);
    for (const line of plan.lines) deps.print(line);
    return { code: 2, plan };
  }
  const release = await acquireLock(root, 'uninstall', { wait: o.wait ?? 0 });
  let held = true;
  const unlock = async () => { if (held) { held = false; await release(); } };
  try {
    const plan = await uninstallPlan(o, deps);
    for (const line of plan.lines) deps.print(line);
    if (plan.source) return { code: 2, plan };
    if (o.dryRun) { deps.print('DRY-RUN: 변경하지 않았습니다'); return { code: 0, plan }; }
    if (!plan.exposure.ok && !(o.yes && o.ignoreExposure)) {
      deps.print(`⚠ 바깥 노출 기록을 읽지 못했어요: ${plan.exposure.file}`);
      return { code: 1, plan };
    }
    if (plan.daemonMismatch) {
      deps.print(`응답한 데몬(포트 ${plan.daemon?.port ?? '알 수 없음'}, 엔트리 ${plan.daemon?.entry ?? '알 수 없음'})은 다른 설치에 속합니다. 제거를 취소했습니다`);
      return { code: 3, plan };
    }
    if (plan.statusUnknown) {
      if (o.yes || !(await deps.confirmUnknownDaemon())) {
        deps.print('데몬 응답을 확인하지 못해 제거를 취소했습니다');
        return { code: 3, plan };
      }
    }
    let stopAgents = o.stopAgents === true;
    if (plan.agents.length && !stopAgents) {
      if (o.yes) { deps.print(`실행 중이라 제거를 취소했습니다: ${plan.agents.map((a) => `${a.kind}:${a.name}`).join(', ')}`); return { code: 3, plan }; }
      stopAgents = (await deps.chooseAgents(plan.agents)) === 'stop';
      if (!stopAgents) { deps.print('제거를 취소했습니다'); return { code: 3, plan }; }
    }
    if (!o.yes && !(await deps.confirm('정말 제거할까요? (y/N)'))) { deps.print('제거를 취소했습니다'); return { code: 0, plan }; }
    if (stopAgents) {
      const stopped = await deps.control('stop-agents');
      if (!stopped?.ok) {
        deps.print('에이전트 중지를 확인하지 못해 제거를 취소했습니다');
        return { code: 3, plan };
      }
      deps.print(`에이전트 중지 요청: ${(stopped?.stopped ?? []).map((a) => `${a.kind}:${a.name}`).join(', ') || '없음'}`);
      let poll = await deps.control('status').catch(() => null);
      if (!poll?.ok) { deps.print('에이전트 중지를 확인하지 못해 제거를 취소했습니다'); return { code: 3, plan }; }
      let left = activeAgents(poll);
      for (let waited = 0; left.length && waited < 60_000; waited += 2_000) {
        await deps.sleep(2_000); poll = await deps.control('status').catch(() => null);
        if (!poll?.ok) { deps.print('에이전트 중지를 확인하지 못해 제거를 취소했습니다'); return { code: 3, plan }; }
        left = activeAgents(poll);
      }
      if (left.length || stopped?.left?.length) { deps.print(`아직 실행 중이라 제거를 취소했습니다: ${[...left, ...(stopped?.left ?? [])].map((a) => `${a.kind}:${a.name}`).join(', ')}`); return { code: 3, plan }; }
    }
    // S6 remains the only exposure undo implementation.
    const reverted = await deps.revertLedger(deps.home);
    if (!reverted?.ok) {
      deps.print(`⚠ 바깥 노출 기록을 읽지 못했어요: ${reverted?.file ?? exposurePath(deps.home)}`);
      if (!o.ignoreExposure) return { code: 1, plan };
    } else deps.print('✔ 바깥 노출을 닫았습니다');
    if (plan.record.service) {
      await serviceOp(plan.record.service.kind, 'deactivate', plan.record.service, deps);
      const [stillHealthy, stillActive] = await Promise.all([
        Number.isInteger(plan.record.port) ? deps.health?.(plan.record.port).catch(() => null) : null,
        deps.serviceActive?.(plan.record.service).catch(() => false),
      ]);
      if (stillHealthy || stillActive) {
        deps.print(`✖ 서비스 ${plan.record.service.name} 또는 포트 ${plan.record.port ?? '알 수 없음'} 가 아직 실행 중이라 제거를 멈췄습니다`);
        return { code: 1, plan };
      }
      deps.print(`✔ 서비스 ${plan.record.service.name} 제거`);
    }
    // The logon task and our linger change (never a linger that was already on).
    await runPolicySteps(startPolicyPlan({ platform: deps.platform, policy: null, record: plan.record }), { root, record: plan.record, dry: false, deps });
    // The user Path entry --add-path appended on Windows (only that folder; the rest of Path stays as it is).
    const added = plan.record.cli?.pathAdded;
    if (added?.kind === 'windows-user-path') {
      if ((await (deps.winPath ?? winPath)((value) => pathWithout(value, added.dir), false)) === 'skipped') deps.print(`! 사용자 Path 에서 ${added.dir} 를 직접 빼 주세요`);
      else deps.print(`✔ 사용자 Path 에서 ${added.dir} 제거 (새 터미널부터)`);
      plan.record.cli.pathAdded = null;
    }
    const keptFiles = new Set(plan.kept.filter((file) => plan.record.files?.[file]));
    // Version folders were verified completely by the plan (manifest.json is the last file of each): no re-hashing here.
    for (const file of plan.files) {
      const expected = plan.record.files[file];
      const own = expected ? await ownedFile(file, expected, recordRoot(file, root, deps.home)) : { owned: true, outside: false };
      if (!own.owned) {
        deps.print(`남김(${own.outside ? '설치 폴더 밖을 가리킴' : '직접 고친 파일'}): ${file}`);
        keptFiles.add(file);
        continue;
      }
      await (deps.rm ?? ((target) => fs.rm(target, { force: true })))(file);
      if (expected) delete plan.record.files[file];
      deps.print(`✔ 파일 삭제 ${file}`);
    }
    for (const dir of plan.snapshots) {
      if (!(await ownedCopy(path.join(root, 'snapshots'), dir, root))) continue; // checked again: never follow a replaced link
      await fs.rm(dir, { recursive: true, force: true }); deps.print(`✔ 스냅샷 삭제 ${dir}`);
    }
    plan.record.snapshots = [];
    if (o.reset) {
      for (const file of plan.reset.remove) { await fs.rm(file, { force: true, recursive: true }); deps.print(`✔ 데이터 삭제 ${file}`); }
      for (const dir of plan.replaced) {
        if (!(await ownedCopy(path.dirname(path.dirname(configPath(deps.home))), dir))) continue;
        await fs.rm(dir, { recursive: true, force: true }); deps.print(`✔ 데이터 사본 삭제 ${dir}`);
      }
      plan.record.replaced = [];
    }
    const keptVersions = new Set();
    for (const [name, state] of Object.entries(plan.versionState)) {
      if (state.kept.length) keptVersions.add(name); else delete plan.record.versions[name];
    }
    // The .replaced-* data copies a --program removal keeps stay listed, so a later --reset can find them.
    const keptCopies = !o.reset && plan.replaced.length;
    const retained = keptFiles.size || keptVersions.size || keptCopies;
    if (retained) {
      plan.record.files = Object.fromEntries(Object.entries(plan.record.files ?? {}).filter(([file]) => keptFiles.has(file)));
      // The pointer was deleted with the other recorded files: the record must not claim a current version.
      const pointerGone = !(await fs.lstat(path.join(root, 'current')).catch(() => null)) && !(await fs.lstat(path.join(root, 'current.txt')).catch(() => null));
      plan.record.current = !pointerGone && plan.record.versions?.[plan.record.current] ? plan.record.current : null;
      plan.record.previous = plan.record.versions?.[plan.record.previous] ? plan.record.previous : null;
      plan.record.service = null;
      await writeRecord(root, plan.record);
      deps.print(keptFiles.size || keptVersions.size ? `⚠ 일부 기록된 파일을 남겨 install.json을 갱신했습니다: ${path.join(root, 'install.json')}` : `남은 데이터 사본(${plan.replaced.join(', ')})을 기억하려고 ${path.join(root, 'install.json')} 만 남겼습니다: agty uninstall --reset 이 지웁니다`);
    } else {
      // These markers are manager-owned and go last; the lock goes right after, before the root itself.
      for (const file of [path.join(root, 'install.json'), path.join(root, 'current'), path.join(root, 'current.txt')]) await fs.rm(file, { force: true });
    }
    try { for (const dir of ['versions', 'bin', 'snapshots', 'downloads']) await pruneEmptyDirs(path.join(root, dir)); } catch (error) { deps.print(`⚠ 빈 폴더를 정리하지 못했습니다 (${error.code ?? error.message})`); }
    await unlock(); // manager.lock lives in the root: release it first so an empty root can go
    if (!retained) {
      const left = await remainingFiles(root);
      if (left.length) deps.print(`남은 파일(직접 만들어졌거나 목록에 없어서 지우지 않았어요): ${left.join(', ')}`);
    }
    await removeRoot(root, deps.print);
    deps.print(retained ? '✔ 프로그램의 삭제 가능한 항목을 제거했습니다' : '✔ 프로그램 제거 완료');
    return { code: 0, plan };
  } finally { await unlock(); }
}

/** What `status` adds: the install record and what answers on its port. */
export async function installStatus(deps = realDeps()) {
  const root = installRoot(rootPlatform(deps.platform), deps.home, deps.env);
  const record = await readRecord(root).catch((error) => ({ broken: error.message }));
  if (!record) return { installed: false, root };
  if (record.broken) return { installed: false, root, error: record.broken };
  const h = record.port ? await deps.health(record.port) : null;
  return {
    installed: true, root, current: record.current, pointer: await readCurrent(root, deps.platform), previous: record.previous,
    versions: Object.keys(record.versions), failedVersions: record.failedVersions, installedBy: record.installedBy,
    service: record.service && { name: record.service.name, kind: record.service.kind, file: record.service.file },
    port: record.port, health: h ? { up: true, version: h.version, protocol: h.protocol, matches: h.version === record.current } : { up: false },
    pendingUpdate: record.update ? { kind: record.update.kind, from: record.update.from, to: record.update.to, step: record.update.step } : null,
    adopted: record.adopted && { from: record.adopted.from, repo: record.adopted.repo }, wslDistro: record.wslDistro,
    startPolicy: startPolicyOf(record), logonTask: record.logonTask?.name ?? null, linger: !!record.linger,
  };
}
export function installStatusLines(s) {
  if (!s.installed) return [`설치(관리자): 없음 (${s.root})${s.error ? ` · ${s.error}` : ''}`];
  return [
    `설치(관리자): ${s.current} · ${s.root} · ${s.installedBy}${s.pointer !== s.current ? ` · ! current 가 ${s.pointer} 를 가리킴` : ''}`,
    `서비스: ${s.service ? `${s.service.name} (${s.service.kind})${s.service.file ? ` ${s.service.file}` : ''}` : '없음'} · 포트 ${s.port} · 시작 정책 ${s.startPolicy}${s.logonTask ? ` (로그온 작업 ${s.logonTask})` : ''}${s.linger ? ' · linger' : ''}`,
    `상태 점검: ${!s.health.up ? '응답 없음' : `응답 (버전 ${s.health.version}, 프로토콜 ${s.health.protocol})${s.health.version !== s.current ? ` · ! 설치된 ${s.current} 가 아님: 다른 데몬이 이 포트를 쓰거나 아직 재시작 전` : ''}`}`,
    ...(s.pendingUpdate ? [`! ${s.pendingUpdate.kind === 'rollback' ? '되돌리기' : '업데이트'} ${s.pendingUpdate.from} -> ${s.pendingUpdate.to} 가 '${s.pendingUpdate.step}' 단계에서 멈췄어요: agty update 로 마저 하거나 되돌리세요`] : []),
    ...(s.failedVersions?.length ? [`실패한 버전(자동으로 다시 시도하지 않음): ${s.failedVersions.join(', ')}`] : []),
    ...(s.adopted ? [`이어받음: ${s.adopted.from}${s.adopted.repo ? ` (${s.adopted.repo})` : ''} · 되돌리기: agty revert-adopt`] : []),
  ];
}

/** Headless: no display (Linux, not WSL), or an SSH session. */
export function headless(platform, env) {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}
/**
 * The desktop app if installed: Agent Tycoon (agent-tycoon.exe, Agent Tycoon.app, agent-tycoon), else its old name Pixel Office.
 * ponytail: fixed candidate paths; P5 gives the app a host hand-off.
 */
export function desktopApp(platform, env, home, exists = fssync.existsSync) {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidates = platform === 'darwin' ? ['Agent Tycoon.app', 'Pixel Office.app'].flatMap((app) => [path.join('/Applications', app), path.join(home, 'Applications', app)])
    : platform === 'win32' ? [path.join(local, 'Agent Tycoon', 'agent-tycoon.exe'), path.join(local, 'Pixel Office', 'pixel-office.exe')]
      : platform === 'linux' ? ['agent-tycoon', 'pixel-office'].flatMap((bin) => [path.join('/usr/bin', bin), path.join(home, '.local', 'bin', bin)]) : [];
  const app = candidates.find((c) => exists(c));
  if (!app) return null;
  return platform === 'darwin' ? ['open', '-a', app] : [app];
}
export function browserCommand(platform, url) {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'wsl') return ['explorer.exe', url];
  if (platform === 'win32') return ['explorer.exe', url]; // `cmd /c start "" url` would get its "" re-quoted by Node
  return ['xdg-open', url];
}

/** open (H §5.3): the app, else the default browser with a one-time login link, else (headless) address + QR + how to register. */
export async function open(o, deps = realDeps()) {
  const config = mergeConfig(await readConfig(deps.home));
  const port = o.port ?? config.port;
  if (!(await deps.health(port))?.service) {
    // on-demand and always: opening the office starts the daemon; manual leaves starting to the user (H §4.3).
    const root = installRoot(rootPlatform(deps.platform), deps.home, deps.env);
    if (startPolicyOf(await readRecord(root).catch(() => null)) === 'manual') throw new Error(`the daemon is off on ${port} (start policy manual: agty start)`);
    await start({ port }, deps);
  }
  const spawnDetached = deps.spawnDetached ?? ((cmd) => new Promise((resolve) => { const c = spawnChild(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore' }); c.once('error', () => resolve(false)); c.once('spawn', () => { c.unref(); resolve(true); }); }));
  const isHeadless = headless(deps.platform, deps.env);
  if (!isHeadless) {
    const app = desktopApp(deps.platform, deps.env, deps.home);
    if (app && (await spawnDetached(app))) { deps.print('✔ Pixel Office 앱을 열었어요'); return { ok: true, how: 'app' }; }
  }
  const token = await hostToken(deps.home);
  const r = await fetch(`http://127.0.0.1:${port}/api/login-code`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(isHeadless ? { qr: true } : {}), signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`login code: HTTP ${r.status}`);
  const login = await r.json();
  if (!isHeadless) {
    const url = `http://localhost:${port}/login?code=${encodeURIComponent(login.code)}`;
    if (await spawnDetached(browserCommand(deps.platform, url))) { deps.print('✔ 브라우저로 사무실을 열었어요 (한 번 쓰는 로그인 링크)'); return { ok: true, how: 'browser' }; }
    deps.print(`브라우저를 열지 못했어요. 이 주소를 여세요 (한 번만 쓰여요):\n${url}`); return { ok: true, how: 'printed' };
  }
  const base = login.url ?? `http://localhost:${port}`;
  const url = `${base}/login?code=${encodeURIComponent(login.code)}`;
  // The installed version's QR script (its node_modules has uqr): the wizard runs this file from install.sh's temp unpack, which has none.
  const installedQr = path.join(installRoot(rootPlatform(deps.platform), deps.home, deps.env), 'current', 'cld', 'bin', 'cld-gui-qr.mjs');
  const qr = await deps.run([process.execPath, fssync.existsSync(installedQr) ? installedQr : path.join(here, '..', 'bin', 'cld-gui-qr.mjs'), url], { optional: true });
  deps.print(`이 컴퓨터에는 화면이 없어요. 다른 기기에서 들어오세요.\n${qr.ok ? qr.stdout : ''}주소: ${base}\n한 번 쓰는 로그인 링크 (10분): ${url}\n휴대폰: 카메라로 QR 을 찍고, 연 다음 공유 → "홈 화면에 추가".\n이미 로그인한 기기가 있으면 그 기기의 "기기 추가"로 등록할 수도 있어요.${base.startsWith('http://localhost') ? '\n바깥에서 들어오려면 먼저 연결 방식을 정하세요: node cld/install/install.mjs --remote' : ''}`);
  return { ok: true, how: 'headless' };
}

export function parseArgs(argv) {
  const o = {};
  const values = { '--from': 'from', '--sums': 'sums', '--sig': 'sig', '--pub': 'pub', '--port': 'port', '--service': 'service', '--installed-by': 'installedBy', '--wait': 'wait', '--root': 'root' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (values[flag]) { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`); o[values[flag]] = v; }
    else if (flag === '--add-path') o.addPath = true; else if (flag === '--force') o.force = true; else if (flag === '--json') o.json = true; else if (flag === '--check') o.check = true; else if (flag === '--rollback') o.rollback = true;
    else if (flag === '--program') o.program = true; else if (flag === '--reset') o.reset = true; else if (flag === '--dry-run') o.dryRun = true; else if (flag === '--yes') o.yes = true; else if (flag === '--stop-agents') o.stopAgents = true; else if (flag === '--ignore-exposure') o.ignoreExposure = true;
    else if (flag === '--allow-second-host') o.allowSecondHost = true;
    else if (flag === '--linger') o.linger = true; else if (flag === '--hold') o.hold = true; else if (flag === '--no-linger') o.linger = false; else if (flag === '--start-policy') { o.startPolicy = argv[++i]; if (!START_POLICIES.includes(o.startPolicy)) throw new Error(`--start-policy is one of ${START_POLICIES.join(', ')}`); }
    else throw new Error(`unknown option: ${flag}`);
  }
  if (o.port !== undefined) { o.port = Number(o.port); if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port is not a port'); }
  if (o.wait !== undefined) { o.wait = Number(o.wait) * 1000; if (!(o.wait >= 0)) throw new Error('--wait is seconds'); }
  if (o.root) o.root = path.resolve(o.root);
  return o;
}
export const USAGE = `사용법:
  agty install --from <묶음> [--sums SHA256SUMS --sig SHA256SUMS.sig --pub <공개 키>] [--port N] [--add-path] [--allow-second-host (시험용, --port 와 함께)] [--service systemd|launchd|schtasks|detached|dry-run|none] [--installed-by cli|gui|source] [--wait 초]
  agty update --from <묶음 | 릴리스 폴더 | URL> [--check [--json]] [--sums … --sig … --pub …] [--yes] [--force] [--wait 초]
  agty update            (중간에 멈춘 업데이트를 마저 하거나 되돌림)
  agty rollback [--yes]  (= update --rollback: 이전 버전으로, 데이터 형식이 다르면 스냅샷 복원)
  agty status [--json]
  agty uninstall --program | --reset [--dry-run] [--yes] [--stop-agents] [--ignore-exposure]
  agty open [--port N]
  agty start [--port N] [--hold]   (데몬이 꺼져 있을 때만 시작, --hold: 응답하는 동안 붙잡고 있기, 로그온 작업용)
  agty stop --daemon [--yes]   (데몬만 멈춤, 실행 중 에이전트가 있으면 먼저 물음)
  agty start-policy [on-demand|always|manual] [--linger|--no-linger]   (보기·바꾸기, 실행 중인 것은 멈추지 않음)
  agty revert-adopt
  install 에는 --start-policy on-demand|always|manual [--linger|--no-linger] 도 줄 수 있어요`;

/** CLI entry (cld/bin/cld-gui delegates here). Returns the exit code. */
export async function main(argv, deps = realDeps()) {
  const [cmd, ...rest] = argv;
  try {
    const policy = cmd === 'start-policy' && rest[0] && !rest[0].startsWith('--') ? rest.shift() : undefined;
    const o = parseArgs(rest);
    if (cmd === 'install') await install(o, deps);
    else if (cmd === 'update' && o.check && o.json) { // for the daemon's notice (P3a): one JSON line, nothing else on stdout
      const r = await update(o, { ...deps, print: () => {} });
      deps.print(JSON.stringify({ v: 1, current: r.current, available: r.available, failed: r.failed, bundle: r.bundle, notes: r.notes }));
    } else if (cmd === 'update') await update(o, deps);
    else if (cmd === 'rollback') { if ((await rollback(o, deps)).ok === false) return 3; }
    else if (cmd === 'open') await open(o, deps);
    else if (cmd === 'start') await start(o, deps);
    else if (cmd === 'stop-daemon') return (await stopDaemon(o, deps)).code;
    else if (cmd === 'start-policy') await startPolicy({ ...o, policy }, deps);
    else if (cmd === 'uninstall') { const result = await uninstall(o, deps); return result.code; }
    else if (cmd === 'status') { const s = await installStatus(deps); deps.print(o.json ? JSON.stringify({ v: 1, ...s }) : installStatusLines(s).join('\n')); return s.installed && s.health?.matches ? 0 : 3; }
    else if (cmd === 'revert-adopt') {
      const root = installRoot(rootPlatform(deps.platform), deps.home, deps.env);
      const release = await acquireLock(root, 'revert-adopt');
      try { const record = await readRecord(root); if (!record) throw new Error('no install record'); await revertAdoption({ root, record, deps }); await writeRecord(root, record); deps.print(`✔ ${OLD_SERVICE} service restored; ${SERVICE} stopped (the installed versions stay in ${root})`); } finally { await release(); }
    } else { deps.print(USAGE); return 2; }
    return 0;
  } catch (error) {
    console.error(`✖ ${error.message}`);
    return error.code === 'LOCKED' ? 4 : error.code === 'CANCELLED' || error.code === 'ONE_HOST' ? 3 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
