/**
 * SPT C2 (§8.4, §6.8), pure: FR-TRC-018's links from requirements to code files, four paths counted
 * apart and never stored: 확정 (a folder of a component the owner confirmed it realizes), 직접 (a
 * layer file names its number; a test file or a rail's only in a test name), 커밋 (a commit naming it
 * changed the file), 작업 (a task number pointing at it, by its spec or the requirement's own row,
 * named by a file or a commit). Test data (a fixtures folder) never links. Then, for the structure
 * shown: the cells each feature reaches (요구 N), the bar, the chain's numbers, each cell's 7-day
 * activity and recent work, and the commits linked by a head-comment tag only (§14 D3: counted, never
 * tied to a feature). Inputs are the code scan (mapWorker.ts) and what the service knows.
 */
import type { MapBlockDetail, MapFeatureDetail, MapLinkPath, MapStructure } from '../../../../core/src/cld/spec/trace.js';
import { SPEC_MAP_BLOCK_RECENT_MAX, SPEC_MAP_BLOCK_TAGS_MAX, SPEC_MAP_FEATURE_TASKS_MAX, SPEC_MAP_PATH_FILES_MAX } from '../../constants.js';
import type { CodeScan, ScanCommit } from './mapWorker.js';
import { layersOf, TEST_DIR } from './structure.js';

export const LINK_PATHS: readonly MapLinkPath[] = ['confirmed', 'direct', 'commit', 'task'];
/** Test data: a folder so named is out of every path (SPT §8.4). */
export const TEST_DATA_DIR = /(^|\/)(fixtures|__fixtures__|testdata|mocks|__mocks__)\//;
/** A test file inside a layer: its test names count, not its body. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TASK_ID = /^T-\d{1,5}$/;

/** A requirement as the chain sees it: the tasks linked to it besides the task specs (its row's T-NNNN, Task Board Tasks), the folders of the components it is confirmed to realize. */
export interface ChainReq {
  uid: string;
  id: string;
  tasks: readonly string[];
  folders: readonly string[];
}
export interface ReqLink {
  paths: Record<MapLinkPath, Set<number>>;
  tasks: string[];
  /** Commits (indexes into the scan's) naming its number. */
  commits: number[];
  /** A commit of the window names it or one of its tasks (진행). */
  recent: boolean;
}
export interface Links {
  reqs: Map<string, ReqLink>;
  /** The requirement numbers and task numbers: a commit naming one is not 꼬리표로만. */
  known: Set<string>;
  commits: readonly ScanCommit[];
  /** Commits naming each task number. */
  taskCommits: Map<string, number[]>;
  titles: ReadonlyMap<string, string>;
}

/**
 * How a file's numbers count: 'body' anywhere in it (a layer's code), 'names' only in its test names
 * (a test file, a rail's file), 'none' (test data). `testData: false` turns the rule off (every body
 * counts): the negative control of the tests.
 */
