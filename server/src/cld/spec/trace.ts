/**
 * SPT-P2 (§4.4-4.5, §5, §7.1), pure: the trace index of one project and the queries on it. The
 * index is built from what the caller already holds (the Registry, the items' masked titles and
 * the IDs their text names, the stored links, this project's Tasks, jobs and first-parent commits)
 * and never stored. Observed links come from a display ID written in a source; suggested ones from
 * a Task the owner confirmed (its commits); confirmed and rejected ones are the stored decisions,
 * laid over the computed ones by (requirement, other end, relation). No git, no file, no LLM here.
 */
import * as path from 'path';

import type {
  EvidenceMark,
  Freshness,
  LinkRel,
  LinkStatus,
  TraceEdge,
  TraceEvidence,
  TraceGraph,
  TraceHistory,
  TraceItem,
  TraceNode,
  TraceNodeType,
  TraceRecentReq,
  TraceSource,
  TraceState,
} from '../../../../core/src/cld/spec/trace.js';
import {
  SPEC_ITEM_TITLE_MAX,
  SPEC_LINK_MATCH_REQS_MAX,
  SPEC_LINK_MODULE_PATHS_MAX,
  SPEC_LINK_PER_REQ_MAX,
  SPEC_RECENT_REQS,
  SPEC_TRACE_COMMITS_PER_NODE,
  SPEC_TRACE_HISTORY_MAX,
  SPEC_TRACE_NODES_MAX,
} from '../../constants.js';
import { maskText } from '../mask.js';
import type { Ids } from '../tracking/docs.js';
import { acceptanceNow, type AcceptanceRecord } from './acceptance.js';
import { aliasRoot } from './archOwner.js';
import { labelIndex, type ModRow, namedLabels, pathOwners, type TraceComp } from './compLinks.js';
import { type LinkBy, type LinkFile, linkKey, refId, type SpecLink } from './links.js';
import { currentId, type ItemHow, type SpecRegistry } from './store.js';

/** The Task fields the trace reads (a BoardTask of this project). */
export interface TraceTask {
  id: string;
  title: string;
  detail?: string;
  goal?: string | null;
  status: string;
  updatedAt?: string;
  reportedDone?: Fact<boolean>;
  commits?: Fact<number>;
  testsPassed?: Fact<boolean>;
}
type Fact<T> = { value: T; source: string; at?: string };
/** The job fields the trace reads (a JobRecord of this project). */
export interface TraceJob {
  id: string;
  desc?: string | null;
  cmd: string;
  started: string;
  ended: string | null;
  exit: number | null;
}
/** A first-parent commit of HEAD: its masked subject and the display IDs its whole message names. */
export interface TraceCommit {
  sha: string;
  time: string;
  subject: string;
  ids: string[];
}
/** An item's text as the last scan read it (memory only): masked title and section, the IDs its own text names. */
export interface ItemText {
  title: string;
  section: string;
  refs: string[];
  /** SPT-P4C: its title and (a document that may keep text) body as words, lower case, joined by one space, capped. */
  words?: string;
}
export interface RefRow {
  /** The 참조만 하는 표's path. */
  path: string;
  id: string;
  refs: string[];
  line: number;
}

export interface CommitState {
  exists: boolean;
  ancestor: boolean;
  reachable: boolean;
}

export interface TraceInput {
  reg: SpecRegistry;
  text: (uid: string) => ItemText | undefined;
  refRows: RefRow[];
  links: LinkFile;
  /** SPT-P3-ACCEPT: every acceptance record, in the order written. */
  acceptance: readonly AcceptanceRecord[];
  tasks: TraceTask[];
  jobs: TraceJob[];
  commits: TraceCommit[];
  /** A confirmed commit not among `commits`: a commit of the repository, an ancestor of HEAD, reachable from a branch or tag. */
  known: (sha: string) => CommitState | undefined;
  ids: Ids;
  /** SPT-P4C: the project's live components, and the trace tables' module cells. */
  comps?: readonly TraceComp[];
  modRows?: readonly ModRow[];
  /** SPT-P4C over 4b: '같은 구성요소' (member → the component it went into), resolved here at read time: links.json is never rewritten. */
  aliases?: ReadonlyMap<string, string>;
}

export interface TraceIndex {
  nodes: Map<string, TraceNode>;
  edges: TraceEdge[];
  adj: Map<string, number[]>;
  /** Each requirement's four states (every item of a tracked document). */
  states: Map<string, TraceState>;
  /** Live requirements (not retired, in a document that is there), in document then line order. */
  reqs: string[];
  /** Live requirement → its overview group id. */
  groupOf: Map<string, string>;
  groups: Map<string, { label: string; doc: string; uids: string[] }>;
  history: Map<string, TraceHistory[]>;
  /** Live requirements with no confirmed or observed link. */
  unlinked: number;
  /** Jobs the owner confirmed as deployed (배포 확인). */
  deployed: Set<string>;
}

