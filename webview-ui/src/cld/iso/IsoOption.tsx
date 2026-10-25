import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { SettingRow } from '../SettingRow.js';
import { setIsoView, useIsoView } from './isoView.js';

/** ISO-PILOT: the switch for the isometric building (off by default). */
export function IsoOption() {
  const on = useIsoView();
  return (
    <SettingRow testId="office-iso-option" title={t('iso.title')} help={t('iso.help')}>
      <Button
        size="sm"
        variant={on ? 'active' : 'default'}
        aria-pressed={on}
        onClick={() => setIsoView(!on)}
      >
        {on ? t('settings.on') : t('settings.off')}
      </Button>
    </SettingRow>
  );
}
