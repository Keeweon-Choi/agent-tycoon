import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { CONTEXT_SEED_TAIL_BYTES, DEFAULT_MAX_CONTEXT_TOKENS } from '../src/constants.js';
import { COMPACTION_LOG_KEPT } from '../src/constants.js';
import {
  extractCompaction,
  extractContextTokens,
  resetCompactions,
  seedCompactions,
  seedContextUsage,
  updateContextUsage,
  widenContextWindow,
} from '../src/contextUsage.js';
import {
  claudeProvider,
  contextWindowBasis,
  contextWindowForModel,
} from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'session',
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeToolDescs: new Map(),
    subagentTools: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    ...overrides,
  } as AgentState;
}

/** Assistant record shaped like Claude's: caching makes input_tokens tiny. */
function assistantRecord(
  opts: {
    input?: number;
    cacheCreation?: number;
    cacheRead?: number;
    output?: number;
    isSidechain?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    isSidechain: opts.isSidechain ?? false,
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: opts.input ?? 2,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        output_tokens: opts.output ?? 0,
      },
    },
  };
}

describe('extractContextTokens', () => {
  it('counts cached prompt tokens, which dominate a real turn', () => {
    expect(
      extractContextTokens(
        assistantRecord({ input: 2, cacheCreation: 501, cacheRead: 443_937, output: 240 }),
      ),
    ).toBe(444_680);
  });

  it('reports nothing for records without usage', () => {
    expect(extractContextTokens({ type: 'user', message: { content: 'hi' } })).toBe(0);
    expect(extractContextTokens({ type: 'progress' })).toBe(0);
    expect(extractContextTokens(null)).toBe(0);
    expect(extractContextTokens('not a record')).toBe(0);
  });

  it('reports nothing for synthetic records, whose usage is all zeros', () => {
    expect(
      extractContextTokens({
        type: 'assistant',
        message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ).toBe(0);
  });
});

describe('claudeProvider.contextWindowForModel', () => {
  it('gives the current models their large window', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8']) {
      expect(contextWindowForModel(model)).toBe(1_000_000);
    }
  });

  it('gives Haiku and the older line the small window', () => {
    for (const model of [
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022',
      'claude-opus-4-1-20250805',
    ]) {
      expect(contextWindowForModel(model)).toBe(200_000);
    }
  });

  it('answers nothing for models it cannot place, rather than guessing', () => {
    expect(contextWindowForModel(undefined)).toBeUndefined();
    expect(contextWindowForModel('<synthetic>')).toBeUndefined();
    // FR-STA-005: a name outside the table is not 1M by default
    for (const model of ['glm-4.6', 'gpt-5-codex', 'my-proxy-model', 'opus']) {
      expect(contextWindowForModel(model)).toBeUndefined();
    }
  });

  it('takes a [1m] suffix at its word', () => {
    expect(contextWindowForModel('claude-opus-4-1[1m]')).toBe(1_000_000);
    expect(contextWindowForModel('some-model[1M]')).toBe(1_000_000);
  });
});

describe('claudeProvider.contextWindowBasis (FR-STA-005)', () => {
  it('a [1m] suffix is reported, a table name estimated, anything else unknown', () => {
    expect(contextWindowBasis('claude-opus-4-1[1m]')).toBe('reported');
    expect(contextWindowBasis('claude-opus-5')).toBe('estimated');
    expect(contextWindowBasis('claude-haiku-4-5-20251001')).toBe('estimated');
    expect(contextWindowBasis('claude-3-5-sonnet-20241022')).toBe('estimated');
    expect(contextWindowBasis('glm-4.6')).toBe('unknown');
  });

  it('says nothing for no model or a synthetic record', () => {
    expect(contextWindowBasis(undefined)).toBeUndefined();
    expect(contextWindowBasis('<synthetic>')).toBeUndefined();
  });

  it('the window and the basis agree: no window, no claim of one', () => {
    for (const model of ['claude-opus-5', 'glm-4.6', 'claude-sonnet-4-1[1m]', 'haiku']) {
      expect(contextWindowForModel(model) === undefined).toBe(
        contextWindowBasis(model) === 'unknown',
      );
    }
  });
});

