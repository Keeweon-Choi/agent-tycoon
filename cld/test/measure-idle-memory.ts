/**
 * MEM-IDLE: the daemon's memory with a huge live transcript, before any viewer
 * and with one. Runs a built cli.js against a temp HOME holding one live
 * interactive Claude session (a `sleep` stands in for its process) whose
 * synthetic transcript is shaped like the 11-03 orchestrator's (~90 MB: user
 * tool results with ~1 MB base64 images, `api-request-blob` records of ~1 MB,
 * `message`, `api-request`, `attachment`, `last-prompt` records) plus one
 * running background sub-agent (a sidecar under <session>/subagents/, so the
 * start recovers it). Nothing from a real transcript is read or copied.
 *
 * Reports, from /proc/<daemon>/status:
 * - start peak: VmHWM after the start settles (peak since exec);
 * - idle: VmRSS after `--idle-seconds` with no viewer;
 * - viewer: VmRSS and VmHWM (reset when the viewer connects) after one
 *   headless Chromium (--disable-gpu) has been connected `--view-seconds`.
 *
 *   nice -n 10 npx tsx cld/test/measure-idle-memory.ts \
 *     [--cli dist/cli.js] [--port 18298] [--idle-seconds 180] [--view-seconds 30] \
 *     [--after-seconds 60] [--mb 90] [--sessions 1] [--history 3] [--heap-snapshot <dir>] [--node-flags a,b]
 *     [--installed-env on|off]
 *
 * While viewed, `--history` pages of the first session's chat are asked for, as the
 * messenger does when scrolled back. Then the viewer leaves and RSS is read again `--after-seconds` later.
 * --heap-snapshot: the daemon runs with --heapsnapshot-signal=SIGUSR2 and gets
 * one at idle and one while viewed, written into <dir> (to see what stays).
 * --node-flags: extra flags for the daemon's node (e.g. --cpu-prof,--cpu-prof-dir=<dir>).
 * A hard deadline and SIGINT/SIGTERM/SIGHUP kill the daemon and the sleep.
 */
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
// The node flags and environment the installer deploys the daemon with.
import { DAEMON_ENV, NODE_FLAGS } from '../install/install.mjs';
import {
  assertPortFree,
  daemonLoginUrl,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
} from '../../server/src/cld/testHome.js';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const CLI = path.resolve(arg('cli', path.join(REPO_ROOT, 'dist/cli.js')));
const PORT = Number(arg('port', '18298'));
const IDLE_S = Number(arg('idle-seconds', '180'));
const VIEW_S = Number(arg('view-seconds', '30'));
const TARGET_MB = Number(arg('mb', '90'));
/** Live sessions, each with a TARGET_MB transcript (the first one also has the sub-agent). */
const SESSIONS = Number(arg('sessions', '1'));
const AFTER_S = Number(arg('after-seconds', '60'));
const SNAP_DIR = arg('heap-snapshot', '');
/** History pages the viewer asks for (the messenger scrolled back), 0 for none. */
const HISTORY = Number(arg('history', '3'));
/** Extra node flags for the daemon (e.g. --cpu-prof), comma-separated. */
const EXTRA_NODE = arg('node-flags', '').split(',').filter(Boolean);
/** --installed-env off: the daemon without the installer's DAEMON_ENV (a build before MEM-IDLE). */
const DEPLOYED_ENV = arg('installed-env', 'on') === 'on' ? DAEMON_ENV : {};
const START_SETTLE_MS = 20_000;
const DEADLINE_MS = (IDLE_S + VIEW_S + AFTER_S) * 1000 + 180_000;
/** fileWatcher adopts a transcript born within 2 scan intervals from its start: wait past it. */
const OLD_TRANSCRIPT_MS = 7_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusMb = (pid: number, key: string): number =>
  Number(
    new RegExp(`${key}:\\s+(\\d+)`).exec(fs.readFileSync(`/proc/${pid}/status`, 'utf-8'))?.[1],
  ) / 1024;
const procStart = (pid: number): string => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
};

