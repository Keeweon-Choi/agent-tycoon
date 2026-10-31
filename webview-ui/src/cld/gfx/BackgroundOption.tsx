import {
  BACKGROUND_MIXES,
  BACKGROUND_TIMES,
} from '../../../../core/src/cld/background.js';
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { SettingRow } from '../SettingRow.js';
import { setBackground, useBackgroundSettings } from './bg/settings.js';

/** BACKGROUND: the isometric view's sky, what stands around the building, and a new arrangement. */
export function BackgroundOptions() {
  const s = useBackgroundSettings();
  return (
    <>
      <SettingRow testId="background-time-option" title={t('bg.time.title')} help={t('bg.time.help')} stacked>
        <div className="flex flex-wrap gap-4" role="group" aria-label={t('bg.time.title')}>
          {BACKGROUND_TIMES.map((time) => (
            <Button
              key={time}
              size="sm"
              variant={s.time === time ? 'active' : 'default'}
              aria-pressed={s.time === time}
              data-time={time}
              onClick={() => setBackground({ time })}
            >
              {t(`bg.time.${time}`)}
            </Button>
          ))}
        </div>
      </SettingRow>
      <SettingRow testId="background-mix-option" title={t('bg.mix.title')} help={t('bg.mix.help')} stacked>
        <div className="flex flex-wrap gap-4" role="group" aria-label={t('bg.mix.title')}>
          {BACKGROUND_MIXES.map((mix) => (
            <Button
              key={mix}
              size="sm"
              variant={s.mix === mix ? 'active' : 'default'}
              aria-pressed={s.mix === mix}
              data-mix={mix}
              onClick={() => setBackground({ mix })}
            >
              {t(`bg.mix.${mix}`)}
            </Button>
          ))}
          <Button size="sm" data-testid="background-reroll" title={t('bg.reroll.help')} onClick={() => setBackground({ reroll: true })}>
            {t('bg.reroll')}
          </Button>
        </div>
      </SettingRow>
    </>
  );
}
