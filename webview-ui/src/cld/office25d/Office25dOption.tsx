import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { SettingRow } from '../SettingRow.js';
import { setOffice25d, useOffice25d } from './office25d.js';

/** 2.5D PILOT: the switch for the three-quarter office (off by default). */
export function Office25dOption() {
  const on = useOffice25d();
  return (
    <SettingRow testId="office-25d-option" title={t('office25d.title')} help={t('office25d.help')}>
      <Button size="sm" variant={on ? 'active' : 'default'} aria-pressed={on} onClick={() => setOffice25d(!on)}>
        {on ? t('settings.on') : t('settings.off')}
      </Button>
    </SettingRow>
  );
}
