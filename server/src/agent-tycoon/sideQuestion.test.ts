import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentStateStore } from '../agentStateStore.js';
import type { Conversations } from './conversations.js';
import type { Engine } from './engine/engine.js';
import type { Messenger } from './engine/messenger.js';
import { OfficeChat } from './office/chat.js';
import { ClaudeSessions } from './providers/claudeProvider.js';
import type { AgentEntry } from './providers/types.js';
import {
  askSide,
  parseSideAsk,
  SIDE_READ_ONLY_ARGS,
  sideFailure,
  sideQuestionArgs,
  sideQuestionPid,
  sideQuestionPrompt,
  sideReason,
} from './sideQuestion.js';
import type { SlashCatalogue } from './slashCommands.js';
import { type SpawnFn, spawnJson, SpawnJsonError } from './spawnJson.js';
import type { WorkViews } from './workView.js';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fake `claude`: logs argv, cwd and stdin, then answers as FAKE_SIDE_MODE says. */
function fakeClaude(): { claude: string; log: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-side-'));
  temps.push(dir);
  const claude = path.join(dir, 'claude');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(
    claude,
    `#!/usr/bin/env node
const fs = require('fs');
// Claude Code's live-session file, which a print-mode fork still writes.
if (process.env.FAKE_SIDE_SESSIONS)
  fs.writeFileSync(process.env.FAKE_SIDE_SESSIONS + '/' + process.pid + '.json', JSON.stringify({ pid: process.pid, procStart: '1', sessionId: 'fork-sid', cwd: process.cwd(), kind: 'interactive', status: 'busy' }));
let stdin = '';
process.stdin.on('data', (b) => (stdin += b));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_SIDE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin }) + '\\n');
  const mode = process.env.FAKE_SIDE_MODE || 'ok';
  if (mode === 'hang') return setTimeout(() => {}, 60000);
  if (mode === 'exit') { process.stderr.write('boom'); process.exit(1); }
  const later = () => process.stdout.write(JSON.stringify({ type: 'result', is_error: mode === 'error', result: mode === 'error' ? '' : ' six of twelve ', session_id: 'fork', credential_expires_at: 1 }));
  mode === 'slow' ? setTimeout(later, 400) : later();
});
`,
  );
  fs.chmodSync(claude, 0o755);
  return { claude, log, dir };
}

const calls = (log: string) =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; stdin: string })
    : [];

describe('side question arguments (T-115)', () => {
  it('forks the Lead session without writing it, with the chosen model and only reading tools', () => {
    const args = sideQuestionArgs('lead-sid', 'model-x');
    expect(args.slice(0, 5)).toEqual([
      '-p',
      '--resume',
      'lead-sid',
      '--fork-session',
      '--no-session-persistence',
    ]);
    expect(args[args.indexOf('--model') + 1]).toBe('model-x');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    for (const flag of ['--strict-mcp-config', '--safe-mode', '--disable-slash-commands'])
      expect(args).toContain(flag);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(args.join(' ')).not.toMatch(/Write|Edit|Bash|bypass|skip-permissions|acceptEdits/);
    expect(args).toEqual(expect.arrayContaining(SIDE_READ_ONLY_ARGS));
  });

  it('gives the earlier side exchanges in the prompt, oldest first, and none for a first question', () => {
    const first = sideQuestionPrompt('which deploy?', []);
    expect(first).toMatch(/Side question: which deploy\?$/);
    expect(first).not.toMatch(/Earlier side questions/);
    const next = sideQuestionPrompt('and after?', [
      { question: 'q1', answer: 'a1' },
      { question: 'q2', answer: 'a2' },
    ]);
    expect(next.indexOf('Q: q1')).toBeLessThan(next.indexOf('A: a1'));
    expect(next.indexOf('A: a1')).toBeLessThan(next.indexOf('Q: q2'));
    expect(next.indexOf('A: a2')).toBeLessThan(next.indexOf('Side question: and after?'));
  });

  it('parses only a well-formed sideAsk', () => {
    const ok = {
      requestId: 'r',
      agentId: 3,
      question: 'q',
      model: 'm',
      earlier: [{ question: 'a', answer: 'b' }],
    };
    expect(parseSideAsk(ok)).toEqual({ type: 'sideAsk', ...ok });
    expect(parseSideAsk({ ...ok, question: '  ' })).toBeNull();
    expect(parseSideAsk({ ...ok, agentId: '3' })).toBeNull();
    expect(parseSideAsk({ ...ok, earlier: [{ question: 'a' }] })).toBeNull();
    expect(
      parseSideAsk({ ...ok, earlier: Array(11).fill({ question: 'a', answer: 'b' }) }),
    ).toBeNull();
  });
});