const STATUS_RANK: Record<LinkStatus, number> = { confirmed: 0, observed: 1, rejected: 2, suggested: 3 };
const shown = (s: string) => maskText(s).slice(0, SPEC_ITEM_TITLE_MAX);
const short = (sha: string) => sha.slice(0, 7);
/** 'FR-ENG-001' → 'FR-ENG', 'T001' → 'T'; '' for an item without an ID. */
export const prefixOf = (id: string): string => id.replace(/-?\d+[a-z]?$/, '') || id;
const ownerBy = (b: LinkBy): NonNullable<TraceEdge['by']> => (b.kind === 'owner' ? { kind: 'owner' } : { kind: 'agent', name: b.name });

/** Identity decisions as the detail's history says them (the rest are the engine's bookkeeping). */
const IDENTITY: Partial<Record<ItemHow, string>> = {
  new: 'created',
  'owner-new': 'created',
  'owner-split': 'created',
  reuse: 'created',
  T1: 'moved',
  T1n: 'moved',
  T3: 'moved',
  'owner-same': 'moved',
  'owner-merge': 'moved',
  T2: 'textChanged',
  T2r: 'textChanged',
};

export function buildIndex(inp: TraceInput): TraceIndex {
  const { reg } = inp;
  const nodes = new Map<string, TraceNode>();
  const computed = new Map<string, TraceEdge>();
  const live = (doc: string) => {
    const d = reg.docs[doc];
    return !!d && d.tracked && d.state !== 'retired';
  };

  // ── requirements ──
  const byId = new Map<string, string[]>();
  const reqs: string[] = [];
  for (const [uid, r] of Object.entries(reg.items)) {
    const d = reg.docs[r.doc];
    if (!d?.tracked) continue;
    const id = currentId(r);
    const t = r.state === 'retired' ? undefined : inp.text(uid);
    nodes.set(uid, {
      id: uid,
      type: 'req',
      label: id || `${path.posix.basename(d.path)}:${r.locator.line}`,
      ...(t?.title && { title: t.title }),
      source: { path: d.path, line: r.locator.line },
    });
    if (r.state === 'retired' || !live(r.doc)) continue;
    reqs.push(uid);
    if (id) byId.set(id, [...(byId.get(id) ?? []), uid]);
  }
  const lineOf = (u: string) => reg.items[u].locator.line;
  reqs.sort((a, b) => {
    const pa = reg.docs[reg.items[a].doc].path;
    const pb = reg.docs[reg.items[b].doc].path;
    return pa !== pb ? (pa < pb ? -1 : 1) : lineOf(a) - lineOf(b);
  });

  const taskById = new Map(inp.tasks.map((t) => [t.id, t]));
  const jobById = new Map(inp.jobs.map((j) => [j.id, j]));
  const commitBySha = new Map(inp.commits.map((c) => [c.sha, c]));
  const add = (e: Omit<TraceEdge, 'id'>) => {
    // req ↔ req: the smaller UID is `from` (SPT §4.3)
    if (e.rel === 'refs' && e.to < e.from) e = { ...e, from: e.to, to: e.from };
    if (e.from === e.to) return;
    const key = linkKey(e.from, e.to, e.rel);
    const old = computed.get(key);
    if (!old || STATUS_RANK[e.status] < STATUS_RANK[old.status]) computed.set(key, { id: `${e.status === 'observed' ? 'o' : 's'}:${key}`, ...e });
  };

  // ── observed: Tasks (title, detail, goal) ──
  for (const t of inp.tasks)
    for (const [field, text] of [['title', t.title], ['detail', t.detail], ['goal', t.goal]] as const)
      for (const id of text ? inp.ids.all(text) : [])
        for (const uid of byId.get(id) ?? []) add({ from: uid, to: t.id, rel: 'implements', status: 'observed', reason: field, source: { taskId: t.id } });
  // ── observed: a requirement's own text (a Task ID, another requirement) and the 참조만 하는 표 rows ──
  const fromText = (uid: string, refs: string[], source: TraceSource) => {
    for (const ref of refs) {
      if (taskById.has(ref)) add({ from: uid, to: ref, rel: 'implements', status: 'observed', reason: 'text', source });
      for (const other of byId.get(ref) ?? []) add({ from: uid, to: other, rel: 'refs', status: 'observed', reason: 'text', source });
    }
  };
  for (const uid of reqs) {
    const refs = inp.text(uid)?.refs;
    if (refs?.length) fromText(uid, refs, { path: reg.docs[reg.items[uid].doc].path, line: lineOf(uid) });
  }
  for (const row of inp.refRows) for (const uid of byId.get(row.id) ?? []) fromText(uid, row.refs, { path: row.path, line: row.line });
  // ── observed: commit messages; a Task ID in one makes it that Task's commit ──
  const taskCommits = new Map<string, TraceCommit[]>();
  for (const c of inp.commits)
    for (const id of c.ids) {
      for (const uid of byId.get(id) ?? []) add({ from: uid, to: c.sha, rel: 'changes', status: 'observed', reason: 'message', source: { sha: c.sha } });
      if (taskById.has(id)) taskCommits.set(id, [...(taskCommits.get(id) ?? []), c]);
    }
  // ── observed: a job's description ──
  for (const j of inp.jobs)
    for (const id of j.desc ? inp.ids.all(j.desc) : [])
      for (const uid of byId.get(id) ?? []) add({ from: uid, to: j.id, rel: 'verifies', status: 'observed', reason: 'desc', source: { jobId: j.id } });
  // ── SPT-P4C: a component merged into another ('같은 구성요소') is its root, the last component along its chain that is there ──
  const compById = new Map<string, TraceComp>();
  for (const c of inp.comps ?? []) if (!compById.has(c.uid)) compById.set(c.uid, c);
  const aliases = inp.aliases ?? new Map<string, string>();
  const roots = new Map<string, string>();
  const rootOf = (u: string) => {
    if (!aliases.has(u)) return u;
    if (!roots.has(u)) roots.set(u, aliasRoot(aliases, u, (x) => compById.has(x)));
    return roots.get(u)!;
  };
  const endOf = (l: SpecLink) => (l.to.t === 'comp' ? rootOf(l.to.uid) : refId(l.to));

  // ── the owner's decisions (laid over the computed links below): a link to a member shows on its root;
  //    for one pair, a confirmed decision wins over a rejected one (either end's rejection hides the computed pair) ──
  const stored = new Map<string, SpecLink>();
  for (const l of inp.links.links) {
    const key = linkKey(l.from.uid, endOf(l), l.rel);
    if (stored.get(key)?.status !== 'confirmed') stored.set(key, l);
  }

  // ── SPT-P4C: components: observed from a module column (reason: the path), suggested when the text names a label ──
  const asRoots = aliases.size ? (inp.comps ?? []).map((c) => ({ ...c, uid: rootOf(c.uid) })) : (inp.comps ?? []);
  const perReq = new Map<string, number>();
  /** At most SPEC_LINK_PER_REQ_MAX per requirement; a pair the owner decided is not counted (a rejected one never hides a later one). */
  const toComp = (uid: string, comp: string, e: Pick<TraceEdge, 'status' | 'reason' | 'source'>) => {
    const n = perReq.get(uid) ?? 0;
    if (n >= SPEC_LINK_PER_REQ_MAX) return;
    const key = linkKey(uid, comp, 'realizes');
    if (computed.has(key)) return;
    if (!stored.has(key)) perReq.set(uid, n + 1);
    add({ from: uid, to: comp, rel: 'realizes', ...e });
  };
  if (compById.size) {
    // A row of a requirements document is its own item (document and line); a 참조만 하는 표's row names
    // an ID (byId). Each requirement's cells merge first (paths capped): one pass per requirement, never rows × same-ID items.
    type Cell = { paths: string[]; path: string; line: number };
    const cells = new Map<string, Cell>();
    const merge = (m: Map<string, Cell>, k: string, c: Cell) => {
      const old = m.get(k);
      if (!old) return void m.set(k, { ...c, paths: c.paths.slice(0, SPEC_LINK_MODULE_PATHS_MAX) });
      for (const p of c.paths) if (old.paths.length < SPEC_LINK_MODULE_PATHS_MAX && !old.paths.includes(p)) old.paths.push(p);
    };
    const own = new Map(reqs.map((u) => [`${reg.docs[reg.items[u].doc].path}\n${lineOf(u)}`, u]));
    const refIds = new Map<string, Cell>();
    for (const row of inp.modRows ?? []) {
      if (row.refs) merge(refIds, row.id, row);
      else {
        const u = own.get(`${row.path}\n${row.line}`);
        if (u) merge(cells, u, row);
      }
    }
    for (const [id, c] of refIds) for (const u of byId.get(id) ?? []) merge(cells, u, c);
    const owners = pathOwners(asRoots);
    for (const [uid, c] of cells) for (const p of c.paths) for (const comp of owners(p)) toComp(uid, comp, { status: 'observed', reason: p, source: { path: c.path, line: c.line } });
    const labels = labelIndex(asRoots);
    // Enough labels for the requirement's quota, past the components the owner already decided.
    const decided = new Map<string, number>();
    for (const l of inp.links.links) if (l.rel === 'realizes') decided.set(l.from.uid, (decided.get(l.from.uid) ?? 0) + 1);
    if (labels.size)
      for (const uid of reqs.slice(0, SPEC_LINK_MATCH_REQS_MAX))
        for (const key of namedLabels(inp.text(uid)?.words ?? '', labels, SPEC_LINK_PER_REQ_MAX + (decided.get(uid) ?? 0)))
          for (const c of labels.get(key)!) toComp(uid, c, { status: 'suggested', reason: 'label', source: { path: reg.docs[reg.items[uid].doc].path, line: lineOf(uid) } });
  }

  // ── suggested: the commits of a Task confirmed to the requirement ──
  for (const l of stored.values())
    if (l.status === 'confirmed' && l.rel === 'implements' && l.to.t === 'task')
      for (const c of taskCommits.get(l.to.id) ?? []) add({ from: l.from.uid, to: c.sha, rel: 'changes', status: 'suggested', reason: l.to.id, source: { sha: c.sha, taskId: l.to.id } });
  for (const [key, l] of stored) {
    const c = computed.get(key);
    computed.set(key, {
      id: l.id,
      from: l.from.uid,
      to: endOf(l),
      rel: l.rel,
      status: l.status,
      by: ownerBy(l.by),
      at: l.at,
      ...(c?.source && { source: c.source }),
      ...(c?.reason && { reason: c.reason }),
      ...(l.kind && { kind: l.kind }),
    });
  }

  // ── the other ends' nodes ──
  const deployed = new Set(inp.links.deploys.map((d) => d.job));
  const gone = new Set<string>();
  const end = (id: string, type: TraceNodeType) => {
    if (nodes.has(id)) return;
    if (type === 'task') {
      const t = taskById.get(id);
      if (t) nodes.set(id, { id, type, label: id, title: shown(t.title), state: { work: { total: 1, byStatus: { [t.status]: 1 } } }, source: { taskId: id } });
    } else if (type === 'job') {
      const j = jobById.get(id);
      if (j) nodes.set(id, { id, type, label: id, title: shown(j.desc || j.cmd), source: { jobId: id } });
    } else if (type === 'commit') {
      const c = commitBySha.get(id);
      // An unreachable commit (its branch deleted) is a gone end: the link stays, shown missing.
      if (c || inp.known(id)?.reachable) nodes.set(id, { id, type, label: short(id), ...(c && { title: c.subject }), source: { sha: id } });
    } else if (type === 'comp') {
      // A component gone from its diagram is a gone end: its confirmed links stay, shown missing.
      const c = compById.get(id);
      if (c) nodes.set(id, { id, type, label: c.label, ...(c.source && { source: c.source }) });
    }
    if (!nodes.has(id)) {
      gone.add(id);
      nodes.set(id, { id, type, label: type === 'commit' ? short(id) : id, state: { freshness: 'missing' } });
    }
  };
  const typeOf: Record<LinkRel, TraceNodeType> = { implements: 'task', changes: 'commit', verifies: 'job', discusses: 'msg', realizes: 'comp', refs: 'req' };
  for (const e of computed.values()) {
    if (typeOf[e.rel] === 'req') {
      for (const u of [e.from, e.to]) if (!nodes.has(u) || reg.items[u]?.state === 'retired') gone.add(u);
      continue;
    }
    end(e.to, typeOf[e.rel]);
  }

  // ── each requirement's four states ──
  const edges = [...computed.values()];
  const adj = new Map<string, number[]>();
  edges.forEach((e, i) => {
    for (const n of [e.from, e.to]) adj.set(n, [...(adj.get(n) ?? []), i]);
  });
  const states = new Map<string, TraceState>();
  const judged = new Map<string, AcceptanceRecord[]>();
  for (const a of inp.acceptance) judged.set(a.uid, [...(judged.get(a.uid) ?? []), a]);
  let unlinked = 0;
  for (const [uid, r] of Object.entries(reg.items)) {
    if (!nodes.has(uid)) continue;
    const mine = (adj.get(uid) ?? []).map((i) => edges[i]);
    const confirmed = mine.filter((e) => e.status === 'confirmed');
    const tasks = confirmed.filter((e) => e.rel === 'implements').flatMap((e) => taskById.get(e.to) ?? []);
    const byStatus: Record<string, number> = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    // The commits that count: confirmed ones, and those of a confirmed Task (suggested, read from HEAD's first parents).
    const shas = mine.filter((e) => e.rel === 'changes' && (e.status === 'confirmed' || (e.status === 'suggested' && e.from === uid))).map((e) => e.to);
    const there = shas.filter((s) => commitBySha.has(s) || inp.known(s)?.reachable);
    const fact = (k: 'commits' | 'testsPassed', src: string) => tasks.some((t) => !!t[k]?.value && t[k]!.source === src);
    const mark = (seen: boolean, said: boolean): EvidenceMark => (seen ? 'observed' : said ? 'reported' : 'none');
    const jobs = confirmed.filter((e) => e.rel === 'verifies').flatMap((e) => (jobById.has(e.to) ? [{ e, j: jobById.get(e.to)! }] : []));
    const evidence: TraceEvidence = {
      change: mark(there.length > 0 || fact('commits', 'observed'), fact('commits', 'reported')),
      integration: mark(there.some((s) => commitBySha.has(s) || inp.known(s)?.ancestor), false),
      test: mark(jobs.some(({ e, j }) => e.kind !== 'deploy' && j.exit === 0) || fact('testsPassed', 'observed'), fact('testsPassed', 'reported')),
      // A deploy job's exit 0 is only its word; ✔ needs the owner's 배포 확인 (SPT §5.2).
      deploy: mark(
        jobs.some(({ e, j }) => e.kind === 'deploy' && deployed.has(j.id)),
        jobs.some(({ e, j }) => e.kind === 'deploy' && j.exit === 0),
      ),
      reported: tasks.some((t) => !!t.reportedDone?.value),
    };
    const linkReview = confirmed.some((e) => e.from === uid && stored.get(linkKey(e.from, e.to, e.rel))?.basis.textHash !== r.textHash);
    const endGone = confirmed.some((e) => gone.has(e.from === uid ? e.to : e.from));
    const acc = acceptanceNow(judged.get(uid) ?? [], r.textHash);
    const acceptanceReview = acc.review;
    const freshness: Freshness =
      r.state === 'unresolved' ? 'unresolved' : r.state === 'retired' || !live(r.doc) || endGone ? 'missing' : linkReview || acceptanceReview ? 'review' : 'current';
    states.set(uid, {
      work: { total: tasks.length, byStatus },
      evidence,
      acceptance: { current: acc.current, ...(acc.previous && { previous: acc.previous }) },
      freshness,
      ...(linkReview && { linkReview }),
      ...(acceptanceReview && { acceptanceReview }),
    });
    const node = nodes.get(uid)!;
    node.state = states.get(uid);
    if (r.state !== 'retired' && live(r.doc) && !mine.some((e) => e.status === 'confirmed' || e.status === 'observed')) unlinked++;
  }

  // ── overview groups: a document's display-ID prefixes (its ID-less items: the document) ──
  const groups = new Map<string, { label: string; doc: string; uids: string[] }>();
  const groupOf = new Map<string, string>();
  for (const uid of reqs) {
    const r = reg.items[uid];
    const prefix = prefixOf(currentId(r));
    const doc = reg.docs[r.doc].path;
    const gid = `grp:${r.doc}:${prefix}`;
    const g = groups.get(gid) ?? { label: prefix || path.posix.basename(doc), doc, uids: [] };
    g.uids.push(uid);
    groups.set(gid, g);
    groupOf.set(uid, gid);
  }

  // ── history: identity decisions and the owner's link decisions ──
  const history = new Map<string, TraceHistory[]>();
  const push = (uid: string, h: TraceHistory) => history.set(uid, [...(history.get(uid) ?? []), h]);
  for (const [uid, r] of Object.entries(reg.items)) {
    if (!nodes.has(uid)) continue;
    for (const d of r.decisions) {
      const action = d.first ? 'created' : d.wasId !== undefined && d.wasId !== currentId(r) ? 'renamed' : d.was !== undefined ? 'textChanged' : IDENTITY[d.how];
      if (action && d.at) push(uid, { at: d.at, kind: 'identity', action, by: { kind: d.by === 'owner' ? 'owner' : 'engine' } });
    }
  }
  for (const h of inp.links.history) if (nodes.has(h.uid)) push(h.uid, { at: h.at, kind: 'link', action: h.action, by: ownerBy(h.by), ...(h.detail && { detail: label(nodes, h.detail) }) });
  for (const a of inp.acceptance) if (nodes.has(a.uid)) push(a.uid, { at: a.at, kind: 'acceptance', action: a.state, by: ownerBy(a.by) });
  for (const [uid, list] of history) history.set(uid, list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-SPEC_TRACE_HISTORY_MAX));

  return { nodes, edges, adj, states, reqs, groupOf, groups, history, unlinked, deployed };
}

