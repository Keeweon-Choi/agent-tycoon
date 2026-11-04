/**
 * building-a-1104 (owner 11-04 20:27): the billboard outside the building carries the old lobby
 * board's pages, turning every ISO_BILLBOARD_PAGE_MS: a summary (나를 기다림, 진행 중 작업), the
 * projects with their states, H/W, GPU. What each shows is the old board's own data and words
 * (projectRows, ringWord, hwViewModel, hwBars, hwDonuts, gpuBoard): nothing is computed anew.
 *
 * Cost: `billboardContent` is plain data; the webview paints it (`paintFace`) into one canvas
 * only when that data, the page or the face's size changes, and the renderer blits that canvas
 * onto the face every frame (no text drawn per frame).
 */
import {
  ACTIVITY_RING_COLORS,
  BOARD_COLORS,
  ISO_BILLBOARD_FACE,
  ISO_BILLBOARD_INK,
  ISO_BILLBOARD_ROWS,
  PIXEL_FONT_FAMILY,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { ringWord } from '../ez/visuals.js';
import { hwBars, hwDonuts } from '../hwDetail.js';
import type { HwViewKind } from '../hwView.js';
import { hwViewModel } from '../hwView.js';
import type { CldSnapshot } from '../officeStore.js';
import type { WaitReason } from '../waiting.js';
import { moreText, pctText, projectRows, runningWork, vramText } from './board.js';

export const BILLBOARD_PAGES = ['summary', 'projects', 'hw', 'gpu'] as const;
export type BillboardPage = (typeof BILLBOARD_PAGES)[number];

export interface FaceLine {
  text: string;
  value?: string;
  /** A state dot's colour (a project's ring). */
  dot?: string;
  hot?: boolean;
}
export interface FaceContent {
  page: BillboardPage;
  title: string;
  /** The summary's two big numbers. */
  big?: Array<{ label: string; value: string; hot: boolean }>;
  lines?: FaceLine[];
}

/** The page after `page`. */
export const nextPage = (page: BillboardPage): BillboardPage =>
  BILLBOARD_PAGES[(BILLBOARD_PAGES.indexOf(page) + 1) % BILLBOARD_PAGES.length];

/** What page `page` shows now. */
export function billboardContent(
  page: BillboardPage,
  d: {
    snap: CldSnapshot;
    agentTools: Record<number, ToolActivity[]>;
    waiting: number;
    workers: ReadonlySet<string>;
    reasons: Readonly<Record<number, WaitReason>>;
    view: HwViewKind;
    now: number;
  },
): FaceContent {
  if (page === 'summary')
    return {
      page,
      title: t('board.label'),
      big: [
        { label: t('board.billboard.waiting'), value: String(d.waiting), hot: d.waiting > 0 },
        { label: t('board.billboard.working'), value: String(runningWork(d.snap)), hot: false },
      ],
    };
  if (page === 'projects') {
    const { shown, more } = projectRows(
      d.snap,
      d.agentTools,
      d.now,
      ISO_BILLBOARD_ROWS,
      d.workers,
      d.reasons,
    );
    const lines: FaceLine[] = shown.map((r) => ({
      text: r.name,
      value: ringWord(r.ring),
      dot: ACTIVITY_RING_COLORS[r.ring].rim,
      hot: r.ring === 'permission' || r.ring === 'waiting',
    }));
    if (more > 0) lines.push({ text: moreText(more) });
    if (!lines.length) lines.push({ text: t('board.noProjects') });
    return { page, title: t('board.page.projects'), lines };
  }
  const hw = d.snap.hwSample;
  if (page === 'hw') {
    if (!hw) return { page, title: 'H/W', lines: [{ text: t('board.waitingHardware') }] };
    const m = hwViewModel(hw, d.view);
    const lines: FaceLine[] = [];
    if (hw.cpuUtil != null) lines.push({ text: 'CPU', value: pctText(hw.cpuUtil) });
    for (const b of hwBars(hw, m)
      .filter((x) => !x.blank)
      .slice(0, 1))
      lines.push({ text: b.label, value: b.text, hot: b.tone === 'critical' });
    for (const n of hwDonuts(m).slice(0, ISO_BILLBOARD_ROWS - lines.length))
      lines.push({
        text: n.label,
        value: n.frac == null ? n.sub : `${pctText(n.frac)} ${n.sub}`,
        hot: n.tone === 'critical',
      });
    return { page, title: 'H/W', lines };
  }
  // GPU: its use, who holds it, the line (the old GPU page's words).
  const board = d.snap.gpuBoard;
  const lines: FaceLine[] = [
    { text: 'GPU', value: hw?.gpuUtil == null ? '-' : pctText(hw.gpuUtil) },
  ];
  const holder = board?.holders[0];
  if (holder)
    lines.push({
      text: `${t('board.using')} ${holder.project}`,
      value: vramText(holder.vramGib),
      hot: true,
    });
  else lines.push({ text: t('board.gpuIdle') });
  lines.push({ text: t('board.queueCount', { count: board?.queue.length ?? 0 }) });
  return { page, title: 'GPU', lines };
}

/**
 * Paint `c` (the face, `w` x `h` device px; `k` device px per iso px of the face): the title,
 * the page's numbers or lines, then a dot per page with the shown one lit. In ISO_BILLBOARD_FACE
 * iso px, so the type is 13 / 18 / 40 CSS px at the lobby's zoom 2.
 */
export function paintFace(
  c: CanvasRenderingContext2D,
  w: number,
  h: number,
  k: number,
  f: FaceContent,
): void {
  const F = ISO_BILLBOARD_FACE;
  const px = (iso: number) => Math.max(1, Math.round(iso * k));
  c.clearRect(0, 0, w, h);
  c.fillStyle = ISO_BILLBOARD_INK.face;
  c.fillRect(0, 0, w, h);
  c.textBaseline = 'middle';
  const font = (iso: number) => `${px(iso)}px ${PIXEL_FONT_FAMILY}`;
  const pad = px(F.pad);
  if (f.big) {
    const cell = w / f.big.length;
    f.big.forEach((b, i) => {
      const cx = cell * i + cell / 2;
      c.textAlign = 'center';
      c.font = font(F.label);
      c.fillStyle = b.hot ? BOARD_COLORS.text : BOARD_COLORS.muted;
      c.fillText(b.label, cx, px(F.bigLabelY));
      c.font = font(F.number);
      c.fillStyle = b.hot ? ISO_BILLBOARD_INK.hot : BOARD_COLORS.text;
      c.fillText(b.value, cx, px(F.bigNumberY));
    });
  } else {
    c.textAlign = 'left';
    c.font = font(F.line);
    c.fillStyle = ISO_BILLBOARD_INK.title;
    c.fillText(f.title, pad, px(F.titleY));
    (f.lines ?? []).forEach((l, i) => {
      const y = px(F.firstLineY + i * F.lineStep);
      let x = pad;
      if (l.dot) {
        const r = px(F.dot);
        c.fillStyle = l.dot;
        c.fillRect(x, y - Math.round(r / 2), r, r);
        x += r + px(F.dotGap);
      }
      c.textAlign = 'left';
      c.fillStyle = l.hot ? BOARD_COLORS.text : l.value ? BOARD_COLORS.text : BOARD_COLORS.muted;
      c.fillText(l.text, x, y, w - x - pad - (l.value ? px(F.valueW) : 0));
      if (l.value) {
        c.textAlign = 'right';
        c.fillStyle = l.hot ? ISO_BILLBOARD_INK.hot : BOARD_COLORS.muted;
        c.fillText(l.value, w - pad, y, px(F.valueW));
      }
    });
  }
  // The page dots, the shown one lit.
  const n = BILLBOARD_PAGES.length;
  const s = px(F.pageDot);
  const gap = px(F.pageDotGap);
  const x0 = Math.round(w / 2 - (n * s + (n - 1) * gap) / 2);
  const y = h - px(F.pageDotFromBottom) - s;
  for (let i = 0; i < n; i++) {
    c.fillStyle =
      BILLBOARD_PAGES[i] === f.page ? ISO_BILLBOARD_INK.frame : ISO_BILLBOARD_INK.dotOff;
    c.fillRect(x0 + i * (s + gap), y, s, s);
  }
}
