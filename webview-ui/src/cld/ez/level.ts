/** U-15: the level numbers as a bar (the server decides Lv; this only places XP between two floors). */
import type { OfficeLevel } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';

export interface LevelLook {
  /** 0..100: how far from this level's floor to the next. */
  pct: number;
  /** XP still needed for the next level. */
  remaining: number;
}

export function levelLook({ xp, floor, next }: OfficeLevel): LevelLook {
  const span = Math.max(1, next - floor);
  return {
    pct: Math.max(0, Math.min(100, Math.floor(((xp - floor) / span) * 100))),
    remaining: Math.max(0, next - xp),
  };
}

/** "Lv 3 · 환생 1회 · 다음 레벨까지 45": the one line every surface can read. */
export const levelText = (level: OfficeLevel): string =>
  [
    t('character.level', { level: level.level }),
    t('character.rebirths', { count: level.rebirths }),
    t('character.xpToNext', { count: levelLook(level).remaining }),
  ].join(' · ');
