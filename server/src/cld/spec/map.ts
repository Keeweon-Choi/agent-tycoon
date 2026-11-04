/**
 * MAP-A, pure: the 지도's structure view. The owner's architecture as the arch query gives it
 * (applyOwner's nodes, a document's subgraphs as groups, composition edges) and the trace index
 * become a module tree: each module's parent from one of three sources, never mixed (the owner's
 * `parents` in arch.json, else its document subgraph, else the folder skeleton's level above), and
 * per module its requirements (confirmed, observed and suggested counted apart, each requirement once
 * at its strongest status, the modules below included) and its active Tasks. `buildMapModel` runs
 * once per revision; `mapView` cuts one selected item out of it. No git, no file, no LLM.
 */
import type {
  ArchNode,
  ArchSource,
  ArchStanding,
  MapCard,
  MapDep,
  MapModule,
  MapOrigin,
  MapParentFrom,
  MapReq,
  MapReqCounts,
  MapUncertain,
  TraceArch,
  TraceMap,
} from '../../../../core/src/cld/spec/trace.js';
import { SPEC_MAP_ACTIVE_TASKS, SPEC_MAP_CARDS_MAX, SPEC_MAP_DEPS_MAX, SPEC_MAP_REQS_MAX, SPEC_MAP_SOURCES_MAX, SPEC_MAP_TREE_MAX, SPEC_MAP_UNCERTAIN_MAX } from '../../constants.js';
import type { TraceIndex } from './trace.js';

export const MAP_ROOT = 'root';
type Status = MapReq['status'];
const RANK: Record<Status, number> = { confirmed: 0, observed: 1, suggested: 2 };
/** Card order: what needs a look again first (its document changed since approval), then approved, read from documents, proposed. */
const STANDING_RANK: Record<ArchStanding, number> = { review: 0, approved: 1, doc: 2, proposed: 3 };

interface Mod {
  id: string;
  label: string;
  kind: MapCard['kind'];
  standing: ArchStanding;
  sources: ArchSource[];
  note?: string;
  folder?: string;
  parent?: string;
  parentFrom?: MapParentFrom;
}
export interface MapModel {
  mods: Map<string, Mod>;
  /** Parent id (MAP_ROOT for the top) → its children, in card order. */
  children: Map<string, string[]>;
  /** Each module's own requirements (realizes): requirement UID → its strongest status. Those below are added when a view asks (subtree). */
  own: Map<string, Map<string, Status>>;
  /** Modules with a confirmed or observed requirement, or any, at or below them (the card order and the 불확실 bundle). */
  strong: Set<string>;
  any: Set<string>;
  edges: TraceArch['edges'];
  ix: TraceIndex;
  pending: TraceMap['pending'];
}

