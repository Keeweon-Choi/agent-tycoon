// TERM-P1 (ADR-0018): Claude in our PTY host. Its argv and environment, what it lists from the
// host's terminals.json and Claude's session files, held(), and deliver()'s paste-then-Enter
// sequence, against a fake host client (no process, no PTY).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { transcriptPath } from '../../../providers/claudeProvider.js';
import { PtyHostClient } from '../../../ptyhost/client.js';
import type { ProgramStatus } from '../../../ptyhost/programStatus.js';
import { ptyhostPaths } from '../../../ptyhost/protocol.js';
import type { ProjectRecord } from '../../registry.js';
import { ClaudeAgent } from './claude.js';
import { ClaudePtyAgent, folderTrusted, ptyArgs, ptyEnv } from './claudePty.js';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const lead: ProjectRecord = {
  projectId: 'p_aaaaaaaaaa',
  leadAssignmentId: 'a_lead',
  name: 'alpha',
  folder: '/work/alpha',
  wantRunning: true,
  model: 'claude-opus-5-5',
};

/** A fake host: writes are recorded with their time; status is set by the test. */
function fakeHost() {
  const writes: Array<{ t: string; data: string; at: number }> = [];
  const spawns: Array<{ args: string[]; meta: Record<string, string> }> = [];
  const status = new Map<string, ProgramStatus>();
  let onWrite: (data: string) => void = () => undefined;
  const client = {
    status,
    connected: true,
    connect: () => Promise.resolve(),
    onChange: () => () => undefined,
    viewers: () => 0,
    call: () => Promise.resolve({ ok: true }),
    write: (t: string, data: string) => {
      writes.push({ t, data, at: Date.now() });
      onWrite(data);
      return Promise.resolve({ ok: true });
    },
    spawn: (spec: { args: string[]; meta: Record<string, string> }) => {
      spawns.push(spec);
      return Promise.resolve({ ok: true, id: 'abcd1234', pid: 1 });
    },
    screen: () => Promise.resolve(null), // no screen: the box check finds nothing to refuse
    typing: <T>(_t: string, fn: () => Promise<T>) => fn(),
  };
  return { client: client as unknown as PtyHostClient, writes, spawns, status, react: (f: (d: string) => void) => (onWrite = f) };
}

/** A temp HOME where our host runs terminal `abcd1234` = this process, with its session file. */
function rig(fileStatus: string, platform: NodeJS.Platform = 'linux', client?: PtyHostClient) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-claudepty-'));
  homes.push(home);
  const pid = process.pid;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const writeSession = (status: string) =>
    fs.writeFileSync(
      path.join(sessions, `${pid}.json`),
      JSON.stringify({ pid, procStart, sessionId: 's-1', cwd: '/work/alpha', kind: 'interactive', name: 'alpha', status }),
    );
  writeSession(fileStatus);
  fs.mkdirSync(ptyhostPaths(home).dir, { recursive: true });
  fs.writeFileSync(
    ptyhostPaths(home).terminals,
    JSON.stringify([{ id: 'abcd1234', pid, cwd: '/work/alpha', startedAt: 1, meta: { assignment: 'a_lead' } }]),
  );
  const host = fakeHost();
  const agent = new ClaudePtyAgent({
    claudePath: '/usr/bin/claude',
    home,
    env: {},
    systemdRun: null,
    cldBin: null,
    hostScript: '/x/cld-ptyhost.js',
    log: () => undefined,
    client: client ?? host.client,
    timing: { enterMs: 50, submitMs: 300, retryMs: 80, pollMs: 10 },
    platform,
  });
  const transcript = transcriptPath('/work/alpha', 's-1', home);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  /** Claude writing a submitted prompt (a person's: origin human). */
  const submit = (text: string) =>
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', uuid: `u-${Math.random()}`, origin: { kind: 'human' }, message: { role: 'user', content: text } })}\n`,
    );
  return { home, agent, host, writeSession, submit };
}

