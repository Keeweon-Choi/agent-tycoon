/**
 * HUD-2B (owner 11-04 "특히 메뉴가 좋아", specs/ui-mock-1104/hud2/hud-2b.png): the desktop top bar's
 * one `≡ 메뉴`, 기기 추가 · 보안 · 범례 · 설정 under it. A disclosure, not an ARIA menu: Tab moves
 * through the rows, Esc closes it (focus back on 메뉴), so does a press outside it or picking a row.
 * The rows are the buttons the bar had (their own dialogs, portalled), kept mounted while closed.
 */
import { useEffect, useId, useRef, useState } from 'react';

import { t } from '../../i18n/index.js';
import { AddDeviceButton } from '../auth/AddDevice.js';
import { SecurityButton } from '../auth/SecurityPanel.js';
import { ActivityLegend } from '../ez/ActivityLegend.js';
import { openSettings } from '../settingsOpen.js';
import { PixelIcon } from './parts.js';

export function HudMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div ref={root} className="game-menu-root">
      <button
        ref={toggle}
        type="button"
        className="game-gx game-menu-btn"
        aria-expanded={open}
        aria-controls={id}
        data-testid="hud-menu"
        onClick={() => setOpen(!open)}
      >
        <PixelIcon name="menu" />
        {t('hud2b.menu')}
      </button>
      {/* A row's own click opens its dialog; this closes the menu on the way (capture runs first). */}
      <div id={id} className="game-menu" hidden={!open} data-testid="hud-menu-list" onClickCapture={() => setOpen(false)}>
        <AddDeviceButton
          label={
            <>
              <PixelIcon name="device" />
              {t('auth.addDevice')}
            </>
          }
        />
        <SecurityButton>
          <PixelIcon name="shield" />
          {t('auth.security')}
        </SecurityButton>
        <ActivityLegend>
          <PixelIcon name="list" />
          {t('activity.legend')}
        </ActivityLegend>
        <button type="button" onClick={() => openSettings()}>
          <PixelIcon name="gear" />
          {t('settings.title')}
        </button>
      </div>
    </div>
  );
}
