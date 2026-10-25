// INSTALL-9: install and update next to each way a user may have Node: nvm (initialised in .bashrc), fnm, Volta
// and a system Node (fake installs in the temp HOME, with claude and codex installed by that Node's npm). Each time:
// install.sh and the manager never run the user's node, the service runs our private Node and carries the user's
// Node folder on its PATH (so the daemon finds claude), the wizard finds claude and codex, and nothing of the user's
// environment changes (rc files, the Node manager's folders, what a login and an interactive shell find, npm config).
// Homebrew and the Windows npm are manual (install-owner-checklist.md).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { release, scenario, snapshot, tree } from './harness.mjs';

const r1 = release('1.0.0');
const r2 = release('1.1.0');
const NODE = 'v20.11.0';

/** node, npm, claude, codex of one Node install in `bin`; node and npm log their runs as "user-node". */
function nodeInstall(bin) {
  fs.mkdirSync(bin, { recursive: true });
  const logged = (name, out) => `#!/bin/sh\nprintf 'user-node\\t%s\\t%s\\n' "${name}" "$*" >>"$AT_TEST_CTL/calls.log"\n${out}\n`;
  fs.writeFileSync(path.join(bin, 'node'), logged('node', `echo ${NODE}`), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), logged('npm', `case "$*" in 'config get prefix') echo "${path.dirname(bin)}" ;; *) echo 10.2.4 ;; esac`), { mode: 0o755 });
  for (const n of ['claude', 'codex']) fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "9.9.9 (${n} under ${bin})"\n`, { mode: 0o755 });
}

const UBUNTU_BASHRC = '# ~/.bashrc\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\nHISTSIZE=1000\n';
const UBUNTU_PROFILE = '# ~/.profile\nif [ -n "$BASH_VERSION" ]; then\n    if [ -f "$HOME/.bashrc" ]; then\n\t. "$HOME/.bashrc"\n    fi\nfi\n';

/** Each environment: set it up in `home`; returns the Node folder and the PATH entry an install shell has. */
const ENVS = {
  'nvm (initialised in .bashrc)': (home) => {
    const bin = path.join(home, '.nvm', 'versions', 'node', NODE, 'bin');
    nodeInstall(bin);
    fs.writeFileSync(path.join(home, '.nvm', 'nvm.sh'), `export PATH="$NVM_DIR/versions/node/${NODE}/bin:$PATH"\n`);
    fs.mkdirSync(path.join(home, '.nvm', 'alias')); fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), `${NODE}\n`);
    fs.writeFileSync(path.join(home, '.bashrc'), `${UBUNTU_BASHRC}export NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"  # This loads nvm\n`);
    fs.writeFileSync(path.join(home, '.profile'), UBUNTU_PROFILE);
    return { bin, managed: path.join(home, '.nvm') };
  },
  fnm: (home, s) => {
    const inst = path.join(home, '.local', 'share', 'fnm', 'node-versions', NODE, 'installation');
    nodeInstall(path.join(inst, 'bin'));
    fs.mkdirSync(path.join(home, '.local', 'share', 'fnm', 'aliases'), { recursive: true });
    fs.symlinkSync(inst, path.join(home, '.local', 'share', 'fnm', 'aliases', 'default'));
    const shell = path.join(s.env.XDG_RUNTIME_DIR, 'fnm_multishells', '4242_1');
    fs.mkdirSync(path.dirname(shell), { recursive: true }); fs.symlinkSync(inst, shell);
    fs.writeFileSync(path.join(home, '.bashrc'), `${UBUNTU_BASHRC}command -v fnm >/dev/null && eval "$(fnm env --use-on-cd)"\n`);
    fs.writeFileSync(path.join(home, '.profile'), UBUNTU_PROFILE);
    return { bin: path.join(shell, 'bin'), managed: path.join(home, '.local', 'share', 'fnm') };
  },
  Volta: (home) => {
    const bin = path.join(home, '.volta', 'bin');
    nodeInstall(bin);
    fs.mkdirSync(path.join(home, '.volta', 'tools', 'user'), { recursive: true });
    fs.writeFileSync(path.join(home, '.volta', 'tools', 'user', 'platform.json'), `{"node":{"runtime":"${NODE.slice(1)}"}}\n`);
    fs.writeFileSync(path.join(home, '.profile'), `${UBUNTU_PROFILE}export VOLTA_HOME="$HOME/.volta"\nexport PATH="$VOLTA_HOME/bin:$PATH"\n`);
    return { bin, managed: path.join(home, '.volta') };
  },
  'system Node': (home, s) => {
    const bin = path.join(s.base, 'sys', 'usr', 'bin'); // stands in for /usr/bin
    nodeInstall(bin);
    fs.writeFileSync(path.join(home, '.bashrc'), UBUNTU_BASHRC);
    fs.writeFileSync(path.join(home, '.profile'), UBUNTU_PROFILE);
    return { bin, managed: bin };
  },
};