describe('claude-pty argv and environment', () => {
  it('always names the permission mode; no --bg, no worktree isolation; resume keeps its flags', () => {
    expect(ptyArgs(lead, 's-1', null, null)).toEqual([
      '-n', 'alpha', '--resume', 's-1', '--model', 'claude-opus-5-5', '--permission-mode', 'default',
    ]);
    const args = ptyArgs({ ...lead, permissionMode: 'bypassPermissions' }, undefined, '/c/bin/cld-gui', '/m.json');
    expect(args).toContain('bypassPermissions');
    expect(args).not.toContain('--bg');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]) as Record<string, unknown>;
    // TERM-P3: the PermissionRequest hook rides in --settings (this session only), the CLI beside CLD_BIN.
    expect(settings).toEqual({
      hooks: {
        PermissionRequest: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `"${process.execPath}" "/c/bin/cld-gui" permission-hook`,
                timeout: expect.any(Number),
              },
            ],
          },
        ],
      },
      statusLine: expect.objectContaining({ type: 'command' }),
      promptSuggestionEnabled: false,
    });
  });

  it('TERM-P3: closeAll kills every terminal of the assignment, one with no session file too, and waits for it to leave', async () => {
    const { home, agent, host } = rig('idle');
    fs.rmSync(path.join(home, '.claude/sessions', `${process.pid}.json`)); // not up yet
    const kills: unknown[] = [];
    (host.client as unknown as { call: (op: string, a: unknown) => Promise<unknown> }).call = (op, a) => {
      if (op === 'kill') {
        kills.push(a);
        setTimeout(() => fs.writeFileSync(ptyhostPaths(home).terminals, '[]'), 50); // it exits
      }
      return Promise.resolve({ ok: true });
    };
    expect(await agent.closeAll({ ...lead, leadAssignmentId: 'a_other' })).toBe(true);
    expect(kills).toEqual([]);
    expect(await agent.closeAll(lead)).toBe(true);
    expect(kills).toEqual([{ t: 'abcd1234' }]);
  });

  it('TERM-P3: closeAll is false while a terminal of the assignment stays', async () => {
    const { agent } = rig('idle');
    const stuck = new ClaudePtyAgent({ ...(agent as unknown as { o: ConstructorParameters<typeof ClaudePtyAgent>[0] }).o, timing: { pollMs: 10, closeMs: 100 } });
    expect(await stuck.closeAll(lead)).toBe(false);
  });

  it('TERM-P3: a start hands the hook over in argv only; no settings file is written', async () => {
    const { home, agent, host } = rig('idle');
    const cldAgent = new ClaudePtyAgent({
      ...(agent as unknown as { o: ConstructorParameters<typeof ClaudePtyAgent>[0] }).o,
      cldBin: path.join(home, 'bin', 'cld-gui'),
      client: host.client,
    });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { '/work': { hasTrustDialogAccepted: true } } }));
    const files = () => fs.readdirSync(path.join(home, '.claude'), { recursive: true }).map(String).sort();
    const before = files();
    expect(await cldAgent.start({ ...lead, name: 'beta', leadAssignmentId: 'a_beta' }, { token: () => 't' })).toMatchObject({ ok: true });
    const args = host.spawns[0].args;
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toHaveProperty('hooks.PermissionRequest');
    expect(files()).toEqual(before);
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('strips CLAUDE* and AI_AGENT, keeps the rest, adds ours', () => {
    expect(
      ptyEnv(
        { HOME: '/h', PATH: '/p', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_PID: '9', AI_AGENT: 'x', LANG: 'C' },
        { CLD_AGENT_TOKEN: 't' },
      ),
    ).toEqual({ HOME: '/h', PATH: '/p', LANG: 'C', CLD_AGENT_TOKEN: 't' });
  });

  it('folder trust is inherited from a trusted folder above; unreadable is unknown', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-trust-'));
    homes.push(home);
    expect(folderTrusted(home, '/work/alpha')).toBeNull();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { '/work': { hasTrustDialogAccepted: true } } }));
    expect(folderTrusted(home, '/work/alpha/sub')).toBe(true);
    expect(folderTrusted(home, '/other')).toBe(false);
  });
});

