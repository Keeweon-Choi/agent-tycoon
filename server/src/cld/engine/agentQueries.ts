/**
 * BRN K3 (cld/docs/design/project-brain.md Appendix A.4, FR-TRC-015): the agent query tools behind
 * the MCP adapter. Read only: no LLM, no agent woken, nothing written but one `agent_query` line in
 * events.jsonl per call. The caller is the agent its CLD_AGENT_TOKEN names (control.ts, mcpTools.ts)
 * and sees its own project only; messages only of its own conversation and the rooms it is in.
 *
 * Answerability (BRN §12): a question these tools do not cover gets `status: 'not_covered'` and what
 * is missing, never a guess; a partly covered answer carries `missing` beside what it has. Every
 * call's tool, its masked arguments and how it was covered go to the event, with the running counts
 * (asked, not covered) since the daemon started.
 *
 * Limits: AGENT_QUERY_PER_MINUTE calls a minute per agent over all these tools; each answer at most
 * AGENT_QUERY_BYTES (search 4 KB, get_resume_context 16 KB), cut with `truncated`. The trace index
 * is the spec reader's (built on a read, let go SPEC_TRACE_IDLE_MS after the last one; the code
 * scan runs in its child process); a message read holds nothing. Text goes through maskText;
 * documents marked 민감 are left out.
 */
import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import * as path from 'path';

import type {
  BrainRef,
  ResumeSection,
  TraceEdge,
  TraceGraph,
  TraceItem,
  TraceMap,
  TraceNode,
  TraceRecent,
  TraceResume,
  TraceTaskReqs,
} from '../../../../core/src/cld/spec/trace.js';
import type { BoardTask, ChatItem } from '../../../../core/src/messages.js';
import {
  AGENT_QUERY_ASK_MAX,
  AGENT_QUERY_BYTES,
  AGENT_QUERY_FILES_MAX,
  AGENT_QUERY_GIT_BYTES,
  AGENT_QUERY_GIT_MS,
  AGENT_QUERY_LINE_MAX,
  AGENT_QUERY_MODULES_MAX,
  AGENT_QUERY_PER_MINUTE,
  AGENT_QUERY_RESUME_BYTES,
  AGENT_QUERY_ROOM_POSTS,
  AGENT_QUERY_SEARCH_BYTES,
  AGENT_QUERY_SEARCH_ROWS,
  AGENT_QUERY_SINCE_COMMITS,
  AGENT_QUERY_SINCE_TASKS,
  AGENT_QUERY_WINDOW_MS,
  RESUME_ITEM_CHARS,
  RESUME_SECTION_ITEMS,
} from '../../constants.js';
import { labelPrefixes } from '../labels.js';
import { MASK_LINE_MAX, maskText } from '../mask.js';
import { messageAround } from '../transcriptHistory.js';
import { configDir } from './events.js';
import { createGitRunner, type GitRunner, READ_ENV } from './git/gitRun.js';
import type { GroupPost } from './groupMessages.js';
import type { GroupRoom } from './groups.js';
import {
  handoffFormat,
  handoffItem,
  handoffRefs,
  handoffSections,
  keepCommits,
} from './handoff.js';
import type { RosterAgent } from './mcpTools.js';
import { readRenewHistory } from './renewals.js';
import type { TaskStore } from './tasks.js';

export const QUERY_TOOLS: ReadonlySet<string> = new Set([
  'get_message',
  'get_requirement',
  'search_requirements',
  'get_related_context',
  'get_task_context',
  'get_resume_context',
  'get_traceability_summary',
]);
const CAP: Record<string, number> = {
  search_requirements: AGENT_QUERY_SEARCH_BYTES,
  get_resume_context: AGENT_QUERY_RESUME_BYTES,
};

type Read<T> = { ok: true; value: T } | { ok: false; error: string };
/** One row of the spec reader's item list (SpecService.items), the fields read here. */
export interface SpecRow {
  uid: string;
  displayId?: string;
  title: string;
  section: string;
  doc: string;
  kind: string;
  trace?: unknown;
}
/** The spec reader's reads (SpecService), bound by project name in the office. Null: the project
 *  is unknown to it. */
export interface SpecReads {
  head(project: string): Promise<{ rev: number; head: string | null } | null>;
  /** The documents marked 민감 (paths) and the requirements they define (UIDs). */
  sensitive(project: string): { paths: Set<string>; uids: Set<string> };
  summary(project: string): Promise<(Record<string, unknown> & { enabled: boolean }) | null>;
  items(
    project: string,
    q: { q: string; limit: number },
  ): Promise<Read<{ enabled: boolean; total: number; items: SpecRow[] }> | null>;
  item(project: string, uid: string): Promise<Read<TraceItem> | null>;
  graph(
    project: string,
    q: { level: 'neighbourhood'; center: string; depth: number },
  ): Promise<Read<TraceGraph> | null>;
  task(project: string, taskId: string): Promise<Read<TraceTaskReqs> | null>;
  taskCode(
    project: string,
    taskId: string,
  ): Promise<Read<{
    files: string[];
    filesTotal: number;
    modules: Array<{ id: string; name: string; files: number }>;
  } | null> | null>;
  recent(project: string): Promise<Read<TraceRecent> | null>;
  map(project: string): Promise<Read<TraceMap> | null>;
}

