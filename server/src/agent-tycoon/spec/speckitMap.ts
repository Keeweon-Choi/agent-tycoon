/**
 * K9 (Project Brain §8.2-§8.3), pure: a Spec Kit feature folder's readings (speckit.ts), put into the
 * map's answer, and the chain's side of them. The numbers a task line writes are the evidence: a
 * story's tasks are the lines tagged `[USn]`, its files the paths those lines name, an FR's tasks
 * the lines that write its number. What Spec Kit does not write is not guessed (`notRead`): no FR ↔
 * story link (the template has no notation), nothing from a constitution's prose, a data model's
 * relations or tasks.md's dependency prose. Every string is masked here, where it is made.
 */
import type { MapKit, MapKitCounts } from '../../../../core/src/agent-tycoon/spec/trace.js';
import { SPEC_KIT_LIST_MAX, SPEC_KIT_TEXT_MAX } from '../../constants.js';
import { maskText } from '../mask.js';
import { type KitDecision, kitId,type KitPlan, type KitSpec, type KitTasks } from './speckit.js';

/** One folder's files, each read when tracked. */
export interface KitReads {
  spec?: KitSpec;
  tasks?: KitTasks;
  plan?: KitPlan;
  research?: KitDecision[];
  /** A tracked data-model.md sits in the folder (its relations are not read). */
  dataModel?: boolean;
}

/** The code files of the scan, with every folder that holds one (`src/api/` with the slash). */
export interface CodeIndex {
  files: ReadonlySet<string>;
  dirs: ReadonlySet<string>;
}
export function codeIndex(files: readonly string[]): CodeIndex {
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i + 1));
  return { files: new Set(files), dirs };
}
const existsIn = (code: CodeIndex | null, path: string): boolean | null => (code ? (path.endsWith('/') ? code.dirs.has(path) : code.files.has(path) || code.dirs.has(`${path}/`)) : null);

const cut = (s: string) => maskText(s.length > SPEC_KIT_TEXT_MAX ? s.slice(0, SPEC_KIT_TEXT_MAX) : s);
const top = <T>(xs: readonly T[]): T[] => xs.slice(0, SPEC_KIT_LIST_MAX);

/** The counts alone (the feature rows). */
export function kitCounts(r: KitReads): MapKitCounts {
  const tasks = r.tasks?.tasks ?? [];
  return {
    stories: r.spec?.stories.length ?? 0,
    frs: r.spec?.frs.length ?? 0,
    scs: r.spec?.scs.length ?? 0,
    tasks: tasks.length,
    done: tasks.filter((t) => t.done).length,
    clarify: r.spec?.frs.filter((f) => f.clarify).length ?? 0,
  };
}

/** The chain's side of a story: the tasks tagged `[USn]` (display IDs and titles) and the files they name. */
export function storyTasks(dir: string, tasks: KitTasks | undefined, n: number): { ids: string[]; titles: Array<[string, string]>; files: string[] } {
  const mine = (tasks?.tasks ?? []).filter((t) => t.story === n);
  return {
    ids: mine.map((t) => kitId(dir, t.id)),
    titles: mine.map((t) => [kitId(dir, t.id), cut(t.text)] as [string, string]),
    files: [...new Set(mine.flatMap((t) => t.files))],
  };
}

/** The whole block for `?feature=`. `code`: the scan's files (null without a scan: nothing is judged to exist). */
export function kitBlock(dir: string, r: KitReads, code: CodeIndex | null, constitution: boolean): MapKit {
  const tasks = r.tasks?.tasks ?? [];
  const spec = r.spec;
  const planPaths = r.plan?.paths ?? [];
  const namedFiles = new Set(tasks.flatMap((t) => t.files));
  const planOnly = new Set<string>();
  for (const p of planPaths) if (p.path.endsWith('/') && existsIn(code, p.path) === false) planOnly.add(p.path.replace(/\/$/, ''));
  for (const f of namedFiles) {
    const d = f.slice(0, f.lastIndexOf('/') + 1);
    if (existsIn(code, d) === false) planOnly.add(d.replace(/\/$/, ''));
  }
  const tasksOfFr = (id: string) => tasks.filter((t) => t.frs.includes(id)).map((t) => t.id);
  const read: MapKit['read'] = [...(spec ? (['spec'] as const) : []), ...(r.tasks ? (['tasks'] as const) : []), ...(r.plan ? (['plan'] as const) : []), ...(r.research ? (['research'] as const) : [])];
  const notRead: MapKit['notRead'] = [];
  if (spec?.frs.length) notRead.push('frStory');
  if (spec?.frs.length && tasks.length && !tasks.some((t) => t.frs.length)) notRead.push('frTask');
  if (r.tasks?.dependenciesProse) notRead.push('dependencies');
  if (r.dataModel) notRead.push('dataModel');
  if (constitution) notRead.push('constitution');
  return {
    dir,
    title: cut(spec?.title || dir),
    counts: kitCounts(r),
    read,
    stories: top(spec?.stories ?? []).map((s) => {
      const mine = tasks.filter((t) => t.story === s.n);
      return {
        id: `US${s.n}`,
        title: cut(s.title),
        ...(s.priority && { priority: s.priority }),
        line: s.line,
        scenarios: top(s.scenarios).map(cut),
        tasks: mine.length,
        done: mine.filter((t) => t.done).length,
        files: new Set(mine.flatMap((t) => t.files)).size,
      };
    }),
    frs: top(spec?.frs ?? []).map((f) => {
      const ts = tasksOfFr(f.id);
      return { id: f.id, text: cut(f.text), line: f.line, ...(f.clarify && { clarify: true as const }), ...(ts.length && { tasks: ts }) };
    }),
    scs: top(spec?.scs ?? []).map((s) => ({ id: s.id, text: cut(s.text), line: s.line })),
    entities: top(spec?.entities ?? []).map(cut),
    phases: (r.tasks?.phases ?? []).map((p, i) => {
      const mine = tasks.filter((t) => t.phase === i);
      return { label: p.label, title: cut(p.title), tasks: mine.length, done: mine.filter((t) => t.done).length };
    }),
    taskList: top(tasks).map((t) => ({
      id: t.id,
      done: t.done,
      ...(t.parallel && { parallel: true as const }),
      ...(t.story !== undefined && { story: t.story }),
      ...(t.phase >= 0 && { phase: t.phase }),
      text: cut(t.text),
      ...(t.files.length && { files: t.files.map((path) => ({ path: maskText(path), exists: existsIn(code, path) })) }),
      line: t.line,
    })),
    taskListMore: Math.max(0, tasks.length - SPEC_KIT_LIST_MAX),
    parallel: tasks.filter((t) => t.parallel).length,
    context: Object.fromEntries(Object.entries(r.plan?.context ?? {}).map(([k, v]) => [cut(k), cut(v)])),
    plan: top(planPaths).map((p) => ({ path: maskText(p.path), ...(p.note && { note: cut(p.note) }), exists: existsIn(code, p.path), line: p.line })),
    planOnly: top([...planOnly].sort()),
    decisions: top(r.research ?? []).map((d) => ({
      topic: cut(d.topic),
      decision: cut(d.decision),
      ...(d.rationale && { rationale: cut(d.rationale) }),
      ...(d.alternatives && { alternatives: cut(d.alternatives) }),
      line: d.line,
    })),
    notRead,
  };
}