/** Session `i`'s id (UUID shaped). */
const sid = (i: number) => `b0000001-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
const SPAWN_TOOL = 'toolu_mem_spawn_1';
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const at = () => new Date(Date.UTC(2026, 10, 3, 9, 0, 0) + seq * 1000).toISOString();
/** Base64-looking filler (never decoded by anyone). */
const b64 = (bytes: number) => 'iVBORw0KGgo'.padEnd(bytes, 'QUFBQUFB');
const usage = {
  input_tokens: 3,
  cache_creation_input_tokens: 2000,
  cache_read_input_tokens: 90_000,
  output_tokens: 200,
};

/** One turn's records, in Claude Code's order; `big` = this turn carries the 1 MB lines. */
function turn(session: string, cwd: string, n: number, big: boolean): string[] {
  const base = {
    sessionId: session,
    cwd,
    version: '2.1.306',
    isSidechain: false,
    userType: 'external',
  };
  const tool = `toolu_mem_${n}`;
  const rec = (r: Record<string, unknown>) =>
    JSON.stringify({ ...base, uuid: uuid(), timestamp: at(), ...r });
  return [
    rec({
      type: 'api-request',
      request: { model: 'claude-opus-4-1', messages: n, pad: 'r'.repeat(1400) },
    }),
    rec({ type: 'api-request-blob', blob: big ? b64(1_100_000) : b64(4_000) }),
    rec({
      type: 'assistant',
      message: {
        id: `msg_${n}`,
        model: 'claude-opus-4-1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: tool,
            name: 'Read',
            input: { file_path: `${cwd}/shot-${n}.png` },
          },
        ],
        usage,
      },
    }),
    rec({ type: 'message', message: { role: 'assistant', text: 'm'.repeat(1800) } }),
    rec({ type: 'message', message: { role: 'user', text: 'u'.repeat(1800) } }),
    rec({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: tool,
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: b64(big ? 1_250_000 : 6_000),
                },
              },
            ],
          },
        ],
      },
    }),
    rec({ type: 'attachment', attachment: { type: 'file', content: 'a'.repeat(500) } }),
  ];
}

/** The ~TARGET_MB live transcript; the last turn leaves a tool open (busy). */
function writeTranscript(file: string, session: string, cwd: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  let bytes = 0;
  const write = (line: string) => {
    fs.writeSync(fd, line + '\n');
    bytes += Buffer.byteLength(line) + 1;
  };
  write(JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: session }));
  for (let n = 0; bytes < TARGET_MB * 1024 * 1024; n++) {
    for (const line of turn(session, cwd, n, n % 20 === 0)) write(line);
    if (n % 50 === 0)
      write(JSON.stringify({ type: 'last-prompt', lastPrompt: 'go on', sessionId: session }));
  }
  write(
    JSON.stringify({
      type: 'assistant',
      sessionId: session,
      uuid: uuid(),
      timestamp: new Date().toISOString(),
      message: {
        model: 'claude-opus-4-1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: SPAWN_TOOL,
            name: 'Agent',
            input: { description: 'mem check', prompt: 'x', run_in_background: true },
          },
        ],
        usage,
      },
    }),
  );
  fs.closeSync(fd);
  return bytes;
}

/** A running background sub-agent: a sidecar with its spawn id and a fresh transcript. */
function writeSubagent(projectDir: string, session: string, cwd: string): string {
  const dir = path.join(projectDir, session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agent-amem1.meta.json'),
    JSON.stringify({
      agentType: 'general-purpose',
      toolUseId: SPAWN_TOOL,
      description: 'mem check',
    }),
  );
  const lines = Array.from({ length: 40 }, (_, n) => turn(session, cwd, 10_000 + n, n === 0))
    .flat()
    .map((l) => l.replace('"isSidechain":false', '"isSidechain":true'));
  const file = path.join(dir, 'agent-amem1.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** Browser code (a string: tsx would wrap named functions in a helper the page lacks): ask
 *  for `n` chat history pages of the contact named like `name` over a second /ws. */
const HISTORY_PAGES = `(n, name) => new Promise((resolve) => {
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
  let agentId = -1;
  let left = n;
  const log = [];
  const ask = (before) => ws.send(JSON.stringify({ type: 'chatHistory', agentId, requestId: 'h' + left, ...(before && { before }) }));
  ws.onopen = () => ws.send(JSON.stringify({ type: 'webviewReady' }));
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'messengerContacts' && agentId < 0) {
      agentId = (m.contacts.find((c) => c.name.includes(name)) ?? m.contacts[0])?.agentId ?? -1;
      if (agentId >= 0) ask();
    } else if (m.type === 'chatHistoryResult') {
      log.push((m.items?.length ?? 0) + ' items' + (m.error ? ' (' + m.error + ')' : '') + (m.done ? ' done' : ''));
      if (--left > 0 && !m.done && m.items?.length) ask(m.items[0].id);
      else { ws.close(); resolve(log.join(', ')); }
    }
  };
  setTimeout(() => resolve('timeout after: ' + log.join(', ') + ' (agent ' + agentId + ')'), 120000);
})`;

async function main(): Promise<void> {
  await assertPortFree(PORT);
  const fake = makeFakeHome({ claude: null });
  const sleeps: ChildProcess[] = [];
  const sessions = path.join(fake.home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  let subagent = '';
  for (let i = 0; i < SESSIONS; i++) {
    const cwd = path.join(fake.home, `work/p${i}`);
    fs.mkdirSync(cwd, { recursive: true });
    const projectDir = path.join(fake.home, '.claude/projects', normalizeProjectPath(cwd));
    const transcript = path.join(projectDir, `${sid(i)}.jsonl`);
    const bytes = writeTranscript(transcript, sid(i), cwd);
    if (i === 0) subagent = writeSubagent(projectDir, sid(i), cwd);
    const holder = spawn('sleep', [String(Math.ceil(DEADLINE_MS / 1000))], { stdio: 'ignore' });
    sleeps.push(holder);
    fs.writeFileSync(
      path.join(sessions, `${holder.pid}.json`),
      JSON.stringify({
        pid: holder.pid,
        sessionId: sid(i),
        cwd,
        startedAt: Date.now() - 3_600_000,
        procStart: procStart(holder.pid!),
        version: '2.1.306',
        kind: 'interactive',
        entrypoint: 'cli',
        name: `p${i}-orchestrator`,
        status: 'busy',
      }),
    );
    console.log(`transcript ${(bytes / 1024 / 1024).toFixed(1)} MB at ${transcript}`);
  }
  await sleep(OLD_TRANSCRIPT_MS);
  // The sub-agent was written just now: keep it "running" (fresh mtime) after the wait too.
  fs.utimesSync(subagent, new Date(), new Date());

  const env = {
    ...process.env,
    ...DEPLOYED_ENV,
    ...fake.env,
    // The fake claude first: the real one must never run here.
    PATH: `${path.dirname(fake.claudePath)}${path.delimiter}${process.env.PATH}`,
  };
  const daemon = spawn(
    process.execPath,
    [
      ...NODE_FLAGS,
      ...EXTRA_NODE,
      ...(SNAP_DIR
        ? ['--heapsnapshot-signal=SIGUSR2', `--diagnostic-dir=${path.resolve(SNAP_DIR)}`]
        : []),
      CLI,
      '--port',
      String(PORT),
      '--no-terminal',
      '--allow-actions',
      '--allow-chat',
      '--engine',
      'on',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  daemon.stdout.on('data', (b: Buffer) => (log += b.toString()));
  daemon.stderr.on('data', (b: Buffer) => (log += b.toString()));
  const pid = daemon.pid!;
  const exited = new Promise((r) => daemon.once('exit', r));
  console.log(`cli ${CLI}\nHOME ${fake.home}\ndaemon pid ${pid} port ${PORT}`);

  const killAll = () => {
    for (const p of [daemon, ...sleeps])
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}\n${log.slice(-3000)}`);
    killAll();
    fs.rmSync(fake.home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const rows: Array<[string, string]> = [];
  const browser = await launchBrowser();
  try {
    await Promise.race([
      daemonLoginUrl(fake.home, PORT, pid),
      exited.then(() => Promise.reject(new Error(`daemon exited\n${log}`))),
    ]);
    await sleep(START_SETTLE_MS);
    rows.push(['start peak (VmHWM)', statusMb(pid, 'VmHWM').toFixed(0)]);
    rows.push([`RSS ${START_SETTLE_MS / 1000} s after start`, statusMb(pid, 'VmRSS').toFixed(0)]);
    await sleep(IDLE_S * 1000 - START_SETTLE_MS);
    rows.push([`idle RSS, no viewer, ${IDLE_S} s`, statusMb(pid, 'VmRSS').toFixed(0)]);
    rows.push(['idle RssAnon', statusMb(pid, 'RssAnon').toFixed(0)]);
    const snapshot = async () => {
      if (!SNAP_DIR) return;
      daemon.kill('SIGUSR2');
      await sleep(10_000);
    };
    await snapshot();

    fs.writeFileSync(`/proc/${pid}/clear_refs`, '5'); // reset VmHWM
    const page = await (await browser.newContext()).newPage();
    const opened = new Promise<void>((resolve) => page.on('websocket', () => resolve()));
    await page.goto(await daemonLoginUrl(fake.home, PORT, pid));
    await opened;
    await sleep(5_000);
    if (HISTORY) {
      // Scroll back like the messenger does: N pages of the first session's chat, in turn.
      const pages = (await page.evaluate(`(${HISTORY_PAGES})(${HISTORY}, 'p0')`)) as string;
      console.log(`history pages: ${pages}`);
    }
    await sleep(VIEW_S * 1000);
    rows.push([`viewer RSS, ${VIEW_S} s`, statusMb(pid, 'VmRSS').toFixed(0)]);
    rows.push(['viewer peak (VmHWM since connect)', statusMb(pid, 'VmHWM').toFixed(0)]);
    await snapshot();
    await page.context().close();
    await sleep(AFTER_S * 1000);
    rows.push([`RSS ${AFTER_S} s after the viewer left`, statusMb(pid, 'VmRSS').toFixed(0)]);
  } finally {
    await browser.close();
    daemon.kill('SIGTERM');
    await Promise.race([exited, sleep(5_000)]);
    killAll();
    clearTimeout(deadline);
  }

  const recovered = log.includes('background agent recovered');
  console.log(
    `\nlog: background agent recovered: ${recovered}; unrecognized-type lines: ${(log.match(/unrecognized record type/g) ?? []).length}`,
  );
  console.log('\n| measure | MB |\n|---|---|');
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
  fs.rmSync(fake.home, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