describe('askSide with a fake claude (T-115)', () => {
  const run = (mode: string, timeoutMs = 10_000) => {
    const f = fakeClaude();
    const cwd = path.join(f.dir, 'lead-folder');
    fs.mkdirSync(cwd);
    return {
      f,
      cwd,
      result: askSide({
        claude: f.claude,
        env: { ...process.env, FAKE_SIDE_LOG: f.log, FAKE_SIDE_MODE: mode },
        cwd,
        sessionId: 'lead-sid',
        model: 'model-x',
        question: 'which deploy?',
        earlier: [{ question: 'q1', answer: 'a1' }],
        timeoutMs,
      }),
    };
  };

  it('runs in the Lead folder with the prompt on stdin and keeps only the answer text', async () => {
    const { f, cwd, result } = run('ok');
    expect(await result).toEqual({ ok: true, text: 'six of twelve' });
    const [call] = calls(f.log);
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(cwd));
    expect(call.argv).toEqual(sideQuestionArgs('lead-sid', 'model-x'));
    expect(call.stdin).toContain('Q: q1\nA: a1');
    expect(call.stdin).toMatch(/Side question: which deploy\?$/);
  });

  it('the running fork leaves no row in the live-session list, while a Lead row stays', async () => {
    const f = fakeClaude();
    const sessions = path.join(f.dir, 'sessions');
    fs.mkdirSync(sessions);
    // A Lead's own row in the same folder: the negative control.
    fs.writeFileSync(
      path.join(sessions, '4242.json'),
      JSON.stringify({
        pid: 4242,
        procStart: '1',
        sessionId: 'lead-sid',
        cwd: f.dir,
        kind: 'interactive',
      }),
    );
    const list = () => new ClaudeSessions(sessions, null, () => true).list(false);
    const result = askSide({
      claude: f.claude,
      env: {
        ...process.env,
        FAKE_SIDE_LOG: f.log,
        FAKE_SIDE_MODE: 'slow',
        FAKE_SIDE_SESSIONS: sessions,
      },
      cwd: f.dir,
      sessionId: 'lead-sid',
      model: 'model-x',
      question: 'q',
      earlier: [],
    });
    await vi.waitFor(() => expect(fs.readdirSync(sessions)).toHaveLength(2), { timeout: 5_000 });
    expect((await list()).map((r) => r.sessionId)).toEqual(['lead-sid']);
    expect(await result).toMatchObject({ ok: true });
    // Once it ended, that pid is nobody's: a leftover file of it would be listed (here alive() is true).
    expect((await list()).map((r) => r.sessionId).sort()).toEqual(['fork-sid', 'lead-sid']);
  });

  it('runs outside the shared queue, one per daemon: a queued run does not wait, a second side question is side_busy', async () => {
    const first = run('hang', 3_000);
    await vi.waitFor(() => expect(calls(first.f.log)).toHaveLength(1), { timeout: 5_000 });
    const queued = spawnJson(process.execPath, ['-e', 'console.log(1)'], { timeoutMs: 5_000 });
    let queuedDone = false;
    void queued.then(() => (queuedDone = true));
    expect(await run('ok').result).toMatchObject({ ok: false, why: { errorCode: 'side_busy' } });
    expect(await queued).toBe(1);
    expect(queuedDone).toBe(true);
    let firstDone = false;
    void first.result.then(() => (firstDone = true));
    await Promise.resolve();
    expect(firstDone).toBe(false);
    expect(await first.result).toMatchObject({ why: { errorCode: 'side_timeout' } });
    // Free again once it ended.
    expect(await run('ok').result).toMatchObject({ ok: true });
  });

  it('a failed run says why (its stderr); an error answer with no text is side_failed', async () => {
    expect(await run('exit').result).toMatchObject({
      ok: false,
      why: { errorCode: 'side_failed_reason', errorParams: { reason: 'boom' } },
    });
    expect(await run('error').result).toMatchObject({
      ok: false,
      why: { errorCode: 'side_failed' },
    });
  });

  it('a run past the timeout is side_timeout with its seconds', async () => {
    const r = await run('hang', 1_000).result;
    expect(r).toMatchObject({
      ok: false,
      why: { errorCode: 'side_timeout', errorParams: { seconds: 1 } },
    });
  });
});

