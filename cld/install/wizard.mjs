#!/usr/bin/env node
/**
 * The CLI install wizard (H §5.4, roadmap P4): a short install dialogue, not a product screen.
 * install.sh / install.ps1 fetch the bundle for this OS/CPU, check its SHA-256 against the table
 * stamped into them (cld/release/stamp-installers.mjs), unpack the bundle's own Node next to this
 * folder in a temp dir and run this file. Every question is asked here; the install itself is the
 * manager's install() (Ed25519 signature of SHA256SUMS checked with --pub, which it pins as
 * release.pub) and the last step is the manager's open().
 *
 *   wizard.mjs --bundle <file> --pub <release key> [--sums f --sig f] [--base-url <release URL> [--insecure-localhost]]
 *              [--gui yes|no] [--launch yes|no] [--yes] [--remote] [--port N] [--service kind] [--add-path]
 *              [--start-policy on-demand|always|manual] [--linger yes|no]
 *              [--wsl-installer <install.sh>]   (Windows: the checked install.sh to run inside a WSL distro)
 *
 * The decisions are the exported pure functions (wizard.test.mjs); main() is the thin prompting layer.
 */
import { execFile as execFileCallback, spawn } from 'node:child_process';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { sha256File, verifySums } from '../release/bundle/verify.mjs';
import { headless, install, open, realDeps, START_POLICIES } from './manager.mjs';
import { lang, TEXT } from './wizardText.mjs';

const require = createRequire(import.meta.url);
const maintenance = require('../bin/cld-gui-maintenance.js');
const execFile = promisify(execFileCallback);

// ── Decisions (pure) ─────────────────────────────────────────────────────────

/** https always; plain http only to this machine and only with --insecure-localhost (tests). */
export function allowedUrl(url, insecureLocalhost = false) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && insecureLocalhost === true && ['127.0.0.1', 'localhost'].includes(u.hostname) && !u.username && !u.password;
}

