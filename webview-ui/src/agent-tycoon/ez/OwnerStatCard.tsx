/**
 * OWNER-STATS: the owner's own 스탯 view, in the agents' stats-card look (StatCard): the face, Lv
 * and the XP bar, then today's and the total counts the daemon keeps (`officeSnapshot.owner`).
 */
import type { OwnerCounts } from '../../../../core/src/messages.js';
import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { OWNER_CHARACTER_ID, STAT_DETAIL_FACE_PX, STAT_TILE_RING } from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { elapsedDuration } from '../kinds.js';
import { useAgtyStore } from '../officeStore.js';
import { LevelRing } from './Fatigue.js';
import { levelLook } from './level.js';
import { ringOf } from './nameplate.js';

const TILE = 'border-2 border-border bg-bg-dark shadow-pixel p-8 flex flex-col gap-4 min-w-0';
const LABEL = 'text-2xs text-text-muted';
const ROWS = ['instructions', 'approvals', 'merges', 'tasks', 'steps', 'seconds'] as const;

const countText = (key: keyof OwnerCounts, n: number): string =>
  key !== 'seconds'
    ? String(n)
    : n < 60
      ? t('elapsed.minutesBare', { count: 0 })
      : elapsedDuration(n * 1000);

export function OwnerStatBody({ officeState }: { officeState: OfficeState }) {
  const stats = useAgtyStore().officeSnapshot?.owner;
  const ch = officeState.characters.get(OWNER_CHARACTER_ID);
  const ring = stats ? ringOf(stats.level) : null;
  const look = stats ? levelLook(stats.level) : null;
  return (
    <div className="px-10 pb-10 flex flex-col gap-8" data-testid="owner-stats">
      <div className="flex items-center gap-8">
        <span className="shrink-0 border-2 border-border">
          <CharacterMugShot palette={ch?.palette ?? 0} hueShift={ch?.hueShift ?? 0} size={STAT_DETAIL_FACE_PX} />
        </span>
        <span className="text-lg text-accent-text">{t('owner.me')}</span>
      </div>
      {!stats || !ring || !look ? (
        <p className="text-xs text-text-muted">{t('owner.stats.none')}</p>
      ) : (
        <>
          <div className={TILE} data-testid="owner-stats-level" data-level={stats.level.level} data-xp={stats.level.xp}>
            <span className={LABEL}>{t('stat.level')}</span>
            <span className="flex items-center gap-8 text-xl leading-none">
              <LevelRing ring={ring} sizes={STAT_TILE_RING} />
              {t('character.level', { level: stats.level.level })}
            </span>
            <span className="block h-12 border-2 border-border bg-bg" data-testid="owner-stats-xp">
              <span className="block h-full bg-accent" style={{ width: `${look.pct}%` }} />
            </span>
            <span className={LABEL}>
              {t('character.xp', { xp: stats.level.xp })} · {t('character.xpToNext', { count: look.remaining })}
            </span>
          </div>
          <table className="border-2 border-border bg-bg-dark shadow-pixel text-xs w-full">
            <thead>
              <tr className="text-text-muted">
                <th className="text-left p-4 font-normal">{t('owner.stats.what')}</th>
                <th className="text-right p-4 font-normal">{t('owner.stats.today')}</th>
                <th className="text-right p-4 font-normal">{t('owner.stats.total')}</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((key) => (
                <tr key={key} data-row={key}>
                  <td className="p-4 whitespace-nowrap">{t(`owner.stats.${key}`)}</td>
                  <td className="p-4 text-right" data-testid={`owner-today-${key}`}>
                    {countText(key, stats.today[key])}
                  </td>
                  <td className="p-4 text-right">{countText(key, stats.total[key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={LABEL}>{t('owner.stats.help')}</p>
        </>
      )}
    </div>
  );
}