describe('OfficeChat sideAsk (T-115)', () => {
  const entry = (over: Partial<AgentEntry> = {}): AgentEntry =>
    ({
      key: 'engine:alpha',
      name: 'alpha',
      dir: '/nowhere',
      sessionId: 'lead-sid',
      agentId: 7,
      ...over,
    }) as AgentEntry;

  function chat(
    opts: {
      mode?: string;
      provider?: string;
      entry?: AgentEntry;
      models?: { value: string; displayName: string }[];
    } = {},
  ) {
    const f = fakeClaude();
    const folder = path.join(f.dir, 'alpha');
    fs.mkdirSync(folder);
    const send = vi.fn();
    const messenger = { send: vi.fn() } as unknown as Messenger;
    const engine = {
      names: () => ['alpha'],
      roster: () => [{ name: 'alpha', provider: opts.provider ?? 'claude' }],
      jobEnv: () => ({ ...process.env, FAKE_SIDE_LOG: f.log, FAKE_SIDE_MODE: opts.mode ?? 'ok' }),
      folderOf: () => folder,
    } as unknown as Engine;
    const office = new OfficeChat({
      opts: { chat: true, store: {} as AgentStateStore, engineClaude: f.claude },
      engine,
      messenger,
      slash: {
        models: () => opts.models ?? [{ value: 'model-x', displayName: 'Model X' }],
      } as unknown as SlashCatalogue,
      conversations: {} as Conversations,
      work: {} as WorkViews,
      entryOf: () => opts.entry ?? entry(),
      leads: () => [],
      readScreen: () => undefined,
      publish: () => undefined,
      officeState: () => ({}) as never,
    });
    const ask = (requestId: string, over: Record<string, unknown> = {}, privileged = true) =>
      office.onClientMessage(
        {
          type: 'sideAsk',
          requestId,
          agentId: 7,
          question: 'which deploy?',
          model: 'model-x',
          earlier: [],
          ...over,
        },
        { send, privileged },
      );
    const answers = async (n: number) => {
      await vi.waitFor(() => expect(send.mock.calls.length).toBeGreaterThanOrEqual(n), {
        timeout: 8_000,
      });
      return send.mock.calls.map((c) => c[0] as Record<string, unknown>);
    };
    return { ask, answers, send, messenger, f, folder, office };
  }

  it('answers from the fork, refuses a second ask while one runs, and never writes to the Lead', async () => {
    const c = chat({ mode: 'slow' });
    c.ask('r1');
    c.ask('r2');
    const got = await c.answers(2);
    expect(got[0]).toMatchObject({
      type: 'sideAnswer',
      requestId: 'r2',
      ok: false,
      errorCode: 'side_busy',
    });
    expect(got[1]).toMatchObject({
      type: 'sideAnswer',
      requestId: 'r1',
      agentId: 7,
      ok: true,
      text: 'six of twelve',
      model: 'model-x',
    });
    expect(got[1]).not.toHaveProperty('credential_expires_at');
    expect((c.messenger.send as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
    const [call] = calls(c.f.log);
    expect(call.argv).toEqual(
      expect.arrayContaining(['--fork-session', '--no-session-persistence']),
    );
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(c.folder));
    // Once answered, the drawer may ask again.
    c.ask('r3');
    expect((await c.answers(3))[2]).toMatchObject({ requestId: 'r3', ok: true });
  });

  it('refuses without starting claude: not privileged, a model the CLI does not list, a Codex Lead, no session', async () => {
    const cases: [ReturnType<typeof chat>, Record<string, unknown>, boolean, string][] = [
      [chat(), {}, false, 'no_permission'],
      [chat(), { model: 'other' }, true, 'side_bad_model'],
      [chat({ models: [] }), { model: '--dangerously-skip-permissions' }, true, 'side_bad_model'],
      [chat({ provider: 'codex' }), {}, true, 'side_not_claude'],
      [chat({ entry: entry({ sessionId: null }) }), {}, true, 'side_no_session'],
      [chat({ entry: entry({ key: 'claude:x' }) }), {}, true, 'not_engine_project'],
    ];
    for (const [c, over, privileged, code] of cases) {
      c.ask('r', over, privileged);
      expect((await c.answers(1))[0]).toMatchObject({ ok: false, errorCode: code });
      expect(calls(c.f.log)).toEqual([]);
    }
  });

  it('a question for another Lead, from another client, waits for none: side_busy at once', async () => {
    const a = chat({ mode: 'slow' });
    const b = chat();
    a.ask('r1');
    await vi.waitFor(() => expect(calls(a.f.log)).toHaveLength(1), { timeout: 5_000 });
    b.ask('r2');
    expect((await b.answers(1))[0]).toMatchObject({
      requestId: 'r2',
      ok: false,
      errorCode: 'side_busy',
    });
    expect(calls(b.f.log)).toEqual([]);
    expect((await a.answers(1))[0]).toMatchObject({ requestId: 'r1', ok: true });
  });

  it('an ask over the limits is refused with an answer, never dropped; one that cannot be addressed is dropped', async () => {
    const c = chat();
    c.ask('r1', { question: 'x'.repeat(4001) });
    c.ask('r2', { earlier: [{ question: 'q', answer: 'a'.repeat(20_001) }] });
    c.ask('r3', { earlier: [{ question: 'q', answer: 'a'.repeat(20_000) }] });
    c.ask('', { agentId: 'seven', question: 'x'.repeat(4001) });
    const got = await c.answers(3);
    expect(got.slice(0, 2)).toEqual([
      expect.objectContaining({
        requestId: 'r1',
        agentId: 7,
        ok: false,
        errorCode: 'side_bad_request',
      }),
      expect.objectContaining({ requestId: 'r2', ok: false, errorCode: 'side_bad_request' }),
    ]);
    expect(got[2]).toMatchObject({ requestId: 'r3', ok: true });
    expect(got).toHaveLength(3);
    expect(calls(c.f.log)).toHaveLength(1);
  });

  it('closing the drawer or the socket stops the fork at once, and the next question may run', async () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const c = chat({ mode: 'hang' });
    const forkPid = async () => {
      let pid: number | undefined;
      await vi.waitFor(
        () => {
          pid = sideQuestionPid();
          expect(pid).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );
      return pid!;
    };
    c.ask('r1');
    const first = await forkPid();
    // Another client's cancel, or another request's, stops nothing.
    c.office.onClientMessage(
      { type: 'sideCancel', requestId: 'r1' },
      { send: vi.fn(), privileged: true },
    );
    c.office.onClientMessage(
      { type: 'sideCancel', requestId: 'rX' },
      { send: c.send, privileged: true },
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(first)).toBe(true);
    const t0 = Date.now();
    c.office.onClientMessage(
      { type: 'sideCancel', requestId: 'r1' },
      { send: c.send, privileged: true },
    );
    expect((await c.answers(1))[0]).toMatchObject({ requestId: 'r1', ok: false });
    expect(Date.now() - t0).toBeLessThan(3_000);
    await vi.waitFor(() => expect(alive(first)).toBe(false), { timeout: 3_000 });
    c.ask('r2');
    const second = await forkPid();
    c.office.onClientClosed(c.send);
    await vi.waitFor(() => expect(alive(second)).toBe(false), { timeout: 3_000 });
    expect((await c.answers(2))[1]).toMatchObject({ requestId: 'r2', ok: false });
  });

  it('a failed fork answers with the failure and frees the drawer', async () => {
    const c = chat({ mode: 'exit' });
    c.ask('r1');
    expect((await c.answers(1))[0]).toMatchObject({
      ok: false,
      errorCode: 'side_failed_reason',
      errorParams: { reason: 'boom' },
      error: 'Claude Code 가 답 없이 끝났어요: boom',
      model: 'model-x',
    });
    c.ask('r2');
    expect((await c.answers(2))[1]).toMatchObject({
      requestId: 'r2',
      errorCode: 'side_failed_reason',
    });
  });
});

/** A spawn whose child writes `stdout` and `stderr`, then exits with `code`. */
function endingSpawn(stdout: string, stderr: string, code: number): SpawnFn {
  return (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('exit', code, null);
      child.emit('close', code, null);
    });
    return child;
  }) as unknown as SpawnFn;
}

