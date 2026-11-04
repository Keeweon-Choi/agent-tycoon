import { t } from '../../i18n/index.js';
import { OnOff, SettingRow } from '../SettingRow.js';
import { setIsoView, useIsoView } from './isoView.js';

/** ISO-PILOT: the switch for the isometric building (off by default). */
export function IsoOption() {
  const on = useIsoView();
  return (
    <SettingRow testId="office-iso-option" title={t('iso.title')} help={t('iso.help')}>
      <OnOff label={t('iso.title')} on={on} onChange={setIsoView} />
    </SettingRow>
  );
}