/** An id as the history says it: a requirement's display ID, a commit's short SHA, else itself. */
const label = (nodes: Map<string, TraceNode>, id: string) => (nodes.get(id)?.type === 'req' || /^[0-9a-f]{40,64}$/.test(id) ? (nodes.get(id)?.label ?? short(id)) : id);

/** A group's state: work summed; each evidence axis observed only when every member's is, reported when any has some; the worst freshness. */
function groupState(ix: TraceIndex, uids: string[]): TraceState {
  const byStatus: Record<string, number> = {};
  let total = 0;
  const axes = ['change', 'integration', 'test', 'deploy'] as const;
  const marks = Object.fromEntries(axes.map((k) => [k, uids.map((u) => ix.states.get(u)?.evidence?.[k] ?? 'none')]));
  for (const u of uids)
    for (const [s, n] of Object.entries(ix.states.get(u)?.work?.byStatus ?? {})) {
      byStatus[s] = (byStatus[s] ?? 0) + n;
      total += n;
    }
  const worst: Freshness[] = ['missing', 'unresolved', 'review', 'current'];
  const fresh = worst.find((f) => uids.some((u) => ix.states.get(u)?.freshness === f)) ?? 'current';
  const evidence = Object.fromEntries(axes.map((k) => [k, marks[k].every((m) => m === 'observed') ? 'observed' : marks[k].some((m) => m !== 'none') ? 'reported' : 'none'])) as Omit<TraceEvidence, 'reported'>;
  return {
    work: { total, byStatus },
    evidence: { ...evidence, reported: uids.some((u) => ix.states.get(u)?.evidence?.reported) },
    acceptance: { current: 'none' },
    freshness: fresh,
    ...(uids.some((u) => ix.states.get(u)?.linkReview) && { linkReview: true }),
    ...(uids.some((u) => ix.states.get(u)?.acceptanceReview) && { acceptanceReview: true }),
  };
}