describe('claude-pty live sessions', () => {
  it("joins the host's terminal to Claude's session file: held by the engine, its assignment", () => {
    const { agent, host } = rig('idle');
    expect(agent.live()).toEqual([
      expect.objectContaining({ id: 'abcd1234', pid: process.pid, kind: 'background', sessionId: 's-1', status: 'idle', assignmentId: 'a_lead' }),
    ]);
    expect(agent.pids()).toEqual(new Set([process.pid]));
    host.status.set('abcd1234', { state: 'blocked', kind: 'permission' });
    expect(agent.live()[0].status).toBe('waiting');
  });

  it("the --bg provider leaves out the host's pids (one conversation, one holder)", () => {
    const { agent, home } = rig('idle');
    const o = { claudePath: '/usr/bin/claude', home, env: {}, systemdRun: null, cldBin: null, sessionPath: null, startMs: 1, stopMs: 1, log: () => undefined };
    expect(new ClaudeAgent(o).live().map((s) => s.pid)).toEqual([process.pid]);
    expect(new ClaudeAgent({ ...o, exclude: () => agent.pids() }).live()).toEqual([]);
  });

  it('held: a permission the session file or OSC names', async () => {
    const { agent, host } = rig('waiting');
    expect(await agent.held(agent.live()[0])).toBe(true);
    const idle = rig('idle');
    expect(await idle.agent.held(idle.agent.live()[0])).toBe(false);
    idle.host.status.set('abcd1234', { state: 'blocked', kind: 'question' });
    expect(await idle.agent.held({ ...idle.agent.live()[0], status: 'idle' })).toBe(true);
    void host;
  });
});

describe('claude-pty deliver', () => {
  it('idle: a bracketed paste, Enter on its own after the paste delay, confirmed by the turn starting', async () => {
    const { agent, host, writeSession, submit } = rig('idle');
    host.react((d) => {
      if (d !== '\r') return;
      host.status.set('abcd1234', { state: 'working' });
      submit('[사장 · 메신저 · 11-01 14:50] ⟨m:abcdefgh⟩\nhi\nthere');
    });
    expect(await agent.deliver(lead, 'hi\nthere\x07', { messageId: 'abcdefgh' })).toBe('typed');
    // TYPIST-STALE: the newline as LF (Ctrl+J), never CR (Enter where the paste markers do not arrive).
    expect(host.writes.map((w) => w.data)).toEqual(['\x1b[200~hi\nthere\x1b[201~', '\r']);
    expect(host.writes[1].at - host.writes[0].at).toBeGreaterThanOrEqual(45);
    writeSession('busy');
    host.status.set('abcd1234', { state: 'working' });
    // A busy session (the messenger hands over only when its main turn is over) takes an ordinary message with Enter...
    host.writes.length = 0;
    expect(await agent.deliver(lead, 'later', {})).toBe('typed');
    expect(host.writes.map((w) => w.data)).toEqual(['\x1b[200~later\x1b[201~', '\r']);
    // ...and a `now` one goes in with chat:sendNow, not Enter.
    host.writes.length = 0;
    expect(await agent.deliver(lead, 'now', { now: true })).toBe('typed');
    expect(host.writes.map((w) => w.data)).toEqual(['\x1b[200~now\x1b[201~', '\x18', '\x13']);
  });

  it('a busy session waiting on a permission (held by OSC) takes nothing', async () => {
    const { agent, host } = rig('busy');
    host.status.set('abcd1234', { state: 'blocked' });
    expect(await agent.deliver(lead, 'x', {})).toBe('notReady');
    expect(host.writes).toEqual([]);
  });

  it('a session waiting on a permission, or none at all, takes nothing', async () => {
    const { agent, host } = rig('waiting');
    expect(await agent.deliver(lead, 'x', {})).toBe('notReady');
    expect(await agent.deliver({ ...lead, leadAssignmentId: 'a_other' }, 'x', {})).toBe('notReady');
    expect(host.writes).toEqual([]);
  });

  it('OSC done counts as ready when the session file has no status yet', async () => {
    const { agent, host, writeSession } = rig('idle');
    writeSession(''); // no status
    host.status.set('abcd1234', { state: 'done' });
    expect(agent.live()[0].status).toBe('idle');
    expect(await agent.deliver(lead, 'x', {})).toBe('typed');
  });
});

