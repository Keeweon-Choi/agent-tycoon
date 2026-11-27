/**
 * T-184 개발실 브랜치 보기, its pure rules: which worktrees get a tip (live agents first, then the most
 * recently changed; past DEVBRANCH_TIPS_MAX one `+N` tip), which merges are today's loops, the jobs
 * running on the base, and where everything sits. BranchMap.tsx draws it.
 *
 * The geometry: the trunk is a horizontal line; tips stand above it in a grid, the row nearest the
 * trunk first. Each column keeps a gutter at its left with one vertical lane per row, the lane of the
 * nearest row rightmost: a branch leaves the trunk, climbs its own lane and turns right into its card,
 * so no branch crosses another or a card. Loops hang below the trunk, one column each, right of the
 * trunk's label, oldest at the left; a job running on the base sits in a box at the trunk's right end.
 */
import type { OfficeJob, RepoMerge } from '../../../../core/src/messages.js';
import {
  DEVBRANCH_BOX_H_PX,
  DEVBRANCH_BOX_W_PX,
  DEVBRANCH_CARD_H_PX,
  DEVBRANCH_CARD_MIN_W_PX,
  DEVBRANCH_CARD_W_PX,
  DEVBRANCH_COL_GAP_PX,
  DEVBRANCH_LANE_PX,
  DEVBRANCH_LOOP_DEPTH_PX,
  DEVBRANCH_LOOP_LABEL_H_PX,
  DEVBRANCH_LOOP_MORE_W_PX,
  DEVBRANCH_LOOP_W_PX,
  DEVBRANCH_LOOPS_MAX,
  DEVBRANCH_PAD_PX,
  DEVBRANCH_ROW_GAP_PX,
  DEVBRANCH_TIPS_MAX,
  DEVBRANCH_TRUNK_GAP_PX,
  DEVBRANCH_TRUNK_LABEL_H_PX,
  DEVBRANCH_TRUNK_LABEL_W_PX,
} from '../../constants.js';

export interface TipIn {
  key: string;
  /** Its agent is running. */
  live: boolean;
  /** Its last sign of life (ms; NaN unknown). */
  last: number;
}

export type Pt = readonly [number, number];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A tip's card and the branch to it (corner points, drawn with rounded corners). `key` null = the `+N` tip. */
export interface TipBox extends Box {
  key: string | null;
  line: Pt[];
}

/** A loop: the U under the trunk and its label's box. */
export interface LoopBox {
  key: string;
  line: Pt[];
  x: number;
  y: number;
  w: number;
}

export interface MapLayout {
  width: number;
  height: number;
  trunkY: number;
  /** Where the trunk's line ends (the box's left edge, else the right padding). */
  trunkEnd: number;
  tips: TipBox[];
  /** Worktrees in the `+N` tip. */
  folded: number;
  loops: LoopBox[];
  /** Today's earlier merges not drawn, and where their count goes. */
  loopsMore: number;
  moreX: number;
  /** The box of the job running on the base, when there is one. */
  box: Box | null;
}

const byOrder = (a: TipIn, b: TipIn) =>
  Number(b.live) - Number(a.live) || (b.last || 0) - (a.last || 0) || a.key.localeCompare(b.key);

/** The tips in drawing order, the rest folded. */
export function orderTips(tips: readonly TipIn[], max = DEVBRANCH_TIPS_MAX): { shown: string[]; folded: number } {
  const sorted = [...tips].sort(byOrder).map((t) => t.key);
  return sorted.length <= max ? { shown: sorted, folded: 0 } : { shown: sorted.slice(0, max), folded: sorted.length - max };
}