export function overview(ix: TraceIndex): TraceGraph {
  return {
    level: 'overview',
    nodes: [...ix.groups].map(([id, g]) => ({ id, type: 'group', label: g.label, title: g.doc, count: g.uids.length, group: g.doc, state: groupState(ix, g.uids) })),
    edges: [],
  };
}

/** One group's requirements, each drawn in its '문서 · 절' cluster; past SPEC_TRACE_NODES_MAX the rest are counted in `hidden`. */
export function groupGraph(ix: TraceIndex, reg: SpecRegistry, group: string, text: (uid: string) => ItemText | undefined): TraceGraph {
  const uids = ix.groups.get(group)?.uids ?? [];
  const kept = uids.slice(0, SPEC_TRACE_NODES_MAX);
  const inside = new Set(kept);
  const nodes = kept.map((u) => {
    const base = path.posix.basename(reg.docs[reg.items[u].doc].path);
    const section = text(u)?.section;
    return { ...ix.nodes.get(u)!, group: section ? `${base} · ${section}` : base };
  });
  const edges = [...new Set(kept.flatMap((u) => ix.adj.get(u) ?? []))].map((i) => ix.edges[i]).filter((e) => inside.has(e.from) && inside.has(e.to));
  return { level: 'group', nodes, edges, ...(uids.length > kept.length && { hidden: uids.length - kept.length }) };
}

