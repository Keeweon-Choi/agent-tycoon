/**
 * The INSTALL scenario harness (e2e-mvp-plan INSTALL, H §9, roadmap P8): the real install.sh, wizard and manager
 * run end to end, each scenario in its own temp HOME with its own port (18256-18259), on a clean environment:
 *
 *   PATH  = <fakebin>:<toolbin>   fakebin: fake.sh under every outside command the installer could reach
 *                                 (systemctl, loginctl, wsl.exe, powershell.exe, schtasks, cmd.exe, wslpath,
 *                                 explorer.exe, xdg-open, sudo, crontab, claude, codex, ...); toolbin: links to
 *                                 the plain tools it needs (sh, tar, gzip, openssl, sha256sum, ...). /usr/bin and
 *                                 the Windows PATH are not on it, so nothing else can be found.
 *   HOME, TMPDIR, XDG_RUNTIME_DIR, AT_TEST_CTL under the scenario folder; XDG_DATA_HOME and AGENT_TYCOON_ROOT unset;
 *   WSL_DISTRO_NAME=AtTest; no WSL_INTEROP; processes start in their own session (no terminal to ask on).
 *
 * The bundle is built here, offline: the manager exactly as build.mjs packs it (cld/install, cld/bin, verify.mjs,
 * the two core modules) with a fake daemon as dist/cli.js (fake/daemon.cjs) and, as its private Node, a two-line
 * script that runs this Node. Signed with a key made for the run. What runs for real: install.sh (SHA-256, openssl
 * signature check, unpack), the wizard, the manager's verify/unpack/self-test/record/service/update/uninstall.
 * What is fake: the daemon, the service manager and every Windows/WSL command (their argv is in calls.log).
 *
 * Cleanup kills only processes whose command line names the scenario folder (all of them started here).
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { writeSumsAndSign } from '../../release/bundle/sign.mjs';
import { currentOs, sha256File } from '../../release/bundle/verify.mjs';
import { snapshot, tree } from './invariants.mjs';

export { snapshot, tree };
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..', '..');
/** The install script under test; the negative control points this at a copy with a check removed. */
export const INSTALL_SH = process.env.AT_INSTALL_SH ? path.resolve(process.env.AT_INSTALL_SH) : path.join(REPO, 'cld', 'install', 'install.sh');
export const PORTS = [18256, 18257, 18258, 18259];
export const OS = currentOs();
export const ARCH = process.arch;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'at-install-suite-'));
const keyPair = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); return { privateKey, pem: publicKey.export({ type: 'spki', format: 'pem' }) }; };
/** The release key of this run, and another one (a signature by it is a forged release). */
export const KEY = keyPair();
export const EVIL = keyPair();
export const PUB = path.join(suite, 'agent-tycoon-release.pub');
fs.writeFileSync(PUB, KEY.pem);

const FAKES = ['systemctl', 'loginctl', 'journalctl', 'crontab', 'launchctl', 'wsl', 'wsl.exe', 'powershell', 'powershell.exe', 'pwsh', 'schtasks', 'schtasks.exe', 'cmd.exe', 'reg.exe', 'netsh', 'netsh.exe', 'explorer.exe', 'xdg-open', 'open', 'wslpath', 'sudo', 'tailscale', 'cloudflared', 'hdiutil', 'ditto', 'claude', 'codex'];
const TOOLS = ['sh', 'bash', 'dash', 'env', 'cat', 'cp', 'mv', 'rm', 'ln', 'mkdir', 'rmdir', 'ls', 'chmod', 'readlink', 'dirname', 'basename', 'sed', 'grep', 'cut', 'tr', 'head', 'tail', 'sort', 'wc', 'tar', 'gzip', 'zstd', 'sha256sum', 'openssl', 'mktemp', 'uname', 'id', 'sleep', 'kill', 'setsid', 'date', 'touch', 'stat', 'cmp', 'curl', 'tty', 'expr', 'awk', 'find', 'script', 'timeout', 'du', 'ss'];
const toolbin = path.join(suite, 'toolbin');
fs.mkdirSync(toolbin);
for (const t of TOOLS) {
  const found = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((d) => path.join(d, t)).find((p) => fs.existsSync(p));
  if (found) fs.symlinkSync(found, path.join(toolbin, t));
}

// ── Releases ─────────────────────────────────────────────────────────────────

/** The manager files a bundle carries (build.mjs step 2, same list). */
function managerFiles() {
  const install = fs.readdirSync(path.join(REPO, 'cld', 'install')).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map((f) => `cld/install/${f}`);
  const bin = fs.readdirSync(path.join(REPO, 'cld', 'bin')).filter((f) => !f.endsWith('.test.mjs')).map((f) => `cld/bin/${f}`);
  return [...install, ...bin, 'cld/release/bundle/verify.mjs', 'core/src/exposureLedger.mjs', 'core/src/remoteSetupPlan.mjs', 'package.json'];
}

