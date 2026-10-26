#!/usr/bin/env node
/*
 * Fake `claude` for the built-in engine (T-0018). It keeps Claude Code's
 * on-disk shape under $HOME (the engine runs claude with a clean env; HOME
 * and PATH survive):
 *   .claude/jobs/<id>/state.json  a background job {sessionId, name, cwd, respawnFlags, state, pid}
 *   .claude/sessions/<pid>.json   a running job's session file; pid = a detached `sleep`
 *   fake-claude.log               one JSON line per call: {argv, cwd, env names, t}
 * Commands, the way 2.1.306 does them (cld/tasks/progress/T-0018.md):
 *   --bg [-n NAME] [--resume SID] [flags]  "backgrounded · <id> · <name>". --resume
 *       continues the job in place only without other flags (flags: a copy under a
 *       new id, said on stderr); a conversation running anywhere is copied too;
 *       a name a running job has gets " (2)"; a folder with .fake-untrusted is
 *       refused ("Workspace not trusted"), nothing started.
 *   agents --json   rows of jobs not stopped, without a pid (also after a "reboot"),
 *                   state `done` (`blocked` with a file fake-blocked-<id>; with fake-perm-<id>
 *                   also waitingFor `permission prompt`),
 *                   and of live interactive session files
 *   stop|kill <id>  stops a running job (the job stays)
 *   attach <id>     resumes a stopped job, like Claude; then ./session-tui.cjs (T-0019:
 *                   the input line cld-gui send types into)
 *   rm <id>         removes a job
 *   (no arguments, or the trust run's --settings … --strict-mcp-config)
 *                   interactive: ./trust-tui.cjs, the folder-trust dialog (AUTO-TRUST)
 * A "reboot" is killing the sleeps (testHome.killFakeSessions): files stay.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOME = process.env.HOME;
// A version probe (agentCli's findClaude, CLAUDE-VERIFY) reads and writes nothing: answered
// before the HOME guard and the call log, so a plain office's probe and every test's call list stay as they were.
if (process.argv[2] === '--version') {
  process.stdout.write('2.1.308 (Claude Code)\n');
  process.exit(0);
}
// Only in a test HOME (testHome.makeEngineHome): never read or write a real one.
// $HOME/bin/claude is a link to this file, or (run-clean-env: no node on PATH) a
// small wrapper that names it.
let ours = false;
try {
  // Windows: no symlinks without admin, so testHome writes bin/claude.cmd naming this file.
  const bin = path.join(HOME, 'bin', process.platform === 'win32' ? 'claude.cmd' : 'claude');
  const self = fs.realpathSync(__filename);
  ours =
    fs.realpathSync(bin) === self ||
    (fs.statSync(bin).size < 1024 && fs.readFileSync(bin, 'utf8').includes(self));
} catch {
  /* no link */
}
if (!ours) {
  process.stderr.write(`fake claude: ${HOME} is not a test HOME\n`);
  process.exit(3);
}
const jobsDir = path.join(HOME, '.claude', 'jobs');
const sessDir = path.join(HOME, '.claude', 'sessions');
const args = process.argv.slice(2);
let stdin = '';
if (args[0] === '--bg') {
  try {
    stdin = fs.readFileSync(0, 'utf-8');
  } catch {
    /* the engine deliberately gives a background start no input */
  }
}
fs.appendFileSync(
  path.join(HOME, 'fake-claude.log'),
  `${JSON.stringify({ argv: args, cwd: process.cwd(), env: Object.keys(process.env).sort(), stdin, t: Date.now() })}\n`,
);

