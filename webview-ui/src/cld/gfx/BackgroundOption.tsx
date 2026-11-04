import {
  BACKGROUND_MIXES,
  BACKGROUND_TIMES,
} from '../../../../core/src/cld/background.js';
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { Choice, SettingRow } from '../SettingRow.js';
import { setBackground, useBackgroundSettings } from './bg/settings.js';

/** BACKGROUND: the isometric view's sky, what stands around the building, and a new arrangement. */
export function BackgroundOptions() {
  const s = useBackgroundSettings();
  return (
    <>
      <SettingRow testId="background-time-option" title={t('bg.time.title')} help={t('bg.time.help')}>
        <Choice
          label={t('bg.time.title')}
          options={BACKGROUND_TIMES}
          value={s.time}
          onPick={(time) => setBackground({ time })}
          text={(time) => t(`bg.time.${time}`)}
          attr="data-time"
        />
      </SettingRow>
      <SettingRow
        testId="background-mix-option"
        title={t('bg.mix.title')}
        help={
          <>
            {t('bg.mix.help')} {t('bg.reroll.help')}
          </>
        }
      >
        <Choice
          label={t('bg.mix.title')}
          options={BACKGROUND_MIXES}
          value={s.mix}
          onPick={(mix) => setBackground({ mix })}
          text={(mix) => t(`bg.mix.${mix}`)}
          attr="data-mix"
        />
        <Button size="sm" data-testid="background-reroll" title={t('bg.reroll.help')} onClick={() => setBackground({ reroll: true })}>
          {t('bg.reroll')}
        </Button>
      </SettingRow>
    </>
  );
}
