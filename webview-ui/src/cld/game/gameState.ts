/**
 * GAME-UI-1 G3 (specs/ui-mock-1103/ideas/agents 05-07): what the party roster, the job run and the
 * game HUD show, pure. Only numbers the app already has; nothing made up.
 */
import { matchKorean } from '../../../../core/src/cld/serverText.js';
import type { OfficeJob, UsageLimitWindow } from '../../../../core/src/messages.js';
import type { TabStatus } from '../../components/AgentCard.js';
import {
  GAME_CONTEXT_WARN_PCT,
  GAME_DAY_FROM_H,
  GAME_HEAT_BASE_C,
  GAME_HEAT_SEGMENTS,
  GAME_HEAT_STEP_C,
  GAME_NIGHT_FROM_H,
  GAME_USAGE_WARN_LEFT,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { tempTone } from '../format.js';
import type { WaitReason } from '../waiting.js';
import type { SegTone } from './parts.js';

/** The four status effects (05): working, waits for me (a question), waits for a permission, resting. */
export type PartyState = 'work' | 'ask' | 'lock' | 'rest';
export const PARTY_STATES: readonly PartyState[] = ['work', 'ask', 'lock', 'rest'];

/** The one waiting rule (waiting.ts) first, then the card's activity; anything else rests. */
export function partyState(reason: WaitReason | undefined, status: TabStatus | null): PartyState {
  if (reason === 'question') return 'ask';
  if (reason === 'permission') return 'lock';
  return status === 'working' ? 'work' : 'rest';
}

/** 컨텍스트 남음: the fatigue is the context fill, so what is left is the rest; null while unknown (Codex). */
export const contextLeft = (fill: number | null | undefined): number | null =>
  fill == null || !Number.isFinite(fill) ? null : Math.max(0, Math.min(100, Math.round(100 - fill)));

export const contextTone = (left: number | null): SegTone | undefined =>
  left !== null && left <= GAME_CONTEXT_WARN_PCT ? 'warn' : undefined;

// ── 06 job run ────────────────────────────────────────────────

/**
 * How far a running job's bar fills, only from a tqdm bar in its log or from the elapsed time against
 * the median of the last five successful runs (the server's `progress_last`). A first run, the log's
 * step count or anything else fills nothing: the runner jogs in place.
 */
export function runFill(job: OfficeJob): { pct: number; source: 'tqdm' | 'median' } | null {
  const p = job.ended || job.gpu === 'queued' ? null : job.progress;
  if (!p || p.indeterminate || !Number.isFinite(p.pct)) return null;
  const code = p.label ? matchKorean(p.label)?.code : undefined;
  if (code === 'progress_last') return { pct: clampPct(p.pct), source: 'median' };
  if (code) return null; // progress_steps, progress_first_run: not a tqdm bar
  return { pct: clampPct(p.pct), source: 'tqdm' };
}
const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/** Cells lit for a percent: never more than reached (floor). */
export const litCells = (pct: number, cells: number): number => Math.floor((clampPct(pct) / 100) * cells);

/** A failed job's bar: the cells reached when it stopped (the server's `stopPct`) and the cell it fell
 *  on, marked red. No basis (null) lights and marks nothing: the stop line under it says where. */
export function stopCells(job: OfficeJob, cells: number): { lit: number; mark: number | undefined } {
  if (job.stopPct == null || !Number.isFinite(job.stopPct)) return { lit: 0, mark: undefined };
  const lit = litCells(job.stopPct, cells);
  return { lit, mark: Math.min(lit, cells - 1) };
}

// ── 07 HUD ────────────────────────────────────────────────────

/** What is left of a usage window, whole percent; null when unknown. */
export const usageLeft = (pct: number | null | undefined): number | null =>
  pct == null || !Number.isFinite(pct) ? null : Math.max(0, Math.min(100, Math.round(100 - pct)));

/** A window's left; a passed reset (`isReset`: the last reading is out of date) is unknown, never a made-up full bar. */
export const windowLeft = (w: Pick<UsageLimitWindow, 'pct' | 'isReset'> | undefined): number | null =>
  w?.isReset ? null : usageLeft(w?.pct);

/**
 * The windows a provider's gauge shows, the main one first: the 5-hour window, or the week when the plan
 * has no 5-hour window (Claude Ultra: the week only). The main one has the cells and is the one a narrow
 * bar and the phone keep; the week follows a 5-hour main (not on the phone).
 */
export function gaugeWindows<W extends { id: string }>(windows: readonly W[], phone: boolean): { main: W | undefined; rest: W[] } {
  const five = windows.find((w) => w.id === '5h');
  const week = windows.find((w) => w.id === '7d');
  return { main: five ?? week, rest: five && week && !phone ? [week] : [] };
}

/** 0 left is dimmed with empty cells (the eye goes to the reset), a little left is amber. */
export const gaugeTone = (left: number | null): 'zero' | 'warn' | undefined =>
  left === null ? undefined : left === 0 ? 'zero' : left <= GAME_USAGE_WARN_LEFT ? 'warn' : undefined;

/** Time to a reset, short: "1:48" for a 5-hour window, "3일" / "19시간" / "40분" for a week. */
export function shortReset(resetAt: string | null | undefined, now: number, weekly: boolean): string | null {
  const then = resetAt ? Date.parse(resetAt) : NaN;
  if (!Number.isFinite(then)) return null;
  const minutes = Math.max(0, Math.ceil((then - now) / 60_000));
  if (!weekly) return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  if (minutes >= 1440) return t('game.hud.days', { count: Math.floor(minutes / 1440) });
  if (minutes >= 60) return t('game.hud.hours', { count: Math.floor(minutes / 60) });
  return t('game.hud.minutes', { count: minutes });
}

/** The heat gauge: lit cells (at least one) and the tone of format.tempTone (85 warm, 95 critical). */
export function heatLook(c: number): { lit: number; tone: SegTone | undefined; word: 'hot' | 'danger' | null } {
  const tone = tempTone(c);
  return {
    lit: Math.max(1, Math.min(GAME_HEAT_SEGMENTS, Math.round((c - GAME_HEAT_BASE_C) / GAME_HEAT_STEP_C))),
    tone: tone === 'critical' ? 'bad' : tone ? 'warn' : undefined,
    word: tone === 'critical' ? 'danger' : tone ? 'hot' : null,
  };
}

/** The sun from 06:00, the moon from 18:00 (host time). */
export const isDaytime = (hour: number): boolean => hour >= GAME_DAY_FROM_H && hour < GAME_NIGHT_FROM_H;