const out = (s) => process.stdout.write(`${s}\n`);
const fail = (s, code = 1) => {
  process.stderr.write(`${s}\n`);
  process.exit(code);
};
if (args[0] === '--help') {
  out("--model <model> aliases: 'opus', 'sonnet', 'haiku'; full: 'claude-opus-4-5'");
  out('--effort <level> (low, medium, high, xhigh, max)');
  out('--permission-mode <mode>  Permission mode to use for the session (choices: "acceptEdits", "default", "plan")');
  process.exit(0);
}
const jobFile = (id) => path.join(jobsDir, id, 'state.json');
const readJob = (id) => {
  try {
    return JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
  } catch {
    return null;
  }
};
const writeJob = (id, job) => {
  fs.mkdirSync(path.dirname(jobFile(id)), { recursive: true });
  fs.writeFileSync(jobFile(id), JSON.stringify(job));
};
const jobs = () => {
  try {
    return fs
      .readdirSync(jobsDir)
      .map((id) => [id, readJob(id)])
      .filter(([, j]) => j);
  } catch {
    return [];
  }
};
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const procStart = (pid) => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
};
const sessionFiles = () => {
  try {
    return fs
      .readdirSync(sessDir)
      .map((f) => JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')))
      .filter((s) => alive(s.pid));
  } catch {
    return [];
  }
};

/** Start a job's process and write its session file. */
function run(id, job) {
  // The session's process: it ends with its test HOME (an hour at most), so a test that
  // never stops it leaks nothing for long (10-24: dozens of day-long sleeps were left over).
  // HOME is in its argv too: without /proc (macOS) `ps` tells a test which home it is of.
  // Windows has no sh: the same loop in Node (cwd outside HOME, so the HOME can be removed).
  const child =
    process.platform === 'win32'
      ? spawn(
          process.execPath,
          ['-e', 'let i=0;const t=setInterval(()=>{if(!require("fs").existsSync(process.argv[2])||++i>=720)clearInterval(t)},5000)', 'fake-claude-session', HOME],
          { detached: true, stdio: 'ignore', cwd: require('os').tmpdir(), windowsHide: true },
        )
      : spawn(
          'sh',
          ['-c', 'i=0; while [ -d "$1" ] && [ $i -lt 720 ]; do sleep 5; i=$((i+1)); done', 'fake-claude-session', HOME],
          { detached: true, stdio: 'ignore' },
        );
  child.unref();
  const pid = child.pid;
  fs.mkdirSync(sessDir, { recursive: true });
  const startedAt = Date.now();
  fs.writeFileSync(
    path.join(sessDir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: job.sessionId,
      cwd: job.cwd,
      startedAt,
      procStart: procStart(pid),
      kind: 'bg',
      name: job.name,
      jobId: id,
      status: 'idle',
    }),
  );
  writeJob(id, { ...job, state: 'working', pid, startedAt });
}

function halt(id, job) {
  if (alive(job.pid)) process.kill(job.pid, 'SIGTERM');
  fs.rmSync(path.join(sessDir, `${job.pid}.json`), { force: true });
  writeJob(id, { ...job, state: 'stopped', pid: null });
}

function banner(id, name) {
  out(`backgrounded · ${id}${name ? ` · ${name}` : ''}`);
  for (const [cmd, what] of [
    ['claude agents', 'list sessions'],
    [`claude attach ${id}`, 'open in this terminal'],
    [`claude logs ${id}`, 'show recent output'],
    [`claude stop ${id}`, 'stop this session'],
  ])
    out(`  ${cmd.padEnd(26)}${what}`);
}

function freeName(name) {
  const used = new Set(
    jobs()
      .filter(([, j]) => alive(j.pid))
      .map(([, j]) => j.name),
  );
  if (!used.has(name)) return name;
  for (let n = 2; ; n++) if (!used.has(`${name} (${n})`)) return `${name} (${n})`;
}

function bg(rest) {
  if (fs.existsSync(path.join(process.cwd(), '.fake-untrusted')))
    fail(
      `Workspace not trusted. Run \`claude\` in ${process.cwd()} once and accept the trust prompt, then retry.`,
    );
  let name;
  let resume;
  const own = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-n' || rest[i] === '--name') own.push('-n', (name = rest[++i]));
    else if (rest[i] === '--resume') resume = rest[++i];
    else own.push(rest[i]);
  }
  let copyOf = null;
  if (resume) {
    const id = resume.slice(0, 8);
    const job = readJob(id);
    if (sessionFiles().some((s) => s.sessionId === resume)) copyOf = id;
    else if (job && own.length) copyOf = id;
    else if (job) return (run(id, job), banner(id, job.name));
    else {
      const j = {
        sessionId: resume,
        name: freeName(name ?? id),
        cwd: process.cwd(),
        respawnFlags: own,
      };
      return (run(id, j), banner(id, j.name));
    }
  }
  const sessionId = crypto.randomUUID();
  const id = sessionId.slice(0, 8);
  const j = { sessionId, name: freeName(name ?? id), cwd: process.cwd(), respawnFlags: own };
  run(id, j);
  if (copyOf)
    process.stderr.write(
      `note: background session ${copyOf} keeps its own saved options, so the flags you passed started a copy as ${id}.\n`,
    );
  banner(id, j.name);
}

