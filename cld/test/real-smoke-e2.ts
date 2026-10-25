/**
 * T-0019's one real smoke run (real `claude`, model haiku, at most 2 tiny
 * prompts, a throwaway project in a fresh /tmp folder). Never touches another
 * session: it only lists them. cld-gui's own state (registry, queue, inbox,
 * events, jobs, the local socket) lives in a temp dir; Claude's is the real
 * ~/.claude (its login). Steps:
 *   1. cld-gui send to the project while it is off: the inbox
 *   2. start (engine): the inbox is typed in as the first message (prompt 1)
 *   3. Claude's cross-session socket: a message from a non-session sender to
 *      a bypassPermissions session (the orchestrators' mode) is held, no turn
 *   4. cld-gui send to the live idle session: typed in at once (prompt 2;
 *      skipped if step 3 was delivered after all)
 *   5. renew with typing switched off (no third prompt): the old session is
 *      stopped and gone before the new one starts; no " (2)" name
 *   6. a cld-gui job in its own systemd user scope
 *   7. claude stop, rm, purge; the temp dirs go
 *
 *   npx tsx cld/test/real-smoke-e2.ts --yes-real-claude [--only-live]
 *
 * --only-live skips steps 1 and 3 (a second run: step 3 leaves the session
 * `waiting` on its held message, so nothing is typed into it after).
 */
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { ChatManager } from '../../server/src/cld/chat.js';
import { answerControl, controlPath, listenControl } from '../../server/src/cld/engine/control.js';
import { Engine, renewText } from '../../server/src/cld/engine/engine.js';
import { EngineEvents, eventsPath, shortStamp } from '../../server/src/cld/engine/events.js';
import { jobJson, Jobs } from '../../server/src/cld/engine/jobs.js';
import { Messenger } from '../../server/src/cld/engine/messenger.js';
import { readLiveSessions } from '../../server/src/cld/engine/agents/claude/sessions.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import { REPO_ROOT } from '../../server/src/cld/testHome.js';