/** Today's merges into `base` (local day of `now`), oldest first: they went in (not `already`, not refused). */
export function mergedToday(merges: readonly RepoMerge[], base: string, now: number): RepoMerge[] {
  const day = new Date(now).toDateString();
  return merges
    .filter((m) => m.ok && m.kind !== 'already' && m.target === base && new Date(m.at).toDateString() === day)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The project's jobs running now on the base: not ended, and not run in one of `branches` (worktree task names). */
export function baseJobs(jobs: readonly OfficeJob[], project: string, branches: ReadonlySet<string>): OfficeJob[] {
  return jobs.filter((j) => j.project === project && !!j.started && !j.ended && !(j.run?.task && branches.has(j.run.task)));
}

/** The grid: the most columns whose cards and gutters fit `avail`; with one column too wide, a narrower card. */
function grid(count: number, avail: number): { cols: number; rows: number; cardW: number } {
  for (let cols = count; cols >= 1; cols--) {
    const rows = Math.ceil(count / cols);
    const colW = DEVBRANCH_CARD_W_PX + rows * DEVBRANCH_LANE_PX + DEVBRANCH_COL_GAP_PX;
    if (cols * colW - DEVBRANCH_COL_GAP_PX <= avail) return { cols, rows, cardW: DEVBRANCH_CARD_W_PX };
  }
  return { cols: 1, rows: count, cardW: Math.max(DEVBRANCH_CARD_MIN_W_PX, avail - count * DEVBRANCH_LANE_PX) };
}

export function layoutMap(
  width: number,
  tipKeys: readonly string[],
  folded: number,
  /** Oldest first: the newest that fit are drawn. */
  loopKeys: readonly string[],
  withBox = false,
): MapLayout {
  const pad = DEVBRANCH_PAD_PX;
  const count = tipKeys.length + (folded > 0 ? 1 : 0);
  const { cols, rows, cardW } = count ? grid(count, width - 2 * pad) : { cols: 1, rows: 0, cardW: DEVBRANCH_CARD_W_PX };
  const h = DEVBRANCH_CARD_H_PX;
  // The box stands half above the trunk: the cards keep their distance from it.
  const gap = withBox ? Math.max(DEVBRANCH_TRUNK_GAP_PX, DEVBRANCH_BOX_H_PX / 2 + DEVBRANCH_ROW_GAP_PX) : DEVBRANCH_TRUNK_GAP_PX;
  const gutter = rows * DEVBRANCH_LANE_PX;
  const colW = cardW + gutter + DEVBRANCH_COL_GAP_PX;
  const trunkY = rows ? pad + rows * h + (rows - 1) * DEVBRANCH_ROW_GAP_PX + gap : pad + (withBox ? DEVBRANCH_BOX_H_PX / 2 : 0);
  const keys: Array<string | null> = [...tipKeys, ...(folded > 0 ? [null] : [])];
  const tips = keys.map((key, i): TipBox => {
    const row = Math.floor(i / cols);
    const colX = pad + (i % cols) * colW;
    const x = colX + gutter;
    const y = trunkY - gap - h - row * (h + DEVBRANCH_ROW_GAP_PX);
    const lane = x - (row + 1) * DEVBRANCH_LANE_PX;
    const mid = y + h / 2;
    return { key, x, y, w: cardW, h, line: [[lane, trunkY], [lane, mid], [x, mid]] };
  });

  const box = withBox ? { x: width - pad - DEVBRANCH_BOX_W_PX, y: trunkY - DEVBRANCH_BOX_H_PX / 2, w: DEVBRANCH_BOX_W_PX, h: DEVBRANCH_BOX_H_PX } : null;
  const trunkEnd = box ? box.x : width - pad;

  // Loops: as many columns as fit between the trunk's label and its end (at most DEVBRANCH_LOOPS_MAX), the rest a count.
  const x0 = pad + DEVBRANCH_TRUNK_LABEL_W_PX;
  const avail = trunkEnd - (box ? DEVBRANCH_COL_GAP_PX : 0) - x0;
  let fit = Math.min(DEVBRANCH_LOOPS_MAX, Math.max(0, Math.floor(avail / DEVBRANCH_LOOP_W_PX)));
  if (loopKeys.length > fit) fit = Math.min(fit, Math.max(0, Math.floor((avail - DEVBRANCH_LOOP_MORE_W_PX) / DEVBRANCH_LOOP_W_PX)));
  const more = loopKeys.length - Math.min(fit, loopKeys.length);
  const shown = loopKeys.slice(more);
  const w = DEVBRANCH_LOOP_W_PX;
  const inset = DEVBRANCH_LANE_PX;
  const bottom = trunkY + DEVBRANCH_LOOP_DEPTH_PX;
  // The count of the earlier ones stands first, where they would have been.
  const first = x0 + (more > 0 ? DEVBRANCH_LOOP_MORE_W_PX : 0);
  const loops = shown.map((key, i): LoopBox => {
    const left = first + i * w;
    return {
      key,
      line: [[left + inset, trunkY], [left + 2 * inset, bottom], [left + w - 2 * inset, bottom], [left + w - inset, trunkY]],
      x: left,
      y: bottom,
      w,
    };
  });
  const below = Math.max(DEVBRANCH_TRUNK_LABEL_H_PX, loopKeys.length ? DEVBRANCH_LOOP_DEPTH_PX + DEVBRANCH_LOOP_LABEL_H_PX : 0, box ? DEVBRANCH_BOX_H_PX / 2 : 0);
  return { width, height: trunkY + below + pad, trunkY, trunkEnd, tips, folded, loops, loopsMore: more, moreX: x0, box };
}

/** A polyline with each inner corner rounded by up to `r` (a quadratic through the corner), as an SVG path. */
export function roundedPath(pts: readonly Pt[], r: number): string {
  if (pts.length < 2) return '';
  const out = [`M${pts[0][0]} ${pts[0][1]}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const d1 = Math.hypot(cx - px, cy - py);
    const d2 = Math.hypot(nx - cx, ny - cy);
    const k = Math.min(r, d1 / 2, d2 / 2);
    const a = [cx - ((cx - px) / d1) * k, cy - ((cy - py) / d1) * k];
    const b = [cx + ((nx - cx) / d2) * k, cy + ((ny - cy) / d2) * k];
    out.push(`L${a[0]} ${a[1]}`, `Q${cx} ${cy} ${b[0]} ${b[1]}`);
  }
  const [lx, ly] = pts[pts.length - 1];
  out.push(`L${lx} ${ly}`);
  return out.join(' ');
}