/**
 * One release folder (as `gh release download` gives it): the bundle for this machine, SHA256SUMS, its signature.
 * o: dataSchema, protocol, manifestVersion (a manifest that disagrees with the file name), target (another os-arch),
 * key (who signs), extra ({ name: [content, mode] } more release files, signed too), files ({ rel: content } in the bundle).
 */
export function release(version, o = {}) {
  const dir = fs.mkdtempSync(path.join(suite, `release-${version}-`));
  const stage = fs.mkdtempSync(path.join(suite, 'stage-'));
  const put = (rel, content, mode = 0o644) => { const f = path.join(stage, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content, { mode }); };
  for (const rel of managerFiles()) put(rel, fs.readFileSync(path.join(REPO, rel)), fs.statSync(path.join(REPO, rel)).mode & 0o777);
  // The one production module the manager's own steps load (the QR of a headless `open`); the daemon's are not needed.
  fs.cpSync(path.join(REPO, 'node_modules', 'uqr'), path.join(stage, 'node_modules', 'uqr'), { recursive: true, dereference: true });
  put('node/bin/node', `#!/bin/sh\n# test bundle: the private Node is this run's Node\nexec '${process.execPath}' "$@"\n`, 0o755);
  put('dist/cli.js', fs.readFileSync(path.join(here, 'fake', 'daemon.cjs')));
  put('cld/release/version.json', JSON.stringify({ version, minApp: version, maxApp: null, dataSchema: o.dataSchema ?? { 'projects.json': 2 } }));
  for (const [rel, content] of Object.entries(o.files ?? {})) put(rel, content); // a doctored bundle
  const files = {};
  for (const e of fs.readdirSync(stage, { recursive: true, withFileTypes: true })) if (e.isFile()) files[path.relative(stage, path.join(e.parentPath, e.name))] = sha256File(path.join(e.parentPath, e.name));
  const [tOs, tArch] = (o.target ?? `${OS}-${ARCH}`).split('-');
  put('manifest.json', JSON.stringify({ name: 'agent-tycoon-daemon', version: o.manifestVersion ?? version, protocol: o.protocol ?? 1, dataSchema: o.dataSchema ?? { 'projects.json': 2 }, minApp: version, maxApp: null, os: tOs, arch: tArch, node: { version: process.versions.node, path: 'node/bin/node' }, entry: 'dist/cli.js', files }, null, 2));
  const name = `agent-tycoon-daemon-${version}-${tOs}-${tArch}.tar.gz`;
  const tar = path.join(suite, `${path.basename(stage)}.tar`);
  const r = spawnSync('tar', ['-cf', tar, ...fs.readdirSync(stage).sort()], { cwd: stage });
  if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
  fs.writeFileSync(path.join(dir, name), zlib.gzipSync(fs.readFileSync(tar)));
  fs.rmSync(tar); fs.rmSync(stage, { recursive: true });
  for (const [n, [content, mode]] of Object.entries(o.extra ?? {})) fs.writeFileSync(path.join(dir, n), content, { mode: mode ?? 0o644 });
  writeSumsAndSign(dir, [name, ...Object.keys(o.extra ?? {})], (o.key ?? KEY).privateKey);
  fs.rmSync(path.join(dir, 'agent-tycoon-release.pub')); // a release folder carries no key you should trust
  return { dir, bundle: path.join(dir, name), name, version };
}

// ── Scenarios ────────────────────────────────────────────────────────────────

const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

/** The pids of every process whose command line names `dir` (started by this scenario). */
export function processesUnder(dir) {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (cmd.includes(dir) && Number(pid) !== process.pid) out.push({ pid: Number(pid), cmd: cmd.split('\0').join(' ') });
  }
  return out;
}