if (!process.argv.includes('--yes-real-claude')) {
  console.error('real claude, 2 prompts: pass --yes-real-claude');
  process.exit(2);
}
const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const HOME = os.homedir();
const t0 = Date.now();
const log = (what: string, data?: unknown) =>
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${what}${data === undefined ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data)}`}`,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  fn: () => T | null | undefined | false,
  ms: number,
  every = 300,
): Promise<T | null> {
  for (const end = Date.now() + ms; ;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(every);
  }
}
const claude = (args: string[], cwd = HOME) => {
  const r = spawnSync(CLAUDE, args, {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

async function main() {
  const rand = Math.random().toString(16).slice(2, 6);
  const name = `cld-e2-smoke-${rand}`;
  const folder = fs.mkdtempSync('/tmp/cld-e2-smoke-'); // /tmp: a folder this PC already trusts
  const state = fs.mkdtempSync('/tmp/cld-e2-state-'); // cld-gui's own files
  const outside = fs.mkdtempSync('/tmp/cld-e2-cwd-');
  log('smoke', { name, folder, state, claude: claude(['--version']).out });
  log('before: claude daemon status', claude(['daemon', 'status']).out.split('\n')[0]);
  log(
    'before: live bg sessions (count)',
    readLiveSessions(HOME).filter((s) => s.kind === 'background').length,
  );

  const events = new EngineEvents(eventsPath(state));
  const chat = new ChatManager({ claudePath: CLAUDE, log: (l) => log(`[chat] ${l}`) });
  let messenger: Messenger | null = null;
  const engine = new Engine({
    claudePath: CLAUDE,
    home: HOME,
    registryFile: path.join(state, '.config/cld-gui/projects.json'),
    readOnly: false,
    log: (l) => log(l),
    event: (type, source, fields) => events.append(type, source, fields),
    started: (n) => messenger?.deliverInbox(n),
    writeInbox: (n, text) => messenger!.writeInbox(n, text),
  });
  messenger = new Messenger({
    home: state,
    engine,
    typist: chat,
    events,
    log: (l) => log(`[msg] ${l}`),
  });
  const jobs = new Jobs({
    home: state,
    events,
    env: () => engine.jobEnv(),
    systemdRun: engine.scopeRunner,
    log: (l) => log(`[job] ${l}`),
  });
  engine.start();
  messenger.start();
  jobs.start();
  const server = await listenControl(controlPath(state), (req) =>
    answerControl(req, {
      names: () => engine.names(),
      projectAt: (cwd) => engine.projectAt(cwd),
      send: (r) => messenger!.send(r),
      job: (r) => jobs.run(r),
      jobs: (all) => ({ ok: true, jobs: jobs.list(all).map(jobJson) }),
      stop: (target, source) => jobs.stop(target, source),
      renew: (n, text, file, source) => {
        const r = engine.renew(n, renewText(text, file, shortStamp()), source);
        return r.ok ? { ok: true, name: n, renew: 'pending' } : r;
      },
    }),
  );
  if (!server) throw new Error('no control socket');
  const onlyLive = process.argv.includes('--only-live');
  /** The CLI as an agent runs it, with cld-gui's HOME = the temp state dir. */
  const cli = (args: string[], cwd = outside) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const child = spawn(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
        cwd,
        env: { PATH: process.env.PATH, HOME: state, CLD_OUTPUT: 'json' },
      });
      let out = '';
      child.stdout.on('data', (b: Buffer) => (out += b.toString()));
      child.on('close', (code) =>
        resolve({ exit: code, ...(JSON.parse(out || '{}') as Record<string, unknown>) }),
      );
    });

  let prompts = 0;
  const ids = new Set<string>();
  const attachPeak = { mb: 0 };
  const sampler = setInterval(() => {
    const ps = spawnSync('ps', ['-eo', 'rss=,args='], { encoding: 'utf-8' }).stdout ?? '';
    for (const line of ps.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && [...ids].some((id) => m[2].includes(`attach ${id}`)))
        attachPeak.mb = Math.max(attachPeak.mb, Math.round(Number(m[1]) / 1024));
    }
  }, 200);
  const session = () =>
    readLiveSessions(HOME).find((s) => s.kind === 'background' && s.cwd === folder) ?? null;
  const records = (sid: string) => {
    try {
      return fs
        .readFileSync(transcriptPath(folder, sid, HOME), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, any>);
    } catch {
      return [];
    }
  };
  const textOf = (r: Record<string, any>): string => {
    const c = r.message?.content;
    return typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.map((x: any) => x.text ?? '').join('')
        : '';
  };
  const userTurns = (sid: string) =>
    records(sid).filter((r) => r.type === 'user' && !r.isMeta && textOf(r));
  const replies = (sid: string) =>
    records(sid)
      .filter((r) => r.type === 'assistant')
      .map(textOf)
      .filter(Boolean);

  try {
    // 1. Off: the inbox.
    const add = await engine.run(
      {
        type: 'engineAction',
        requestId: 's1',
        action: 'add',
        name,
        folder,
        model: 'haiku',
        permissionMode: 'bypassPermissions',
      },
      true,
      'smoke',
    );
    log('add', add);
    if (!onlyLive)
      log('cld-gui send while off', await cli(['send', name, 'Reply with just the word one.']));

    // 2. Start: the inbox is the first message.
    const started = await engine.run(
      { type: 'engineAction', requestId: 's2', action: 'start', name },
      true,
      'smoke',
    );
    log('start', started);
    const s1 = session();
    if (!s1 || !started.ok) throw new Error('not started');
    ids.add(s1.id!);
    const file = path.join(HOME, '.claude/sessions', `${s1.pid}.json`);
    const sf = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    log('session file', {
      kind: sf.kind,
      name: sf.name,
      status: sf.status,
      messagingSocketPath: !!sf.messagingSocketPath,
      peerProtocol: sf.peerProtocol,
      peerFeatures: sf.peerFeatures,
    });
    try {
      const names = fs
        .readFileSync(`/proc/${s1.pid}/environ`, 'latin1')
        .split('\0')
        .map((e) => e.split('=')[0]);
      log('session process environment has CLD_BIN', names.includes('CLD_BIN'));
      const p = fs
        .readFileSync(`/proc/${s1.pid}/environ`, 'latin1')
        .split('\0')
        .find((e) => e.startsWith('PATH='));
      log('its PATH starts with cld/bin', p?.startsWith(`PATH=${path.join(REPO_ROOT, 'cld/bin')}`));
    } catch (err) {
      log('environ unreadable', String(err));
    }
    try {
      const job = JSON.parse(
        fs.readFileSync(path.join(HOME, '.claude/jobs', s1.id!, 'state.json'), 'utf-8'),
      ) as { respawnFlags?: string[] };
      log('respawnFlags', job.respawnFlags);
    } catch {
      log('no job state.json');
    }
    if (!onlyLive) {
      const first = await until(
        () => replies(s1.sessionId).length > 0 && userTurns(s1.sessionId),
        120_000,
      );
      if (!first) throw new Error('the inbox was not delivered');
      prompts++;
      log('prompt 1 (inbox at start): user turn', {
        isMeta: first[0].isMeta ?? false,
        text: textOf(first[0]).slice(0, 120),
      });
      log('reply', replies(s1.sessionId).join(' | ').slice(0, 80));
      await until(() => session()?.status === 'idle', 60_000);
      log('status after the turn', session()?.status);
      log(
        'inbox files left',
        fs
          .readdirSync(path.join(state, '.config/cld-gui/inbox', name))
          .filter((f) => f.endsWith('.md')).length,
      );
    }

    // 3. Claude's cross-session socket, from a sender that is not a Claude session.
    const before = { users: userTurns(s1.sessionId).length, replies: replies(s1.sessionId).length };
    let peerDelivered = false;
    if (!onlyLive) {
      const sock = String(sf.messagingSocketPath);
      const reply = await new Promise<string>((resolve) => {
        const c = net.connect(sock);
        let got = '';
        c.setEncoding('utf8');
        c.on('connect', () => {
          c.write(
            `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Reply with just the word peer.' }, from: 'cld-gui-smoke', msg_id: randomUUID() })}\n`,
          );
          setTimeout(() => c.end(), 1_000);
        });
        c.on('data', (d) => (got += d));
        c.on('error', (e) => resolve(`error ${e.message}`));
        c.on('close', () => resolve(got));
      });
      log('peer socket: what came back on the connection', reply || '(nothing)');
      await sleep(10_000);
      peerDelivered =
        userTurns(s1.sessionId).length > before.users ||
        replies(s1.sessionId).length > before.replies;
      log('peer message 10 s later', { delivered: peerDelivered, status: session()?.status });
      log(
        'peer: screen (last lines)',
        strip(claude(['logs', s1.id!]).out)
          .split('\n')
          .filter((l) => l.trim())
          .slice(-6)
          .join(' ⏎ ')
          .slice(0, 600),
      );
      if (peerDelivered) prompts++;
    }

    // 4. A send to the live, idle session.
    if (!peerDelivered) {
      const live = await cli(['send', '--if-idle', name, 'Reply with just the word two.']);
      log('cld-gui send while live and idle', live);
      const second = await until(
        () =>
          replies(s1.sessionId).length > before.replies &&
          userTurns(s1.sessionId).length > before.users,
        120_000,
      );
      if (!second) throw new Error('the live send got no reply');
      prompts++;
      const turns = userTurns(s1.sessionId);
      log('prompt 2 (live send): user turn', {
        isMeta: turns.at(-1)?.isMeta ?? false,
        text: textOf(turns.at(-1)!).slice(0, 120),
      });
      log('reply', replies(s1.sessionId).slice(-1)[0]?.slice(0, 80));
      await until(() => session()?.status === 'idle', 60_000);
    } else log('step 4 skipped: the peer message counted as the second prompt');
    log('attach RSS peak MB', attachPeak.mb);

    // 5. renew, typing off (no third prompt): stop before start, no " (2)".
    messenger.dispose();
    const handoff = path.join(outside, 'handoff.md');
    fs.writeFileSync(handoff, '# handoff\nnothing to do');
    const oldSid = s1.sessionId;
    const renew = await cli(['renew', '--project', name, handoff]);
    log('cld-gui renew', renew);
    const renewed = await until(() => {
      const lines = fs
        .readFileSync(eventsPath(state), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      return lines.find((e) => e.type === 'orch_renew');
    }, 120_000);
    log('orch_renew', renewed);
    const s2 = session();
    if (s2) ids.add(s2.id!);
    log(
      'after renew: live bg sessions in the folder',
      readLiveSessions(HOME)
        .filter((s) => s.kind === 'background' && s.cwd === folder)
        .map((s) => ({ name: s.name, sid: s.sessionId.slice(0, 8) })),
    );
    log('new conversation', {
      differs: s2?.sessionId !== oldSid,
      name: s2?.name,
      noSuffix: s2?.name === name,
    });
    log(
      'handoff waits in the inbox (typing was off)',
      fs
        .readdirSync(path.join(state, '.config/cld-gui/inbox', name))
        .filter((f) => f.endsWith('.md')).length,
    );

    // 6. A job in its own scope.
    const job = await cli(['job', 'echo hi from a real job; sleep 2'], folder);
    log('cld-gui job', { ...job, log: String(job.log).replace(state, '<state>') });
    try {
      log('its cgroup', fs.readFileSync(`/proc/${String(job.pid)}/cgroup`, 'utf-8').trim());
    } catch {
      log('its cgroup: gone already');
    }
    await until(() => jobs.list().find((r) => r.id === job.id)?.ended, 30_000);
    log(
      'job ended',
      jobs.list().map((r) => ({ id: r.id, exit: r.exit })),
    );
    log('job log', fs.readFileSync(String(job.log), 'utf-8').trim());
    log(
      'events',
      fs
        .readFileSync(eventsPath(state), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { type: string }).type),
    );
    log('prompts sent', prompts);
  } finally {
    clearInterval(sampler);
    messenger.dispose();
    jobs.dispose();
    server.close();
    await chat.disposeAll();
    const live = readLiveSessions(HOME).filter((s) => s.kind === 'background' && s.cwd === folder);
    for (const s of live) log(`cleanup stop ${s.id}`, claude(['stop', s.id!]).out);
    await until(() => readLiveSessions(HOME).every((s) => s.cwd !== folder), 30_000);
    engine.dispose();
    for (const id of ids) log(`cleanup rm ${id}`, claude(['rm', id]).out || claude(['rm', id]).err);
    log('cleanup purge', claude(['purge', '-y', folder], '/tmp').out.split('\n').slice(-1)[0]);
    for (const d of [folder, state, outside]) fs.rmSync(d, { recursive: true, force: true });
    log(
      'after cleanup: live sessions in the folder',
      readLiveSessions(HOME).filter((s) => s.cwd === folder).length,
    );
    log(
      'after cleanup: agents rows',
      (claude(['agents', '--json', '--all']).out.match(new RegExp(name, 'g')) ?? []).length,
    );
  }
}

const deadline = setTimeout(() => {
  console.error('deadline');
  process.exit(1);
}, 8 * 60_000);
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(deadline);
    setTimeout(() => process.exit(), 1_000).unref();
  });
