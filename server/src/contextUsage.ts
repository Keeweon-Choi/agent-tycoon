import * as fs from 'fs';

import type { CompactionRecord, ContextLimitBasis } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  COMPACTION_LOG_KEPT,
  CONTEXT_SEED_TAIL_BYTES,
  CONTEXT_WINDOW_TIERS,
  DEFAULT_MAX_CONTEXT_TOKENS,
} from './constants.js';
import type { AgentState } from './types.js';

/**
 * How full an agent's context window is — the context gauge above every character.
 *
 * The number is a SNAPSHOT of the newest turn, never a running total: an
 * agent's context is whatever the last request carried, so it drops when the
 * session compacts or clears. Cached prompt tokens dominate that figure
 * (`input_tokens` alone is usually single digits once caching kicks in), so
 * all three prompt counters are summed plus what the model just wrote.
 */
interface UsageBlock {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** Shape we care about; transcripts carry far more per record. */
interface TranscriptRecord {
  type?: string;
  subtype?: string;
  timestamp?: string;
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
  isSidechain?: boolean;
  /** `contextWindow`: ACP-1's usage records carry the window the agent reported (acp/transcript.ts). */
  message?: { model?: string; usage?: UsageBlock; contextWindow?: number };
}

/**
 * Context size implied by one transcript record, or 0 when it says nothing.
 *
 * Zero covers three cases that all mean "no news": records without usage,
 * synthetic assistant messages (API errors, interrupts) which report all-zero
 * usage, and anything malformed. Callers treat 0 as "leave the gauge alone" —
 * a real context is never 0 once a turn has run.
 */
export function extractContextTokens(record: unknown): number {
  const usage = (record as TranscriptRecord | null)?.message?.usage;
  if (!usage || typeof usage !== 'object') return 0;
  const sum =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0);
  return Number.isFinite(sum) && sum > 0 ? sum : 0;
}

/**
 * The context a compaction left behind: `compactMetadata.postTokens` of a
 * `compact_boundary` record (0 when absent), or null for any other record. The
 * boundary arrives with no assistant turn after it (Claude compacts while idle
 * too), so without it the gauge would keep the context the compaction emptied.
 */
export function extractCompactionTokens(record: unknown): number | null {
  const r = record as TranscriptRecord | null;
  if (r?.type !== 'system' || r.subtype !== 'compact_boundary') return null;
  const post = r.compactMetadata?.postTokens;
  return typeof post === 'number' && Number.isFinite(post) && post > 0 ? post : 0;
}

const wholeTokens = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;

/**
 * The compaction a `compact_boundary` record stands for, or null for any other
 * record. `at` is the record's own time (the daemon's clock when it has none);
 * `trigger` and the token counts are there only when the record carried them.
 */
export function extractCompaction(record: unknown): CompactionRecord | null {
  const r = record as TranscriptRecord | null;
  if (r?.type !== 'system' || r.subtype !== 'compact_boundary') return null;
  const meta = r.compactMetadata;
  const stamped = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  const trigger = meta?.trigger === 'auto' || meta?.trigger === 'manual' ? meta.trigger : undefined;
  const pre = wholeTokens(meta?.preTokens);
  const post = wholeTokens(meta?.postTokens);
  return {
    at: Number.isFinite(stamped) ? stamped : Date.now(),
    ...(trigger && { trigger }),
    ...(pre !== undefined && { preTokens: pre }),
    ...(post !== undefined && { postTokens: post }),
  };
}

/**
 * Window an observed context has to fit in, when nobody can name it.
 *
 * The provider's answer for the model is the real source (see
 * `HookProvider.contextWindowForModel`); this is the backstop for unrecognized
 * models and for windows larger than anything we know about. It only ever
 * widens: a context that doesn't fit proves the assumption too small, while a
 * context that shrinks proves nothing (a 900k session compacted to 20k is
 * still running in a 1M window).
 */
export function widenContextWindow(observed: number, current: number): number {
  const window = Math.max(current || 0, DEFAULT_MAX_CONTEXT_TOKENS);
  for (const tier of CONTEXT_WINDOW_TIERS) {
    if (tier >= observed) return Math.max(window, tier);
  }
  const largest = CONTEXT_WINDOW_TIERS[CONTEXT_WINDOW_TIERS.length - 1];
  return Math.max(window, Math.ceil(observed / largest) * largest);
}

/** What a record's model says about the window: its size and where that comes from. */
interface Declared {
  window?: number;
  basis?: ContextLimitBasis;
}