const RULE = '─'.repeat(60);
/** Claude Code's input box between its rules; a multi-line paste shows as its placeholder. */
const claudeScreen = (box: string) =>
  `\x1b[2J\x1b[H${RULE}\r\n❯ ${box.includes('\n') ? `[Pasted text #1 +${box.split('\n').length - 1} lines]` : box}\r\n${RULE}\r\n  ? for shortcuts`;

/**
 * MSG-RECALL: our real host client (its viewer gate) over a fake Claude Code: a bracketed paste
 * fills the input box, Up recalls the last prompt over it (Claude's history, 11-01 14:51), Enter
 * submits what the box holds, and the box is on the screen the host's mirror serves.
 */
function claudeHost() {
  const client = new PtyHostClient({ home: '/nonexistent', launch: () => undefined, log: () => undefined });
  const writes: string[] = [];
  const history: string[] = [];
  let box = '';
  let onSubmit: (text: string) => void = () => undefined;
  let onPaste: () => void = () => undefined;
  const o = client as unknown as Record<string, unknown>;
  o.connect = () => Promise.resolve();
  o.call = (op: string, f: { data?: string }) => {
    const d = f.data;
    if (op === 'write' && d !== undefined) {
      writes.push(d);
      if (d.startsWith('\x1b[200~')) {
        box += d.slice(6, -6).replaceAll('\r', '\n');
        onPaste();
      } else if (d === '\x1b[A') box = history.at(-1) ?? box;
      else if (d === '\r') {
        history.push(box);
        onSubmit(box);
        box = '';
      } else box += d;
    }
    return Promise.resolve({ ok: true });
  };
  o.screen = () => Promise.resolve({ snapshot: claudeScreen(box), cols: 80, rows: 24 });
  return {
    client,
    writes,
    history,
    setBox: (b: string) => (box = b),
    onSubmit: (f: (text: string) => void) => (onSubmit = f),
    onPaste: (f: () => void) => (onPaste = f),
  };
}

describe('MSG-RECALL: a delivery never submits a prompt that is not its own (11-01 14:51)', () => {
  const OLD = '[사장 · 메신저 · 11-01 13:30] ⟨m:3i6ukaoc⟩\n오 fx=1에서 확인하는 거 좋당\n[첨부] /x.png';
  const NEW = '[사장 · 메신저 · 11-01 14:50] ⟨m:xpjaixhk⟩\n> cld-gui: 유령 연출을…\n피로도 말이야';

  it("a viewer's Up between the paste and Enter waits for Enter: our prompt goes in, then the Up", async () => {
    const h = claudeHost();
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.history.push(OLD);
    h.onSubmit(submit);
    // The owner on the phone presses Up while the paste settles.
    h.onPaste(() => setTimeout(() => void h.client.viewerWrite('abcd1234', '\x1b[A'), 10));
    expect(await agent.deliver(lead, NEW, { messageId: 'xpjaixhk' })).toBe('typed');
    expect(h.history.at(-1)).toContain('⟨m:xpjaixhk⟩');
    expect(h.writes.map((w) => w.slice(0, 6))).toEqual(['\x1b[200~', '\r', '\x1b[A']);
  });

  it('a recalled prompt (or a draft) already in the box: nothing is written, the message waits', async () => {
    const h = claudeHost();
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.onSubmit(submit);
    h.setBox(OLD); // Up pressed before the delivery
    expect(await agent.deliver(lead, NEW, { messageId: 'xpjaixhk' })).toBe('inputBusy');
    h.setBox('내가 쓰던 글');
    expect(await agent.deliver(lead, NEW, { messageId: 'xpjaixhk' })).toBe('inputBusy');
    expect(h.writes).toEqual([]);
    // An empty box (the hint line only) takes it.
    h.setBox('');
    expect(await agent.deliver(lead, NEW, { messageId: 'xpjaixhk' })).toBe('typed');
  });

  it('지금 보내기 (force) on a taken box: no box check, the box\'s text goes in with ours, confirmed by our mark', async () => {
    const h = claudeHost();
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.onSubmit(submit);
    h.setBox('내가 쓰던 글 ');
    expect(await agent.deliver(lead, NEW, { messageId: 'xpjaixhk', force: true })).toBe('typed');
    expect(h.history.at(-1)).toMatch(/^내가 쓰던 글 \[사장/);
  });

  it('a session that turns busy after our Enter (a task notification, a Stop hook, a slow hook) is not lost: unconfirmed', async () => {
    const { agent, host, writeSession } = rig('idle');
    host.react((d) => {
      if (d !== '\r') return;
      host.status.set('abcd1234', { state: 'working' }); // its turn, ours queued behind it
      writeSession('busy');
    });
    expect(await agent.deliver(lead, NEW, { messageId: 'xpjaixhk' })).toBe('unconfirmed');
  });

  it('a busy session that takes ours at its next tool step (attachment queued_command): typed', async () => {
    const { agent, host, home } = rig('busy');
    const file = transcriptPath('/work/alpha', 's-1', home);
    host.react((d) => {
      if (d !== '\r') return;
      fs.appendFileSync(file, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: NEW })}\n`);
      setTimeout(
        () =>
          fs.appendFileSync(
            file,
            `${JSON.stringify({ isSidechain: false, type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: NEW, commandMode: 'prompt', origin: { kind: 'human' } } })}\n`,
          ),
        50,
      );
    });
    expect(await agent.deliver(lead, NEW, { messageId: 'xpjaixhk' })).toBe('typed');
  });

  it("another queued prompt (the owner typed one into the terminal) taken by a working session just before ours: unconfirmed, not lost", async () => {
    const { agent, host, home } = rig('busy');
    const file = transcriptPath('/work/alpha', 's-1', home);
    host.react((d) => {
      if (d !== '\r') return;
      host.status.set('abcd1234', { state: 'working' });
      fs.appendFileSync(
        file,
        `${JSON.stringify({ isSidechain: false, type: 'attachment', uuid: 'q0', attachment: { type: 'queued_command', prompt: '터미널에서 친 말', commandMode: 'prompt' } })}\n`,
      );
    });
    expect(await agent.deliver(lead, NEW, { messageId: 'xpjaixhk' })).toBe('unconfirmed');
  });

  it("the prompt that went in carries another message's mark: lost, though the turn started", async () => {
    const { agent, host, submit } = rig('idle');
    host.react((d) => {
      if (d !== '\r') return;
      host.status.set('abcd1234', { state: 'working' });
      submit(OLD);
    });
    expect(await agent.deliver(lead, NEW, { messageId: 'xpjaixhk' })).toBe('lost');
  });

  it('a task notification meanwhile is no lost paste; an idle session with no prompt of ours is; a busy one is unconfirmed', async () => {
    const { agent, host, submit, writeSession, home } = rig('idle');
    const file = transcriptPath('/work/alpha', 's-1', home);
    host.react((d) => {
      if (d !== '\r') return;
      fs.appendFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'n1', origin: { kind: 'task-notification' }, message: { content: '<task-notification>' } })}\n`);
      setTimeout(() => submit(NEW), 30);
    });
    expect(await agent.deliver(lead, NEW, { messageId: 'xpjaixhk' })).toBe('typed');
    host.react(() => undefined);
    expect(await agent.deliver(lead, NEW, { messageId: 'zzzzzzzz' })).toBe('lost');
    writeSession('busy');
    expect(await agent.deliver(lead, NEW, { messageId: 'yyyyyyyy' })).toBe('unconfirmed');
  });
});

