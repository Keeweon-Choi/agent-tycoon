/**
 * T-0041: a temp's look by model. Only what the stores already name (a
 * spawn's `model` input, office codex's `model` field) is shown, as a letter;
 * nothing is chosen or assigned by it (policyScan allows this file only).
 */
import { t } from '../i18n/index.js';
import { rankName, rankOfLevel } from './rank.js';

export type ModelBadge = 'opus' | 'sonnet' | 'haiku' | 'sol' | 'terra' | 'luna';
/** The badge's letter and its name (범례, tooltips). Colours: MODEL_BADGE_COLORS. */
export const MODEL_BADGES: Readonly<
  Record<ModelBadge, { letter: string; name: string }>
> = {
  opus: { letter: 'O', name: 'Opus' },
  sonnet: { letter: 'S', name: 'Sonnet' },
  haiku: { letter: 'H', name: 'Haiku' },
  sol: { letter: 'S', name: 'Codex Sol' },
  terra: { letter: 'T', name: 'Codex Terra' },
  luna: { letter: 'L', name: 'Codex Luna' },
};

/**
 * "Opus-5.5" from a real model id ("claude-opus-5-5", "claude-sonnet-4-5-20250929",
 * "claude-3-5-haiku-20241022"); null for an alias ("opus") or any other shape.
 */
export function modelVersion(model: string | null | undefined): string | null {
  const parts = (model ?? '').toLowerCase().replace(/\[.*$/, '').split('-');
  if (parts.shift() !== 'claude') return null;
  const words = parts.filter((p) => /^[a-z]+$/.test(p));
  const nums = parts.filter((p) => /^\d{1,2}$/.test(p)); // the 8-digit date is not a version
  if (words.length !== 1 || !nums.length) return null;
  const [word] = words;
  return `${word[0].toUpperCase()}${word.slice(1)}-${nums.join('.')}`;
}

/** The model as known: "Opus-5.5" from its real id, else the badge's name; null without a badge. */
export const modelName = (badge: ModelBadge | null | undefined, modelId?: string | null): string | null =>
  badge ? (modelVersion(modelId) ?? MODEL_BADGES[badge].name) : null;

/**
 * The readable tag below a character's feet and in its stat card: "<rank> · <model>".
 * The rank is the level's (rank.ts); the model is information only and never changes it.
 * With neither known it reads as a teammate.
 */
export function rankModelLabel(
  level: number | null | undefined,
  badge: ModelBadge | null | undefined,
  modelId?: string | null,
): string {
  const rank = rankOfLevel(level);
  const parts = [rank && rankName(rank), modelName(badge, modelId)].filter(Boolean);
  return parts.length ? parts.join(' · ') : t('kind.teammate');
}

/** Registry values only: omit an absent model/effort rather than inventing one. */
export function modelEffortLabel(
  model: string | null | undefined,
  effort: string | null | undefined,
): string | null {
  const parts = [model?.trim(), effort?.trim()].filter((part): part is string => !!part);
  return parts.length ? parts.join(' · ') : null;
}

/** The badge for a model id ("claude-opus-4-5", "sonnet", "terra"); unknown models get none. */
export function modelBadge(model: string | null | undefined): ModelBadge | null {
  const words = (model ?? '').toLowerCase().split(/[^a-z]+/);
  return (Object.keys(MODEL_BADGES) as ModelBadge[]).find((b) => words.includes(b)) ?? null;
}
