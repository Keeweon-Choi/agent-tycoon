#!/usr/bin/env node
/**
 * The environment invariant checker (H §9, P8): a read-only fingerprint of what an INSTALL test must never
 * change on the real machine, compared before and after a run. It writes only the snapshot file it is given.
 *
 *   node cld/test/install/invariants.mjs snapshot <out.json> [--home DIR] [--no-system]
 *   node cld/test/install/invariants.mjs compare <before.json> [--home DIR] [--no-system]   exit 0 same, 1 changed
 *
 * --home: fingerprint another HOME (the negative control, and the dev-environment check inside scenarios).
 * --no-system: leave out what is not under HOME (crontab, the real daemon's port, systemctl --user, the Windows Path).
 *
 * ~/.config/cld-gui and ~/.pixel-agents are watched by the files an installer writes or deletes (config.json, the
 * folder itself, server.json, the token), not by every file: the real daemon rewrites its own logs and state all the time.
 * ponytail: ~/.claude and ~/.codex are watched by their settings file only; Claude Code rewrites the rest itself.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const REAL_PORT = 18240;
const RC_FILES = ['.bashrc', '.profile', '.bash_profile', '.bash_login', '.zshrc', '.zprofile', '.zshenv', '.npmrc'];
const LOOKUP = 'for c in node npm pnpm yarn claude codex agty cld-gui; do printf "%s=%s\\n" "$c" "$(command -v "$c")"; done; printf "PATH=%s\\n" "$PATH"; printf "node=%s npm=%s\\n" "$(node -v 2>/dev/null)" "$(npm -v 2>/dev/null)"';

function file(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return `link:${fs.readlinkSync(p)}`;
    if (st.isDirectory()) return 'dir';
    return st.isFile() ? `file:${sha(fs.readFileSync(p))}` : 'other';
  } catch { return 'absent'; }
}

/** dev:ino of a folder: a delete-and-recreate or a rename-aside (snapshot restore, reset) changes it. */
function identity(p) { try { const st = fs.lstatSync(p); return `${st.isDirectory() ? 'dir' : 'not-dir'}:${st.dev}:${st.ino}`; } catch { return 'absent'; } }

/** Every entry under `dir` (links not followed): one hash of "rel kind content" lines, and the count. */
export function tree(dir) {
  if (!fs.existsSync(dir)) return 'absent';
  const lines = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { lines.push(`${path.relative(dir, d)} unreadable`); return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) { lines.push(`${rel}/`); walk(full); } else lines.push(`${rel} ${file(full)}`);
    }
  };
  walk(dir);
  return `${lines.length}:${sha(lines.join('\n'))}`;
}

const names = (dir, prefix) => { try { return fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort().join(',') || 'none'; } catch { return 'absent'; } };