export function parseWizardArgs(argv) {
  const o = {};
  const values = { '--bundle': 'bundle', '--sums': 'sums', '--sig': 'sig', '--pub': 'pub', '--base-url': 'baseUrl', '--gui': 'gui', '--launch': 'launch', '--port': 'port', '--service': 'service', '--wsl-installer': 'wslInstaller', '--start-policy': 'startPolicy', '--linger': 'linger' };
  const flags = { '--yes': 'yes', '--remote': 'remote', '--add-path': 'addPath', '--insecure-localhost': 'insecureLocalhost' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (values[flag]) { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`); o[values[flag]] = v; }
    else if (flags[flag]) o[flags[flag]] = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  for (const k of ['gui', 'launch', 'linger']) if (o[k] !== undefined && !['yes', 'no'].includes(o[k])) throw new Error(`--${k} is yes or no`);
  if (o.startPolicy !== undefined && !START_POLICIES.includes(o.startPolicy)) throw new Error(`--start-policy is one of ${START_POLICIES.join(', ')}`);
  if (o.port !== undefined) { o.port = Number(o.port); if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port is not a port'); }
  if (!o.remote && !(o.bundle && o.pub)) throw new Error('--bundle and --pub are required (install.sh and install.ps1 pass them)');
  if (o.baseUrl && !allowedUrl(o.baseUrl, o.insecureLocalhost)) throw new Error(`${o.baseUrl}: downloads are HTTPS only (http://127.0.0.1 or localhost needs --insecure-localhost)`);
  return o;
}

/** A question can be asked only with a terminal on both ends. */
export const interactive = (proc = process) => !!(proc.stdin?.isTTY && proc.stdout?.isTTY);

/** Desktop app default (H §5.4): yes on a desktop with graphics, skip when headless, over SSH or without a terminal. */
export const desktopDefault = ({ platform, env, tty }) => tty && !headless(platform, env);

/** A flag decides; else --yes or no terminal takes the default; else ask. */
export function choice(flag, def, { yes = false, tty = false } = {}) {
  if (flag !== undefined) return { value: flag === 'yes' };
  if (yes || !tty) return { value: def };
  return { ask: true, def };
}

/** "Where should your agents work?" is a real choice only on Windows with a WSL distro; null = no question. */
export function whereChoices({ platform, distros = [] }) {
  if (platform !== 'win32' || !distros.length) return null;
  return [{ kind: 'wsl', distro: distros[0] }, { kind: 'native' }, { kind: 'remote' }];
}

/** `wsl.exe -l -q` prints UTF-16LE; the default distro comes first. Docker Desktop's own distros are not for agents. */
export function parseWslList(out) {
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(String(out));
  const text = buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8');
  return text.replace(/[\0﻿]/g, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^docker-desktop/i.test(l));
}

const APP = { linux: /\.AppImage$/i, darwin: /\.dmg$/i, win32: /[-_]setup\.exe$/i };
const ARCHES = { x64: ['x64', 'x86_64', 'amd64'], arm64: ['arm64', 'aarch64'] };
/**
 * The desktop installer for this machine among the release's file names: AppImage on Linux (no sudo),
 * dmg on macOS, NSIS on Windows, and from WSL the Windows NSIS (no Linux GUI inside WSL). null = none.
 * ponytail: the Windows side of WSL is taken as x64; read it from Windows when arm64 Windows ships.
 */
export function desktopArtifact(names, { platform, arch }) {
  const p = platform === 'wsl' ? 'win32' : platform;
  const a = platform === 'wsl' ? 'x64' : arch;
  return names.filter((n) => APP[p]?.test(n) && n.split(/[-_.]/).some((t) => ARCHES[a]?.includes(t.toLowerCase()))).sort()[0] ?? null;
}

/** name -> sha256 from a SHA256SUMS text. */
export const sumsEntries = (text) => Object.fromEntries(text.split('\n').map((l) => /^([0-9a-f]{64}) {2}(\S+)$/.exec(l)).filter(Boolean).map((m) => [m[2], m[1]]));

// ── Effects ──────────────────────────────────────────────────────────────────

function detectLines(t, platform, env, distros, home) {
  const lines = [];
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec((() => { try { return fssync.readFileSync('/etc/os-release', 'utf8'); } catch { return ''; } })())?.[1];
  if (platform === 'win32') lines.push(t.system(`Windows ${process.arch}${distros.length ? ' + WSL2' : ''}`));
  else if (platform === 'darwin') lines.push(t.system(`macOS ${process.arch}`));
  else lines.push(t.system(platform === 'wsl' ? `Windows + WSL2 (${env.WSL_DISTRO_NAME ?? 'WSL'})` : `Linux ${process.arch}`));
  if (platform === 'win32' && distros.length) lines.push(t.system(`${distros[0]} (WSL2)`));
  if ((platform === 'wsl' || platform === 'linux') && pretty) lines.push(t.system(pretty));
  // The doctor's own lookup (login shell, interactive shell, known install places).
  const deps = maintenance.realDeps({ platform, home });
  for (const [name, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) lines.push(maintenance.agentCli(deps, name, platform, home) ? t.found(label) : t.missing(label));
  return lines;
}

async function wslDistros() {
  try { return parseWslList((await execFile('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 15_000 })).stdout); } catch { return []; }
}

function prompter(t, print) {
  let rl = null;
  const q = async (text) => { rl ??= readline.createInterface({ input: process.stdin, output: process.stdout }); return (await rl.question(`${text} `)).trim().toLowerCase(); };
  return {
    yes: async (text, def) => { const a = await q(`${text} ${t.yesNo(def)}`); return a === '' ? def : a.startsWith('y') || a.startsWith('예'); },
    pick: async (text, options) => {
      print(text);
      options.forEach((label, i) => print(`  ${i + 1}) ${label}`));
      for (;;) { const a = await q(t.choose(options.length)); if (a === '') return 0; const n = Number(a); if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1; }
    },
    close: () => rl?.close(),
  };
}

const exitCode = (cmd, args, opts = {}) => new Promise((resolve) => spawn(cmd, args, { stdio: 'inherit', ...opts }).once('exit', (code) => resolve(code ?? 1)).once('error', () => resolve(-1)));

async function download(url, file, insecureLocalhost) {
  if (!allowedUrl(url, insecureLocalhost)) throw new Error(`refusing ${url}: HTTPS only`);
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!allowedUrl(r.url || url, insecureLocalhost)) throw new Error(`refusing the redirect to ${r.url}: HTTPS only`);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
}

/** Puts a verified desktop installer in place; asks before running anything. Returns where it went. */
async function placeApp(file, name, tmp, ctx) {
  const home = os.homedir();
  if (/\.AppImage$/i.test(name)) { // no sudo: ~/.local/bin/pixel-office is where `open` looks
    const dest = path.join(home, '.local', 'bin', 'pixel-office');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(file, dest); await fs.chmod(dest, 0o755);
    return dest;
  }
  if (!(await ctx.decide(undefined, true, ctx.t.desktopRun(name)))) throw new Error('not run (your answer)');
  if (/\.dmg$/i.test(name)) {
    const mnt = path.join(tmp, 'mnt');
    await execFile('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, file]);
    try {
      const app = (await fs.readdir(mnt)).find((n) => n.endsWith('.app'));
      if (!app) throw new Error(`${name} holds no .app`);
      const dest = path.join(home, 'Applications', app);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await execFile('ditto', [path.join(mnt, app), dest]);
      return dest;
    } finally { await execFile('hdiutil', ['detach', mnt]).catch(() => {}); }
  }
  let exe = file; // NSIS; from WSL it runs on the Windows side, from a Windows folder
  if (ctx.platform === 'wsl') {
    const winTemp = (await execFile('cmd.exe', ['/d', '/c', 'echo %TEMP%'], { cwd: '/mnt/c' })).stdout.trim();
    exe = path.join((await execFile('wslpath', ['-u', winTemp])).stdout.trim(), name);
    await fs.copyFile(file, exe);
  }
  try {
    const code = await exitCode(exe, []);
    if (code !== 0) throw new Error(`${name} exited with ${code}`);
  } finally { if (exe !== file) await fs.rm(exe, { force: true }); }
  return name;
}

async function desktopStep(o, ctx) {
  const { t, print } = ctx;
  const dir = path.dirname(path.resolve(o.bundle));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tycoon-desktop-'));
  try {
    // Signed list only: the same check the manager made for the bundle (made here too: from Windows the bundle may have gone to WSL).
    const listed = sumsEntries(verifySums({ sums: o.sums ?? path.join(dir, 'SHA256SUMS'), sig: o.sig ?? path.join(dir, 'SHA256SUMS.sig'), pubkey: o.pub }).toString('utf8'));
    const name = desktopArtifact(Object.keys(listed), { platform: ctx.platform, arch: process.arch });
    if (!name) { print(t.desktopNone); return; }
    if (!(await ctx.decide(o.gui, desktopDefault(ctx), t.desktopAsk))) { print(t.desktopSkip); return; }
    let file = path.join(dir, name);
    if (!fssync.existsSync(file)) {
      if (!o.baseUrl) throw new Error(`${name} is not beside the bundle`);
      file = path.join(tmp, name);
      await download(`${o.baseUrl}/${name}`, file, o.insecureLocalhost);
    }
    if (sha256File(file) !== listed[name]) throw new Error(`${name}: SHA-256 does not match the signed SHA256SUMS; not run`);
    print(t.desktopDone(await placeApp(file, name, tmp, ctx)));
  } catch (error) {
    print(t.desktopFailed(error.message));
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}

// wsl.exe argv (pure: wizard.test.mjs). `--exec`, never `--`: with `--` the distro's shell re-parses the joined
// line (spaces split, backslashes and quotes eaten, $(...) run); with --exec every value arrives as its own argv element.
export const wslPathArgv = (distro, winPath) => ['-d', distro, '--exec', 'wslpath', '-u', winPath];
const RUN_INSTALLER = 'f=$(wslpath -u "$1") && shift && exec sh "$f" "$@"';
/** The checked install.sh (a Windows path) run inside the distro with the same release and options; `from` = { dir, pub } as WSL paths, for a --from install. */
export function wslInstallArgv(distro, installer, o, from = null) {
  const args = ['--gui', 'no', '--launch', 'no', ...(o.yes ? ['--yes'] : []), ...(o.port ? ['--port', String(o.port)] : []), ...(o.service ? ['--service', o.service] : []), ...(o.addPath ? ['--add-path'] : []), ...(o.startPolicy ? ['--start-policy', o.startPolicy] : []), ...(o.linger ? ['--linger', o.linger] : [])];
  if (o.baseUrl) args.push('--base-url', o.baseUrl, ...(o.insecureLocalhost ? ['--insecure-localhost'] : []));
  else args.push('--from', from.dir, '--pub', from.pub);
  return ['-d', distro, '--exec', 'sh', '-c', RUN_INSTALLER, 'sh', installer, ...args];
}
export const wslOpenArgv = (distro) => ['-d', distro, '--exec', 'sh', '-c', '"${AGENT_TYCOON_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-tycoon}/bin/agty" open'];

/** Windows choosing WSL: the install.sh install.ps1 checked against its stamped hash, run inside the distro (same release, same options); the GUI stays on Windows. */
async function wslInstall(o, distro, ctx) {
  if (!o.wslInstaller) throw new Error(ctx.t.wslNoInstaller);
  const toWsl = async (p) => (await execFile('wsl.exe', wslPathArgv(distro, path.resolve(p)))).stdout.trim();
  const from = o.baseUrl ? null : { dir: await toWsl(path.dirname(o.bundle)), pub: await toWsl(o.pub) };
  ctx.print(ctx.t.wslRun(distro));
  const code = await exitCode('wsl.exe', wslInstallArgv(distro, path.resolve(o.wslInstaller), o, from));
  if (code !== 0) throw new Error(ctx.t.wslFailed(distro, code));
}

export async function main(argv, { env = process.env, print = console.log } = {}) {
  const t = TEXT[lang(env)];
  let o;
  try { o = parseWizardArgs(argv); } catch (error) { console.error(`✖ ${error.message}`); return 2; }
  const mdeps = realDeps();
  const tty = interactive();
  const p = prompter(t, print);
  const ctx = { t, print, env, tty, platform: mdeps.platform, decide: async (flag, def, question) => { const c = choice(flag, def, { yes: o.yes, tty }); return c.ask ? p.yes(question, c.def) : c.value; } };
  try {
    for (const line of t.banner) print(line);
    const distros = ctx.platform === 'win32' && !o.remote ? await wslDistros() : [];
    for (const line of detectLines(t, ctx.platform, env, distros, mdeps.home)) print(line);
    if (!tty && !o.yes) print(t.noTty);
    let where = { kind: o.remote ? 'remote' : 'here' };
    const choices = o.remote ? null : whereChoices({ platform: ctx.platform, distros });
    if (choices) where = choices[!tty || o.yes ? 0 : await p.pick(t.where, choices.map((c) => (c.kind === 'wsl' ? t.whereWsl(c.distro) : c.kind === 'native' ? t.whereNative : t.whereRemote)))];
    if (where.kind === 'remote') { for (const line of t.remote) print(line); return 0; }
    if (where.kind === 'wsl') await wslInstall(o, where.distro, ctx);
    else {
      // H §4.3: the start policy (Linux and WSL; asked here, inside the distro, when Windows hands over to WSL).
      let startPolicy = o.startPolicy;
      if (!startPolicy && tty && !o.yes && ['linux', 'wsl'].includes(ctx.platform)) startPolicy = START_POLICIES[await p.pick(t.policyAsk, [t.policyOnDemand, t.policyAlways, t.policyManual])];
      const systemd = !o.service || o.service === 'systemd' ? fssync.existsSync('/run/systemd/system') : false;
      const linger = startPolicy === 'always' && systemd ? await ctx.decide(o.linger, false, t.lingerAsk) : undefined;
      await install({ from: o.bundle, sums: o.sums, sig: o.sig, pub: o.pub, port: o.port, service: o.service, addPath: o.addPath, installedBy: 'cli', startPolicy, linger }, mdeps);
    }
    await desktopStep(o, ctx);
    // Without a terminal the default is no: a one-time login link must not land in a non-interactive log.
    if (await ctx.decide(o.launch, tty, t.launchAsk)) {
      try {
        if (where.kind === 'wsl') { const code = await exitCode('wsl.exe', wslOpenArgv(where.distro)); if (code !== 0) throw new Error(`exit ${code}`); }
        else await open({ port: o.port }, mdeps);
      } catch (error) { print(t.launchFailed(error.message)); }
    }
    print(t.ready);
    return 0;
  } catch (error) {
    console.error(`✖ ${error.message}`);
    return 1;
  } finally { p.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