/**
 * ENV-2: like Claude Code, run the status line of `--settings` once the session
 * is up, with the session JSON on stdin. Its rate_limits come from
 * $HOME/fake-rate-limits.json when that file exists (an API-key account has none).
 */
function statusLine(rest) {
  const at = rest.indexOf('--settings');
  if (at < 0) return;
  let settings;
  try {
    settings = JSON.parse(rest[at + 1]);
  } catch {
    return;
  }
  const command = settings.statusLine && settings.statusLine.command;
  if (!command) return;
  let rateLimits;
  try {
    rateLimits = JSON.parse(fs.readFileSync(path.join(HOME, 'fake-rate-limits.json'), 'utf8'));
  } catch {
    /* none */
  }
  const input = {
    cwd: process.cwd(),
    workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
    ...(rateLimits && { rate_limits: rateLimits }),
  };
  const r = spawnSync(command, {
    shell: true,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...(settings.env || {}) },
    timeout: 10_000,
  });
  fs.appendFileSync(
    path.join(HOME, 'fake-statusline.log'),
    `${JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr })}\n`,
  );
}

const [cmd, id] = args;
if (cmd === undefined || (cmd === '--settings' && args.includes('--strict-mcp-config'))) {
  // AUTO-TRUST: an interactive `claude` in a folder (./trust-tui.cjs, its own process).
  process.exit(spawnSync(process.execPath, [path.join(__dirname, 'trust-tui.cjs')], { stdio: 'inherit' }).status ?? 0);
} else if (cmd === '--bg') {
  bg(args.slice(1));
  statusLine(args.slice(1));
} else if (cmd === 'agents' && id === '--json') {
  const rows = jobs()
    .filter(([, j]) => j.state !== 'stopped')
    .map(([jid, j]) => ({
      id: jid,
      cwd: j.cwd,
      kind: 'background',
      startedAt: j.startedAt ?? 0,
      sessionId: j.sessionId,
      name: j.name,
      // A file $HOME/fake-blocked-<id>: waiting on a question its terminal shows; fake-perm-<id>:
      // a permission dialog (session-tui.cjs draws it), listed as Claude Code 2.1.31x lists one.
      ...(fs.existsSync(path.join(HOME, `fake-perm-${jid}`))
        ? { state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' }
        : { state: fs.existsSync(path.join(HOME, `fake-blocked-${jid}`)) ? 'blocked' : 'done' }),
      // A running job's pid, as Claude Code lists it (T-0043: 터미널로 보기 attaches only a live one).
      ...(alive(j.pid) && { pid: j.pid }),
    }));
  for (const s of sessionFiles().filter((x) => x.kind === 'interactive'))
    rows.push({
      pid: s.pid,
      cwd: s.cwd,
      kind: 'interactive',
      startedAt: s.startedAt,
      sessionId: s.sessionId,
      name: s.name,
      status: 'idle',
    });
  out(JSON.stringify(rows, null, 2));
} else if (cmd === 'stop' || cmd === 'kill') {
  const job = id && readJob(id);
  if (!job || !alive(job.pid)) fail(`No running background session ${id}`);
  // $HOME/fake-slow-stop: the stop is accepted but the session is slow to exit (a hook shutting down).
  if (!fs.existsSync(path.join(HOME, 'fake-slow-stop'))) halt(id, job);
  out(`Stopped ${id}`);
} else if (cmd === 'rm') {
  const job = id && readJob(id);
  if (!job) fail(`No background session ${id}`);
  if (alive(job.pid)) halt(id, job);
  fs.rmSync(path.join(jobsDir, id), { recursive: true, force: true });
  out(`Removed ${id}`);
} else if (cmd === 'attach') {
  const job = id && readJob(id);
  if (!job) fail(`No background session ${id}`);
  if (!alive(job.pid)) run(id, job);
  const attach = path.join(__dirname, 'session-tui.cjs');
  if (fs.existsSync(attach))
    process.exit(spawnSync(process.execPath, [attach, id], { stdio: 'inherit' }).status ?? 0);
  out(`attached ${id}`);
} else fail(`fake claude: unknown command ${args.join(' ')}`, 2);