function run(cmd, args, { env, cwd, timeout = 15_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, cwd, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return r.error.code === 'ENOENT' ? 'no-command' : `error:${r.error.code}`;
  return `exit=${r.status} ${r.stdout.trim()}`;
}

export function snapshot({ home = os.homedir(), system = true } = {}) {
  const h = (...p) => path.join(home, ...p);
  const out = {};
  for (const rc of RC_FILES) out[`rc ${rc}`] = file(h(rc));
  out['claude settings.json'] = file(h('.claude', 'settings.json'));
  out['codex config.toml'] = file(h('.codex', 'config.toml'));
  out['cld-gui folder'] = identity(h('.config', 'cld-gui'));
  out['cld-gui config.json'] = file(h('.config', 'cld-gui', 'config.json'));
  out['cld-gui daemon.pid'] = file(h('.config', 'cld-gui', 'daemon.pid'));
  out['cld-gui tls'] = names(h('.config', 'cld-gui', 'tls'), '');
  out['~/.config cld-gui*'] = names(h('.config'), 'cld-gui');
  out['pixel-agents folder'] = identity(h('.pixel-agents'));
  for (const f of ['config.json', 'server.json', 'standalone-token']) out[`pixel-agents ${f}`] = file(h('.pixel-agents', f));
  out['pixel-agents layout.json'] = fs.existsSync(h('.pixel-agents', 'layout.json')) ? 'present' : 'absent';
  out['systemd user units'] = tree(h('.config', 'systemd', 'user'));
  out['install root'] = tree(h('.local', 'share', 'agent-tycoon'));
  out['~/.local/share agent-tycoon*'] = names(h('.local', 'share'), 'agent-tycoon');
  for (const n of ['agty', 'cld-gui', 'cld', 'pixel-office']) out[`~/.local/bin/${n}`] = file(h('.local', 'bin', n));
  out['nvm alias'] = tree(h('.nvm', 'alias'));
  out['fnm aliases'] = tree(h('.local', 'share', 'fnm', 'aliases'));
  out['volta user tools'] = tree(h('.volta', 'tools', 'user'));
  // The user's own shell, from a fixed base PATH: what a login (and an interactive) shell finds.
  // MOTD_SHOWN: Ubuntu's update-motd.sh would otherwise print the MOTD and touch ~/.motd_shown once a day.
  const env = { HOME: home, USER: process.env.USER ?? os.userInfo().username, SHELL: '/bin/bash', LANG: 'C.UTF-8', MOTD_SHOWN: '1', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
  const lookup = (flags) => run('bash', [flags, LOOKUP], { env, cwd: home }).replace(/^exit=\d+ /, '').split('\n').filter((l) => /^[a-z-]+=/i.test(l)).join('\n');
  out['login shell'] = lookup('-lc');
  out['interactive shell'] = lookup('-lic');
  out['npm config list'] = sha(run('bash', ['-lic', 'npm config list 2>/dev/null'], { env, cwd: home }));
  if (system) {
    out.crontab = sha(run('crontab', ['-l']));
    // pid of whatever listens on the real daemon's port: a restart (or a second daemon) shows up here.
    out[`port ${REAL_PORT}`] = run('ss', ['-ltnpH', `sport = :${REAL_PORT}`]).replace(/fd=\d+/g, '').split('\n').map((l) => /pid=\d+/.exec(l)?.[0] ?? '').sort().join(',') || 'none';
    for (const s of ['cld-gui', 'agent-tycoon']) out[`systemctl --user ${s}`] = `${run('systemctl', ['--user', 'is-enabled', s])} / ${run('systemctl', ['--user', 'is-active', s])}`;
    const reg = '/mnt/c/Windows/System32/reg.exe';
    if (fs.existsSync(reg)) out['Windows user Path'] = sha(run(reg, ['query', 'HKCU\\Environment', '/v', 'Path']));
  }
  return out;
}

export function diff(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).map((k) => ({ key: k, before: before[k], after: after[k] }));
}

function main(argv) {
  const [cmd, target, ...rest] = argv;
  const opt = (flag) => { const i = rest.indexOf(flag); return i < 0 ? undefined : rest[i + 1]; };
  const o = { home: opt('--home') ? path.resolve(opt('--home')) : os.homedir(), system: !rest.includes('--no-system') };
  if (cmd === 'snapshot' && target) {
    fs.writeFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), ...o, values: snapshot(o) }, null, 2)}\n`);
    console.log(`invariants: snapshot of ${o.home} -> ${target}`);
    return 0;
  }
  if (cmd === 'compare' && target) {
    const before = JSON.parse(fs.readFileSync(target, 'utf8'));
    const changed = diff(before.values, snapshot({ home: before.home ?? o.home, system: before.system ?? o.system }));
    if (!changed.length) { console.log(`invariants: unchanged (${Object.keys(before.values).length} items, ${before.home}, since ${before.at})`); return 0; }
    console.error(`invariants: CHANGED (${changed.length}):`);
    for (const c of changed) console.error(`  ${c.key}: ${c.before} -> ${c.after}`);
    return 1;
  }
  console.error('usage: invariants.mjs snapshot <out.json> [--home DIR] [--no-system] | compare <before.json>');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