export function fileRule(file: string, inLayer: boolean, testData = true): 'body' | 'names' | 'none' {
  if (!testData) return 'body';
  if (TEST_DATA_DIR.test(file)) return 'none';
  return !inLayer || TEST_DIR.test(file) || TEST_FILE.test(file) ? 'names' : 'body';
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => void (m.get(k) ?? m.set(k, []).get(k)!).push(v);

/** Every requirement's files by the four paths; null without the scan's links (a C1 scan). `since`: the 7-day window's start (ms). */
export function reqLinks(scan: CodeScan, reqs: readonly ChainReq[], since: number, taskTitles: ReadonlyMap<string, string> = new Map(), testData = true): Links | null {
  const L = scan.links;
  if (!L) return null;
  const layers = layersOf(scan.files, scan.edges, scan.workspaces);
  const rule = scan.files.map((f) => fileRule(f, f.includes('/') && layers.some((l) => f.startsWith(`${l}/`)), testData));
  const idFiles = (id: string) => {
    const out = new Set<number>();
    for (const i of L.body[id] ?? []) if (rule[i] === 'body') out.add(i);
    for (const i of L.names[id] ?? []) if (rule[i] !== 'none') out.add(i);
    return out;
  };
  const changed = (k: number) => L.commits[k].f.filter((i) => rule[i] !== 'none');
  const byId = new Map<string, number[]>();
  L.commits.forEach((c, k) => c.ids.forEach((id) => push(byId, id, k)));
  const specTasks = new Map<string, string[]>();
  for (const [num, t] of Object.entries(L.tasks)) for (const id of t.ids) push(specTasks, id, num);
  const taskFiles = new Map<string, Set<number>>();
  const filesOfTask = (t: string) => {
    let s = taskFiles.get(t);
    if (!s) {
      s = idFiles(t);
      for (const k of byId.get(t) ?? []) for (const i of changed(k)) s.add(i);
      taskFiles.set(t, s);
    }
    return s;
  };
  const sinceS = since / 1000;
  const fresh = (ks: readonly number[] | undefined) => !!ks?.some((k) => L.commits[k].t >= sinceS);
  const out = new Map<string, ReqLink>();
  const known = new Set<string>(Object.keys(L.tasks));
  for (const r of reqs) {
    if (r.id) known.add(r.id);
    const tasks = [...new Set([...r.tasks, ...(r.id ? (specTasks.get(r.id) ?? []) : [])])].sort();
    tasks.forEach((t) => known.add(t));
    const commits = r.id ? (byId.get(r.id) ?? []) : [];
    const commit = new Set<number>();
    for (const k of commits) for (const i of changed(k)) commit.add(i);
    const task = new Set<number>();
    for (const t of tasks) for (const i of filesOfTask(t)) task.add(i);
    const dirs = r.folders.map((d) => `${d.replace(/\/+$/, '')}/`);
    const confirmed = new Set<number>();
    if (dirs.length) scan.files.forEach((f, i) => dirs.some((d) => f.startsWith(d)) && confirmed.add(i));
    out.set(r.uid, {
      paths: { confirmed, direct: r.id ? idFiles(r.id) : new Set(), commit, task },
      tasks,
      commits,
      recent: fresh(commits) || tasks.some((t) => fresh(byId.get(t))),
    });
  }
  const taskCommits = new Map([...byId].filter(([id]) => TASK_ID.test(id)));
  return { reqs: out, known, commits: L.commits, taskCommits, titles: new Map([...Object.entries(L.tasks).map(([k, t]) => [k, t.title] as const), ...taskTitles]) };
}

/** A requirement's files by the paths on. */
export function filesOn(l: ReqLink | undefined, on: ReadonlySet<MapLinkPath>): Set<number> {
  const s = new Set<number>();
  if (l) for (const p of on) for (const i of l.paths[p]) s.add(i);
  return s;
}
/** Its requirements that reach a file by a path on (the bar). */
export const linkedCount = (links: Links, uids: readonly string[], on: ReadonlySet<MapLinkPath>): number => uids.filter((u) => filesOn(links.reqs.get(u), on).size > 0).length;
/** A commit linked only by a head-comment tag: it names one and no requirement or task number. */
export const tagOnly = (c: ScanCommit, known: ReadonlySet<string>): boolean => c.tags.length > 0 && !c.ids.some((id) => known.has(id) || TASK_ID.test(id));

/** Fills the cells of the structure shown: which features reach each (요구 N, most first) and its commits of the window. */
export function lightCells(links: Links, s: MapStructure, owner: Int32Array, keyOf: ReadonlyMap<string, string>, on: ReadonlySet<MapLinkPath>, since: number): void {
  const per = s.blocks.map(() => new Map<string, number>());
  for (const [uid, l] of links.reqs) {
    const key = keyOf.get(uid);
    if (!key) continue;
    const cells = new Set<number>();
    for (const i of filesOn(l, on)) if (owner[i] >= 0) cells.add(owner[i]);
    for (const k of cells) per[k].set(key, (per[k].get(key) ?? 0) + 1);
  }
  const week = new Array<number>(s.blocks.length).fill(0);
  for (const c of links.commits) {
    if (c.t < since / 1000) continue;
    for (const k of new Set(c.f.map((i) => owner[i]))) if (k >= 0) week[k]++;
  }
  s.blocks.forEach((b, k) => {
    b.features = [...per[k]].sort((a, x) => x[1] - a[1] || (a[0] < x[0] ? -1 : 1)).map(([key, reqs]) => ({ key, reqs }));
    b.week = week[k];
  });
}

/** `?feature=`'s chain: 요구 → 작업 → 커밋 → 파일, its tasks, its 7-day commits, and per requirement [펼치기]'s files by every path. */
export function featureChain(
  links: Links,
  uids: readonly string[],
  files: readonly string[],
  on: ReadonlySet<MapLinkPath>,
  since: number,
): Pick<MapFeatureDetail, 'chain' | 'tasks' | 'tasksMore' | 'week'> & { perReq: Map<string, Pick<MapFeatureDetail['reqs'][number], 'tasks' | 'paths'>> } {
  const tasks = new Map<string, number>();
  const commits = new Set<number>();
  const all = new Set<number>();
  const perReq = new Map<string, Pick<MapFeatureDetail['reqs'][number], 'tasks' | 'paths'>>();
  for (const u of uids) {
    const l = links.reqs.get(u);
    if (!l) continue;
    l.tasks.forEach((t) => tasks.set(t, (tasks.get(t) ?? 0) + 1));
    l.commits.forEach((k) => commits.add(k));
    for (const i of filesOn(l, on)) all.add(i);
    const paths: NonNullable<MapFeatureDetail['reqs'][number]['paths']> = {};
    for (const p of LINK_PATHS)
      if (l.paths[p].size)
        paths[p] = {
          n: l.paths[p].size,
          files: [...l.paths[p]]
            .slice(0, SPEC_MAP_PATH_FILES_MAX)
            .map((i) => files[i])
            .sort(),
        };
    perReq.set(u, { ...(l.tasks.length && { tasks: l.tasks }), ...(Object.keys(paths).length && { paths }) });
  }
  const sinceS = since / 1000;
  const recent = new Set([...commits].filter((k) => links.commits[k].t >= sinceS));
  for (const t of tasks.keys()) for (const k of links.taskCommits.get(t) ?? []) if (links.commits[k].t >= sinceS) recent.add(k);
  const list = [...tasks].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return {
    chain: { reqs: uids.length, tasks: tasks.size, commits: commits.size, files: all.size },
    tasks: list.slice(0, SPEC_MAP_FEATURE_TASKS_MAX).map(([id, reqs]) => ({ id, ...(links.titles.get(id) && { title: links.titles.get(id) }), reqs })),
    tasksMore: Math.max(0, list.length - SPEC_MAP_FEATURE_TASKS_MAX),
    week: recent.size,
    perReq,
  };
}

/** `?block=`: the cell's features (named), its last commits, its head-comment tags, its 꼬리표로만 commits. */
export function blockDetail(
  links: Links,
  scan: CodeScan,
  s: MapStructure,
  owner: Int32Array,
  id: string,
  names: ReadonlyMap<string, { short: string; name: string }>,
): MapBlockDetail | null {
  const k = s.blocks.findIndex((b) => b.id === id);
  if (k < 0) return null;
  const b = s.blocks[k];
  const touches = (c: ScanCommit) => c.f.some((i) => owner[i] === k);
  const recent: MapBlockDetail['recent'] = [];
  let only = 0;
  for (const c of links.commits) {
    if (!touches(c)) continue;
    if (recent.length < SPEC_MAP_BLOCK_RECENT_MAX) recent.push({ sha: c.sha.slice(0, 7), at: new Date(c.t * 1000).toISOString(), subject: c.s, tags: c.tags });
    if (tagOnly(c, links.known)) only++;
  }
  const tags = Object.entries(scan.links?.tags ?? {})
    .map(([tag, fs]) => ({ tag, files: fs.filter((i) => owner[i] === k).length }))
    .filter((t) => t.files > 0)
    .sort((a, x) => x.files - a.files || (a.tag < x.tag ? -1 : 1))
    .slice(0, SPEC_MAP_BLOCK_TAGS_MAX);
  return {
    id,
    features: b.features.map((f) => ({ key: f.key, short: names.get(f.key)?.short ?? f.key, name: names.get(f.key)?.name ?? f.key, reqs: f.reqs })),
    week: b.week,
    recent,
    tags,
    tagOnly: only,
  };
}