export interface QueryDeps {
  home: string;
  /** The agent's conversation now (its recorded chain goes on to the ones before); null: none. */
  transcriptOf(name: string): string | null;
  /** The agent's work folder (git reads of get_resume_context). */
  folderOf(name: string): string | null;
  rooms(): GroupRoom[];
  /** A room's newest `limit` posts, oldest first. */
  timeline(room: GroupRoom, limit: number): GroupPost[];
  tasks: TaskStore;
  /** One events.jsonl line. */
  event(type: string, fields: Record<string, unknown>): void;
  /** Absent: the requirement tools answer not_covered (no spec reader in this daemon). */
  spec?: SpecReads;
  run?: GitRunner;
  now?: () => number;
}

type Result = Record<string, unknown>;
type Miss = { code: string; message: string };
const fail = (code: string, message: string) => ({ error: { code, message } });
const miss = (code: string, message: string): Miss => ({ code, message });
const MISS = {
  noSpec: miss('no_spec', 'requirements are not read in this daemon'),
  trackingOff: miss(
    'tracking_off',
    'document tracking is off for your project: no requirement is indexed',
  ),
  sensitive: miss('sensitive', 'it is in a document marked sensitive: agents do not read it'),
};
const UID = /^r_[a-z2-7]{10}$/;
/** A message id as a reply names it (core/src/cld/reply.ts REPLY_ID), with or without its `⟨m:`/`⟨re:` mark. */
const MESSAGE_ID = /^(?:⟨(?:m|re):)?([A-Za-z0-9._:-]{1,64})⟩?$/;
// T-80: the handoff's first line reads `[agty renew · ` now and `[cld-gui renew · ` in conversations from before (drop the old one a release later).
const RENEW_HEADS = labelPrefixes(' renew · ');
const RENEW_HEAD_MAX = Math.max(...RENEW_HEADS.map((h) => h.length));
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);
/** At most n UTF-16 units, never splitting a surrogate pair (an emoji at the mark). */
const cut = (t: string, n = AGENT_QUERY_LINE_MAX) => {
  if (t.length <= n) return t;
  const end = /[\uD800-\uDBFF]/.test(t[n - 1]) ? n - 1 : n;
  return `${t.slice(0, end)}…`;
};
const iso = (ms: number) => new Date(ms).toISOString();

/** The call being answered: a source line maskText cut (over MASK_LINE_MAX) makes it `truncated`. */
const cutLines = new AsyncLocalStorage<{ cut: boolean }>();
/** maskText, noting on the call when a line was over the cap (maskText cuts it silently). */
function mask(text: string): string {
  const call = cutLines.getStore();
  if (call && text.length > MASK_LINE_MAX && text.split('\n').some((l) => l.length > MASK_LINE_MAX))
    call.cut = true;
  return maskText(text);
}

export class AgentQueries {
  private readonly now: () => number;
  private readonly run: GitRunner;
  /** Agent name → its query calls in the last window. */
  private readonly calls = new Map<string, number[]>();
  /** Agent name → its refused window: until when, and the refusals not logged since the logged one. */
  private readonly refused = new Map<string, { until: number; dropped: number }>();
  private asked = 0;
  private uncovered = 0;

  constructor(private readonly d: QueryDeps) {
    this.now = d.now ?? Date.now;
    this.run = d.run ?? createGitRunner();
  }

  /** D3b: names that answer for other sessions now start a fresh window. */
  forget(names: readonly string[]): void {
    for (const n of names) {
      this.calls.delete(n);
      this.refused.delete(n);
    }
  }

