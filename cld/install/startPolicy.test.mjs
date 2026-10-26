// node --test cld/install/startPolicy.test.mjs
// R1 + P6 start policy. Every Windows/WSL/systemd effect goes through a fake runner: nothing here runs
// schtasks, powershell, wsl, systemctl or loginctl for real.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HOLD_CHECK_MS, HOLD_MISSES, install, logonTaskCommand, logonTaskRemoveCommand, main, newRecord, open, readRecord, servicePlan, start, startPolicy, startPolicyPlan, stopDaemon, writeRecord } from './manager.mjs';
import { parseWizardArgs, wslInstallArgv } from './wizard.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `start-policy-${name}-`));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The script a powershell.exe -EncodedCommand argv carries (UTF-16LE base64). */
const decoded = (argv) => {
  assert.deepEqual(argv.slice(0, -1), ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  return Buffer.from(argv.at(-1), 'base64').toString('utf16le');
};

/** A manager install record in a temp HOME, with a service of `kind`. */
async function setup({ platform = 'wsl', kind = 'systemd', extra = {} } = {}) {
  const home = tmp('home');
  const root = path.join(home, 'install');
  fs.mkdirSync(root, { recursive: true });
  const record = { ...newRecord({ root, platform, env: { WSL_DISTRO_NAME: 'Ubuntu-Test' } }), port: 18257, ...extra };
  record.service = { name: 'agent-tycoon', kind, file: null, argv: ['node', 'cli.js'], cwd: root };
  await writeRecord(root, record);
  return { home, root };
}

/** Fake effects: commands and printed lines are recorded; health answers when `up`. */
function fakeDeps(home, { platform = 'wsl', up = false, agents = [], confirm = false, lingered = false } = {}) {
  const runs = [];
  const lines = [];
  const controlCalls = [];
  const state = { up };
  const deps = {
    platform, home, uid: 1000, env: { USER: 'owner', AGENT_TYCOON_ROOT: path.join(home, 'install') },
    print: (line) => lines.push(String(line)),
    run: async (cmd) => { runs.push(cmd); if (cmd.join(' ') === 'systemctl --user start agent-tycoon') state.up = true; return { ok: true, stdout: '', stderr: '' }; },
    health: async () => (state.up ? { service: 'cld-gui', version: '1.0.0', protocol: 1 } : null),
    sleep: async () => {},
    confirm: async () => confirm,
    lingered: () => lingered,
    control: async (cmd) => {
      controlCalls.push(cmd);
      return { ok: true, projects: agents.map((name) => ({ name, state: 'on' })), jobs: [], tasks: [], daemon: { pid: 1, port: 18257, entry: '/nowhere/dist/cli.js' } };
    },
  };
  return { deps, runs, lines, controlCalls, state };
}

test('plan: each policy x platform, exact argv', () => {
  const record = { root: '/home/owner/.local/share/agent-tycoon', wslDistro: 'Ubuntu-Test', service: { name: 'agent-tycoon', kind: 'systemd' } };
  const task = logonTaskCommand({ distro: 'Ubuntu-Test', root: record.root });
  const linger = ['wsl.exe', '-d', 'Ubuntu-Test', '-u', 'root', '--exec', 'loginctl', 'enable-linger', 'owner'];
  const cmds = (o) => startPolicyPlan({ user: 'owner', record, ...o }).map((s) => s.cmd);

  // WSL + systemd
  assert.deepEqual(cmds({ platform: 'wsl', policy: 'on-demand' }), [['systemctl', '--user', 'enable', 'agent-tycoon']]);
  assert.deepEqual(cmds({ platform: 'wsl', policy: 'always' }), [['systemctl', '--user', 'enable', 'agent-tycoon'], task]);
  assert.deepEqual(cmds({ platform: 'wsl', policy: 'always', linger: true }), [['systemctl', '--user', 'enable', 'agent-tycoon'], task, linger]);
  assert.deepEqual(cmds({ platform: 'wsl', policy: 'always', linger: true, lingered: true }), [['systemctl', '--user', 'enable', 'agent-tycoon'], task]); // already on: not ours
  assert.deepEqual(cmds({ platform: 'wsl', policy: 'manual' }), [['systemctl', '--user', 'disable', 'agent-tycoon']]);
  // WSL without systemd (detached daemon): the logon task only
  assert.deepEqual(cmds({ platform: 'wsl', policy: 'always', kind: 'detached', linger: true }), [task]);
  assert.deepEqual(cmds({ platform: 'wsl', policy: 'manual', kind: 'detached' }), []);
  // Linux + systemd: no Windows task; linger only with consent
  assert.deepEqual(cmds({ platform: 'linux', policy: 'always' }), [['systemctl', '--user', 'enable', 'agent-tycoon']]);
  assert.deepEqual(cmds({ platform: 'linux', policy: 'always', linger: true }), [['systemctl', '--user', 'enable', 'agent-tycoon'], ['loginctl', 'enable-linger', 'owner']]);
  assert.deepEqual(cmds({ platform: 'linux', policy: 'manual' }), [['systemctl', '--user', 'disable', 'agent-tycoon']]);

  // Leaving always undoes only what we made; uninstall (policy null) does nothing else.
  const ours = { ...record, logonTask: { name: 'agent-tycoon-wsl-Ubuntu-Test', distro: 'Ubuntu-Test' }, linger: { user: 'owner', distro: 'Ubuntu-Test' } };
  const undo = [logonTaskRemoveCommand({ name: 'agent-tycoon-wsl-Ubuntu-Test', distro: 'Ubuntu-Test' }), ['wsl.exe', '-d', 'Ubuntu-Test', '-u', 'root', '--exec', 'loginctl', 'disable-linger', 'owner']];
  assert.deepEqual(startPolicyPlan({ platform: 'wsl', policy: 'on-demand', record: ours, user: 'owner' }).map((s) => s.cmd), [['systemctl', '--user', 'enable', 'agent-tycoon'], ...undo]);
  assert.deepEqual(startPolicyPlan({ platform: 'wsl', policy: null, record: ours }).map((s) => s.cmd), undo);
  assert.deepEqual(startPolicyPlan({ platform: 'wsl', policy: null, record }).map((s) => s.cmd), []);
});

test('the logon task: hidden holder (wscript + our VBS) running `agty start --hold`, per user, no time limit, no second instance', () => {
  const script = decoded(logonTaskCommand({ distro: 'Ubuntu-Test', root: '/home/owner/.local/share/agent-tycoon' }));
  assert.match(script, /^\$d = \(Join-Path \$env:LOCALAPPDATA 'agent-tycoon'\)$/m);
  assert.match(script, /^\$f = Join-Path \$d 'hold-Ubuntu-Test\.vbs'$/m);
  assert.match(script, /-Execute 'wscript\.exe' -Argument \('\/\/B \/\/Nologo "' \+ \$f \+ '" ' \+ '-d Ubuntu-Test --exec "\/home\/owner\/\.local\/share\/agent-tycoon\/bin\/agty" start --hold'\)/);
  assert.match(script, /-AtLogOn -User "\$env:USERDOMAIN\\\$env:USERNAME"/);
  assert.match(script, /-RestartCount 3 -RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(script, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/); // the 72 h default would end the holder
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /Register-ScheduledTask -TaskName 'agent-tycoon-wsl-Ubuntu-Test' .* -Force/);
  assert.doesNotMatch(script, /shutdown|terminate|RunLevel Highest|wslconfig|vmIdleTimeout/i);
  assert.throws(() => logonTaskCommand({ distro: "x'; Remove-Item", root: '/r' }), /distro name/);
  assert.throws(() => logonTaskCommand({ distro: null, root: '/r' }), /distro name/);

  const removal = decoded(logonTaskRemoveCommand({ name: 'agent-tycoon-wsl-Ubuntu-Test', distro: 'Ubuntu-Test' }));
  assert.match(removal, /Unregister-ScheduledTask -TaskName 'agent-tycoon-wsl-Ubuntu-Test' -Confirm:\$false/);
  assert.match(removal, /Remove-Item -LiteralPath \(Join-Path \$d 'hold-Ubuntu-Test\.vbs'\)/);
  assert.match(removal, /-not \(Get-ChildItem -LiteralPath \$d -Force\)\) \{ Remove-Item -LiteralPath \$d -Force \}/); // the folder only once empty
});

