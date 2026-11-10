/**
 * FEAT-HUD-CONTROL-CENTER (owner 11-06 17:12, 안 C / C2): the bottom-left control center's pure parts. The usage
 * view is provider-neutral: one row shape per agent the usage store knows, each window it reports (a model's week
 * too) with what is left and its reset, so a new agent is one more row. Which part shows is one small reducer over
 * the folded tile's separate targets.
 */
import type { UsageProvider } from '../../../../core/src/messages.js';
import { USAGE_REPORT_FRESH_MS, USAGE_URGENT_LEFT_PCT } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { timeAgo, usageWindowName, usageWindows, usageWindowTitle } from '../format.js';
import { windowLeft } from '../game/gameState.js';

export interface UsageWindowView {
  id: string;
  /** 5시간, 주간, "Fable 주간", or the provider's own window id. */
  label: string;
  /** Whole percent left; null when unknown (no figure, or the last reading's reset passed). */
  leftPct: number | null;
  resetAt: string | null;
  /** The hover line: used, left and the reset. */
  title: string;
}

export interface AgentUsage {
  id: string;
  agent: string;
  /** Empty: the agent reports no limit (한도 정보 없음). */
  windows: UsageWindowView[];
  /** When the agent reported these figures (ISO), when its source carries a time. */
  reportedAt: string | null;
}

export const usageView = (providers: readonly UsageProvider[]): AgentUsage[] =>
  providers.map((p) => ({
    id: p.id,
    agent: p.name,
    windows: usageWindows(p).map((w) => ({
      id: w.id,
      label: usageWindowName(w),
      leftPct: windowLeft(w),
      resetAt: w.resetAt,
      title: usageWindowTitle(w),
    })),
    reportedAt: p.at ?? null,
  }));

/** "12분 전 기준" once a report is older than USAGE_REPORT_FRESH_MS; null while fresh or without a time. */
export function usageAsOf(reportedAt: string | null, now: number): string | null {
  const at = reportedAt ? Date.parse(reportedAt) : Number.NaN;
  return Number.isFinite(at) && now - at >= USAGE_REPORT_FRESH_MS ? t('usage.asOf', { ago: timeAgo(reportedAt, now) }) : null;
}

/** The one window that stands for an agent when the agents are put in order (the folded rows' order): its 5-hour
 *  window when its plan has one (owner 11-06 22:15), unless another window is nearly used up (USAGE_URGENT_LEFT_PCT);
 *  else the one closest to its limit. None without a figure. */
export function tightest(agent: AgentUsage): UsageWindowView | undefined {
  let best: UsageWindowView | undefined;
  for (const w of agent.windows) if (w.leftPct !== null && (best?.leftPct == null || w.leftPct < best.leftPct)) best = w;
  const fiveHour = agent.windows.find((w) => w.id === '5h' && w.leftPct !== null);
  return fiveHour && best && best.leftPct! > USAGE_URGENT_LEFT_PCT ? fiveHour : best;
}

/** The windows an agent's folded row shows (owner 11-06 22:23): a plan with a 5-hour window shows it and the week
 *  side by side, left and right; any other agent shows its tightest window (a week-only plan: the week). */
export function foldedWindows(agent: AgentUsage): UsageWindowView[] {
  const five = agent.windows.find((w) => w.id === '5h' && w.leftPct !== null);
  const week = agent.windows.find((w) => w.id === '7d' && w.leftPct !== null);
  const one = tightest(agent);
  return five && week ? [five, week] : one ? [one] : [];
}

/** The folded summary's usage: the agents closest to their limits, the tightest first (by `window`, which only
 *  orders them), each with the windows its row shows. */
export function closest(
  view: readonly AgentUsage[],
  count: number,
): Array<{ agent: AgentUsage; window: UsageWindowView; windows: UsageWindowView[] }> {
  return view
    .flatMap((agent) => {
      const window = tightest(agent);
      return window ? [{ agent, window, windows: foldedWindows(agent) }] : [];
    })
    .sort((a, b) => a.window.leftPct! - b.window.leftPct!)
    .slice(0, count);
}

/** The phone strip's ways to fit one line at 390 px, tried in this order until the row fits (ControlCenter.tsx measures):
 *  every plan's two windows with names; two windows with logos only; the tightest agent's two windows and one for the
 *  others (owner 11-06 22:23); one window each, as before. */
export const PHONE_FOLD_LEVELS = 4;
export function phoneFolded<T extends { windows: UsageWindowView[]; window: UsageWindowView }>(entries: readonly T[], level: number): { entries: T[]; names: boolean } {
  const lean = level >= 2;
  return {
    names: level !== 1,
    entries: entries.map((e, i) => (level >= 3 || (lean && i > 0) ? { ...e, windows: [e.window] } : e)),
  };
}

/** What the control center shows over the folded tile: everything, the usage alone, the notification panel, or nothing. */
export type CcPart = 'all' | 'usage' | 'notices' | 'menu' | null;
/** The control center's own state; the notification panel is the HUD's 알림 (hudStore), which other parts open too.
 *  'menu' is the ≡ list of the card stack and the status line (the control center has its tiles in 'all'). */
export type CcLocal = 'all' | 'usage' | 'menu' | null;

/** The notification panel wins while it is open (the dock's handle opens it from anywhere). */
export const ccPart = (local: CcLocal, noticesOpen: boolean): CcPart => (noticesOpen ? 'notices' : local);

/** A target pressed while `shown` shows: the part to show next (its own part again folds it). */
export const ccPress = (shown: CcPart, target: Exclude<CcPart, null>): CcPart => (shown === target ? null : target);