  /** One query by agent `me` (already identified by its token and known to have a project). */
  async call(me: RosterAgent, tool: string, input: Record<string, unknown>): Promise<Result> {
    const now = this.now();
    const times = (this.calls.get(me.name) ?? []).filter((t) => now - t < AGENT_QUERY_WINDOW_MS);
    this.calls.set(me.name, times);
    let r: Result;
    const refused = this.refused.get(me.name);
    if (times.length >= AGENT_QUERY_PER_MINUTE && refused && now < refused.until) {
      // A looping agent: one event per refused window, the rest counted into the next one logged.
      refused.dropped++;
      return {
        ...fail('rate_limited', `more than ${AGENT_QUERY_PER_MINUTE} queries a minute`),
        retryAfterSec: Math.max(1, Math.ceil((refused.until - now) / 1000)),
      };
    }
    if (times.length >= AGENT_QUERY_PER_MINUTE)
      r = {
        ...fail('rate_limited', `more than ${AGENT_QUERY_PER_MINUTE} queries a minute`),
        retryAfterSec: Math.max(1, Math.ceil((times[0] + AGENT_QUERY_WINDOW_MS - now) / 1000)),
      };
    else {
      times.push(now);
      try {
        const call = { cut: false };
        r = await cutLines.run(call, () => this.answer(me, tool, input));
        if (call.cut && !('error' in r)) r = { ...r, truncated: true };
      } catch (err) {
        r = fail('daemon_error', err instanceof Error ? err.message : String(err));
      }
    }
    const error = (r.error as { code?: string } | undefined)?.code;
    const missing = (r.missing as Miss[] | undefined)?.map((m) => m.code);
    const covered = error
      ? 'error'
      : r.status === 'not_covered'
        ? 'none'
        : missing?.length
          ? 'partial'
          : 'full';
    this.asked++;
    if (covered === 'none') this.uncovered++;
    const dropped = refused?.dropped ?? 0;
    if (error === 'rate_limited')
      this.refused.set(me.name, { until: times[0] + AGENT_QUERY_WINDOW_MS, dropped: 0 });
    else this.refused.delete(me.name);
    this.d.event('agent_query', {
      from: me.name,
      project: me.project,
      tool,
      // Each string masked as the text it is (per-line rules: an env dump, a key), then the keys.
      ask: cut(
        maskText(
          JSON.stringify(input, (_k, v: unknown) => (typeof v === 'string' ? maskText(v) : v)),
        ),
        AGENT_QUERY_ASK_MAX,
      ),
      covered,
      ...(missing?.length && { missing }),
      ...(error && { code: error }),
      asked: this.asked,
      notCovered: this.uncovered,
      ...(dropped > 0 && { droppedRateLimited: dropped }),
    });
    return fit(r, CAP[tool] ?? AGENT_QUERY_BYTES);
  }