const devenv = (home) => Object.fromEntries(Object.entries(snapshot({ home, system: false })).filter(([k]) => /^(rc |claude|codex|nvm|fnm|volta|login|interactive|npm)/.test(k)));
const servicePath = (s) => /^Environment=PATH=(.*)$/m.exec(fs.readFileSync(path.join(s.home, '.config/systemd/user/agent-tycoon.service'), 'utf8'))[1].split(':');

for (const [label, setUp] of Object.entries(ENVS)) {
  test(`INSTALL-9 ${label}: install and update use our Node, find claude and codex, change nothing of the user's`, { timeout: 60_000 }, async (t) => {
    const s = await scenario(`i9-${label.split(' ')[0].toLowerCase()}`, { agents: false }); t.after(() => s.cleanup());
    const { bin, managed } = setUp(s.home, s);
    // The shell the user runs the one-line installer from has this Node on PATH (nvm from .bashrc, fnm env, Volta, /usr/bin).
    const shellEnv = { PATH: `${s.env.PATH.split(':')[0]}:${bin}:${s.env.PATH.split(':').slice(1).join(':')}` };
    const before = { env: devenv(s.home), managed: tree(managed) };

    let r = await s.installSh(r1, [], { env: shellEnv });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /✓ Claude Code found/); assert.match(r.out, /✓ Codex found/);
    const unit = fs.readFileSync(path.join(s.home, '.config/systemd/user/agent-tycoon.service'), 'utf8');
    assert.match(unit, new RegExp(`ExecStart=${s.root}/current/node/bin/node `), 'the service runs our private Node');
    assert.ok(servicePath(s).includes(bin), `the service PATH carries ${bin} (claude, codex)`);
    assert.ok(!servicePath(s).some((p) => p.startsWith(s.root)), 'our Node never becomes the agents\' node');

    r = await s.agty(['update', '--from', r2.dir], { env: shellEnv });
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal((await s.health())?.version, '1.1.0');
    assert.ok(servicePath(s).includes(bin), 'still there after the update');

    const ran = s.calls().filter((c) => c[0] === 'user-node');
    assert.deepEqual(ran.filter((c) => c[1] === 'node'), [], 'the user\'s node never ran');
    assert.ok(ran.every((c) => c[1] === 'npm' && c[2] === 'config get prefix'), `only a read of npm's prefix: ${JSON.stringify(ran)}`);
    assert.deepEqual(devenv(s.home), before.env, 'rc files, shells, npm config unchanged');
    assert.equal(tree(managed), before.managed, 'the Node manager\'s folder is unchanged');
  });
}

// The service PATH keeps every Node folder the install recorded: an update run where the user's Node is not on PATH
// (ssh host agty update, cron, the Windows app's `wsl.exe --exec`) merges into the record instead of rebuilding from
// its own PATH; another Node on the updater's PATH is added; a recorded folder without claude/codex now stays and is named.
test('INSTALL-9 nvm: updates from other shells never drop a recorded Node folder from the service PATH', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i9-nvm-noshell', { agents: false }); t.after(() => s.cleanup());
  const { bin } = ENVS['nvm (initialised in .bashrc)'](s.home, s);
  const withNode = (dir) => ({ PATH: `${s.env.PATH.split(':')[0]}:${dir}:${s.env.PATH.split(':').slice(1).join(':')}` });
  let r = await s.installSh(r1, [], { env: withNode(bin) });
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(servicePath(s).includes(bin));
  assert.deepEqual(s.record().service.pathNodeDirs, [bin], 'the install records the Node folder');

  r = await s.agty(['update', '--from', r2.dir]); // PATH without nvm
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(servicePath(s).includes(bin), `the service PATH lost ${bin}: ${servicePath(s).join(':')}`);

  const other = path.join(s.home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin'); // nvm use 22 in another shell
  nodeInstall(other);
  for (const n of ['claude', 'codex']) fs.rmSync(path.join(bin, n)); // and the old version's agents are gone
  r = await s.agty(['update', '--from', release('1.2.0').dir], { env: withNode(other) });
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.out.includes(`! ${bin} (recorded at install) has no claude or codex now; kept on the service PATH`), r.out);
  assert.deepEqual(servicePath(s).filter((p) => p.includes('.nvm')), [bin, other], 'merged: the recorded folder first, the new one added');
  assert.deepEqual(s.record().service.pathNodeDirs, [bin, other]);
});