/**
 * TYPIST-STALE (11-04 laptop): a fake Claude Code over a fake PTY. `markers: false` is a Windows
 * ConPTY that hands a paste over as keys (the 11-04 21:45 split): CR in it is Enter, LF (Ctrl+J)
 * a new line; `markers: true` is a Unix PTY (bracketed paste honoured: CR and LF both a new
 * line). `swallow` Enters are lost (a composer not ready yet, one a slow paste took in). The box
 * shows whole (no placeholder), as the laptop's did, unless `fold`: then a multi-line box shows as
 * Claude's `[Pasted text #<n> +<line breaks> lines]`, `#n` counting every paste up (ours, and the
 * owner's own through `setBox`). `onSwallow` runs at each Enter lost. `blindRead(k)`: the k-th screen read fails.
 */
function conptyHost(o: { markers: boolean; swallow?: number; fold?: boolean }) {
  const client = new PtyHostClient({ home: '/nonexistent', launch: () => undefined, log: () => undefined });
  const writes: string[] = [];
  const submitted: string[] = [];
  let box = '';
  let pastes = 0;
  let reads = 0;
  let blindAt = 0;
  let swallow = o.swallow ?? 0;
  let onSubmit: (text: string) => void = () => undefined;
  let onSwallow: () => void = () => undefined;
  const enter = () => {
    if (swallow > 0) {
      swallow--;
      return onSwallow();
    }
    if (!box) return;
    submitted.push(box);
    onSubmit(box);
    box = '';
  };
  const key = (ch: string) => (ch === '\r' ? enter() : (box += ch));
  const c = client as unknown as Record<string, unknown>;
  c.connect = () => Promise.resolve();
  c.call = (op: string, f: { data?: string }) => {
    const d = f.data;
    if (op === 'write' && d !== undefined) {
      writes.push(d);
      if (d.startsWith('\x1b[200~')) {
        const inner = d.slice(6, -6);
        pastes++;
        if (o.markers) box += inner.replaceAll('\r', '\n');
        else for (const ch of inner) key(ch);
      } else for (const ch of d) key(ch);
    }
    return Promise.resolve({ ok: true });
  };
  const screen = () =>
    `\x1b[2J\x1b[H${RULE}\r\n${(o.fold && box.includes('\n') ? `[Pasted text #${pastes} +${box.split('\n').length - 1} lines]` : box)
      .split('\n')
      .map((l, i) => `${i ? '  ' : '❯ '}${l}`)
      .join('\r\n')}\r\n${RULE}\r\n  ? for shortcuts`;
  c.screen = () => Promise.resolve(++reads === blindAt ? null : { snapshot: screen(), cols: 100, rows: 30 });
  return {
    client,
    writes,
    submitted,
    /** The owner put `b` there (a paste of theirs when multi-line: it counts). */
    setBox: (b: string) => {
      if (b.includes('\n')) pastes++;
      box = b;
    },
    blindRead: (k: number) => (blindAt = k),
    setSwallow: (n: number) => (swallow = n),
    onSubmit: (f: (text: string) => void) => (onSubmit = f),
    onSwallow: (f: () => void) => (onSwallow = f),
  };
}

describe('TYPIST-STALE: a typed message is submitted once, whole, or it says so (11-04 laptop)', () => {
  const MSG = '[사장 · 메신저 · 11-04 21:43] ⟨m:vtujnxny⟩\nㅎㅇ';
  const REVIVE =
    '[cld-gui 자동 복구 · 11-02 20:37] 컴퓨터가 다시 켜져서 엔진이 이 대화를 다시 띄웠다.\n\n[사장 · 메신저 · 10-28 21:38] ⟨m:z44duxtf⟩\n안뇽';

  it('negative control: the fake ConPTY submits a CR inside a paste as its own turn (the header alone, as on the laptop)', async () => {
    const h = conptyHost({ markers: false });
    await h.client.write('abcd1234', `\x1b[200~${MSG.replaceAll('\n', '\r')}\x1b[201~`);
    await h.client.write('abcd1234', '\r');
    expect(h.submitted).toEqual(['[사장 · 메신저 · 11-04 21:43] ⟨m:vtujnxny⟩', 'ㅎㅇ']);
  });

  for (const markers of [false, true])
    it(`header and body go in as ONE prompt (${markers ? 'Unix PTY' : 'Windows ConPTY, paste as keys'})`, async () => {
      const h = conptyHost({ markers });
      const { agent, submit } = rig('idle', markers ? 'linux' : 'win32', h.client);
      h.onSubmit(submit);
      expect(await agent.deliver(lead, MSG, { messageId: 'vtujnxny' })).toBe('typed');
      expect(h.submitted).toEqual([MSG]);
    });

  it('an Enter that did not take is pressed again while our paste sits whole in the box: one paste, two Enters', async () => {
    const h = conptyHost({ markers: false, swallow: 1 });
    const { agent, submit } = rig('idle', 'win32', h.client);
    h.onSubmit(submit);
    expect(await agent.deliver(lead, MSG, { messageId: 'vtujnxny' })).toBe('typed');
    expect(h.writes.filter((w) => w.startsWith('\x1b[200~'))).toHaveLength(1);
    expect(h.writes.filter((w) => w === '\r')).toHaveLength(2);
    expect(h.submitted).toEqual([MSG]);
  });

  it('no Enter takes (retries spent): unsubmitted, never `typed`; the next try submits that draft with Enter only', async () => {
    const h = conptyHost({ markers: true, swallow: 99 });
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.onSubmit(submit);
    expect(await agent.deliver(lead, MSG, { messageId: 'vtujnxny' })).toBe('unsubmitted');
    expect(h.writes.filter((w) => w === '\r')).toHaveLength(3); // Enter, then PTY_SUBMIT_RETRIES more
    // An inbox delivery (no mark) used to be `typed` here and left its draft in the box for good.
    h.setBox('');
    expect(await agent.deliver(lead, REVIVE, {})).toBe('unsubmitted');
    h.setSwallow(0);
    h.writes.length = 0;
    expect(await agent.deliver(lead, REVIVE, {})).toBe('typed');
    expect(h.writes).toEqual(['\r']); // the draft in the box, not a second copy of it
    expect(h.submitted).toEqual([REVIVE]);
  });

  it('a message of ours Up recalled into the box is never submitted again (negative: the earlier-paste Enter did)', async () => {
    const h = conptyHost({ markers: true });
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.onSubmit(submit);
    const M1 = '[사장 · 메신저 · 11-04 21:43] ⟨m:aaaaaaaa⟩\n첫 말';
    expect(await agent.deliver(lead, M1, { messageId: 'aaaaaaaa' })).toBe('typed');
    h.setBox(M1); // the owner pressed Up in the terminal
    h.writes.length = 0;
    // Whatever a caller still passes (an older messenger handed its earlier pastes over).
    const o = { messageId: 'bbbbbbbb', earlier: [M1] };
    expect(await agent.deliver(lead, MSG, o)).toBe('inputBusy');
    expect(h.submitted).toEqual([M1]);
    expect(h.writes).toEqual([]);
  });

  // A message Claude folds into a placeholder (five lines).
  const LONG = '[사장 · 메신저 · 11-04 22:10] ⟨m:longlong⟩\n하나\n둘\n셋\n넷';
  const OWNERS = '내 로그 1\n2\n3\n4\n5\n6\n7\n8'; // the owner's own paste: another line count

  it("while our folded paste waits for its Enter, the owner's own paste put there instead is not submitted", async () => {
    const h = conptyHost({ markers: true, fold: true, swallow: 1 });
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.onSubmit(submit);
    h.onSwallow(() => h.setBox(OWNERS));
    expect(await agent.deliver(lead, LONG, { messageId: 'longlong' })).toBe('lost');
    expect(h.writes.filter((w) => w === '\r')).toHaveLength(1); // no Enter again on the owner's paste
    expect(h.submitted).toEqual([]);
  });

  it("a folded paste left unsubmitted: the owner's own paste put there instead, even of our line count, is not ours (its #n)", async () => {
    const h = conptyHost({ markers: true, fold: true, swallow: 99 });
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.onSubmit(submit);
    expect(await agent.deliver(lead, LONG, { messageId: 'longlong' })).toBe('unsubmitted');
    // The owner cleared it and pasted their own text, with as many line breaks as ours.
    h.setBox('내 글 1\n2\n3\n4\n5');
    h.setSwallow(0);
    h.writes.length = 0;
    expect(await agent.deliver(lead, LONG, { messageId: 'longlong' })).toBe('inputBusy');
    expect(h.writes).toEqual([]);
    expect(h.submitted).toEqual([]);
  });

  it('a folded paste left unsubmitted is still ours by its #n: the next try (forced or not) presses Enter only, no second copy', async () => {
    for (const force of [true, false]) {
      const h = conptyHost({ markers: true, fold: true, swallow: 99 });
      const { agent, submit } = rig('idle', 'linux', h.client);
      h.onSubmit(submit);
      expect(await agent.deliver(lead, LONG, { messageId: 'longlong' })).toBe('unsubmitted');
      h.setSwallow(0);
      h.writes.length = 0;
      expect(await agent.deliver(lead, LONG, { messageId: 'longlong', ...(force && { force }) })).toBe('typed');
      expect(h.writes).toEqual(['\r']);
      expect(h.submitted).toEqual([LONG]); // once
    }
  });

  it("the owner's paste of our line count put there between our Enters is not submitted by a retry Enter (its #n is not ours)", async () => {
    const h = conptyHost({ markers: true, fold: true, swallow: 1 });
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.onSubmit(submit);
    h.onSwallow(() => h.setBox('내 글 1\n2\n3\n4\n5')); // as many line breaks as LONG
    expect(await agent.deliver(lead, LONG, { messageId: 'longlong' })).toBe('lost');
    expect(h.writes.filter((w) => w === '\r')).toHaveLength(1);
    expect(h.submitted).toEqual([]);
  });

  it('no #n read after our paste (a screen we could not read): the placeholder there is no one\'s, no retry Enter on it', async () => {
    const h = conptyHost({ markers: true, fold: true, swallow: 1 });
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.onSubmit(submit);
    h.blindRead(2); // the first read is the box check (free); the second reads the `#n` after our paste
    expect(await agent.deliver(lead, LONG, { messageId: 'longlong' })).toBe('lost');
    expect(h.writes.filter((w) => w === '\r')).toHaveLength(1);
    expect(h.submitted).toEqual([]);
  });

  it('what the owner types into the box between our Enters is never submitted by a retry Enter', async () => {
    const h = conptyHost({ markers: true, swallow: 1 });
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.onSubmit(submit);
    h.onSwallow(() => h.setBox('내가 치던 글'));
    expect(await agent.deliver(lead, MSG, { messageId: 'vtujnxny' })).toBe('lost');
    expect(h.writes.filter((w) => w === '\r')).toHaveLength(1);
    expect(h.submitted).toEqual([]);
  });

  it("a paste an older build left in the box, or a person's draft, waits untouched", async () => {
    const h = conptyHost({ markers: true });
    const { agent, submit } = rig('idle', 'linux', h.client);
    h.onSubmit(submit);
    for (const draft of [REVIVE, '내가 쓰던 글', `${REVIVE} 그리고`]) {
      h.setBox(draft);
      expect(await agent.deliver(lead, MSG, { messageId: 'vtujnxny' })).toBe('inputBusy');
    }
    expect(h.writes).toEqual([]);
    expect(h.submitted).toEqual([]);
  });
});