export interface HoodQuery {
  center: string;
  depth: number;
  /** Only these node types (the centre always). */
  types?: ReadonlySet<TraceNodeType>;
  confirmedOnly?: boolean;
}

/**
 * The neighbourhood: breadth first from the centre, depth ≤ 2. Past SPEC_TRACE_COMMITS_PER_NODE
 * commits reached through one node, the rest fold into one '+N' node (`more:<that node>`); past
 * SPEC_TRACE_NODES_MAX nodes the farthest are left out and counted in `hidden`, with what the
 * request's filters kept out.
 */
export function neighbourhood(ix: TraceIndex, q: HoodQuery): TraceGraph {
  const depthOf = new Map<string, number>([[q.center, 0]]);
  const via = new Map<string, string>();
  const filtered = new Set<string>();
  let frontier = [q.center];
  for (let d = 1; d <= q.depth; d++) {
    const next: string[] = [];
    for (const n of frontier)
      for (const i of ix.adj.get(n) ?? []) {
        const e = ix.edges[i];
        const o = e.from === n ? e.to : e.from;
        if (depthOf.has(o)) continue;
        const type = ix.nodes.get(o)?.type;
        if (!type || (q.confirmedOnly && e.status !== 'confirmed') || (q.types && !q.types.has(type))) {
          filtered.add(o);
          continue;
        }
        depthOf.set(o, d);
        via.set(o, n);
        next.push(o);
      }
    frontier = next;
  }
  // Commits past the per-node cap fold into '+N' (the confirmed ones are kept first).
  const ORDER: Partial<Record<TraceNodeType, number>> = { req: 0, task: 1, job: 2, doc: 3, commit: 9 };
  const statusTo = (id: string) => Math.min(...(ix.adj.get(id) ?? []).map((i) => STATUS_RANK[ix.edges[i].status]));
  const perOwner = new Map<string, string[]>();
  for (const [id, owner] of via) if (ix.nodes.get(id)?.type === 'commit') perOwner.set(owner, [...(perOwner.get(owner) ?? []), id]);
  const into = new Map<string, string>();
  const folded: TraceNode[] = [];
  for (const [owner, cs] of perOwner) {
    if (cs.length <= SPEC_TRACE_COMMITS_PER_NODE) continue;
    const rest = cs.sort((a, b) => statusTo(a) - statusTo(b)).slice(SPEC_TRACE_COMMITS_PER_NODE);
    const id = `more:${owner}`;
    for (const c of rest) into.set(c, id);
    folded.push({ id, type: 'commit', label: `+${rest.length}`, count: rest.length });
    depthOf.set(id, depthOf.get(owner)! + 1);
  }
  let ids = [...depthOf.keys()].filter((id) => !into.has(id) && (ix.nodes.has(id) || id.startsWith('more:')));
  ids.sort((a, b) => depthOf.get(a)! - depthOf.get(b)! || (ORDER[ix.nodes.get(a)?.type ?? 'commit'] ?? 5) - (ORDER[ix.nodes.get(b)?.type ?? 'commit'] ?? 5));
  let hidden = [...filtered].filter((id) => !depthOf.has(id)).length;
  if (ids.length > SPEC_TRACE_NODES_MAX) {
    hidden += ids.slice(SPEC_TRACE_NODES_MAX).reduce((sum, id) => sum + (folded.find((f) => f.id === id)?.count ?? 1), 0);
    ids = ids.slice(0, SPEC_TRACE_NODES_MAX);
  }
  const keep = new Set(ids);
  const byFold = new Map(folded.map((f) => [f.id, f]));
  const nodes = ids.map((id) => byFold.get(id) ?? ix.nodes.get(id)!);
  const edges: TraceEdge[] = [];
  const merged = new Map<string, TraceEdge>();
  for (const i of new Set(ids.flatMap((id) => ix.adj.get(id) ?? []).concat([...into.keys()].flatMap((id) => ix.adj.get(id) ?? [])))) {
    const e = ix.edges[i];
    const from = into.get(e.from) ?? e.from;
    const to = into.get(e.to) ?? e.to;
    if (!keep.has(from) || !keep.has(to) || from === to) continue;
    if (from === e.from && to === e.to) {
      edges.push(e);
      continue;
    }
    const id = `more:${from}>${to}`;
    const prev = merged.get(id);
    if (!prev || STATUS_RANK[e.status] < STATUS_RANK[prev.status]) merged.set(id, { id, from, to, rel: e.rel, status: e.status });
  }
  const foldedCount = folded.filter((f) => keep.has(f.id)).reduce((s, f) => s + (f.count ?? 0), 0);
  return {
    level: 'neighbourhood',
    center: q.center,
    nodes,
    edges: [...edges, ...merged.values()],
    ...(foldedCount && { folded: { commit: foldedCount } }),
    ...(hidden && { hidden }),
  };
}