describe('widenContextWindow', () => {
  it('never reports a window below the default', () => {
    expect(widenContextWindow(1_000, 0)).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
  });

  it('jumps to the next known tier once a context outgrows the default', () => {
    expect(widenContextWindow(444_680, DEFAULT_MAX_CONTEXT_TOKENS)).toBe(1_000_000);
  });

  it('never shrinks, so compaction does not make the gauge lurch', () => {
    expect(widenContextWindow(20_476, 1_000_000)).toBe(1_000_000);
  });

  it('rounds up past the largest known tier instead of pinning at 100%', () => {
    expect(widenContextWindow(1_400_000, DEFAULT_MAX_CONTEXT_TOKENS)).toBe(2_000_000);
  });
});

describe('updateContextUsage', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });

  it('broadcasts the context of the newest turn', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 50_000, output: 300 }));

    expect(messages).toEqual([
      {
        type: 'agentContextUsage',
        id: 1,
        contextTokens: 50_302,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        limitBasis: 'unknown', // no provider, no model table: nobody can name the window
      },
    ]);
  });

  it('snapshots rather than accumulates: the gauge falls after a compaction', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 240_000 }));
    expect(agent.contextTokens).toBe(240_002);
    expect(agent.maxContextTokens).toBe(1_000_000);

    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 20_000 }));
    expect(agent.contextTokens).toBe(20_002);
    // The window learned from the pre-compaction turn stays put.
    expect(agent.maxContextTokens).toBe(1_000_000);
  });

  describe('compact_boundary', () => {
    const boundary = (postTokens?: number): Record<string, unknown> => ({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'auto', preTokens: 345_417, ...(postTokens && { postTokens }) },
    });

    it('drops the gauge to postTokens when no turn follows (idle compaction)', () => {
      updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 345_304 }));
      expect(agent.contextTokens).toBe(345_306);
      updateContextUsage(1, agent, agents, boundary(15_972));
      expect(agent.contextTokens).toBe(15_972);
      expect(messages.filter((m) => m.type === 'agentContextUsage').at(-1)).toMatchObject({
        contextTokens: 15_972,
      });
      // the window learned from the pre-compaction turn stays put
      expect(agent.maxContextTokens).toBe(1_000_000);
    });

    it('is 0 when the boundary carries no postTokens', () => {
      updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 100_000 }));
      updateContextUsage(1, agent, agents, boundary());
      expect(agent.contextTokens).toBe(0);
    });

    it('is replaced by the next assistant usage', () => {
      updateContextUsage(1, agent, agents, boundary(15_972));
      updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 19_998 }));
      expect(agent.contextTokens).toBe(20_000);
    });
  });

  it('leaves the gauge alone for records that report nothing', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 50_000 }));
    updateContextUsage(1, agent, agents, { type: 'user', message: { content: 'next prompt' } });

    expect(agent.contextTokens).toBe(50_002);
    expect(messages).toHaveLength(1);
  });

  it("ignores a lead's sidechain records -- those turns are its sub-agents'", () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 120_000 }));
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 8_000, isSidechain: true }));

    expect(agent.contextTokens).toBe(120_002);
    expect(messages).toHaveLength(1);
  });

  it("measures against the provider's window for the model that wrote the turn", () => {
    // Real numbers: a fresh Opus 5 session's first turn. Against the 200k
    // default this reads 17% -- five times what Claude Code itself reports.
    updateContextUsage(
      1,
      agent,
      agents,
      assistantRecord({ input: 2, cacheCreation: 12_753, cacheRead: 20_623, output: 226 }),
      claudeProvider,
    );

    expect(agent.contextTokens).toBe(33_604);
    expect(agent.maxContextTokens).toBe(1_000_000);
  });

  it('follows the window down when the session switches to a smaller model', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 50_000 }), claudeProvider);
    expect(agent.maxContextTokens).toBe(1_000_000);

    updateContextUsage(
      1,
      agent,
      agents,
      {
        ...assistantRecord({ cacheRead: 50_000 }),
        message: { model: 'claude-haiku-4-5-20251001', usage: { cache_read_input_tokens: 50_000 } },
      },
      claudeProvider,
    );
    expect(agent.maxContextTokens).toBe(200_000);
  });

  it('widens past the declared window rather than showing more than 100%', () => {
    updateContextUsage(
      1,
      agent,
      agents,
      {
        type: 'assistant',
        message: {
          model: 'claude-haiku-4-5-20251001',
          usage: { cache_read_input_tokens: 260_000 },
        },
      },
      claudeProvider,
    );

    expect(agent.maxContextTokens).toBe(1_000_000);
  });

  it('reads sidechain records in a teammate transcript, which has nothing else', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 44_651, isSidechain: true }));
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 53_695, isSidechain: true }));

    expect(agent.contextTokens).toBe(53_697);
    expect(messages).toHaveLength(2);
  });
});

