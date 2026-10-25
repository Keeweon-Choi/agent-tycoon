/**
 * RANK-LEVELS: a character's rank is its level's band (THEME.ranks, 10 levels each);
 * the model never changes it. No level known, no rank (never guessed). Also the
 * per-browser choice of the rank icon's style (설정 → 화면).
 */
import { t } from '../i18n/index.js';
import { THEME } from './theme.js';

export type RankId = (typeof THEME.ranks)[number]['id'];

/** The rank of a level: the last band whose start it has reached; none without a level. */
export function rankOfLevel(level: number | null | undefined): RankId | null {
  if (level === null || level === undefined || !(level >= THEME.ranks[0].from)) return null;
  return THEME.ranks.filter((r) => level >= r.from).at(-1)?.id ?? null;
}

/** The rank's place in the table (its colour on the ramp); the star ranks. */
export const rankIndex = (id: RankId): number => THEME.ranks.findIndex((r) => r.id === id);
export const rankHasStar = (id: RankId): boolean =>
  THEME.ranks.some((r) => r.id === id && 'star' in r);

export const rankName = (id: RankId): string => t(`rank.${id}`);

export const RANK_STYLES = ['badge', 'tie', 'medal'] as const;
export type RankStyle = (typeof RANK_STYLES)[number];

const RANK_STYLE_KEY = 'cld.rank-style';
let rankStyle: RankStyle = (() => {
  try {
    const saved = localStorage.getItem(RANK_STYLE_KEY);
    return RANK_STYLES.find((s) => s === saved) ?? 'badge';
  } catch {
    return 'badge';
  }
})();

/** The icon style every rank icon is drawn in (a per-browser setting, the ID card by default). */
export const getRankStyle = (): RankStyle => rankStyle;
export function setRankStyle(style: RankStyle): void {
  rankStyle = style;
  try {
    localStorage.setItem(RANK_STYLE_KEY, style);
  } catch {
    // Private browsing or a locked-down webview: keep the in-memory choice.
  }
}