/** One requirement's detail: its node, every link it has (all four states) with the other ends, its history. */
export function itemDetail(ix: TraceIndex, uid: string): TraceItem | null {
  const node = ix.nodes.get(uid);
  if (!node || node.type !== 'req') return null;
  const edges = (ix.adj.get(uid) ?? []).map((i) => ix.edges[i]);
  const others = [...new Set(edges.map((e) => (e.from === uid ? e.to : e.from)))].flatMap((id) => ix.nodes.get(id) ?? []);
  return { node, edges, nodes: others, history: ix.history.get(uid) ?? [] };
}

/** SPT-P3-ISSUES: the requirements linked to one Task (every state), with their nodes. */
export function taskRequirements(ix: TraceIndex, taskId: string): Pick<TraceItem, 'edges' | 'nodes'> {
  const edges = (ix.adj.get(taskId) ?? []).map((i) => ix.edges[i]).filter((e) => e.to === taskId && e.rel === 'implements');
  return { edges, nodes: [...new Set(edges.map((e) => e.from))].flatMap((id) => ix.nodes.get(id) ?? []) };
}

// ── SPT-P3-OVERVIEW: the 개요's counts and the 요구사항 filter each one opens (one definition for both) ──

const AXES = ['change', 'integration', 'test', 'deploy'] as const;
type Axis = (typeof AXES)[number];
/** unlinked: no confirmed or observed link; observed: observed links only; linked: a confirmed Task; ev/evr: an axis ✔ or ◐. Acceptance is its own dimension (ACCEPTANCE_FILTERS, `acceptance=`). */
export const SHOW_FILTERS: readonly string[] = [
  'unlinked',
  'observed',
  'linked',
  'review',
  'missing',
  ...AXES.map((a) => `ev:${a}`),
  ...AXES.map((a) => `evr:${a}`),
];

