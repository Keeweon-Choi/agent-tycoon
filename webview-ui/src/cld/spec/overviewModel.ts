/**
 * SPT-P3-OVERVIEW: the 개요's pure parts. The Task counts it shows (and opens 이슈 on), the label of
 * the 요구사항 filter a number opens, and 최근 본 요구사항: the last requirements opened in the detail,
 * per project in localStorage (every access in try/catch: the page works without it).
 */
import type { EvidenceMark, TraceAcceptanceWeek, TraceEvidence } from '../../../../core/src/cld/spec/trace.js';
import type { BoardFactSource, BoardTask } from '../../../../core/src/messages.js';
import { GAME_WEEK_BAR_PX, GAME_WEEK_CELLS, SPEC_OVERVIEW_DONE_WINDOW_MS, SPEC_OVERVIEW_VIEWED } from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { LedState } from '../game/parts.js';
import { EVIDENCE_AXES, ledOf } from './traceModel.js';

export const TASK_COLUMNS = ['todo', 'doing', 'review', 'blocked', 'done'] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

/** The project's Tasks per status, and the ones done in the last 7 days (their last change, `updatedAt`). */
export function taskCounts(tasks: readonly Pick<BoardTask, 'project' | 'status' | 'updatedAt'>[], project: string, now: number) {
  const mine = tasks.filter((x) => x.project === project);
  const by = Object.fromEntries(TASK_COLUMNS.map((s) => [s, mine.filter((x) => x.status === s).length])) as Record<TaskColumn, number>;
  // ponytail: updatedAt is the last change, not the moment it became done; a done Task edited later counts again. A doneAt fact when that matters.
  const doneWeek = mine.filter((x) => x.status === 'done' && now - Date.parse(x.updatedAt) <= SPEC_OVERVIEW_DONE_WINDOW_MS).length;
  return { ...by, doneWeek };
}

const AXIS_KEY = { change: 'spec.ev.change', integration: 'spec.ev.integration', test: 'spec.ev.test', deploy: 'spec.ev.deploy' } as const;
/** The 요구사항 list's chip for a `show` filter (the server's SHOW_FILTERS). */
export function showText(show: string): string {
  const [kind, value] = show.split(':');
  if (kind === 'ev' || kind === 'evr') {
    const axis = t(AXIS_KEY[value as keyof typeof AXIS_KEY] ?? 'spec.ev.change');
    return kind === 'ev' ? t('spec.overview.show.ev', { axis }) : t('spec.overview.show.evr', { axis });
  }
  if (kind === 'review') return t('spec.fresh.review');
  if (kind === 'missing') return t('spec.fresh.missing');
  if (kind === 'linked') return t('spec.overview.show.linked');
  if (kind === 'observed') return t('spec.overview.show.observed');
  return t('spec.overview.unlinked');
}

// ── GAME-UI-0: 진행 중 작업's lights ──
type Axis = (typeof EVIDENCE_AXES)[number];
const markOf = (f?: { value: boolean | number; source: BoardFactSource }): EvidenceMark =>
  !f?.value ? 'none' : f.source === 'observed' ? 'observed' : f.source === 'reported' ? 'reported' : 'none';
/**
 * A Task's four lights: its linked requirement's evidence (`ev`, from `…/task/:id`), else what the
 * Task itself says (its commits and tests, as the server counts them; integration and deploy it
 * cannot know). A half light carries why when the data says it: the Task's own report, or a deploy
 * job's exit 0 (always the reason for 배포 ◐); else none, and the 개요 shows only '<axis> 보고만'.
 */
export function questLights(task: Pick<BoardTask, 'id' | 'commits' | 'testsPassed'>, ev?: TraceEvidence): Array<{ axis: Axis; led: LedState; why?: string }> {
  const own: Record<Axis, EvidenceMark> = { change: markOf(task.commits), integration: 'none', test: markOf(task.testsPassed), deploy: 'none' };
  return EVIDENCE_AXES.map((axis) => {
    const led = ledOf(ev ? ev[axis] : own[axis]);
    const why =
      led !== 'half'
        ? undefined
        : axis === 'test' && own.test === 'reported'
          ? t('game.why.taskTest', { task: task.id })
          : axis === 'change' && own.change === 'reported'
            ? t('game.why.taskCommits', { task: task.id, count: Number(task.commits?.value) })
            : axis === 'deploy'
              ? t('game.why.deploy.half')
              : undefined;
    return { axis, led, ...(why && { why }) };
  });
}

// ── 최근 본 요구사항 ──
export interface Viewed {
  uid: string;
  label: string;
}
const viewedKey = (project: string) => `cld.spec.viewed.v1:${project}`;

/** A stored list, checked: anything else is an empty list. */
export function parseViewed(raw: string | null): Viewed[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is Viewed => typeof x?.uid === 'string' && typeof x?.label === 'string').slice(0, SPEC_OVERVIEW_VIEWED) : [];
  } catch {
    return [];
  }
}
/** `v` first, once, the list cut at SPEC_OVERVIEW_VIEWED. */
export const pushViewed = (list: readonly Viewed[], v: Viewed): Viewed[] => [v, ...list.filter((x) => x.uid !== v.uid)].slice(0, SPEC_OVERVIEW_VIEWED);

export function readViewed(project: string): Viewed[] {
  try {
    return parseViewed(localStorage.getItem(viewedKey(project)));
  } catch {
    return [];
  }
}
export function rememberViewed(project: string, v: Viewed): void {
  try {
    localStorage.setItem(viewedKey(project), JSON.stringify(pushViewed(readViewed(project), v)));
  } catch {
    // Storage blocked: the 개요 shows none.
  }
}

// ── GAME-UI-1 G2: 이번 주 수락 ──
/**
 * 이번 주 수락's numbers: this week's sum, the best past week, whether this week beats it (신기록:
 * gold, only past a real best, never on a project's first accepted week), each day's cells (at
 * most GAME_WEEK_CELLS, accepted first, rejected on top) and the bars of the past weeks and this one.
 */
export function weekView(w: TraceAcceptanceWeek) {
  const total = w.days.reduce((n, d) => n + d.accepted, 0);
  const best = Math.max(0, ...w.weeks);
  const all = [...w.weeks, total];
  const top = Math.max(1, ...all);
  return {
    total,
    best,
    record: best > 0 && total > best,
    days: w.days.map((d, i) => {
      const accepted = Math.min(d.accepted, GAME_WEEK_CELLS);
      return { ...d, cells: accepted, rejectedCells: Math.min(d.rejected, GAME_WEEK_CELLS - accepted), future: i > w.today, today: i === w.today };
    }),
    bars: all.map((n) => Math.max(2, Math.round((n / top) * GAME_WEEK_BAR_PX))),
  };
}