const originOf = (s: ArchStanding): MapOrigin => (s === 'approved' ? 'owner_confirmed' : s === 'proposed' ? 'algorithm_suggested' : 'document_explicit');
/** A subgraph's diagram: `g:<doc>:<block>:<index>` → `<doc>:<block>`. */
const diagramOfGroup = (gid: string) => gid.slice(2, gid.lastIndexOf(':'));
/** `top/sub/` → `top/`; a top folder has none. */
const folderAbove = (p: string) => {
  const parts = p.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/` : undefined;
};

export function buildMapModel(arch: TraceArch, owner: ReadonlyArray<{ uid: string; parent: string }>, ix: TraceIndex): MapModel {
  const mods = new Map<string, Mod>();
  const standingOf = new Map(arch.diagrams.map((d) => [d.id, d.standing] as const));
  for (const g of arch.groups) mods.set(g.id, { id: g.id, label: g.label, kind: 'group', standing: standingOf.get(diagramOfGroup(g.id)) ?? 'doc', sources: [g.source] });
  const nodeById = new Map<string, ArchNode>();
  for (const n of arch.nodes) {
    nodeById.set(n.id, n);
    mods.set(n.id, { id: n.id, label: n.label, kind: n.kind, standing: n.standing, sources: n.sources, ...(n.note && { note: n.note }), ...(n.folder && { folder: n.folder }) });
  }
  // The folder each module stands for (its own, else the first one merged into it).
  const byFolder = new Map<string, string>();
  for (const n of arch.nodes) for (const f of [n.folder, ...(n.folders ?? [])]) if (f && !byFolder.has(f)) byFolder.set(f, n.id);
  const groupById = new Map(arch.groups.map((g) => [g.id, g] as const));
  const candidates = (id: string): Array<[string | undefined, MapParentFrom]> => {
    const n = nodeById.get(id);
    const doc = n ? n.group : groupById.get(id)?.parent;
    const own = n?.folder ?? n?.folders?.[0];
    const up = own ? folderAbove(own) : undefined;
    return [
      [doc, 'doc'],
      [up && byFolder.get(up), 'folder'],
    ];
  };
  // A parent is taken only when the chain above it never comes back to the module (a hand-made
  // arch.json may hold a cycle): the owner's first, in the file's order, then each module's own.
  const cycles = (id: string, parent: string) => {
    for (let at: string | undefined = parent, n = 0; at && n <= mods.size; at = mods.get(at)?.parent, n++) if (at === id) return true;
    return false;
  };
  const set = (id: string, parent: string | undefined, from: MapParentFrom) => {
    const m = mods.get(id);
    if (!m || m.parent || !parent || parent === id || !mods.has(parent) || cycles(id, parent)) return false;
    m.parent = parent;
    m.parentFrom = from;
    return true;
  };
  for (const p of owner) set(p.uid, p.parent, 'owner');
  for (const id of mods.keys()) for (const [parent, from] of candidates(id)) if (set(id, parent, from)) break;

  // Each module's own requirements (realizes; the index already resolved aliases).
  const own = new Map<string, Map<string, Status>>();
  for (const id of mods.keys()) {
    const m = new Map<string, Status>();
    for (const i of ix.adj.get(id) ?? []) {
      const e = ix.edges[i];
      if (e.rel !== 'realizes' || e.status === 'rejected') continue;
      const req = e.from === id ? e.to : e.from;
      if (ix.nodes.get(req)?.type === 'req') put(m, req, e.status);
    }
    own.set(id, m);
  }
  const children = new Map<string, string[]>([[MAP_ROOT, []]]);
  for (const m of mods.values()) {
    const p = m.parent ?? MAP_ROOT;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(m.id);
  }
  // Flags only (memory linear in the modules), children before parents (the top-down order reversed,
  // no recursion however deep): a module has what its children have.
  const strong = new Set<string>();
  const any = new Set<string>();
  const order: string[] = [];
  for (let i = 0, q = [...children.get(MAP_ROOT)!]; i < q.length; i++) {
    order.push(q[i]);
    q.push(...(children.get(q[i]) ?? []));
  }
  for (const id of order.reverse()) {
    const mine = [...own.get(id)!.values()];
    const p = mods.get(id)!.parent;
    if (mine.length || any.has(id)) {
      any.add(id);
      if (p) any.add(p);
    }
    if (mine.some((x) => x !== 'suggested') || strong.has(id)) {
      strong.add(id);
      if (p) strong.add(p);
    }
  }
  const pending = {
    diagrams: arch.diagrams.filter((d) => d.standing === 'doc').map((d) => ({ doc: d.doc, block: d.block, version: d.version })),
    folders: arch.nodes.flatMap((n) => (n.standing === 'proposed' && n.folder ? [n.folder] : [])),
  };
  const model: MapModel = { mods, children, own, strong, any, edges: arch.edges, ix, pending };
  for (const list of children.values())
    list.sort((a, b) => {
      const x = mods.get(a)!;
      const y = mods.get(b)!;
      return (
        STANDING_RANK[x.standing] - STANDING_RANK[y.standing] ||
        Number(strong.has(b)) - Number(strong.has(a)) ||
        Number(any.has(b)) - Number(any.has(a)) ||
        (children.get(b)?.length ?? 0) - (children.get(a)?.length ?? 0) ||
        (x.label < y.label ? -1 : x.label > y.label ? 1 : 0)
      );
    });
  return model;
}

const put = (m: Map<string, Status>, uid: string, s: Status) => {
  const old = m.get(uid);
  if (!old || RANK[s] < RANK[old]) m.set(uid, s);
};
/** The requirements of `id` and every module below it, each at its strongest (a visited set: computed when a view asks, never kept). */
function subtree(m: MapModel, ids: readonly string[]): Map<string, Status> {
  const out = new Map<string, Status>();
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const [u, s] of m.own.get(id) ?? []) put(out, u, s);
    stack.push(...(m.children.get(id) ?? []));
  }
  return out;
}

function counts(reqs: ReadonlyMap<string, Status>): MapReqCounts {
  const out: MapReqCounts = { confirmed: 0, observed: 0, suggested: 0 };
  for (const s of reqs.values()) out[s]++;
  return out;
}
/** Tasks in doing, review or blocked, confirmed to one of these requirements that is confirmed or observed for the module (a suggestion counts none). */
function activeTasks(ix: TraceIndex, reqs: ReadonlyMap<string, Status>): number {
  const tasks = new Set<string>();
  for (const [uid, s] of reqs) {
    if (s === 'suggested') continue;
    for (const i of ix.adj.get(uid) ?? []) {
      const e = ix.edges[i];
      if (e.rel !== 'implements' || e.status !== 'confirmed') continue;
      const byStatus = ix.nodes.get(e.to)?.state?.work?.byStatus ?? {};
      if (Object.keys(byStatus).some((st) => SPEC_MAP_ACTIVE_TASKS.has(st))) tasks.add(e.to);
    }
  }
  return tasks.size;
}

function card(m: MapModel, id: string, reqs = subtree(m, [id])): MapCard {
  const x = m.mods.get(id)!;
  return {
    id,
    label: x.label,
    kind: x.kind,
    standing: x.standing,
    origin: originOf(x.standing),
    ...(x.parentFrom && { parentFrom: x.parentFrom }),
    reqs: counts(reqs),
    activeTasks: activeTasks(m.ix, reqs),
    children: m.children.get(id)?.length ?? 0,
  };
}

/** The view of one selected item (MAP_ROOT: the project); null when `uid` is no module of it. */
export function mapView(m: MapModel, uid: string): TraceMap | null {
  if (uid !== MAP_ROOT && !m.mods.has(uid)) return null;
 const reqs = subtree(m, uid === MAP_ROOT ? m.children.get(MAP_ROOT)! : [uid]);
  const all = reqs;
  const x = m.mods.get(uid);
  const selected: MapModule = x
    ? { ...card(m, uid, reqs), ...(x.parent && { parent: x.parent }), sources: x.sources.slice(0, SPEC_MAP_SOURCES_MAX), ...(x.note && { note: x.note }), ...(x.folder && { folder: x.folder }) }
    : { id: MAP_ROOT, label: '', kind: 'system', standing: 'approved', origin: 'owner_confirmed', reqs: counts(all), activeTasks: activeTasks(m.ix, all), children: m.children.get(MAP_ROOT)!.length, sources: [] };
  const crumbs: TraceMap['crumbs'] = [];
  for (let at = x?.parent, n = 0; at && n <= m.mods.size; at = m.mods.get(at)?.parent, n++) crumbs.unshift({ id: at, label: m.mods.get(at)!.label });
  crumbs.unshift({ id: MAP_ROOT, label: '' });
  if (x) crumbs.push({ id: uid, label: x.label });

  const kids = m.children.get(uid) ?? [];
  const cards = kids.slice(0, SPEC_MAP_CARDS_MAX).map((id) => card(m, id));
  // Dependencies between the cards shown: each relation's ends lifted to the card they sit under.
  const shown = new Set(cards.map((c) => c.id));
  const lift = (id: string) => {
    for (let at: string | undefined = id, n = 0; at && n <= m.mods.size; at = m.mods.get(at)?.parent, n++) if (shown.has(at)) return at;
    return undefined;
  };
  const deps = new Map<string, MapDep>();
  for (const e of m.edges) {
    const from = lift(e.from);
    const to = lift(e.to);
    if (!from || !to || from === to) continue;
    const origin = e.owner ? 'owner_confirmed' : 'document_explicit';
    const key = `${from}|${to}|${origin}`;
    const old = deps.get(key);
    if (old) old.count++;
    else if (deps.size < SPEC_MAP_DEPS_MAX) deps.set(key, { from, to, ...(e.label && { label: e.label }), origin, count: 1 });
  }
  const uncertain: MapUncertain[] = [];
  for (const id of kids) {
    const k = m.mods.get(id)!;
    const why: MapUncertain['why'] | null = k.standing !== 'approved' ? k.standing : m.strong.has(id) ? null : m.any.has(id) ? 'suggested' : 'unlinked';
    if (why) uncertain.push({ id, label: k.label, why });
  }
  const order = new Map(m.ix.reqs.map((u, i) => [u, i]));
  const reqList = [...reqs].sort(([a, s], [b, t]) => RANK[s] - RANK[t] || (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const tree: TraceMap['tree'] = [];
  let treeAll = 0;
  // Depth first, in card order, with a stack (no recursion however deep).
  for (const stack = [...m.children.get(MAP_ROOT)!].reverse(); stack.length; ) {
    const c = stack.pop()!;
    treeAll++;
    const k = m.mods.get(c)!;
    if (tree.length < SPEC_MAP_TREE_MAX) tree.push({ id: c, label: k.label, ...(k.parent && { parent: k.parent }), standing: k.standing, children: m.children.get(c)?.length ?? 0 });
    stack.push(...[...(m.children.get(c) ?? [])].reverse());
  }
  return {
    enabled: true,
    selected,
    crumbs,
    cards,
    more: kids.length - cards.length,
    deps: [...deps.values()],
    uncertain: uncertain.slice(0, SPEC_MAP_UNCERTAIN_MAX),
    uncertainMore: Math.max(0, uncertain.length - SPEC_MAP_UNCERTAIN_MAX),
    reqs: reqList.slice(0, SPEC_MAP_REQS_MAX).map(([u, status]) => {
      const n = m.ix.nodes.get(u);
      return { uid: u, label: n?.label ?? u, ...(n?.title && { title: n.title }), status, ...(m.ix.states.get(u) && { state: m.ix.states.get(u) }) };
    }),
    reqsMore: Math.max(0, reqList.length - SPEC_MAP_REQS_MAX),
    tree,
    treeMore: treeAll - tree.length,
    reqTotal: m.ix.reqs.length,
    pending: m.pending,
  };
}

/** Spec tracking off: an empty map (nothing was read to make it). */
export const offMap = (): TraceMap => ({
  enabled: false,
  selected: { id: MAP_ROOT, label: '', kind: 'system', standing: 'approved', origin: 'owner_confirmed', reqs: { confirmed: 0, observed: 0, suggested: 0 }, activeTasks: 0, children: 0, sources: [] },
  crumbs: [{ id: MAP_ROOT, label: '' }],
  cards: [],
  more: 0,
  deps: [],
  uncertain: [],
  uncertainMore: 0,
  reqs: [],
  reqsMore: 0,
  tree: [],
  treeMore: 0,
  reqTotal: 0,
  pending: { diagrams: [], folders: [] },
});

/** Whether `parent` above `uid` would make a cycle, given the parents now (the write's check: never write what the read would drop). */
export function parentCycles(m: MapModel, uid: string, parent: string): boolean {
  for (let at: string | undefined = parent, n = 0; at && n <= m.mods.size; at = m.mods.get(at)?.parent, n++) if (at === uid) return true;
  return false;
}
