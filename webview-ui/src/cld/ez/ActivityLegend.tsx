import { useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { STATUS_ICON_FRAME_SEC } from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import { MODEL_BADGES, type ModelBadge as Badge, modelName } from '../modelBadges.js';
import { useCldStore } from '../officeStore.js';
import { REST_SPRITES } from '../rest.js';
import { ModelBadge } from '../TempList.js';
import { THEME } from '../theme.js';
import { EFFECT_SPRITES, propFrame, ringSprite, statusIconFrame } from './drawVisuals.js';
import { FatigueBar, LevelBar, RestBubble } from './Fatigue.js';
import { fatigueLook, fatigueRules } from './fatigueState.js';
import { PixelSprite } from './PixelSprite.js';
import { ACTIVITY_VISUALS, type RingState,ringWord } from './visuals.js';

/** Ring state, its colour in words, and what else marks it (never colour alone). */
const RINGS: Array<[RingState, string, string]> = [
  ['working', 'activity.color.working', 'activity.mark.working'],
  ['waiting', 'activity.color.waiting', 'activity.mark.waiting'],
  ['permission', 'activity.color.permission', 'activity.mark.permission'],
  ['idle', 'activity.color.idle', 'activity.mark.idle'],
  ['off', 'activity.color.off', 'activity.mark.off'],
  ['neutral', 'activity.color.neutral', 'activity.mark.neutral'],
];

/** T-0036 head icons (the working one is the activity's own emoji). */
const HEAD_ICONS: Array<['zzz' | 'alert' | 'lock', string]> = [
  ['zzz', 'activity.head.zzz'],
  ['alert', 'activity.head.alert'],
  ['lock', 'activity.head.lock'],
];

/** The HUD's 범례 button: what the rings, props and head badges mean. */
/** `zIndex`: above the dialog it opens from (the phone opens it inside 설정). */
export function ActivityLegend({ zIndex }: { zIndex?: number } = {}) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(ACTIVITY_VISUALS);
  // The numbers in force: the user's ez-rules.json over the defaults.
  const f = fatigueRules(useCldStore().ezRules?.fatigue);
  return (
    <>
      <Button
        size="sm"
        className="shrink-0"
        aria-haspopup="dialog"
        title={t('activity.legendTitle')}
        onClick={() => setOpen(true)}
      >
        {t('activity.legend')}
      </Button>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={t('activity.legend')}
        zIndex={zIndex}
      >
        <div className="px-10 pb-8 text-sm" data-testid="activity-legend">
          <h3 className="text-xs text-text-muted mb-4">{t('activity.ringHeading')}</h3>
          <ul className="grid gap-6 mb-12">
            {RINGS.map(([state, color, also]) => (
              <li key={state} className="flex items-center gap-8" data-ring={state}>
                <PixelSprite sprite={ringSprite(state)} scale={3} className="bg-bg-thumb" />
                <span>
                  {ringWord(state)} <span className="text-text-muted">· {t(color as TranslationKey)}</span>
                  <span className="block text-xs text-text-muted">{t(also as TranslationKey)}</span>
                </span>
              </li>
            ))}
          </ul>
          <h3 className="text-xs text-text-muted mb-4">{t('activity.headHeading')}</h3>
          <ul className="grid grid-cols-2 gap-x-12 gap-y-4 mb-12" data-testid="status-icon-legend">
            {HEAD_ICONS.map(([icon, words]) => (
              <li key={icon} className="flex items-center gap-6">
                <PixelSprite
                  sprite={statusIconFrame(icon, 2 * STATUS_ICON_FRAME_SEC)}
                  scale={3}
                  className="bg-bg-thumb"
                />
                <span>{t(words as TranslationKey)}</span>
              </li>
            ))}
            <li className="flex items-center gap-6">
              <span className="text-lg leading-none">📖</span>
              <span>{t('activity.head.working')}</span>
            </li>
          </ul>
          <h3 className="text-xs text-text-muted mb-4">{t('activity.propHeading')}</h3>
          <ul className="grid grid-cols-2 gap-x-12 gap-y-4 mb-12">
            {entries.map(([emoji, { prop, label }]) =>
              prop ? (
                <li key={emoji} className="flex items-center gap-6" data-prop={prop}>
                  <PixelSprite sprite={propFrame(prop, 0)} scale={3} className="bg-bg-thumb" />
                  <span>
                    {emoji} {t(label as TranslationKey)}
                  </span>
                </li>
              ) : null,
            )}
          </ul>
          <h3 className="text-xs text-text-muted mb-4">{t('activity.headOnly')}</h3>
          <p className="text-xs leading-relaxed">
            {entries
              .filter(([, { prop }]) => !prop)
              .map(([emoji, { label }]) => `${emoji} ${t(label as TranslationKey)}`)
              .join(' · ')}
          </p>
          <h3 className="text-xs text-text-muted mt-12 mb-4">
            {t('activity.fatigueHeading')}
          </h3>
          <ul className="grid gap-6 text-xs" data-testid="fatigue-legend">
            {[0, f.tired, f.yawn].map((value) => (
              <li key={value} className="flex items-center gap-8">
                <FatigueBar look={fatigueLook(value, 0, f)} />
                <span className="text-text-muted">{value ? t('activity.fromPercent', { percent: value }) : t('activity.start')}</span>
              </li>
            ))}
            <li className="flex items-center gap-8">
              <PixelSprite
                sprite={EFFECT_SPRITES.sweat.frames[0]}
                scale={2}
                className="bg-bg-thumb"
              />
              <span>{t('activity.sweat', { percent: f.tired })}</span>
            </li>
            <li className="flex items-center gap-8">
              <PixelSprite
                sprite={EFFECT_SPRITES.yawn.frames[2]}
                scale={2}
                className="bg-bg-thumb"
              />
              <span>{t('activity.yawn', { percent: f.yawn })}</span>
            </li>
            <li className="flex items-center gap-8">
              <RestBubble />
              <span>{t('activity.rest', { percent: f.rest })}</span>
            </li>
            <li className="flex items-center gap-8" data-testid="compaction-legend">
              <span className="font-bold text-yellow-300 whitespace-nowrap">{t('activity.compactionExample')}</span>
              <span>
                {t('activity.compactionInfo')}
              </span>
            </li>
            <li className="flex items-center gap-8" data-testid="rest-legend">
              <PixelSprite sprite={REST_SPRITES[THEME.rest.prop].frames[1]} scale={3} className="bg-bg-thumb" />
              <span>{t(THEME.rest.legend)}</span>
            </li>
          </ul>
          <h3 className="text-xs text-text-muted mt-12 mb-4">{t('activity.levelHeading')}</h3>
          <div className="grid gap-6 text-xs" data-testid="level-legend">
            <LevelBar level={{ level: 3, xp: 345, floor: 300, next: 600, rebirths: 1 }} />
            <p className="leading-relaxed">{t('activity.levelInfo')}</p>
            <p className="leading-relaxed">{t('activity.rebirthInfo')}</p>
          </div>
          <h3 className="text-xs text-text-muted mt-12 mb-4">{t('activity.modelHeading')}</h3>
          <ul className="grid grid-cols-2 gap-x-12 gap-y-4 text-xs" data-testid="model-legend">
            {(Object.keys(MODEL_BADGES) as Badge[]).map((b) => (
              <li key={b} className="flex items-center gap-6">
                <ModelBadge badge={b} />
                <span>{modelName(b)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted mt-4">{t('activity.modelUnknown')}</p>
          <h3 className="text-xs text-text-muted mt-12 mb-4">{t('activity.hoursHeading')}</h3>
          <p className="text-xs leading-relaxed">
            {t('activity.hoursInfo')}
          </p>
        </div>
      </Modal>
    </>
  );
}
