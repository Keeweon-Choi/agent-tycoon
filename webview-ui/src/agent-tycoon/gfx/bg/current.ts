import type { BackgroundSettings } from '../../../../../core/src/agent-tycoon/background.js';
import { agtyGetSnapshot } from '../../officeStore.js';
import { skyIsNight } from './draw.js';
import { backgroundSettings } from './settings.js';

/** What the isometric renderer draws under the building right now: the setting and whether it
 *  is night by the host's clock (the browser's own zone until the daemon has said). */
export function isoBackground(): { settings: BackgroundSettings; night: boolean } {
  const settings = backgroundSettings();
  const offset = agtyGetSnapshot().hostInfo?.utcOffsetMin ?? -new Date().getTimezoneOffset();
  return { settings, night: skyIsNight(settings, Date.now(), offset) };
}