/** SPT-P3-ACCEPT: 수용▾ and the 개요's acceptance numbers: the current version's state, or 'review' (수용 재검토). */
export const ACCEPTANCE_FILTERS = ['none', 'validate', 'accepted', 'rejected', 'review'] as const;
export type AcceptanceFilter = (typeof ACCEPTANCE_FILTERS)[number];
/** Whether requirement `uid` is in the list `acceptance=<a>` opens (the one definition its count uses). */
export function acceptanceIs(ix: TraceIndex, uid: string, a: AcceptanceFilter): boolean {
  const s = ix.states.get(uid);
  return a === 'review' ? !!s?.acceptanceReview : (s?.acceptance?.current ?? 'none') === a;
}

/** Whether requirement `uid` is in the list `show` (one of SHOW_FILTERS) names. */
export function shows(ix: TraceIndex, uid: string, show: string): boolean {
  const s = ix.states.get(uid);
  const links = (ix.adj.get(uid) ?? []).map((i) => ix.edges[i].status);
  const [kind, value] = show.split(':');
  switch (kind) {
    case 'unlinked':
      return !links.some((x) => x === 'confirmed' || x === 'observed');
    case 'observed':
      return links.includes('observed') && !links.includes('confirmed');
    case 'linked':
      return !!s?.work?.total;
    case 'review':
    case 'missing':
      return s?.freshness === kind;
    case 'ev':
      return s?.evidence?.[value as Axis] === 'observed';
    case 'evr':
      return s?.evidence?.[value as Axis] === 'reported';
    default:
      return false;
  }
}