export async function scenario(name, { agents = true } = {}) {
  let port = null;
  for (const p of PORTS) if (await portFree(p)) { port = p; break; }
  if (!port) throw new Error(`no free test port in ${PORTS.join(', ')}`);
  const base = fs.mkdtempSync(path.join(suite, `${name}-`));
  const dirs = Object.fromEntries(['home', 'ctl', 'tmp', 'fakebin', 'run'].map((d) => [d, path.join(base, d)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { mode: 0o700 });
  for (const f of FAKES) if (agents || !['claude', 'codex'].includes(f)) fs.symlinkSync(path.join(here, 'fake', 'fake.sh'), path.join(dirs.fakebin, f));
  const home = dirs.home;
  const root = path.join(home, '.local', 'share', 'agent-tycoon');
  const env = { HOME: home, USER: 'attest', LOGNAME: 'attest', SHELL: '/bin/bash', LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: dirs.tmp, XDG_RUNTIME_DIR: dirs.run, AT_TEST_CTL: dirs.ctl, WSL_DISTRO_NAME: 'AtTest', PATH: `${dirs.fakebin}:${toolbin}` };

  /**
   * Runs a command in the scenario (own session, clean env); resolves { code, out, err, pid }. `opts.child` gets the
   * ChildProcess; `opts.input` is written at once, `opts.answers` ([[/prompt/, 'reply\n'], ...]) one by one as each prompt shows.
   */
  const run = (cmd, args = [], opts = {}) => new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? home, env: { ...env, ...opts.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    opts.child?.(child);
    let out = ''; let err = '';
    const answers = [...(opts.answers ?? [])];
    let seen = 0;
    child.stdout.on('data', (d) => {
      out += d;
      if (answers.length && answers[0][0].test(out.slice(seen))) { seen = out.length; child.stdin.write(answers.shift()[1]); if (!answers.length) child.stdin.end(); }
    });
    child.stderr.on('data', (d) => { err += d; });
    if (!answers.length) child.stdin.end(opts.input ?? '');
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout ?? 90_000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? signal, out, err, pid: child.pid }); });
  });

  const s = {
    name, base, home, root, port, env, ctl: dirs.ctl, run,
    /** install.sh --from <release> --pub <key>, non-interactive on this scenario's port unless `defaults: false`. */
    installSh: (rel, extra = [], { defaults = true, ...opts } = {}) => run('sh', [INSTALL_SH, '--from', rel.dir, '--pub', opts.pub ?? PUB, ...(defaults ? ['--yes', '--gui', 'no', '--launch', 'no', '--port', String(port)] : []), ...extra], opts),
    /** The installed CLI (root/bin/agty), as a user runs it. */
    agty: (args, opts) => run(path.join(root, 'bin', 'agty'), args, opts),
    record: () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'install.json'), 'utf8')); } catch { return null; } },
    /** Every outside command the installer ran: [name, ...argv]. */
    calls: () => { try { return fs.readFileSync(path.join(dirs.ctl, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')); } catch { return []; } },
    health: async () => { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) }); return r.ok ? await r.json() : null; } catch { return null; } },
    /** Running fake daemons of this scenario (not self-tests). */
    daemons: () => processesUnder(base).filter((p) => p.cmd.includes('dist/cli.js') && !p.cmd.includes('--self-test')),
    flag: (name, version, content = '') => fs.writeFileSync(path.join(dirs.ctl, `${name}-${version}`), String(content)),
    unflag: (name, version) => fs.rmSync(path.join(dirs.ctl, `${name}-${version}`), { force: true }),
    /** { rel: sha256 } of the regular files under HOME/<rel> (sockets and links left out). */
    files: (rel = '.config/cld-gui') => {
      const dir = path.join(home, rel);
      if (!fs.existsSync(dir)) return null;
      return Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort().map((f) => [path.relative(dir, f), sha(fs.readFileSync(f))]));
    },
    /** A fixed set of user data: ~/.config/cld-gui (projects, tasks, chat), ~/.claude, ~/.codex. */
    seedData: () => {
      const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
      put('.config/cld-gui/projects.json', '{"v":2,"projects":[{"name":"shop","path":"~/work/shop"}]}\n');
      put('.config/cld-gui/tasks.json', '{"v":2,"tasks":[{"id":"T-1","title":"keep me"}]}\n');
      put('.config/cld-gui/groups/team.jsonl', '{"from":"boss","text":"hello"}\n');
      put('.config/cld-gui/passkeys.json', '{"keys":["test"]}\n');
      put('.claude/settings.json', '{"theme":"dark"}\n');
      put('.claude/projects/-work-shop/s1.jsonl', '{"type":"user"}\n');
      put('.codex/config.toml', 'model = "test"\n');
      put('.codex/sessions/2026/s.jsonl', '{}\n');
    },
    async cleanup() {
      for (const p of processesUnder(base)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
      for (let i = 0; i < 20 && processesUnder(base).length; i += 1) await sleep(100);
      if (!process.env.AT_KEEP) fs.rmSync(base, { recursive: true, force: true });
    },
  };
  return s;
}

/**
 * A release folder over plain HTTP on 127.0.0.1 (an ephemeral port): the URL form of `agty update --from`.
 * `cut`: a file name whose download breaks off halfway (the network goes away).
 */
export async function serve(dir, { cut = null } = {}) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Length': body.length });
    if (path.basename(file) === cut) { res.write(body.subarray(0, body.length >> 1)); setTimeout(() => res.socket.destroy(), 50); return; }
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

/** Waits until fn() is truthy (polls every 100 ms). */
export async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out after ${ms} ms`); await sleep(100); }
}

process.on('exit', () => { if (!process.env.AT_KEEP) fs.rmSync(suite, { recursive: true, force: true }); });