/** What Claude Code 2.1.x prints with --output-format json when the request itself failed (and exits 1). */
const errorAnswer = (result: string) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result,
    session_id: 's',
    account_email: 'me@localhost',
  });

describe('why a side question failed (T-140)', () => {
  const ask = (stdout: string, stderr: string, code = 1) =>
    askSide({
      claude: '/usr/bin/claude',
      env: {},
      cwd: os.tmpdir(),
      sessionId: 'lead-sid',
      model: 'default',
      question: 'q',
      earlier: [],
      spawnFn: endingSpawn(stdout, stderr, code),
    });

  it('spawnJson keeps stderr and the JSON a run printed before it exited 1', async () => {
    const err = await spawnJson('claude', ['-p'], {
      timeoutMs: 5_000,
      unqueued: true,
      spawnFn: endingSpawn(errorAnswer('Invalid API key'), 'warn: one\nthe last line\n\n', 1),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpawnJsonError);
    expect((err as SpawnJsonError).json).toMatchObject({
      is_error: true,
      result: 'Invalid API key',
    });
    expect((err as SpawnJsonError).stderr).toContain('the last line');
  });

  it('an expired login (the JSON error answer, exit 1) is side_login', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await ask(
      errorAnswer(
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
      ),
      '',
    );
    expect(r).toMatchObject({ ok: false, why: { errorCode: 'side_login' } });
    expect(warn.mock.calls[0][0]).toMatch(
      /^\[agty\] side question: claude -p failed \(exit 1\): Failed to authenticate\. API Error: 401/,
    );
    expect(warn.mock.calls[0][0]).not.toContain('example.com');
    warn.mockRestore();
  });

  it('with no JSON, the last stderr line is the reason, cleaned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await ask(
      '',
      `loading\nError: cannot read ${os.homedir()}/proj/x and /home/someone/y with sk-ant-oat01-abcdef\n`,
    );
    expect(r).toMatchObject({
      ok: false,
      why: {
        errorCode: 'side_failed_reason',
        errorParams: { reason: 'Error: cannot read ~/proj/x and ~/y with …' },
      },
    });
    warn.mockRestore();
  });

  it('a usage limit says so, with the reset time when the text has one; nothing at all is the bare side_failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await ask(errorAnswer("You've hit your limit · resets 7pm (Asia/Seoul)"), '')).ok).toBe(
      false,
    );
    expect(sideFailure("You've hit your limit · resets 7pm (Asia/Seoul)")).toMatchObject({
      errorCode: 'side_limit_reset',
      errorParams: { reset: '7pm (Asia/Seoul)' },
      error: '사용량 한도에 걸렸어요. 7pm (Asia/Seoul) 에 풀려요',
    });
    expect(sideFailure('Claude AI usage limit reached|1731500000').errorCode).toBe('side_limit');
    // The weekly wording the CLI prints when the week's limit is used up (the review of T-140).
    expect(
      sideFailure("You've hit your weekly limit · resets Nov 15, 9am (Asia/Seoul)"),
    ).toMatchObject({
      errorCode: 'side_limit_reset',
      errorParams: { reset: 'Nov 15, 9am (Asia/Seoul)' },
    });
    expect(sideFailure("You've reached your weekly limit.").errorCode).toBe('side_limit');
    expect(sideFailure('Please run /login').errorCode).toBe('side_login');
    expect(sideFailure('').errorCode).toBe('side_failed');
    expect(await ask('', '')).toMatchObject({ why: { errorCode: 'side_failed' } });
    vi.restoreAllMocks();
  });

  it('the reason is one line, never a token, an e-mail or an account field, and at most 200 characters', () => {
    // Built at run time: the public export rewrites the address literals it knows to `@localhost`, which
    // is no address to the masking under test (the exported tree failed here before rc.9 could publish).
    const mail = ['me', 'example.com'].join('@');
    const r = sideReason(
      {
        is_error: true,
        result: `bad\n  token ${'A'.repeat(40)} for ${mail} ${'x '.repeat(200)}`,
        account_email: mail,
      },
      'ignored',
    );
    expect(r).not.toMatch(/\n|AAAA|example\.com/);
    expect(r.length).toBeLessThanOrEqual(200);
    expect(r.startsWith('bad token … for …')).toBe(true);
    // An answer that is not an error gives stderr's reason, never its text.
    expect(sideReason({ is_error: false, result: 'fine' }, 'boom\n')).toBe('boom');
  });
});