/** The 개요's numbers over the live requirements, each the size of the list its filter opens. */
export function overviewCounts(ix: TraceIndex) {
  const n = (show: string) => ix.reqs.reduce((sum, u) => sum + (shows(ix, u, show) ? 1 : 0), 0);
  const axes = (prefix: string) => Object.fromEntries(AXES.map((a) => [a, n(`${prefix}:${a}`)])) as Record<Axis, number>;
  return {
    observedOnly: n('observed'),
    reviewNeeded: n('review'),
    evidence: axes('ev'),
    evidenceReported: axes('evr'),
    work: { linked: n('linked'), total: ix.reqs.length },
    acceptance: Object.fromEntries(ACCEPTANCE_FILTERS.map((a) => [a, ix.reqs.filter((u) => acceptanceIs(ix, u, a)).length])) as Record<AcceptanceFilter, number>,
  };
}

/** The requirements a commit or a job (`id`) is confirmed to or names, confirmed first, at most SPEC_RECENT_REQS. */
/** GAME-UI-0: a job with exit 0 confirmed as some requirement's deploy job but with no 배포 확인 is only its word (◐, SPT §5.2). */
export const deployReported = (ix: TraceIndex, jobId: string, exit: number | null): boolean =>
  exit === 0 && !ix.deployed.has(jobId) && (ix.adj.get(jobId) ?? []).some((i) => ix.edges[i].rel === 'verifies' && ix.edges[i].status === 'confirmed' && ix.edges[i].kind === 'deploy');

export function reqsOf(ix: TraceIndex, id: string, max = SPEC_RECENT_REQS): TraceRecentReq[] {
  const out = new Map<string, TraceRecentReq>();
  for (const i of ix.adj.get(id) ?? []) {
    const e = ix.edges[i];
    const uid = e.from === id ? e.to : e.from;
    const node = ix.nodes.get(uid);
    if (node?.type !== 'req' || (e.status !== 'confirmed' && e.status !== 'observed') || out.get(uid)?.status === 'confirmed') continue;
    out.set(uid, { uid, label: node.label, status: e.status });
  }
  return [...out.values()].sort((a, b) => (a.status === b.status ? 0 : a.status === 'confirmed' ? -1 : 1)).slice(0, max);
}

/** SPT-P4C: a component's requirements (confirmed or observed): how many, and the first SPEC_RECENT_REQS, confirmed first. */
export function compReqs(ix: TraceIndex, comp: string): { count: number; list: TraceRecentReq[] } {
  const all = reqsOf(ix, comp, Infinity);
  return { count: all.length, list: all.slice(0, SPEC_RECENT_REQS) };
}