function applyContextTokens(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  tokens: number,
  fromMainChain: boolean,
  declared: Declared,
): void {
  if (fromMainChain) agent.sawMainChainUsage = true;
  agent.contextTokens = tokens;
  // A named model wins over the running estimate -- switching models mid-session
  // genuinely changes the window, and the provider knows it while we're only
  // guessing from what we've seen.
  // A window the agent reported is the window (it is never widened to our guesses).
  agent.maxContextTokens =
    declared.basis === 'reported' && declared.window && tokens <= declared.window
      ? declared.window
      : widenContextWindow(tokens, declared.window ?? agent.maxContextTokens);
  if (declared.basis) agent.limitBasis = declared.basis;
  agents.broadcast({
    type: 'agentContextUsage',
    id: agentId,
    contextTokens: agent.contextTokens,
    maxContextTokens: agent.maxContextTokens,
    limitBasis: agent.limitBasis ?? 'unknown',
  });
}

/** The agent's compaction log, created on first use. */
function compactionLog(agent: AgentState): NonNullable<AgentState['compactions']> {
  return (agent.compactions ??= { count: 0, partial: false, recent: [] });
}

/** The compactions counted so far, for a broadcast or a client that connects. */
export function compactionsMessage(
  agentId: number,
  log: NonNullable<AgentState['compactions']>,
): Record<string, unknown> {
  return {
    type: 'agentCompactions',
    id: agentId,
    count: log.count,
    ...(log.partial && { partial: true }),
    recent: log.recent,
  };
}

function noteCompaction(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  compaction: CompactionRecord,
): void {
  const log = compactionLog(agent);
  log.count += 1;
  log.recent.push(compaction);
  if (log.recent.length > COMPACTION_LOG_KEPT) log.recent.shift();
  agents.broadcast(compactionsMessage(agentId, log));
}

/** A new transcript (/clear, a teammate's next session) is a new conversation: its count starts over. */
export function resetCompactions(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
): void {
  const had = (agent.compactions?.count ?? 0) > 0;
  agent.compactions = undefined;
  if (had) agents.broadcast(compactionsMessage(agentId, { count: 0, partial: false, recent: [] }));
}

/**
 * Fold one freshly-read transcript record into the agent's context gauge.
 *
 * Sidechain records are another agent's turn, but WHOSE depends on the file:
 * in a lead's transcript they're its sub-agents (older Claude formats inline
 * them) and must not move the lead's gauge; a teammate's own transcript is
 * sidechain top to bottom and would otherwise never report anything. So the
 * rule is positional — once this file has produced a main-chain turn, later
 * sidechain records belong to someone else.
 */
export function updateContextUsage(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  record: unknown,
  provider?: HookProvider | null,
): void {
  const compacted = extractCompactionTokens(record);
  const tokens = compacted ?? extractContextTokens(record);
  if (tokens <= 0 && compacted === null) return;
  const isSidechain = (record as TranscriptRecord | null)?.isSidechain === true;
  if (isSidechain && agent.sawMainChainUsage) return;
  applyContextTokens(agentId, agent, agents, tokens, !isSidechain, declaredBy(record, provider));
  // The daemon counts compactions itself, for every Claude agent (not only an engine
  // project's): the gauge falling is no evidence of one, the boundary record is.
  const compaction = extractCompaction(record);
  if (compaction) noteCompaction(agentId, agent, agents, compaction);
}

/** What the model that wrote this record says about its window. A record naming no
 *  model (a compaction boundary) says nothing and leaves the agent's last word standing. */
function declaredBy(record: unknown, provider?: HookProvider | null): Declared {
  const reported = (record as TranscriptRecord | null)?.message?.contextWindow;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0)
    return { window: Math.round(reported), basis: 'reported' };
  const model = (record as TranscriptRecord | null)?.message?.model;
  if (typeof model !== 'string' || !model || model === '<synthetic>') return {};
  const window = provider?.contextWindowForModel?.(model);
  const basis =
    provider?.contextWindowBasis?.(model) ?? (window === undefined ? 'unknown' : 'estimated');
  return { window, basis };
}

/** The last CONTEXT_SEED_TAIL_BYTES of a transcript as whole lines, or null when
 *  it is unreadable or empty. Shared by every seed that reads a tail on adoption. */
