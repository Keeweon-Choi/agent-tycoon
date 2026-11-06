/**
 * ACP-1 against the mock ACP agent (e2e/fixtures/mock-acp/mock-acp, never a real one): presets,
 * the prompt -> transcript -> store path, the owner's permission answer, no decision on a lost pipe
 * or no answer, stop and cancel, resume and load, hostile input, caps.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { koText } from '../../../../../../core/src/cld/serverText.js';
import { createAgentState } from '../../../../agentState.js';
import { AgentStateStore } from '../../../../agentStateStore.js';
import { ACP_ASKS_MAX, ACP_OPEN_TOOLS_MAX, ACP_TRANSCRIPT_MAX_BYTES } from '../../../../constants.js';
import { claudeProvider } from '../../../../providers/hook/claude/claude.js';
import { processTranscriptLine, setHookProvider } from '../../../../transcriptParser.js';
import { chatItems } from '../../../transcriptView.js';
import { alreadyTyped, turnOver } from '../../messenger.js';
import type { ProjectRecord } from '../../registry.js';
import type { LiveSession } from '../types.js';
import type { AcpAsk } from './acp.js';
import { AcpAgent, permissionOptions } from './acp.js';
import type { AcpPreset } from './presets.js';
import { ACP_PRESETS, findPreset, installedPresets } from './presets.js';
import { acpDir, acpFillPct, AcpTranscript, safeId } from './transcript.js';

const MOCK = path.resolve(__dirname, '../../../../../../e2e/fixtures/mock-acp/mock-acp');
const PRESET: AcpPreset = { id: 'mocky', name: 'Mocky', bins: ['mocky'], argv: ['--acp', '--stdio'], billing: 'metered' };
const OPTIONS = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

let tmp: string;
let home: string;
let folder: string;
let agents: AcpAgent[];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => T | null | undefined | false, ms = 8_000): Promise<T> {
  for (const end = Date.now() + ms; ; await wait(20)) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-'));
  home = path.join(tmp, 'home');
  folder = path.join(tmp, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(folder);
  agents = [];
});
afterEach(async () => {
  for (const a of agents) a.dispose();
  await wait(50);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const project = (o: Partial<ProjectRecord> = {}): ProjectRecord =>
  ({ projectId: 'p_1', assignmentId: 'a_1', name: 'mocky-w1', folder, role: 'worker', ...o }) as ProjectRecord;
const log = () =>
  fs.existsSync(path.join(home, 'mock-acp.log'))
    ? fs.readFileSync(path.join(home, 'mock-acp.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>)
    : [];
const got = (method: string) => log().filter((l) => l.got?.method === method);

function make(
  scenario: Record<string, unknown>,
  ask: (name: string, ask: AcpAsk, signal: AbortSignal) => Promise<string | false | null> = () => Promise.resolve(null),
  preset = PRESET,
) {
  fs.writeFileSync(path.join(home, 'mock-acp.json'), JSON.stringify(scenario));
  const lines: string[] = [];
  const a = new AcpAgent({
    preset,
    bin: MOCK,
    home,
    env: () => ({ PATH: process.env.PATH, HOME: home }),
    ask,
    log: (l) => lines.push(l),
    timing: { startMs: 5_000, closeMs: 500, killMs: 500 },
  });
  agents.push(a);
  return { a, lines };
}
const live = (a: AcpAgent): LiveSession => a.live()[0]!;
const records = (file: string) =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

describe('presets', () => {
  it('offers only an installed binary, with exactly its argv', () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const env = { PATH: bin };
    expect(installedPresets({ env, home, platform: 'linux' })).toEqual([]);
    fs.writeFileSync(path.join(bin, 'gemini'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'copilot'), 'not executable', { mode: 0o644 });
    const found = installedPresets({ env, home, platform: 'linux' });
    expect(found.map((f) => f.preset.id)).toEqual(['gemini']);
    expect(found[0]!.bin).toBe(path.join(bin, 'gemini'));
    expect(found[0]!.preset.argv).toEqual(['--acp']);
    // Its own install folder under the home folder counts too.
    const own = path.join(home, '.opencode/bin');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
    expect(findPreset(ACP_PRESETS.find((p) => p.id === 'opencode')!, { env, home, platform: 'linux' })).toBe(path.join(own, 'opencode'));
  });

  it("an editor's copilot launcher on the PATH is not the Copilot CLI; the real one after it is", () => {
    const shim = path.join(tmp, 'Microsoft VS Code', 'bin', 'copilot-shim');
    const server = path.join(home, '.vscode-server', 'bin', 'abc', 'bin', 'remote-cli');
    const real = path.join(tmp, 'npm-global', 'bin');
    for (const d of [shim, server, real]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'copilot'), '#!/bin/sh\n', { mode: 0o755 });
    }
    const copilot = ACP_PRESETS.find((p) => p.id === 'copilot')!;
    expect(findPreset(copilot, { env: { PATH: [shim, server].join(':') }, home, platform: 'linux' })).toBeNull();
    expect(findPreset(copilot, { env: { PATH: [shim, server, real].join(':') }, home, platform: 'linux' })).toBe(path.join(real, 'copilot'));
    // Windows: the same launcher folder, by its Windows path.
    expect(copilot.notIn!.test('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\copilot-shim')).toBe(true);
  });

  it('never fetches a package at start, and Copilot is the metered one', () => {
    for (const p of ACP_PRESETS) {
      expect(p.bins.some((b) => /^(npx|uvx|bunx|pnpx)$/.test(b))).toBe(false);
      expect(p.argv.every((a) => a.startsWith('-') || /^[a-z]+$/.test(a))).toBe(true);
    }
    expect(ACP_PRESETS.filter((p) => p.billing === 'metered').map((p) => p.id)).toEqual(['copilot']);
  });

  it('starts the preset argv in the agent folder, nothing else', async () => {
    const { a } = make({ turns: [[{ say: 'hi' }]] });
    const r = await a.start(project(), { token: () => 'tok' });
    expect(r.ok).toBe(true);
    const start = log().find((l) => l.start)!;
    expect(start.argv).toEqual(['--acp', '--stdio']);
    expect(fs.realpathSync(start.cwd)).toBe(fs.realpathSync(folder));
  });
});

describe('a prompt', () => {
  it('reaches the transcript in the shape every reader knows, and the store', async () => {
    const { a } = make({
      turns: [
        [
          { say: '안녕하세요, 시작해요' },
          { tool: { toolCallId: 't1', kind: 'execute', title: 'Run tests', rawInput: { command: 'npm test' } } },
          { usage: { used: 64_000, size: 128_000 } },
          { toolDone: 't1' },
          { plan: [{ content: 'Fix login', status: 'in_progress' }] },
          { say: '끝났어요' },
        ],
      ],
    });
    const r = await a.start(project(), { token: () => null });
    expect(r.ok && r.id).toBeTruthy();
    const s = live(a);
    expect(s).toMatchObject({ kind: 'background', assignmentId: 'a_1', status: 'idle', name: 'mocky-w1' });
    const changes: string[] = [];
    a.onChange(() => changes.push(a.live()[0]?.status ?? 'gone'));
    expect(await a.deliver(project(), '[사장 · 메신저 · 11-06 21:00] ⟨m:abc⟩\n테스트 돌려 줘')).toBe('typed');
    expect(live(a).status).toBe('busy');
    // One prompt at a time: the next waits in the messenger's queue.
    expect(await a.deliver(project(), 'second')).toBe('notReady');
    await until('the turn ends', () => live(a).status === 'idle');
    expect(changes[0]).toBe('busy');
    const file = a.transcript(s);
    expect(file.startsWith(acpDir(home))).toBe(true);
    const recs = records(file);
    expect(recs[0]).toMatchObject({ type: 'permission-mode', permissionMode: 'acp' });
    expect(recs.map((x) => x.subtype ?? x.message?.content?.[0]?.type ?? x.type)).toEqual([
      'permission-mode',
      'user',
      'text',
      'tool_use',
      'acp_usage',
      'tool_result',
      'tool_use',
      'tool_result',
      'text',
      'turn_duration',
    ]);
    const text = fs.readFileSync(file, 'utf8');
    expect(turnOver(text, Date.now(), 5_000)).toBe(true);
    const items = chatItems(text);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(items[1]!.text).toBe('안녕하세요, 시작해요');
    expect(items[2]).toMatchObject({ toolName: 'Bash', text: 'Running: npm test', desc: 'Run tests' });
    expect(alreadyTyped(text, 'abc')).toBe(true);
    expect(acpFillPct(file)).toBe(50);

    // The office's parser: tools animate, the gauge reads the reported window, no permission guess.
    setHookProvider(claudeProvider);
    const store = new AgentStateStore();
    const agent = createAgentState({ id: 1, sessionId: 'x', isExternal: false, projectDir: '', jsonlFile: file, directoryName: 'm' });
    store.set(1, agent);
    const out: Array<Record<string, any>> = [];
    store.on('broadcast', (m) => out.push(m as Record<string, any>));
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const perm = new Map<number, ReturnType<typeof setTimeout>>();
    for (const line of text.split('\n').filter(Boolean)) processTranscriptLine(1, line, store, timers, perm);
    expect(agent.permissionMode).toBe('acp');
    expect(perm.size).toBe(0);
    expect(out.find((m) => m.type === 'agentToolStart')).toMatchObject({ toolId: 't1', toolName: 'Bash' });
    expect(out.find((m) => m.type === 'agentContextUsage')).toMatchObject({ contextTokens: 64_000, maxContextTokens: 128_000, limitBasis: 'reported' });
    for (const t of [...timers.values()]) clearTimeout(t);
    expect(a.capabilities.context).toBe(true);
  });

  it('a compaction is the compaction record every agent has', async () => {
    const { a } = make({ turns: [[{ usage: { used: 90, size: 100 } }, { compaction: true }, { say: 'ok' }]] });
    await a.start(project(), { token: () => null });
    await a.deliver(project(), 'go');
    await until('the turn ends', () => live(a).status === 'idle');
    const file = a.transcript(live(a));
    expect(records(file).filter((r) => r.subtype === 'compact_boundary')).toHaveLength(1);
    expect(acpFillPct(file)).toBe(null);
    expect(a.compaction.mark).toBe('"subtype":"compact_boundary"');
  });
});

describe('a permission request', () => {
  const asking = { turns: [[{ ask: { toolCall: { toolCallId: 't9', kind: 'execute', title: 'rm -rf build', rawInput: { command: 'rm -rf build' } }, options: OPTIONS } }]] };

  it("reaches the owner's card with its options; the answer goes to the agent exactly once", async () => {
    const asks: AcpAsk[] = [];
    const { a } = make(asking, (name, ask) => {
      expect(name).toBe('mocky-w1');
      asks.push(ask);
      return Promise.resolve('no');
    });
    await a.start(project(), { token: () => null });
    await a.deliver(project(), 'clean up');
    await until('the turn ends', () => live(a).status === 'idle');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.options.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
    expect(asks[0]).toMatchObject({ tool: 'Bash', input: { command: 'rm -rf build' } });
    const answers = log().filter((l) => l.answer);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.answer.result).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(fs.readFileSync(a.transcript(live(a)), 'utf8')).toContain('outcome:no');
  });

  it('no answer from the owner sends no decision; a stop then cancels the turn', async () => {
    let signal: AbortSignal | undefined;
    const { a } = make({ ...asking, caps: { close: true } }, (_n, _a, s) => {
      signal = s;
      return Promise.resolve(null); // the character gone, nobody there: no decision
    });
    await a.start(project(), { token: () => null });
    await a.deliver(project(), 'clean up');
    await until('the card was asked', () => signal);
    await wait(400);
    expect(log().filter((l) => l.answer)).toHaveLength(0);
    expect(live(a).status).toBe('busy');
    const s = live(a);
    expect(await a.stop(s)).toEqual({ ok: true });
    expect(got('session/cancel')).toHaveLength(1);
    // ACP: a client answers its open requests `cancelled` once it cancels the turn (never allowed).
    const answers = await until('the cancelled answer', () => {
      const a = log().filter((l) => l.answer);
      return a.length ? a : null;
    });
    expect(answers[0]!.answer.result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(got('session/close')).toHaveLength(1);
    // The cancelled answer went out before the close.
    const order = log().map((l) => l.got?.method ?? (l.got?.id === 1000 ? 'answer' : ''));
    expect(order.indexOf('answer')).toBeLessThan(order.indexOf('session/close'));
    await until('the child left', () => a.live().length === 0);
    expect(signal!.aborted).toBe(true);
  });

  it('a dropped pipe ends the card with no decision', async () => {
    let signal: AbortSignal | undefined;
    const { a, lines } = make(asking, (_n, _a, s) => {
      signal = s;
      return new Promise((resolve) => s.addEventListener('abort', () => resolve(null)));
    });
    await a.start(project(), { token: () => null });
    await a.deliver(project(), 'clean up');
    await until('the card was asked', () => signal);
    process.kill(live(a).pid, 'SIGKILL'); // our own mock child
    await until('the session is gone', () => a.live().length === 0);
    expect(signal!.aborted).toBe(true);
    expect(log().filter((l) => l.answer)).toHaveLength(0);
    expect(lines.some((l) => l.includes('ended'))).toBe(true);
  });

  it('a request whose card a newer one took is answered cancelled at once: the turn goes on', async () => {
    const two = { turns: [[asking.turns[0]![0]!, asking.turns[0]![0]!, { say: 'done' }]] };
    let n = 0;
    const { a } = make(two, () => Promise.resolve(++n === 1 ? false : OPTIONS[0]!.optionId));
    await a.start(project(), { token: () => null });
    await a.deliver(project(), 'clean up');
    await until('the turn ends', () => live(a).status === 'idle');
    const answers = log().filter((l) => l.answer);
    expect(answers.map((l) => l.answer.result.outcome.outcome)).toEqual(['cancelled', 'selected']);
  });

  it(`at most ACP_ASKS_MAX requests stay open per session; one more is cancelled at once`, async () => {
    const req = (id: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: { sessionId: 's1', toolCall: { toolCallId: `t${id}`, title: 'ls' }, options: OPTIONS },
      });
    const steps = Array.from({ length: ACP_ASKS_MAX + 1 }, (_, i) => ({ raw: req(i + 1) }));
    const { a } = make({ sessionId: 's1', turns: [[...steps, { waitCancel: true }]] }, (_n, _a, s) =>
      new Promise((resolve) => s.addEventListener('abort', () => resolve(null))),
    );
    await a.start(project(), { token: () => null });
    await a.deliver(project(), 'go');
    const over = await until('the one over the cap answered', () => log().find((l) => l.got?.id === ACP_ASKS_MAX + 1));
    expect(over.got.result).toEqual({ outcome: { outcome: 'cancelled' } });
    await wait(100);
    expect(log().filter((l) => typeof l.got?.id === 'number' && l.got.id <= ACP_ASKS_MAX && !l.got.method)).toHaveLength(0);
    await a.stop(live(a));
  });

  it('options are checked: unknown kinds, duplicates and oversized ids are dropped', () => {
    expect(
      permissionOptions([
        ...OPTIONS,
        { optionId: 'yes', name: 'dup', kind: 'allow_once' },
        { optionId: 'x', name: 'bad', kind: 'allow_everything' },
        { optionId: 'y'.repeat(5_000), name: 'big', kind: 'reject_always' },
        'junk',
        null,
      ]).map((o) => o.optionId),
    ).toEqual(['yes', 'always', 'no']);
    expect(permissionOptions({ not: 'an array' })).toEqual([]);
  });
});

describe('a conversation continued', () => {
  it('resumes where the agent can, and never writes a load replay again', async () => {
    const r1 = make({ caps: { resume: true }, sessionId: 'sess-1' });
    await r1.a.start(project(), { token: () => null });
    r1.a.dispose();
    await until('gone', () => r1.a.live().length === 0);
    const r2 = make({ caps: { resume: true } });
    const out = await r2.a.start(project(), { resume: 'sess-1', token: () => null });
    expect(out).toEqual({ ok: true, id: 'sess-1' });
    expect(got('session/resume')).toHaveLength(1);
    expect(r2.a.capabilities.resume).toBe(true);
    expect(r2.a.viewed(live(r2.a))).toBe(false); // it may rest when idle: it comes back
    r2.a.dispose();
    await until('gone', () => r2.a.live().length === 0);
    const r3 = make({ caps: { loadSession: true } });
    expect(await r3.a.start(project(), { resume: 'sess-1', token: () => null })).toEqual({ ok: true, id: 'sess-1' });
    expect(got('session/load')).toHaveLength(1);
    expect(fs.readFileSync(r3.a.transcript(live(r3.a)), 'utf8')).not.toContain('replayed');
  });

  it('starts fresh and says so where it cannot', async () => {
    const { a } = make({});
    const out = await a.start(project(), { resume: 'old', token: () => null });
    expect(out).toMatchObject({ ok: true, note: koText('acp_started_fresh') });
    expect(got('session/new')).toHaveLength(1);
    expect(a.viewed(live(a))).toBe(true); // never stopped for idleness: it would forget
  });

  it('a session id the registry could not read back is refused at start, never kept', async () => {
    for (const bad of ['my session', '세션-1']) {
      const { a } = make({ sessionId: bad });
      expect((await a.start(project(), { token: () => null })).ok).toBe(false);
      await until('no child left', () => a.live().length === 0);
    }
  });

  it('an agent that wants its own login says so', async () => {
    const { a } = make({ auth: true });
    expect(await a.start(project(), { token: () => null })).toEqual({ ok: false, error: koText('acp_auth', { name: 'Mocky' }) });
    await until('no child left', () => a.live().length === 0);
  });
});

describe('hostile input', () => {
  it('malformed messages, unknown kinds, other sessions and requests we never offered change nothing', async () => {
    const big = 'x'.repeat(300_000);
    const { a } = make({
      turns: [
        [
          { raw: 'not json at all' },
          { raw: '[1,2,3]' },
          { raw: '{"jsonrpc":"2.0","id":77,"result":{}}' },
          { raw: '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"other","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"from another session"}}}}' },
          { raw: '{"jsonrpc":"2.0","id":78,"method":"fs/read_text_file","params":{"sessionId":"s","path":"/etc/passwd"}}' },
          { raw: '{"jsonrpc":"2.0","id":79,"method":"terminal/create","params":{"sessionId":"s","command":"rm"}}' },
          { update: { sessionUpdate: 'something_new', payload: 1 } },
          { update: { sessionUpdate: 'tool_call', toolCallId: 'big', kind: 'Task', title: big } },
          { update: { sessionUpdate: 'usage_update', used: -5, size: 'lots' } },
          { say: 'still here' },
        ],
        [{ raw: `{"jsonrpc":"2.0","method":"session/update","params":{"x":"${'y'.repeat(9 * 1024 * 1024)}"}}` }, { say: 'never' }],
      ],
    });
    await a.start(project(), { token: () => null });
    const file = a.transcript(live(a));
    await a.deliver(project(), 'one');
    await until('the turn ends', () => live(a).status === 'idle');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('still here');
    expect(text).not.toContain('from another session');
    expect(text).not.toContain('acp_usage');
    // A tool kind it invented is a plain tool (never a sub-agent spawn), its title cut.
    const tool = records(file).find((r) => r.message?.content?.[0]?.type === 'tool_use')!;
    expect(tool.message.content[0].name).toBe('Tool');
    expect(tool.message.content[0].input.description.length).toBeLessThanOrEqual(2_001);
    // What we never offered is refused (method not found), not run.
    const errors = log().filter((l) => l.got?.id === 78 || l.got?.id === 79);
    expect(errors.map((l) => l.got.error?.code)).toEqual([-32601, -32601]);
    // An oversized message closes this session only.
    await a.deliver(project(), 'two');
    await until('the session closed', () => a.live().length === 0);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('never');
  }, 20_000);

  it("L2: the agent's stderr is masked before the log or the start failure shows it", async () => {
    const key = 'sk-ant-api03-abcdefghijklmnop';
    const { a, lines } = make({ stderr: `auth failed: ANTHROPIC_API_KEY=${key}`, sessionId: 'x'.repeat(5_000) });
    const r = await a.start(project(), { token: () => null });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(JSON.stringify(r)).toContain('auth failed');
    expect(lines.join('\n')).not.toContain(key);
  });

  it('L1: an agent-chosen id never makes two projects share a transcript; one taken in a folder is refused', async () => {
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    const { a } = make({ sessionId: '1' });
    await a.start(project(), { token: () => null });
    await a.start(project({ projectId: 'p_2', assignmentId: 'a_2', name: 'mocky-w2', folder: other }), { token: () => null });
    const files = a.live().map((s) => a.transcript(s));
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    // Another assignment in the same folder, the agent saying "1" again: refused, never shared.
    const third = await a.start(project({ assignmentId: 'a_3', name: 'mocky-w3' }), { token: () => null });
    expect(third.ok).toBe(false);
    expect(a.live()).toHaveLength(2);
  });

  it('L3: open tool calls and the file size are capped; our prompts and turn ends still go in', () => {
    const file = path.join(acpDir(home), 'cap.jsonl');
    const t = new AcpTranscript(file, 's', () => undefined);
    t.begin();
    for (let i = 0; i <= ACP_OPEN_TOOLS_MAX; i++) t.update({ sessionUpdate: 'tool_call', toolCallId: `t${i}`, kind: 'read', title: 'x' });
    expect(records(file).filter((r) => r.type === 'assistant')).toHaveLength(ACP_OPEN_TOOLS_MAX);
    (t as unknown as { size: number }).size = ACP_TRANSCRIPT_MAX_BYTES + 1;
    const before = records(file).length;
    t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chatty' } });
    t.user('next');
    t.end();
    const after = records(file).slice(before);
    expect(after.map((r) => r.subtype ?? r.type)).toEqual(['user', 'turn_duration']);
  });

  it('a hostile session id never leaves our folder', async () => {
    expect(safeId('../../../etc/passwd')).toMatch(/^[0-9a-f]{32}$/);
    expect(safeId('abc-123_x.y')).toBe('abc-123_x.y');
    const { a } = make({ sessionId: '../../outside' });
    await a.start(project(), { token: () => null });
    const file = a.transcript(live(a));
    expect(path.dirname(file)).toBe(acpDir(home));
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('caps', () => {
  it('are the preset’s and the agent’s, never its name', async () => {
    const { a } = make({ caps: { loadSession: true } });
    expect(a.id).toBe('mocky');
    expect(a.protocol).toBe('acp');
    expect(a.capabilities).toMatchObject({
      approvalPolicy: ['ask'],
      sandbox: null,
      attach: null,
      lifetime: 'session',
      limits: false,
      usageRefresh: false,
      context: false,
      billing: 'metered',
      name: 'Mocky',
      resume: false,
    });
    await a.start(project(), { token: () => null });
    expect(a.capabilities.resume).toBe(true);
    expect(a.ready()).toBe(null);
  });

  it('a binary gone since is not ready', () => {
    const a = new AcpAgent({ preset: PRESET, bin: path.join(tmp, 'gone'), home, env: () => ({}), ask: () => Promise.resolve(null), log: () => undefined });
    expect(a.ready()).toBe(koText('acp_missing', { name: 'Mocky' }));
  });
});
