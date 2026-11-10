import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentProvider } from './agents/types.js';
import type { ProjectRecord } from './registry.js';
import { holderOf, type Live, type MatchCtx } from './sessionMatch.js';

const agentOf = (lifetime: 'session' | 'run'): AgentProvider =>
  ({
    id: 'fake',
    capabilities: { lifetime },
    // Claude's rule in short: the base name, or `<base> (N)`.
    nameMatches: (name: string | null | undefined, base: string) => name === base || !!name?.startsWith(`${base} (`),
  }) as unknown as AgentProvider;

describe('sessionMatch', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-match-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rec = (name: string, extra: Partial<ProjectRecord> = {}): ProjectRecord =>
    ({ projectId: `id-${name}`, name, folder: dir, wantRunning: true, ...extra }) as ProjectRecord;
  const session = (agent: AgentProvider, extra: Partial<Live> = {}): Live =>
    ({ pid: 1, cwd: dir, kind: 'background', sessionId: 'sess-0001', name: 'api', agent, ...extra }) as Live;
  const ctxOf = (agent: AgentProvider, projects: ProjectRecord[], live: Live[], lines: string[]): MatchCtx => ({
    projects,
    live,
    agentOf: () => agent,
    host: { os: 'linux', home: dir, caseInsensitive: false } as unknown as MatchCtx['host'],
    logged: new Set<string>(),
    log: (line) => lines.push(line),
  });

  it('two agents in one folder with matching names: neither claims the session, logged once per agent', () => {
    const agent = agentOf('session');
    const a = rec('api');
    const b = rec('api2', { title: 'api' });
    const lines: string[] = [];
    const ctx = ctxOf(agent, [a, b], [session(agent)], lines);
    expect(holderOf(ctx, a)).toBeNull();
    expect(holderOf(ctx, a)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(holderOf(ctx, b)).toBeNull();
    expect(lines).toHaveLength(2);
    // Only its own conversation id makes the session one agent's.
    const own = rec('api', { sessionId: 'sess-0001' });
    expect(holderOf(ctxOf(agent, [own, b], [session(agent)], []), own)?.sessionId).toBe('sess-0001');
  });

  it('a background session wins over the agent\'s own conversation open in a terminal', () => {
    const agent = agentOf('session');
    const p = rec('api', { sessionId: 'sess-conv' });
    const conv = session(agent, { kind: 'interactive', sessionId: 'sess-conv', name: 'other' });
    const bg = session(agent, { sessionId: 'sess-bg' });
    expect(holderOf(ctxOf(agent, [p], [conv, bg], []), p)?.sessionId).toBe('sess-bg');
    expect(holderOf(ctxOf(agent, [p], [conv], []), p)?.sessionId).toBe('sess-conv');
  });

  it("a 'run' provider with no run rests: a made-up background session, until it is not wanted or is ready", () => {
    const agent = agentOf('run');
    const p = rec('api');
    const rest = holderOf(ctxOf(agent, [p], [], []), p);
    expect(rest).toMatchObject({ resting: true, kind: 'background', name: 'api', cwd: dir });
    const off = rec('api', { wantRunning: false });
    expect(holderOf(ctxOf(agent, [off], [], []), off)).toBeNull();
  });
});