export function readTranscriptTail(jsonlFile: string): string | null {
  try {
    const stat = fs.statSync(jsonlFile);
    const start = Math.max(0, stat.size - CONTEXT_SEED_TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return null;
    const fd = fs.openSync(jsonlFile, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      const text = buf.toString('utf8');
      // A mid-file start lands inside a record; drop that fragment.
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The model the newest record in a transcript's tail names (`message.model`), or
 *  undefined. `<synthetic>` (API errors, interrupts) is no model. */
export function transcriptModel(jsonlFile: string): string | undefined {
  let model: string | undefined;
  for (const line of (readTranscriptTail(jsonlFile) ?? '').split('\n')) {
    try {
      const m = (JSON.parse(line) as TranscriptRecord | null)?.message?.model;
      if (typeof m === 'string' && m && !m.startsWith('<')) model = m;
    } catch {
      /* a partial or malformed line */
    }
  }
  return model;
}

/**
 * Seed the gauge from a transcript's tail when watching starts.
 *
 * Most agents are adopted or restored mid-session with `fileOffset` at
 * end-of-file, so streaming alone leaves them gauge-less until their next
 * turn — an office full of idle agents would show nothing. Reading the last
 * chunk backwards finds the newest usage record without replaying history.
 */
export function seedContextUsage(
  agentId: number,
  agents: AgentStateStore,
  provider?: HookProvider | null,
): void {
  const agent = agents.get(agentId);
  if (!agent || agent.contextTokens > 0 || !agent.jsonlFile) return;

  const text = readTranscriptTail(agent.jsonlFile);
  if (text === null) return; // unreadable or empty -- the stream will seed it on the next turn

  // Newest first. Main-chain wins; sidechain is the fallback that makes
  // teammate transcripts (sidechain-only files) work.
  const lines = text.split('\n');
  let sidechain: { tokens: number; declared: Declared } | null = null;
  // A compaction newer than every turn: the gauge shows what it left, measured
  // in the window of the turn it emptied (the boundary record names no model).
  let compacted: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const post = extractCompactionTokens(record);
    if (post !== null) {
      compacted ??= post;
      continue;
    }
    const tokens = extractContextTokens(record);
    if (tokens <= 0) continue;
    if ((record as TranscriptRecord).isSidechain === true) {
      sidechain ??= { tokens, declared: declaredBy(record, provider) };
      continue;
    }
    const declared = declaredBy(record, provider);
    if (compacted === null) {
      applyContextTokens(agentId, agent, agents, tokens, true, declared);
    } else {
      const widest = declared.window ?? widenContextWindow(tokens, agent.maxContextTokens);
      applyContextTokens(agentId, agent, agents, compacted, true, { ...declared, window: widest });
    }
    return;
  }
  if (compacted !== null) {
    applyContextTokens(agentId, agent, agents, compacted, false, {});
  } else if (sidechain) {
    applyContextTokens(agentId, agent, agents, sidechain.tokens, false, sidechain.declared);
  }
}

/**
 * Count the compactions already in a transcript the stream will not replay.
 *
 * An agent adopted or restored mid-session starts reading at `fileOffset` (the end of the
 * file), so the boundaries before it would never be counted. This reads the
 * CONTEXT_SEED_TAIL_BYTES before that offset and counts the boundaries in it; when the
 * transcript is longer than that, older ones are out of reach and the log says `partial`
 * (the real count is at least what it shows). Boundaries after the offset are the stream's:
 * nothing is counted twice. Runs once per agent per transcript.
 *
 * ponytail: whole-tail sidechain rule (a sidechain boundary counts only if the tail has no
 * main-chain turn), not the stream's positional one; exact for lead and teammate files.
 */
export function seedCompactions(agentId: number, agents: AgentStateStore): void {
  const agent = agents.get(agentId);
  if (!agent || agent.compactions || !agent.jsonlFile) return;
  const log = compactionLog(agent);
  const end = agent.fileOffset;
  if (end <= 0) return; // read from the start by the stream
  let text: string;
  try {
    const start = Math.max(0, end - CONTEXT_SEED_TAIL_BYTES);
    const buf = Buffer.alloc(end - start);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    text = buf.toString('utf8');
    log.partial = start > 0;
    // A mid-file start lands inside a record; drop that fragment.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return;
  }
  const records: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('compact_boundary') && !line.includes('"usage"')) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* a partial or malformed line */
    }
  }
  const mainChain = records.some(
    (r) => (r as TranscriptRecord).isSidechain !== true && extractContextTokens(r) > 0,
  );
  for (const r of records) {
    const compaction = extractCompaction(r);
    if (!compaction) continue;
    if ((r as TranscriptRecord).isSidechain === true && mainChain) continue;
    log.count += 1;
    log.recent.push(compaction);
    if (log.recent.length > COMPACTION_LOG_KEPT) log.recent.shift();
  }
  if (log.count > 0) agents.broadcast(compactionsMessage(agentId, log));
}