  private async answer(
    me: RosterAgent,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<Result> {
    const project = me.project!;
    const head = await this.head(project);
    const out = (body: Result) => ({ ...head, ...body });
    const none = (missing: Miss[]) => out({ status: 'not_covered', missing });
    switch (tool) {
      case 'get_message':
        return this.message(me, input, out, none);
      case 'get_resume_context':
        return this.resume(me, out, none);
      case 'get_task_context':
        return this.taskContext(me, input, out, none);
    }
    const spec = this.d.spec;
    if (!spec) return none([MISS.noSpec]);
    switch (tool) {
      case 'get_requirement': {
        const r = await this.requirement(project, input.id);
        if ('error' in r) return r;
        if ('missing' in r) return none(r.missing);
        return out({ requirement: r.item, ...(r.also && { alsoDefinedAs: r.also }) });
      }
      case 'search_requirements': {
        const q = str(input.query);
        if (!q || q.length > 100)
          return fail(
            'bad_input',
            'query is required (1-100 characters: a display ID or words of a title)',
          );
        const r = await spec.items(project, { q, limit: AGENT_QUERY_SEARCH_ROWS });
        if (!r) return none([MISS.noSpec]);
        if (!r.ok) return fail('spec_error', r.error);
        if (!r.value.enabled) return none([MISS.trackingOff]);
        const hidden = spec.sensitive(project).paths;
        const rows = r.value.items.filter((x) => !hidden.has(x.doc));
        if (!rows.length)
          return none([
            miss(
              'not_found',
              `no requirement of your project's tracked documents has '${q}' in its ID or title`,
            ),
          ]);
        return out({
          total: r.value.total - (r.value.items.length - rows.length),
          items: rows.map((x) => ({
            uid: x.uid,
            ...(x.displayId && { id: x.displayId }),
            title: x.title,
            section: x.section,
            doc: x.doc,
            kind: x.kind,
          })),
        });
      }
      case 'get_related_context': {
        const depth = input.depth ?? 1;
        if (depth !== 1 && depth !== 2) return fail('bad_input', 'depth must be 1 or 2');
        const r = await this.requirement(project, input.id);
        if ('error' in r) return r;
        if ('missing' in r) return none(r.missing);
        const g = await spec.graph(project, { level: 'neighbourhood', center: r.uid, depth });
        if (!g || !g.ok) return g ? fail('spec_error', g.error) : none([MISS.noSpec]);
        const { nodes, edges } = visible(
          g.value.nodes,
          g.value.edges,
          spec.sensitive(project).paths,
          r.uid,
        );
        if (!edges.length)
          return none([
            miss(
              'no_link',
              `${r.item.node.label} has no link to anything yet (no Task, commit, job, component or other requirement names it)`,
            ),
          ]);
        return out({ center: r.uid, nodes: nodes.map(brief), edges: edges.map(edge) });
      }
      case 'get_traceability_summary':
        return this.summary(project, out, none);
      default:
        return fail('unknown_tool', `no tool '${tool}'`);
    }
  }

  private async head(project: string): Promise<Result> {
    const h = await this.d.spec?.head(project).catch(() => null);
    return { project, rev: h?.rev ?? null, asOf: iso(this.now()), head: h?.head ?? null };
  }

  /** A requirement by its UID or its display ID (`FR-TRC-015`), with its detail; or what is missing. */
  private async requirement(
    project: string,
    raw: unknown,
  ): Promise<
    | { error: Miss }
    | { missing: Miss[] }
    | { uid: string; item: Result & { node: TraceNode }; also?: string[] }
  > {
    const id = str(raw);
    if (!id || id.length > 100)
      return fail('bad_input', 'id is required: a requirement UID (r_…) or its display ID');
    const spec = this.d.spec!;
    let uid = UID.test(id) ? id : null;
    let also: string[] | undefined;
    if (!uid) {
      const r = await spec.items(project, { q: id, limit: AGENT_QUERY_SEARCH_ROWS });
      if (!r) return { missing: [MISS.noSpec] };
      if (!r.ok) return fail('spec_error', r.error);
      if (!r.value.enabled) return { missing: [MISS.trackingOff] };
      const all = r.value.items.filter((x) => x.displayId?.toLowerCase() === id.toLowerCase());
      const hidden = spec.sensitive(project).paths;
      const hits = all.filter((x) => !hidden.has(x.doc));
      if (!all.length)
        return {
          missing: [miss('not_found', `no tracked document of your project defines '${id}'`)],
        };
      if (!hits.length) return { missing: [MISS.sensitive] };
      uid = hits[0].uid;
      if (hits.length > 1) also = hits.slice(1).map((x) => x.uid);
    }
    const r = await spec.item(project, uid);
    if (!r) return { missing: [MISS.noSpec] };
    if (!r.ok)
      return r.error === 'off'
        ? { missing: [MISS.trackingOff] }
        : r.error === 'item'
          ? { missing: [miss('not_found', `no requirement '${id}' in your project`)] }
          : fail('spec_error', r.error);
    const hidden = spec.sensitive(project).paths;
    if (hidden.has(r.value.node.source?.path ?? '')) return { missing: [MISS.sensitive] };
    const { history: _h, edges: e0, nodes: n0, acceptance, ...rest } = r.value;
    const { nodes, edges } = visible(n0, e0, hidden, uid);
    return {
      uid,
      item: {
        ...rest,
        node: rest.node,
        ...(rest.text && { text: mask(rest.text) }),
        ...(acceptance?.length && { acceptance: acceptance.slice(0, 3) }),
        links: edges.map(edge),
        nodes: nodes.map(brief),
      },
      ...(also && { also }),
    };
  }

  private async summary(
    project: string,
    out: (b: Result) => Result,
    none: (m: Miss[]) => Result,
  ): Promise<Result> {
    const spec = this.d.spec!;
    const s = await spec.summary(project);
    if (!s) return none([MISS.noSpec]);
    if (!s.enabled) return none([MISS.trackingOff]);
    // The 개요's `missing` (requirements whose end is gone) is `endMissing` here: `missing` is what this answer lacks.
    const pick = (k: string) => (k in s ? { [k === 'missing' ? 'endMissing' : k]: s[k] } : {});
    const missing: Miss[] = [];
    // The 개요's counts include the documents marked 민감 and cannot be split: with any, they are left
    // out; the feature list (built without those documents' requirements) still answers.
    const hidden = spec.sensitive(project);
    if (hidden.paths.size)
      missing.push(
        miss(
          'sensitive_counts',
          'the document and requirement counts are left out: some documents are marked sensitive',
        ),
      );
    const map = await spec.map(project);
    const recent = await spec.recent(project);
    if (!map?.ok) missing.push(miss('no_map', 'the feature list could not be read'));
    if (!recent?.ok) missing.push(miss('no_recent', 'the recent changes could not be read'));
    return out({
      ...(!hidden.paths.size &&
        ['docs', 'items', 'questions', 'review', 'unlinked', 'linkReview', 'missing'].reduce(
          (a, k) => ({ ...a, ...pick(k) }),
          {},
        )),
      ...(map?.ok && { requirements: map.value.reqTotal }),
      ...(map?.ok && {
        features: map.value.features.map((f) => ({
          key: f.key,
          name: f.name,
          reqs: f.reqs,
          linked: f.linked,
          ...(f.blocked && { blocked: true }),
          ...(f.progress && { progress: true }),
          ...(f.changed && { changed: f.changed }),
        })),
      }),
      ...(recent?.ok && {
        recent: {
          commits: recent.value.commits.map((c) => ({
            sha: c.sha.slice(0, 12),
            subject: maskText(c.subject),
            at: c.at,
            reqs: c.reqs.filter((x) => !hidden.uids.has(x.uid)).map((x) => x.label),
          })),
          jobs: recent.value.jobs.map((j) => ({ id: j.id, desc: j.desc, exit: j.exit, at: j.at })),
        },
      }),
      ...(missing.length && { missing }),
    });
  }

  // ── get_message ──

  private async message(
    me: RosterAgent,
    input: Record<string, unknown>,
    out: (b: Result) => Result,
    none: (m: Miss[]) => Result,
  ): Promise<Result> {
    const m = MESSAGE_ID.exec(str(input.id) ?? '');
    if (!m) return fail('bad_input', 'id is required: a message id as ⟨m:id⟩ or ⟨re:id⟩ show it');
    const id = m[1];
    // Rooms first, only the caller's and their newest posts: a post's own id, or the delivery id its
    // header carried into a member's transcript. Another room's post is never looked at, so its id
    // reads as not found (an out_of_scope would say it exists).
    for (const room of this.d.rooms().filter((r) => r.members.includes(me.name))) {
      const posts = this.d.timeline(room, AGENT_QUERY_ROOM_POSTS);
      const k = posts.findIndex(
        (p) => p.id === id || Object.values(p.messageIds ?? {}).includes(id),
      );
      if (k < 0) continue;
      const line = (p: GroupPost | undefined) =>
        p && { sender: p.sender ?? 'owner', at: iso(p.at), text: cut(mask(p.text)) };
      const p = posts[k];
      return out({
        message: {
          id: p.id,
          sender: p.sender ?? 'owner',
          at: iso(p.at),
          text: mask(p.text),
          ...(p.replyTo && { replyTo: { ...p.replyTo, text: mask(p.replyTo.text) } }),
        },
        conversation: { kind: 'room', id: room.id, name: room.name },
        ...(k > 0 && { before: line(posts[k - 1]) }),
        ...(k + 1 < posts.length && { after: line(posts[k + 1]) }),
      });
    }
    const file = this.d.transcriptOf(me.name);
    if (!file)
      return none([miss('no_transcript', 'you have no conversation record this daemon can read')]);
    const found = await messageAround(file, id);
    if (!found)
      return none([
        miss(
          'not_found',
          "no message with this id in your own conversation (this one and the ones the renew and Lead history say it continues) or in the rooms you are in; another agent's one-to-one conversation is never read",
        ),
      ]);
    const sender = (i: ChatItem) =>
      i.kind === 'assistant'
        ? me.name
        : i.from === 'peer'
          ? (i.fromName ?? 'peer')
          : i.from === 'system'
            ? 'system'
            : 'owner';
    const line = (i: ChatItem | undefined) =>
      i && { sender: sender(i), at: iso(i.at), text: cut(mask(i.text)) };
    const i = found.item;
    return out({
      message: {
        id: i.messageId ?? i.id,
        sender: sender(i),
        at: iso(i.at),
        text: mask(i.text),
        ...(i.replyTo && { replyTo: { ...i.replyTo, text: mask(i.replyTo.text) } }),
      },
      conversation: {
        kind: 'dm',
        agent: me.name,
        ...(found.session && { earlierSession: found.session }),
      },
      ...(found.before && { before: line(found.before) }),
      ...(found.after && { after: line(found.after) }),
    });
  }

  // ── get_task_context ──

  private async taskContext(
    me: RosterAgent,
    input: Record<string, unknown>,
    out: (b: Result) => Result,
    none: (m: Miss[]) => Result,
  ): Promise<Result> {
    const project = me.project!;
    let t: BoardTask | undefined;
    if (input.taskId !== undefined) {
      const id = str(input.taskId);
      if (!id) return fail('bad_input', 'taskId must be a task id');
      t = this.d.tasks.get(id);
      if (!t) return none([miss('not_found', `no task '${id}'`)]);
      if (t.project !== project)
        return fail('out_of_scope', `task '${id}' belongs to another project`);
    } else {
      t = this.d.tasks
        .list({ project })
        .filter(
          (x) =>
            x.status !== 'done' &&
            !!me.assignmentId &&
            x.assignee?.assignmentId === me.assignmentId,
        )
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
      if (!t) return none([miss('no_task', 'no open task is assigned to you: give taskId')]);
    }
    const missing: Miss[] = [];
    const spec = this.d.spec;
    let reqs: Result[] = [];
    let code: Result | null = null;
    if (!spec) missing.push(MISS.noSpec);
    else {
      const r = await spec.task(project, t.id);
      if (!r || !r.ok || !r.value.enabled)
        missing.push(r?.ok === false ? miss('spec_error', r.error) : MISS.trackingOff);
      else {
        const hidden = spec.sensitive(project).paths;
        reqs = visible(r.value.nodes, r.value.edges, hidden, t.id).nodes.map(brief);
        if (!reqs.length)
          missing.push(
            miss('no_link', 'no requirement is linked to this task (confirmed or named by it)'),
          );
        else {
          const c = await spec.taskCode(project, t.id);
          if (!c?.ok || !c.value)
            missing.push(miss('no_code_scan', 'the code map of your project could not be read'));
          else {
            const files = c.value.files.filter((f) => !hidden.has(f));
            if (!files.length)
              missing.push(
                miss(
                  'no_code_link',
                  "no code file is reached from this task's requirements by the map's default paths",
                ),
              );
            code = {
              files: files.slice(0, AGENT_QUERY_FILES_MAX),
              ...(files.length > AGENT_QUERY_FILES_MAX && {
                filesMore: files.length - AGENT_QUERY_FILES_MAX,
              }),
              modules: c.value.modules.slice(0, AGENT_QUERY_MODULES_MAX),
            };
          }
        }
      }
    }
    return out({
      task: {
        id: t.id,
        title: mask(t.title),
        status: t.status,
        ...(t.detail && { detail: mask(t.detail) }),
        ...(t.note && { note: mask(t.note) }),
        ...(t.parentId && { parentId: t.parentId }),
        ...(t.branch && { branch: t.branch }),
        ...(t.worktree && { worktree: t.worktree }),
        ...(t.assignee && { assignee: t.assignee.name }),
        updatedAt: t.updatedAt,
      },
      requirements: reqs,
      ...(code && { code }),
      // What says the work is checked: the Task's facts, each with its source (observed, reported).
      verification: {
        ...(t.testsRan && { testsRan: t.testsRan }),
        ...(t.testsPassed && { testsPassed: t.testsPassed }),
        ...(t.commits && { commits: t.commits }),
        ...(t.filesChanged && { filesChanged: t.filesChanged }),
        ...(t.reportedDone && { reportedDone: t.reportedDone }),
      },
      ...(missing.length && { missing }),
    });
  }

  // ── get_resume_context ──

  private async resume(
    me: RosterAgent,
    out: (b: Result) => Result,
    none: (m: Miss[]) => Result,
  ): Promise<Result> {
    const term = lastTerm(this.d.home, me.name);
    const file = lastHandoff(this.d.home, me.name);
    if (!file)
      return none([
        miss(
          'no_handoff',
          'you have no renew handoff on record (none written, or older than the 30 days delivered handoffs are kept)',
        ),
      ]);
    const { handoff, basis } = renewParts(file.text);
    const headSha = /HEAD: ([0-9a-f]{7,40})\b/.exec(basis)?.[1] ?? null;
    const branch = /브랜치: ([^ ·\n]+)/.exec(basis)?.[1] ?? null;
    const project = me.project!;
    const folder = this.d.folderOf(me.name);
    const tasks = this.d.tasks.list({ project });
    // B5: the handoff's references, read again the way the renew read them (commits checked by git).
    let refs = handoffRefs(handoff, new Set(tasks.map((t) => t.id)), me.name);
    refs = folder
      ? await keepCommits(refs, this.run, folder)
      : refs.filter((r) => r.t !== 'commit');
    const missing: Miss[] = [];
    const since = term?.endedAt ?? file.at;
    const commits =
      folder && headSha
        ? await this.log(folder, [`${headSha}..HEAD`, '-n', String(AGENT_QUERY_SINCE_COMMITS)])
        : null;
    if (commits === null)
      missing.push(miss('no_git', 'the commits since the handoff could not be read'));
    return out({
      renew: {
        at: iso(since),
        ...(term && {
          oldSession: term.sessionId,
          newSession: term.next,
          oldTranscript: term.transcript,
        }),
        file: file.path,
      },
      handoff: mask(handoff),
      basis: mask(basis),
      base: { branch, head: headSha },
      since: {
        ...(commits && { commits }),
        tasks: tasks
          .filter((t) => Date.parse(t.updatedAt) > since)
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .slice(0, AGENT_QUERY_SINCE_TASKS)
          .map((t) => ({
            id: t.id,
            title: mask(t.title),
            status: t.status,
            updatedAt: t.updatedAt,
          })),
      },
      refs: await this.resolveRefs(me, refs, folder),
      ...(missing.length && { missing }),
    });
  }

  /** `git log` lines as {sha, subject} (subjects masked); null when git could not read them. */
  private async log(
    folder: string,
    args: string[],
  ): Promise<Array<{ sha: string; subject: string }> | null> {
    try {
      const r = await this.run(folder, ['log', '--format=%H%x09%s', ...args], {
        env: READ_ENV,
        timeoutMs: AGENT_QUERY_GIT_MS,
        maxBytes: AGENT_QUERY_GIT_BYTES,
      });
      if (r.code !== 0) return null;
      return r.stdout
        .toString('utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => ({ sha: l.slice(0, 40), subject: cut(mask(l.slice(41))) }));
    } catch {
      return null;
    }
  }

  /** B5's `refs[]` resolved: each with what it names now, or `resolved: false` and why. */
  private async resolveRefs(
    me: RosterAgent,
    refs: BrainRef[],
    folder: string | null,
  ): Promise<Result[]> {
    const project = me.project!;
    const shas = refs.flatMap((r) => (r.t === 'commit' ? [r.sha] : []));
    const subjects = new Map(
      (shas.length && folder ? ((await this.log(folder, ['--no-walk', ...shas])) ?? []) : []).map(
        (c) => [c.sha, c.subject],
      ),
    );
    const out: Result[] = [];
    for (const ref of refs) {
      const no = (why: string) => out.push({ ref, resolved: false, why });
      if (ref.t === 'task') {
        const t = this.d.tasks.get(ref.id);
        if (t && t.project === project) out.push({ ref, title: mask(t.title), status: t.status });
        else no('no such task in your project now');
      } else if (ref.t === 'commit') {
        const s = subjects.get(ref.sha);
        if (s === undefined) no('not read from git');
        else out.push({ ref, subject: s });
      } else if (ref.t === 'req' || ref.t === 'display') {
        if (!this.d.spec) {
          no(MISS.noSpec.message);
          continue;
        }
        const r = await this.requirement(project, ref.t === 'req' ? ref.uid : ref.id);
        if ('error' in r) no(r.error.message);
        else if ('missing' in r) no(r.missing[0].message);
        else
          out.push({
            ref,
            uid: r.uid,
            label: r.item.node.label,
            ...(r.item.node.title && { title: r.item.node.title }),
            ...(r.item.node.state && { state: r.item.node.state }),
          });
      } else if (ref.t === 'msg') {
        no('read it with get_message');
      } else no('this kind of reference is not covered by these tools yet');
    }
    return out;
  }
}

/** `name`'s latest recorded renew (renew-history.json), or undefined. */
const lastTerm = (home: string, name: string) =>
  readRenewHistory(home)
    .filter((t) => t.name === name)
    .sort((a, b) => b.endedAt - a.endedAt)[0];

/** A renew's first message (handoff.renewPrompt) cut into the handoff as written and the work basis. */
export function renewParts(text: string): { handoff: string; basis: string } {
  const at = text.indexOf('\n--- 인수인계');
  const basisAt = text.indexOf('\n--- 작업 기준');
  const handoff =
    at < 0
      ? ''
      : text.slice(text.indexOf('\n', at + 1) + 1, basisAt > at ? basisAt : undefined).trim();
  return { handoff, basis: basisAt < 0 ? '' : text.slice(basisAt + 1).trim() };
}

/**
 * The newest renew handoff written into `name`'s inbox (waiting, or delivered/), or null. Only a
 * file whose real path is inside that inbox is read: a name with a path in it, or a link (file or
 * folder) to anywhere else, is refused.
 */
export function lastHandoff(
  home: string,
  name: string,
): { path: string; text: string; at: number } | null {
  if (!name || name === '.' || name === '..' || path.basename(name) !== name) return null;
  let root: string;
  try {
    root = path.join(fs.realpathSync(path.join(configDir(home), 'inbox')), name);
  } catch {
    return null;
  }
  const dir = path.join(configDir(home), 'inbox', name);
  const inside = (p: string) => {
    try {
      return fs.realpathSync(p).startsWith(root + path.sep);
    } catch {
      return false;
    }
  };
  let best: { path: string; at: number } | null = null;
  for (const d of [dir, path.join(dir, 'delivered')]) {
    let names: string[];
    try {
      names = fs.readdirSync(d).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of names) {
      const p = path.join(d, f);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue; // a FIFO or a device would block the event loop on open/read
        if (best && st.mtimeMs <= best.at) continue;
        if (!inside(p)) continue;
        const fd = fs.openSync(p, 'r');
        const head = Buffer.alloc(RENEW_HEAD_MAX * 3);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        if (RENEW_HEADS.some((h) => head.toString('utf-8', 0, n).startsWith(h))) best = { path: p, at: st.mtimeMs };
      } catch {
        /* gone meanwhile */
      }
    }
  }
  if (!best || !inside(best.path)) return null;
  try {
    return { path: best.path, text: fs.readFileSync(best.path, 'utf-8'), at: Math.round(best.at) };
  } catch {
    return null;
  }
}

/**
 * BRN K5: the latest renew handoff of `name` (a project's Lead) for the 개요's five lines, read on
 * request (nothing held): masked as a whole where it is made, its four sections at most
 * RESUME_SECTION_ITEMS lines each, a line at most RESUME_ITEM_CHARS. Null: none on record.
 */
export function resumeHandoff(home: string, name: string): TraceResume['handoff'] {
  const file = lastHandoff(home, name);
  if (!file) return null;
  const handoff = maskText(renewParts(file.text).handoff);
  const s = handoffSections(handoff);
  const section = (lines: string[]): ResumeSection => ({
    items: lines.slice(0, RESUME_SECTION_ITEMS).map((l) => {
      const it = handoffItem(l);
      return { ...it, text: cut(it.text, RESUME_ITEM_CHARS) };
    }),
    total: lines.length,
  });
  return {
    // The renew record may be older than the file picked (a handoff still waiting, a failed renew).
    at: iso(Math.max(lastTerm(home, name)?.endedAt ?? 0, file.at)),
    format: handoffFormat(handoff),
    goal: section(s.goal),
    done: section(s.done),
    open: section(s.open),
    next: section(s.next),
  };
}

/** What the caller may see of a graph around `center`: nodes outside the sensitive documents that
 *  are still reached from `center` once those are taken out (a node reached only through a removed
 *  one goes too), and the edges between what is left. */
function visible(
  nodes: TraceNode[],
  edges: TraceEdge[],
  hidden: ReadonlySet<string>,
  center: string,
): { nodes: TraceNode[]; edges: TraceEdge[] } {
  const gone = new Set(nodes.filter((n) => hidden.has(n.source?.path ?? '')).map((n) => n.id));
  const kept = edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
  const reached = new Set([center]);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of kept)
      if (reached.has(e.from) !== reached.has(e.to)) {
        reached.add(e.from);
        reached.add(e.to);
        grew = true;
      }
  }
  return {
    nodes: nodes.filter((n) => reached.has(n.id) && !gone.has(n.id)),
    edges: kept.filter((e) => reached.has(e.from) && reached.has(e.to)),
  };
}
const brief = (n: TraceNode): Result => ({
  id: n.id,
  type: n.type,
  label: n.label,
  ...(n.title && { title: n.title }),
  ...(n.state && { state: n.state }),
  ...(n.source && { source: n.source }),
});
const edge = (e: TraceEdge): Result => ({
  from: e.from,
  to: e.to,
  rel: e.rel,
  status: e.status,
  ...(e.reason && { reason: e.reason }),
});