describe('limitBasis on the gauge', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;
  beforeEach(() => {
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });
  const turn = (model: string | undefined, cacheRead = 50_000) => ({
    type: 'assistant',
    message: { ...(model && { model }), usage: { cache_read_input_tokens: cacheRead } },
  });
  const basisSent = () => messages.filter((m) => m.type === 'agentContextUsage').at(-1)?.limitBasis;

  it('a table model is estimated, a [1m] one reported, an unlisted one unknown', () => {
    updateContextUsage(1, agent, agents, turn('claude-opus-5'), claudeProvider);
    expect(basisSent()).toBe('estimated');
    updateContextUsage(1, agent, agents, turn('claude-opus-4-1[1m]'), claudeProvider);
    expect(basisSent()).toBe('reported');
    updateContextUsage(1, agent, agents, turn('glm-4.6'), claudeProvider);
    expect(basisSent()).toBe('unknown');
  });

  it('widening past the table window stays an estimate', () => {
    updateContextUsage(1, agent, agents, turn('claude-haiku-4-5', 260_000), claudeProvider);
    expect(agent.maxContextTokens).toBe(1_000_000);
    expect(basisSent()).toBe('estimated');
  });

  it('a record with no model keeps the last word; with none ever, the window is unknown', () => {
    updateContextUsage(1, agent, agents, turn(undefined), claudeProvider);
    expect(basisSent()).toBe('unknown');
    updateContextUsage(1, agent, agents, turn('claude-opus-5'), claudeProvider);
    updateContextUsage(1, agent, agents, turn(undefined, 60_000), claudeProvider);
    expect(basisSent()).toBe('estimated');
  });

  it('a compaction boundary does not change it', () => {
    updateContextUsage(1, agent, agents, turn('claude-opus-4-1[1m]'), claudeProvider);
    updateContextUsage(
      1,
      agent,
      agents,
      { type: 'system', subtype: 'compact_boundary' },
      claudeProvider,
    );
    expect(basisSent()).toBe('reported');
  });

  it('seeding from a transcript tail carries it too', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tycoon-basis-'));
    try {
      const file = path.join(dir, 's.jsonl');
      fs.writeFileSync(file, JSON.stringify(turn('glm-4.6')) + '\n');
      const seeded = createTestAgent({ id: 2, jsonlFile: file });
      agents.set(2, seeded);
      seedContextUsage(2, agents, claudeProvider);
      expect(seeded.limitBasis).toBe('unknown');
      expect(basisSent()).toBe('unknown');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compactions counted by the daemon', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;
  beforeEach(() => {
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });
  const boundary = (extra: Record<string, unknown> = {}, meta?: Record<string, unknown>) => ({
    type: 'system',
    subtype: 'compact_boundary',
    ...(meta && { compactMetadata: meta }),
    ...extra,
  });
  const sent = () => messages.filter((m) => m.type === 'agentCompactions');

  it("extractCompaction reads the record's own time, trigger and token counts, and only those it has", () => {
    expect(
      extractCompaction(
        boundary(
          { timestamp: '2026-11-04T05:02:03.000Z' },
          { trigger: 'auto', preTokens: 412_000, postTokens: 38_000 },
        ),
      ),
    ).toEqual({
      at: Date.parse('2026-11-04T05:02:03.000Z'),
      trigger: 'auto',
      preTokens: 412_000,
      postTokens: 38_000,
    });
    expect(
      extractCompaction(boundary({ timestamp: '2026-11-04T05:02:03.000Z' }, { trigger: 'manual' })),
    ).toEqual({
      at: Date.parse('2026-11-04T05:02:03.000Z'),
      trigger: 'manual',
    });
    // nothing usable: the daemon's own clock, no invented fields
    const bare = extractCompaction(
      boundary({}, { trigger: 'weird', preTokens: -5, postTokens: 'x' }),
    );
    expect(Object.keys(bare!)).toEqual(['at']);
    expect(Math.abs(bare!.at - Date.now())).toBeLessThan(5_000);
  });

  it('other records are no compaction', () => {
    for (const r of [
      assistantRecord(),
      { type: 'user' },
      { type: 'system', subtype: 'init' },
      null,
      'x',
    ]) {
      expect(extractCompaction(r)).toBeNull();
    }
  });

  it('counts each boundary once and sends the log; the gauge falling alone counts nothing', () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 300_000 }));
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 10_000 })); // 97% fall, no boundary
    expect(agent.compactions).toBeUndefined();
    expect(sent()).toHaveLength(0);

    updateContextUsage(
      1,
      agent,
      agents,
      boundary(
        { timestamp: '2026-11-04T05:00:00Z' },
        { trigger: 'auto', preTokens: 300_000, postTokens: 15_000 },
      ),
    );
    updateContextUsage(
      1,
      agent,
      agents,
      boundary({ timestamp: '2026-11-04T06:00:00Z' }, { trigger: 'manual' }),
    );
    expect(agent.compactions?.count).toBe(2);
    expect(sent().at(-1)).toEqual({
      type: 'agentCompactions',
      id: 1,
      count: 2,
      recent: [
        {
          at: Date.parse('2026-11-04T05:00:00Z'),
          trigger: 'auto',
          preTokens: 300_000,
          postTokens: 15_000,
        },
        { at: Date.parse('2026-11-04T06:00:00Z'), trigger: 'manual' },
      ],
    });
  });

  it('keeps only the newest few; the count keeps going', () => {
    for (let i = 0; i < COMPACTION_LOG_KEPT + 3; i++)
      updateContextUsage(
        1,
        agent,
        agents,
        boundary({ timestamp: new Date(1_000_000 + i * 1000).toISOString() }, { trigger: 'auto' }),
      );
    expect(agent.compactions?.count).toBe(COMPACTION_LOG_KEPT + 3);
    expect(agent.compactions?.recent).toHaveLength(COMPACTION_LOG_KEPT);
    expect(agent.compactions?.recent[0].at).toBe(1_000_000 + 3 * 1000); // the oldest three are gone
    expect(sent().at(-1)?.recent).toHaveLength(COMPACTION_LOG_KEPT);
  });

  it("a lead does not count its sub-agents' boundaries once its own turn was seen; a teammate file counts its own", () => {
    updateContextUsage(1, agent, agents, assistantRecord({ cacheRead: 50_000 }));
    updateContextUsage(1, agent, agents, boundary({ isSidechain: true }));
    expect(agent.compactions).toBeUndefined();

    const teammate = createTestAgent({ id: 2 });
    agents.set(2, teammate);
    updateContextUsage(2, teammate, agents, boundary({ isSidechain: true }));
    expect(teammate.compactions?.count).toBe(1);
  });

  it('a new transcript starts over, and tells the screens', () => {
    updateContextUsage(1, agent, agents, boundary());
    resetCompactions(1, agent, agents);
    expect(agent.compactions).toBeUndefined();
    expect(sent().at(-1)).toEqual({ type: 'agentCompactions', id: 1, count: 0, recent: [] });
    // nothing to say when nothing was counted
    messages.length = 0;
    resetCompactions(1, agent, agents);
    expect(sent()).toHaveLength(0);
  });

  describe('seedCompactions (an agent adopted mid-session)', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tycoon-compactions-'));
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const seeded = (records: Array<Record<string, unknown>>, atEnd = true, id = 5): AgentState => {
      const file = path.join(tmpDir, `s${id}.jsonl`);
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const a = createTestAgent({
        id,
        jsonlFile: file,
        fileOffset: atEnd ? fs.statSync(file).size : 0,
      });
      agents.set(id, a);
      seedCompactions(id, agents);
      return a;
    };

    it('counts the boundaries the stream will not replay, whole conversation in reach', () => {
      const a = seeded([
        assistantRecord(),
        boundary({}, { trigger: 'auto' }),
        assistantRecord(),
        boundary(),
      ]);
      expect(a.compactions).toMatchObject({ count: 2, partial: false });
      expect(sent().at(-1)).toMatchObject({ id: 5, count: 2 });
      expect(sent().at(-1)).not.toHaveProperty('partial');
    });

    it('a file the stream reads from the start is not counted twice', () => {
      const a = seeded([assistantRecord(), boundary()], false);
      expect(a.compactions).toEqual({ count: 0, partial: false, recent: [] });
      expect(sent()).toHaveLength(0);
    });

    it('counts only what lies before the offset: the rest is the stream’s', () => {
      const records = [boundary(), assistantRecord(), boundary()];
      const file = path.join(tmpDir, 'mid.jsonl');
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const firstLine = JSON.stringify(records[0]).length + 1;
      const a = createTestAgent({ id: 9, jsonlFile: file, fileOffset: firstLine });
      agents.set(9, a);
      seedCompactions(9, agents);
      expect(a.compactions?.count).toBe(1);
    });

    it('a conversation longer than the tail reads as a floor', () => {
      const filler = { type: 'user', message: { content: 'x'.repeat(4_000) } };
      const fillerCount = Math.ceil(CONTEXT_SEED_TAIL_BYTES / 4_000) + 10;
      const a = seeded([
        boundary(), // out of reach
        ...Array.from({ length: fillerCount }, () => filler),
        assistantRecord(),
        boundary(),
      ]);
      expect(a.compactions).toMatchObject({ count: 1, partial: true });
      expect(sent().at(-1)).toMatchObject({ count: 1, partial: true });
    });

    it('runs once per transcript', () => {
      const a = seeded([boundary()]);
      seedCompactions(5, agents);
      seedCompactions(5, agents);
      expect(a.compactions?.count).toBe(1);
      expect(sent()).toHaveLength(1);
    });

    it('ignores a boundary under sub-agent turns the same way the stream does, and a missing file', () => {
      expect(
        seeded([assistantRecord(), boundary({ isSidechain: true })], true, 6).compactions?.count,
      ).toBe(0);
      expect(
        seeded([assistantRecord({ isSidechain: true }), boundary({ isSidechain: true })], true, 7)
          .compactions?.count,
      ).toBe(1);
      const gone = createTestAgent({
        id: 8,
        jsonlFile: path.join(tmpDir, 'gone.jsonl'),
        fileOffset: 50,
      });
      agents.set(8, gone);
      expect(() => seedCompactions(8, agents)).not.toThrow();
    });
  });
});