describe('claude-pty on Windows and macOS (TERM-P2)', () => {
  it("waits for ConPTY's slower paste ingest before Enter on Windows (Orca: 50 ms + 64 B/ms there, 4 KB/ms elsewhere)", async () => {
    const text = 'x'.repeat(6_400); // 100 ms of ConPTY ingest, under 2 ms elsewhere
    const gap = async (platform: NodeJS.Platform) => {
      const { agent, host } = rig('idle', platform);
      host.react((d) => {
        if (d === '\r') host.status.set('abcd1234', { state: 'working' });
      });
      expect(await agent.deliver(lead, text, {})).toBe('typed');
      return host.writes[1].at - host.writes[0].at;
    };
    expect(await gap('win32')).toBeGreaterThanOrEqual(145);
    expect(await gap('darwin')).toBeLessThan(140);
  });

  it('any install starts (a .cmd launcher too); every start names its conversation for the join (--session-id, or the resumed id)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-win-'));
    homes.push(dir);
    const o = { home: dir, env: {}, systemdRun: null, cldBin: null, hostScript: '/x/cld-ptyhost.js', log: () => undefined, platform: 'win32' as const };
    for (const f of ['claude.exe', 'claude.cmd']) fs.writeFileSync(path.join(dir, f), '');
    for (const f of ['claude.exe', 'claude.cmd']) expect(new ClaudePtyAgent({ ...o, claudePath: path.join(dir, f) }).ready()).toBeNull();
    const host = fakeHost();
    const agent = new ClaudePtyAgent({ ...o, claudePath: path.join(dir, 'claude.cmd'), client: host.client });
    const token = () => null;
    expect(await agent.start(lead, { token })).toEqual(expect.objectContaining({ ok: true }));
    expect(await agent.start(lead, { resume: 's-old', token })).toEqual(expect.objectContaining({ ok: true }));
    const [fresh, resumed] = host.spawns;
    const id = fresh.args[fresh.args.indexOf('--session-id') + 1];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.args[0]).toBe('-n'); // Claude reads its flags anywhere; -n first as before
    expect(fresh.meta).toEqual({ assignment: 'a_lead', session: id });
    expect(resumed.args).not.toContain('--session-id');
    expect(resumed.meta).toEqual({ assignment: 'a_lead', session: 's-old' });
  });

  it('a host that ended with its agents (Windows: the Task Scheduler task) is logged once; its terminals count as gone', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-gone-'));
      homes.push(home);
      fs.mkdirSync(ptyhostPaths(home).dir, { recursive: true });
      // A pid that cannot be alive (above Linux's pid_max) left in the list by a killed host.
      const dead = 2 ** 22 + 1;
      fs.writeFileSync(
        ptyhostPaths(home).terminals,
        JSON.stringify([{ id: 'dead0001', pid: dead, cwd: '/w', startedAt: 1, meta: { assignment: 'a_lead' } }]),
      );
      const host = fakeHost();
      (host.client as unknown as { connected: boolean }).connected = false;
      const logs: string[] = [];
      const agent = new ClaudePtyAgent({
        claudePath: '/usr/bin/claude', home, env: {}, systemdRun: null, cldBin: null,
        hostScript: '/x/cld-ptyhost.js', log: (l) => logs.push(l), client: host.client, platform,
      });
      expect(agent.live()).toEqual([]);
      expect(agent.terminals()).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/--resume/);
      if (platform === 'win32') expect(logs[0]).toMatch(/Task Scheduler/);
      else expect(logs[0]).not.toMatch(/Task Scheduler/);
    }
  });
});