const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
/**
 * An answer cut to `cap` bytes of JSON: the biggest string (to half, with '…') or list (its newer
 * half dropped) below the top goes first, until it fits; then `truncated: true`. A list of one is
 * looked into, never dropped whole. Still over (many short fields): the head and `missing` too_big.
 */
export function fit(r: Result, cap: number): Result {
  if (bytes(r) <= cap) return r;
  const out = structuredClone(r) as Result;
  out.truncated = true;
  for (let round = 0; round < 500 && bytes(out) > cap; round++) {
    let best: { holder: Record<string | number, unknown>; key: string | number; n: number } | null =
      null;
    const walk = (holder: Record<string | number, unknown>, key: string | number, v: unknown) => {
      if (typeof v === 'string') {
        if (v.length > 16) {
          const n = bytes(v);
          if (!best || n > best.n) best = { holder, key, n };
        }
      } else if (Array.isArray(v)) {
        const n = bytes(v);
        if (v.length > 1 && (!best || n > best.n)) best = { holder, key, n };
        v.forEach((x, i) => walk(v as unknown as Record<number, unknown>, i, x));
      } else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) walk(v as Record<string, unknown>, k, x);
    };
    for (const [k, v] of Object.entries(out)) if (k !== 'error') walk(out, k, v);
    if (!best) break;
    const b = best as { holder: Record<string | number, unknown>; key: string | number };
    const v = b.holder[b.key];
    b.holder[b.key] =
      typeof v === 'string'
        ? `${v.slice(0, Math.floor(v.length / 2))}…`
        : (v as unknown[]).slice(0, Math.ceil((v as unknown[]).length / 2));
  }
  if (bytes(out) <= cap) return out;
  // Nothing left to halve (many short fields): the head only, and why.
  const head = Object.fromEntries(
    ['project', 'rev', 'asOf', 'head', 'status', 'error'].filter((k) => k in r).map((k) => [k, r[k]]),
  );
  return {
    ...head,
    truncated: true,
    missing: [{ code: 'too_big', message: `the answer did not fit in ${cap} bytes: ask for less` }],
  };
}