test('the VBS holder: shipped in cld/bin, written verbatim by the task script, hidden window, waits, quotes every argument', () => {
  const vbs = fs.readFileSync(path.join(repo, 'cld/bin/agent-tycoon-hold.vbs'), 'utf8');
  assert.match(vbs, /^cmd = "wsl\.exe"$/m);
  assert.match(vbs, /cmd = cmd & " """ & args\(i\) & """"/);
  assert.match(vbs, /^WScript\.Quit CreateObject\("WScript\.Shell"\)\.Run\(cmd, 0, True\)$/m); // 0: no console window, True: wait
  assert.ok(/^[\x09\x0A\x20-\x7E]*$/.test(vbs), 'ASCII only (Set-Content -Encoding ASCII)');
  const script = decoded(logonTaskCommand({ distro: 'Ubuntu-Test', root: '/r' }));
  const at = script.indexOf("-Value (") + '-Value ('.length;
  const { value, end } = psLiteral(script, at);
  assert.equal(value, vbs);
  assert.ok(script.startsWith(').Replace("`n", "`r`n")', end + 1)); // CRLF for wscript
  assert.match(script, /Set-Content -LiteralPath \$f -Encoding ASCII -NoNewline -Value/);
});

test('EncodedCommand round-trip: the argv decodes to exactly the script, non-ASCII and quotes included', () => {
  const root = '/home/o’brien/é한 "x"'.replaceAll('"', '');
  const argv = logonTaskCommand({ distro: 'Ubuntu-Test', root });
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(argv.at(-1)), 'one base64 argument: nothing for interop to re-quote');
  const script = decoded(argv);
  assert.equal(Buffer.from(script, 'utf16le').toString('base64'), argv.at(-1));
  assert.ok(script.includes(`--exec "${root}/bin/agty" start --hold`.replace('’', '’’')));
});

/** The value of the PowerShell single-quoted literal starting at `at` and where it ends: PowerShell ends it at any of ' \u2018 \u2019 \u201A \u201B, doubled = one. */
function psLiteral(script, at) {
  const q = /['\u2018-\u201B]/;
  let value = '';
  for (let i = at + 1; i < script.length; i += 1) {
    if (!q.test(script[i])) { value += script[i]; continue; }
    if (!q.test(script[i + 1] ?? '')) return { value, end: i };
    value += script[i + 1]; i += 1;
  }
  throw new Error('unterminated');
}

test('the logon task script keeps a hostile install path inside its literal (curly quotes, $, `, ;, &, spaces, non-ASCII)', () => {
  for (const root of ["/home/o'brien/x", '/home/o\u2019brien/x; Remove-Item C:\\ -Recurse #', '/h/a b/$env:X/`whoami`;&|/\u201Bq\u2018/é한']) {
    const script = decoded(logonTaskCommand({ distro: 'Ubuntu-Test', root }));
    const at = script.indexOf(`'" ' + '`) + `'" ' + `.length;
    const { value, end } = psLiteral(script, at);
    assert.equal(value, `-d Ubuntu-Test --exec "${root}/bin/agty" start --hold`);
    assert.ok(script.startsWith(')\n$t = New-ScheduledTaskTrigger', end + 1), `${root}: the literal ends early`);
  }
  // Task Scheduler expands %VAR% in an action's arguments.
  assert.throws(() => logonTaskCommand({ distro: 'Ubuntu-Test', root: '/h/%USERPROFILE%' }), /cannot go in a logon task/);
});

test('start: a detached daemon that is alive but not answering yet is waited for, never killed and replaced', async (t) => {
  const { home, root } = await setup({ kind: 'detached' });
  const record = await readRecord(root); record.service.argv = ['sleep', '5']; await writeRecord(root, record);
  const booting = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'dist/cli.js'], { stdio: 'ignore' });
  t.after(() => booting.kill('SIGKILL'));
  let died = null; booting.on('exit', (code, signal) => { died = signal ?? code; });
  const pidFile = path.join(home, '.config', 'cld-gui', 'daemon.pid');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true }); fs.writeFileSync(pidFile, `${booting.pid}\n`);
  const f = fakeDeps(home);
  let polls = 0; f.deps.health = async () => (++polls > 2 ? { service: 'cld-gui', version: '1.0.0' } : null); // it answers a moment later
  assert.deepEqual(await start({}, f.deps), { ok: true, already: false });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(died, null);
  assert.equal(fs.readFileSync(pidFile, 'utf8'), `${booting.pid}\n`);
});

test('start: does nothing when the daemon answers (never a second daemon); else asks the service once', async () => {
  const { home } = await setup();
  const up = fakeDeps(home, { up: true });
  assert.deepEqual(await start({}, up.deps), { ok: true, already: true });
  assert.deepEqual(up.runs, []);

  const down = fakeDeps(home);
  assert.deepEqual(await start({}, down.deps), { ok: true, already: false });
  assert.deepEqual(down.runs, [['systemctl', '--user', 'start', 'agent-tycoon']]);
  assert.equal(down.deps.env.XDG_RUNTIME_DIR, '/run/user/1000'); // from a logon task there is no login shell
  // A second request (the logon task again, or the app) finds it up.
  await start({}, down.deps);
  assert.equal(down.runs.length, 1);
});

test('start --hold: starts if needed, holds while the daemon answers, exits after it stays down', async () => {
  const { home } = await setup();
  const f = fakeDeps(home);
  const slept = [];
  let checks = 0;
  // Up after the start; one miss (a crash restart) is forgiven; then stopped for good.
  const answers = [true, true, false, true, true, ...Array(HOLD_MISSES).fill(false)];
  f.deps.sleep = async (ms) => { slept.push(ms); };
  f.deps.health = async () => {
    if (!f.runs.length) return null; // down until `systemctl --user start`
    const up = answers[checks] ?? false; checks += 1;
    return up ? { service: 'cld-gui', version: '1.0.0' } : null;
  };
  assert.deepEqual(await start({ hold: true }, f.deps), { ok: true, held: true });
  assert.deepEqual(f.runs, [['systemctl', '--user', 'start', 'agent-tycoon']]);
  assert.equal(slept.filter((ms) => ms === HOLD_CHECK_MS).length, answers.length - 1); // every check after the first answer
  assert.equal(HOLD_CHECK_MS, 60_000);

  // Already up: no start at all, just the hold.
  const up = fakeDeps(home, { up: true });
  let n = 0; up.deps.health = async () => (n++ < 3 ? { service: 'cld-gui' } : null);
  assert.deepEqual(await start({ hold: true }, up.deps), { ok: true, held: true });
  assert.deepEqual(up.runs, []);
  assert.equal((await main(['start', '--hold', '--nope'], up.deps)), 1); // flags are checked
});

test('an agent session cannot set a start policy through install either', async () => {
  const { home, root } = await setup();
  const f = fakeDeps(home);
  f.deps.env.CLD_AGENT_TOKEN = 'agent-token';
  await assert.rejects(install({ from: '/nowhere.tar.gz', startPolicy: 'always' }, f.deps), /에이전트 세션/);
  assert.deepEqual(f.runs, []);
  assert.equal(fs.existsSync(path.join(root, 'manager.lock')), false); // refused before the lock
  assert.equal(await main(['install', '--from', '/nowhere.tar.gz', '--start-policy', 'manual'], f.deps), 1);
  assert.equal((await readRecord(root)).startPolicy, undefined);
});

test('always on WSL: task + consented linger recorded; applying it again is idempotent', async () => {
  const { home, root } = await setup();
  const f = fakeDeps(home, { confirm: true });
  await startPolicy({ policy: 'always' }, f.deps);
  let record = await readRecord(root);
  assert.equal(record.startPolicy, 'always');
  assert.deepEqual(record.logonTask, { name: 'agent-tycoon-wsl-Ubuntu-Test', distro: 'Ubuntu-Test' });
  assert.deepEqual(record.linger, { user: 'owner', distro: 'Ubuntu-Test' });
  assert.equal(f.runs.filter((c) => c.includes('enable-linger')).length, 1);

  await startPolicy({ policy: 'always' }, f.deps);
  record = await readRecord(root);
  assert.equal(f.runs.filter((c) => c.includes('enable-linger')).length, 1); // ours already: not again
  assert.equal(f.runs.filter((c) => c[0] === 'powershell.exe').length, 2); // Register -Force replaces, never duplicates
  assert.deepEqual(record.logonTask, { name: 'agent-tycoon-wsl-Ubuntu-Test', distro: 'Ubuntu-Test' });
});

test('native Windows: changing the policy re-registers the daemon task without stopping it', async () => {
  const { home, root } = await setup({ platform: 'win32', kind: 'schtasks' });
  const record = await readRecord(root);
  record.service.file = 'C:\\AgentTycoon\\bin\\agent-tycoon-daemon.vbs';
  await writeRecord(root, record);
  const f = fakeDeps(home, { platform: 'win32', up: true });

  await startPolicy({ policy: 'always' }, f.deps);
  assert.match(decoded(f.runs.at(-1)), /Register-ScheduledTask .* -Trigger \$t .* -Force/);
  assert.match(decoded(f.runs.at(-1)), /New-ScheduledTaskTrigger -AtLogOn/);

  await startPolicy({ policy: 'on-demand' }, f.deps);
  assert.match(decoded(f.runs.at(-1)), /Register-ScheduledTask .* -Settings \$s -Force/);
  assert.doesNotMatch(decoded(f.runs.at(-1)), /-AtLogOn|-Trigger \$t/);
  assert.deepEqual(f.runs.filter((c) => /\b(stop|restart|kill|--now|\/End|terminate|shutdown)\b/i.test(c.join(' '))), []);
  assert.equal(f.state.up, true);
  assert.equal((await readRecord(root)).startPolicy, 'on-demand');
});

test('linger never without consent: no terminal answer, --no-linger, or already on', async () => {
  for (const [opts, o] of [[{ confirm: false }, {}], [{ confirm: true }, { linger: false }], [{ confirm: true, lingered: true }, {}]]) {
    const { home, root } = await setup({ platform: 'linux', extra: { wslDistro: null } });
    const f = fakeDeps(home, { platform: 'linux', ...opts });
    await startPolicy({ policy: 'always', ...o }, f.deps);
    assert.equal(f.runs.some((c) => c.includes('enable-linger')), false);
    assert.equal((await readRecord(root)).linger, undefined);
  }
});

test('changing the policy never stops the daemon or an agent session (INSTALL-16)', async () => {
  const { home, root } = await setup();
  const f = fakeDeps(home, { up: true, agents: ['alpha', 'beta'], confirm: true });
  for (const policy of ['always', 'manual', 'on-demand', 'always', 'on-demand']) await startPolicy({ policy }, f.deps);
  const stopping = f.runs.filter((c) => /\b(stop|restart|kill|--now|\/End|terminate|shutdown)\b/.test(c.join(' ')));
  assert.deepEqual(stopping, []);
  assert.equal(f.controlCalls.includes('stop-agents'), false);
  assert.equal(f.state.up, true);
  assert.equal((await readRecord(root)).startPolicy, 'on-demand');
  await assert.rejects(startPolicy({ policy: 'sometimes' }, f.deps), /on-demand, always, manual/);
  f.deps.env.CLD_AGENT_TOKEN = 't';
  await assert.rejects(startPolicy({ policy: 'manual' }, f.deps), /에이전트 세션/);
});

test('open: on-demand starts a stopped daemon; manual does not', async () => {
  const { home, root } = await setup();
  const f = fakeDeps(home);
  f.deps.spawnDetached = async () => true;
  f.deps.home = home;
  // open needs the host token for the login link; the start is what this test is about.
  await open({ port: 18257 }, f.deps).catch(() => {});
  assert.deepEqual(f.runs[0], ['systemctl', '--user', 'start', 'agent-tycoon']);

  const record = await readRecord(root); record.startPolicy = 'manual'; await writeRecord(root, record);
  const m = fakeDeps(home);
  await assert.rejects(open({ port: 18257 }, m.deps), /manual: agty start/);
  assert.deepEqual(m.runs, []);
});

test('stop --daemon: warns while agents run, stops only after yes', async () => {
  const { home, root } = await setup();
  const record = await readRecord(root); record.current = '1.0.0'; await writeRecord(root, record);
  const entry = path.join(root, 'versions', '1.0.0', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '');
  const status = (f) => { f.deps.control = async () => ({ ok: true, projects: [{ name: 'alpha', state: 'on' }], jobs: [], tasks: [], daemon: { pid: 1, port: 18257, entry } }); return f; };

  const no = status(fakeDeps(home, { up: true, confirm: false }));
  assert.equal((await stopDaemon({}, no.deps)).code, 3);
  assert.deepEqual(no.runs, []);
  assert.ok(no.lines.some((l) => l.includes('session:alpha')));

  const yes = status(fakeDeps(home, { up: true, confirm: false }));
  assert.equal((await stopDaemon({ yes: true }, yes.deps)).code, 0);
  assert.deepEqual(yes.runs, [['systemctl', '--user', 'stop', 'agent-tycoon']]);
});

test('manual survives an install/update: activate does not re-enable the unit', () => {
  const s = { name: 'agent-tycoon' };
  assert.ok(servicePlan('systemd', 'activate', s).some((step) => step.cmd.includes('enable')));
  assert.ok(!servicePlan('systemd', 'activate', { ...s, autostart: false }).some((step) => step.cmd.includes('enable')));
});

test('CLI: start-policy shows and changes; install and the wizard take --start-policy', async () => {
  const { home, root } = await setup();
  const f = fakeDeps(home);
  assert.equal(await main(['start-policy'], f.deps), 0);
  assert.match(f.lines.at(-1), /필요할 때만 \(on-demand\)/);
  assert.equal(await main(['start-policy', 'manual'], f.deps), 0);
  assert.equal((await readRecord(root)).startPolicy, 'manual');
  assert.equal(await main(['start-policy', 'never'], f.deps), 1);
  assert.equal(await main(['install', '--start-policy', 'nope'], f.deps), 1);

  assert.equal(parseWizardArgs(['--bundle', 'b', '--pub', 'p', '--start-policy', 'always', '--linger', 'yes']).startPolicy, 'always');
  assert.throws(() => parseWizardArgs(['--bundle', 'b', '--pub', 'p', '--start-policy', 'often']), /start-policy/);
  assert.throws(() => parseWizardArgs(['--bundle', 'b', '--pub', 'p', '--linger', 'maybe']), /linger/);
  const argv = wslInstallArgv('Ubuntu-Test', 'C:\\i.sh', { startPolicy: 'always', linger: 'yes', baseUrl: 'https://x' });
  assert.deepEqual(argv.slice(argv.indexOf('--start-policy'), argv.indexOf('--start-policy') + 4), ['--start-policy', 'always', '--linger', 'yes']);
});

test('no `wsl --shutdown` anywhere in product code (F-24)', () => {
  // Any non-comment line naming --shutdown fails (an argv element, one command string, a script in a template),
  // except guidance a person reads. Every script folder is scanned, the installer and helper scripts too.
  const GUIDANCE = new Set(['server/src/cld/remote/net.ts']); // the mirrored-networking how-to
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'target', 'dist', 'docs'].includes(e.name)) walk(full); } else if (/\.(m?js|cjs|ts|tsx|rs|ps1|sh|cmd|bat)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(full);
    }
  };
  for (const dir of ['cld', 'server/src', 'adapters', 'webview-ui/src']) if (fs.existsSync(path.join(repo, dir))) walk(path.join(repo, dir));
  for (const name of ['cld-gui', 'cld-gui-login']) files.push(path.join(repo, 'cld/bin', name));
  assert.ok(files.some((f) => f.endsWith(path.join('cld', 'install', 'install.ps1'))) && files.some((f) => f.endsWith(path.join('cld', 'scripts', 'connect.ps1'))));
  for (const file of files) {
    if (GUIDANCE.has(path.relative(repo, file).split(path.sep).join('/'))) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*(#|\/\/|\*|\/\*|rem\b)/i.test(line)) continue;
      assert.doesNotMatch(line, /--shutdown/, `${file}: runs wsl --shutdown?`);
    }
  }
});
