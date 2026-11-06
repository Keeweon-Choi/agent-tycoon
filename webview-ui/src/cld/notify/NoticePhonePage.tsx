/**
 * FIX-PHONE-NOTICES-COMPACT (T-68, owner 11-06 22:33): the phone's 알림 page. One head row carries the title, where
 * things stand (the bell and "모두 확인했어요" or the unread count), 설정 and 사무실; the filters sit behind one button
 * in NoticeCenter, so the list takes the height the chips and the search used to.
 */
import { useState } from 'react';

import { t } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { MobilePage } from '../OfficeNavigation.js';
import { NoticePanel, NoticeStatus, NoticeViewToggle, type OpenTarget } from './NoticeLayer.js';
import { unreadCount, useNotices } from './notices.js';

export function NoticePhonePage({
  getOfficeState,
  onOpen,
  onClose,
}: {
  getOfficeState: () => OfficeState;
  onOpen: OpenTarget;
  onClose: () => void;
}) {
  const [view, setView] = useState<'list' | 'settings'>('list');
  const unread = unreadCount(useNotices().items);
  return (
    <MobilePage
      id="notices"
      title={t('notice.title')}
      label={t('notice.mobilePage')}
      onClose={onClose}
      tabs={
        <div className="nc-phone-head">
          <strong className="text-lg text-devroom-title shrink-0">{t('notice.title')}</strong>
          <span className="material-symbols-sharp nc-glyph" aria-hidden="true">
            notifications
          </span>
          <div className="nc-head-text">
            <NoticeStatus view={view} unread={unread} />
          </div>
          <NoticeViewToggle
            view={view}
            onToggle={() => setView(view === 'list' ? 'settings' : 'list')}
          />
        </div>
      }
    >
      <NoticePanel
        getOfficeState={getOfficeState}
        onOpen={onOpen}
        onClose={onClose}
        phone={{ view }}
      />
    </MobilePage>
  );
}