describe('seedContextUsage', () => {
  let tmpDir: string;
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tycoon-context-'));
    agents = new AgentStateStore();
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(name: string, records: Array<Record<string, unknown>>): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  function seedAgent(jsonlFile: string, overrides: Partial<AgentState> = {}): AgentState {
    const agent = createTestAgent({ jsonlFile, ...overrides });
    agents.set(agent.id, agent);
    seedContextUsage(agent.id, agents);
    return agent;
  }

  it('seeds from the newest turn so a mid-session adoption has a gauge immediately', () => {
    const file = writeTranscript('session.jsonl', [
      assistantRecord({ cacheRead: 10_000 }),
      assistantRecord({ cacheRead: 90_000 }),
      { type: 'user', message: { content: 'a prompt with no usage' } },
    ]);

    const agent = seedAgent(file);

    expect(agent.contextTokens).toBe(90_002);
    expect(messages).toHaveLength(1);
  });

  it('seeds a boundary newer than the last turn as its postTokens, in the emptied turn window', () => {
    const file = writeTranscript('idle.jsonl', [
      assistantRecord({ cacheRead: 345_304 }),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { postTokens: 15_972 } },
      { type: 'user', isCompactSummary: true, message: { content: 'summary' } },
    ]);

    const agent = seedAgent(file);

    expect(agent.contextTokens).toBe(15_972);
    expect(agent.maxContextTokens).toBe(1_000_000);
  });

  it('seeds a boundary without postTokens as 0, and ignores an older boundary under a newer turn', () => {
    const boundary = { type: 'system', subtype: 'compact_boundary' };
    expect(
      seedAgent(writeTranscript('a.jsonl', [assistantRecord({ cacheRead: 99_998 }), boundary]), {
        id: 3,
      }).contextTokens,
    ).toBe(0);
    expect(
      seedAgent(
        writeTranscript('b.jsonl', [
          assistantRecord({ cacheRead: 300_000 }),
          { ...boundary, compactMetadata: { postTokens: 15_972 } },
          assistantRecord({ cacheRead: 40_000 }),
        ]),
        { id: 4 },
      ).contextTokens,
    ).toBe(40_002);
  });

  it('prefers the main chain over a sub-agent turn recorded after it', () => {
    const file = writeTranscript('lead.jsonl', [
      assistantRecord({ cacheRead: 150_000 }),
      assistantRecord({ cacheRead: 5_000, isSidechain: true }),
    ]);

    expect(seedAgent(file).contextTokens).toBe(150_002);
  });

  it('falls back to sidechain records for a teammate transcript', () => {
    const file = writeTranscript('teammate.jsonl', [
      assistantRecord({ cacheRead: 44_651, isSidechain: true }),
      assistantRecord({ cacheRead: 53_695, isSidechain: true }),
    ]);

    expect(seedAgent(file).contextTokens).toBe(53_697);
  });

  it('reads only the tail, skipping the record the read landed inside', () => {
    const filler = { type: 'user', message: { content: 'x'.repeat(4_000) } };
    const fillerCount = Math.ceil(CONTEXT_SEED_TAIL_BYTES / 4_000) + 10;
    const file = writeTranscript('long.jsonl', [
      assistantRecord({ cacheRead: 1_000 }),
      ...Array.from({ length: fillerCount }, () => filler),
      assistantRecord({ cacheRead: 77_000 }),
    ]);
    expect(fs.statSync(file).size).toBeGreaterThan(CONTEXT_SEED_TAIL_BYTES);

    expect(seedAgent(file).contextTokens).toBe(77_002);
  });

  it('stays quiet for a transcript with no turns yet, and for a missing file', () => {
    seedAgent(writeTranscript('fresh.jsonl', [{ type: 'user', message: { content: 'hello' } }]));
    seedAgent(path.join(tmpDir, 'gone.jsonl'), { id: 2 });

    expect(messages).toHaveLength(0);
  });

  it('leaves an agent that already reported its context untouched', () => {
    const file = writeTranscript('known.jsonl', [assistantRecord({ cacheRead: 90_000 })]);

    const agent = seedAgent(file, { contextTokens: 12_345 });

    expect(agent.contextTokens).toBe(12_345);
    expect(messages).toHaveLength(0);
  });
});
