import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { staleBuildBannerMessage, type StaleBusyReason } from './staleBuild.js';

export function StaleBuildBanner({
  busy,
  reloadedFor,
  server,
  onReload,
}: {
  busy: StaleBusyReason | null;
  reloadedFor: string | undefined;
  server: string | undefined;
  onReload: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="stale-build-banner"
      className="fixed left-1/2 -translate-x-1/2 top-[calc(var(--cld-safe-top)+16px)] z-[70] pixel-panel flex items-center gap-8 px-10 py-6 text-sm w-max max-w-[min(480px,calc(100vw-32px))]"
    >
      <span className="min-w-0 break-words">{t(staleBuildBannerMessage(reloadedFor, server, busy))}</span>
      <Button size="sm" variant="active" className="shrink-0" onClick={onReload}>
        {t('build.stale.reload')}
      </Button>
    </div>
  );
}
