/**
 * The lobby board (T-0046), its pure rules (the H/W history is hwHistory.ts):
 * the donut maths, the pages and their rotation, the project rows with
 * "외 N", the GPU queue's labels and the ending words. The Node runner tests
 * these; BoardPages.tsx draws them and LobbyBoard.tsx places the board.
 */
import type { GpuEnd, GpuTicket } from '../../../../core/src/messages.js';
import {
  BOARD_PAGE_MS,
  BOARD_PICK_HOLD_MS,
  BOARD_PROJECT_ROWS,
  BOARD_RECENT_MS,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { contextPct } from '../ez/fatigueState.js';
import type { RingState } from '../ez/visuals.js';
import { timeAgo } from '../format.js';
import { isFeedNoise } from '../notify/newsList.js';
import { type CldSnapshot, ezContext, virtualAgentId } from '../officeStore.js';
import { codexWord, jobWord, spanText } from '../panels/jobs.js';
import { rowLook } from '../panels/statusTree.js';
import { serverLine } from '../serverText.js';
import { capRows } from '../temps.js';

// ── Donuts ───────────────────────────────────────────────────

/** How full a donut is (0-1), or null when it cannot be drawn. */
export function donutFrac(
  used: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (used == null || total == null || !(total > 0) || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(1, used / total));
}

/** The arc of `frac`, clockwise from 12 o'clock (radians). */
export function donutArc(frac: number): { start: number; end: number } {
  const start = -Math.PI / 2;
  return { start, end: start + frac * 2 * Math.PI };
}

/** "37%", with "<1%" and ">99%" so a sliver never reads as 0 or 100. */
export function pctText(frac: number): string {
  if (frac > 0 && frac < 0.01) return '<1%';
  if (frac < 1 && frac > 0.99) return '>99%';
  return `${Math.round(frac * 100)}%`;
}

// ── Pages ────────────────────────────────────────────────────

export const BOARD_PAGES = ['projects', 'hw', 'gpu'] as const;
export type BoardPage = (typeof BOARD_PAGES)[number];
export const pageTitle = (page: BoardPage): string =>
  page === 'projects' ? t('board.page.projects') : page === 'hw' ? 'H/W' : 'GPU';

/** The board's turning pages: the one shown, since when, and when a tab was last picked. */
export interface Rotation {
  page: BoardPage;
  since: number;
  picked: number;
}

export const startRotation = (now: number): Rotation => ({
  page: 'projects',
  since: now,
  picked: -Infinity,
});

/** A tab picked by hand: its page, held for BOARD_PICK_HOLD_MS. */
export const pickPage = (page: BoardPage, now: number): Rotation => ({
  page,
  since: now,
  picked: now,
});

/**
 * One tick: the page turns every BOARD_PAGE_MS, but not while the pointer
 * is over the board or a tab was picked in the last BOARD_PICK_HOLD_MS; a
 * pause restarts the page's full time.
 */
export function rotate(r: Rotation, now: number, hovering: boolean): Rotation {
  if (hovering || now - r.picked < BOARD_PICK_HOLD_MS)
    return r.since === now ? r : { ...r, since: now };
  if (now - r.since < BOARD_PAGE_MS) return r;
  const next = BOARD_PAGES[(BOARD_PAGES.indexOf(r.page) + 1) % BOARD_PAGES.length];
  return { ...r, page: next, since: now };
}

// ── 프로젝트 ─────────────────────────────────────────────────

export interface ProjectRow {
  name: string;
  agentId: number;
  ring: RingState;
  /** 피로도: the context in use, %, or null before its first report. */
  context: number | null;
  jobs: number;
  codex: number;
  work: string | null;
  /** "3분 전 · 빌드 끝", or null. */
  last: string | null;
}

/** Feed kinds too chatty to be a project's notable news. */
const isNoise = (kind: string): boolean => kind === 'turn_end' || isFeedNoise(kind);
/** What most needs the user first. */
const ATTENTION: RingState[] = ['permission', 'waiting', 'working', 'neutral', 'idle', 'off'];

/** One row per project, those that need the user first; past `max`, "외 N". D3b: `workers`
 *  (a project's Workers) are no project rows. */
export function projectRows(
  snap: CldSnapshot,
  agentTools: Record<number, ToolActivity[]>,
  now: number,
  max = BOARD_PROJECT_ROWS,
  workers: ReadonlySet<string> = new Set(),
): { shown: ProjectRow[]; more: number } {
  const office = snap.officeSnapshot;
  if (!office) return { shown: [], more: 0 };
  const ctx = ezContext(snap);
  const rows = office.orchestrators.filter((o) => !workers.has(o.name)).map((o) => {
    const agentId = o.agentId ?? virtualAgentId(`orch:${o.name}`);
    const sample = snap.contexts[agentId];
    const event = snap.events.find((e) => e.name === o.name && !isNoise(e.kind));
    const said = event ? serverLine(event.summary) : undefined;
    const summary = said?.startsWith(`${o.name} `) ? said.slice(o.name.length + 1) : said;
    const runningJob = snap.officeJobs?.jobs.find((j) => j.project === o.name && !j.ended);
    const runningCodex = snap.codexTasks?.tasks.find(
      (t) => t.project === o.name && (t.state === 'running' || t.state === 'limit'),
    );
    return {
      order: o.order,
      row: {
        name: o.name,
        agentId,
        ring: rowLook(o, o.agentId != null ? agentTools[o.agentId] : undefined, ctx).ring,
        context: sample ? Math.round(contextPct(sample)) : null,
        jobs: (snap.officeJobs?.jobs ?? []).filter((j) => j.project === o.name && !j.ended).length,
        codex: (snap.codexTasks?.tasks ?? []).filter(
          (t) => t.project === o.name && (t.state === 'running' || t.state === 'limit'),
        ).length,
        work:
          [
            runningJob && `${runningJob.label ?? t('panel.job')} · ${jobWord(runningJob)}`,
            runningCodex &&
              `${runningCodex.title ?? runningCodex.spec ?? t('panel.codexJob')} · ${codexWord(runningCodex)}`,
          ]
            .filter(Boolean)
            .join(' / ') || null,
        last: event ? `${timeAgo(event.ts, now)} · ${summary}` : null,
      },
    };
  });
  rows.sort(
    (a, b) => ATTENTION.indexOf(a.row.ring) - ATTENTION.indexOf(b.row.ring) || a.order - b.order,
  );
  return capRows(
    rows.map((r) => r.row),
    max,
  );
}

export const moreText = (more: number): string => t('board.more', { count: more });

/** The ticker's items: the latest notable news across projects, newest first. */
export function tickerItems(events: CldSnapshot['events'], now: number, max = 6): string[] {
  return events
    .filter((e) => !isNoise(e.kind))
    .slice(0, max)
    .map((e) => `${timeAgo(e.ts, now)} ${serverLine(e.summary)}`);
}

// ── GPU ──────────────────────────────────────────────────────

/** A ticket's number as printed on it: "#07". */
export const ticketText = (n: number): string => `#${String(n).padStart(2, '0')}`;

/** "2 GiB", or "?" when it gave none (it then runs alone, HIF §9). */
export const vramText = (gib: number | null | undefined): string =>
  gib == null ? 'VRAM ?' : `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;

/** How long since `ts` ("12분"), for waits and holds. */
export function sinceText(ts: string, now: number): string {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? spanText(now - t) : '?';
}

/** A ticket's line on the board: number, VRAM, wait. */
export const ticketLine = (t: GpuTicket, now: number): string =>
  `${ticketText(t.ticket)} · ${vramText(t.vramGib)} · ${sinceText(t.ts, now)}`;

/** How a ticket ended, in words (HIF §6: gpu_cancel's reasons, gpu_release). */
export function endWords(e: Pick<GpuEnd, 'kind' | 'reason' | 'exit'>): string {
  if (e.reason === 'dead') return t('board.end.dead');
  if (e.kind === 'cancel') {
    if (e.reason === 'wait') return t('board.end.wait');
    if (e.reason === 'stop') return t('board.end.stop');
    return t('board.end.cancel');
  }
  return e.exit != null && e.exit !== 0 ? t('board.end.failed') : t('board.end.done');
}

/** The endings still on the board, newest first, each with how faded it is (1 = new, 0 = gone). */
export function recentEnds(
  recent: readonly GpuEnd[],
  now: number,
): Array<{ end: GpuEnd; fade: number }> {
  return recent
    .map((end) => ({ end, age: now - Date.parse(end.ts) }))
    .filter(({ age }) => Number.isFinite(age) && age < BOARD_RECENT_MS)
    .map(({ end, age }) => ({ end, fade: 1 - Math.max(0, age) / BOARD_RECENT_MS }))
    .reverse();
}
