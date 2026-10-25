/**
 * A logged-in device the daemon has no Web Push subscription for (a new
 * address is a new origin; a signed-out device loses its row): permission
 * already granted resubscribes silently, otherwise this banner's button is
 * the user gesture the browser wants. Dismissible; see pushBannerKind. It sits
 * below every panel and modal (z 50 and up) and leaves after PUSH_BANNER_SHOW_MS,
 * so it never keeps a control covered (the passkey prompt, a menu, a list).
 */
import { useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { useNotices } from './notices.js';
import {
  currentPermission,
  dismissPushBanner,
  PUSH_BANNER_SHOW_MS,
  pushBannerDismissedAt,
  pushBannerKind,
  pushOptedOut,
  pushSupport,
  subscribePush,
} from './push.js';

export function PushBanner() {
  const { push, settings } = useNotices();
  const [dismissed, setDismissed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const tried = useRef(false);
  const [now] = useState(Date.now); // a dismissal's week is measured from page load
  let kind = dismissed
    ? 'none'
    : pushBannerKind({
        push,
        support: pushSupport(),
        permission: currentPermission(),
        dismissedAt: pushBannerDismissedAt(),
        optedOut: pushOptedOut(),
        now,
      });
  const enable = () =>
    subscribePush(push!.publicKey!, settings, (m) => transport.send(m)).catch(() =>
      setFailed(true),
    );
  useEffect(() => {
    if (kind !== 'resubscribe' || tried.current) return;
    tried.current = true; // once per page load: a failure shows the banner instead
    void enable();
  });
  if (kind === 'resubscribe') kind = failed ? 'ask' : 'none';
  const shown = kind !== 'none';
  useEffect(() => {
    if (!shown || busy) return;
    const timer = setTimeout(() => setDismissed(true), PUSH_BANNER_SHOW_MS);
    return () => clearTimeout(timer);
  }, [shown, busy, failed]);
  if (kind === 'none') return null;
  return (
    <div
      role="status"
      data-testid="push-banner"
      data-kind={kind}
      className="fixed left-1/2 -translate-x-1/2 bottom-[calc(var(--cld-toast-bottom)+64px)] z-[45] pixel-panel flex items-center gap-8 px-10 py-6 text-sm w-max max-w-[min(480px,calc(100vw-32px))]"
    >
      <span className="min-w-0 break-words">
        {t(kind === 'ios-install' ? 'notice.pushBannerIos' : 'notice.pushBannerOff')}
      </span>
      {kind === 'ask' && (
        <Button
          size="sm"
          variant="active"
          className="shrink-0"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setFailed(false);
            void enable().finally(() => setBusy(false));
          }}
        >
          {t('notice.pushBannerEnable')}
        </Button>
      )}
      <Button
        size="sm"
        className="shrink-0"
        aria-label={t('common.close')}
        onClick={() => {
          dismissPushBanner();
          setDismissed(true);
        }}
      >
        ×
      </Button>
    </div>
  );
}
