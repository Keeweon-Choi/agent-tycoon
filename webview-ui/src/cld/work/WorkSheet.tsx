/**
 * T-0056: what a temp is doing, read-only. Desktop: a side sheet beside the
 * office; phone: a page over it (safe-area insets kept). A Claude temp shows
 * its task prompt, its text (Markdown), tool calls folded to EZ lines and
 * trimmed results. No input, and two buttons only: 리더에게 가기 and 닫기. The daemon masks every
 * string (server/src/cld/mask.ts) before it gets here.
 */
import { useEffect, useRef } from 'react';

import { Button } from '../../components/ui/Button.js';
import { TITLE_BAR, WINDOW_PAD } from '../../components/ui/windowChrome.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { kindLabel } from '../kinds.js';
import { Line } from '../messenger/Messenger.js';
import { staffFocus } from '../staff.js';
import { ModelBadge } from '../TempList.js';
import { closeWork, useWork } from './workStore.js';

/** Mounted at the composition root: renders nothing while no view is open. */
export function WorkSheet({ mobile }: { mobile: boolean }) {
  const w = useWork();
  const list = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const open = w.open;
  const close = () => closeWork((m) => transport.send(m));
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => {
    const el = list.current;
    // A transcript follows its newest line.
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [w.items]);
  if (!open) return null;
  const waiting = w.items === null && !w.error;
  const body = w.items ? (
    w.items.length === 0 ? (
      <p className="text-sm text-text-muted">{t('work.empty')}</p>
    ) : (
      <div className="space-y-8">
        {w.items.map((item) => (
          <Line key={item.id} item={item} received={false} />
        ))}
      </div>
    )
  ) : null;
  // WINMODEL: a phone page sits at z 50 + its place in the order; the work view (opened from the
  // 현황판 too) must cover every page, and closing it leaves the page it came from as it was.
  return (
    <section
      aria-label={t('work.label', { name: open.name })}
      data-testid="work-sheet"
      data-kind={open.kind}
      className={
        mobile
          ? 'absolute inset-0 z-[70] bg-bg flex flex-col min-h-0 pl-(--cld-safe-left) pr-(--cld-safe-right)'
          : 'pixel-panel relative z-30 w-[min(460px,40vw)] min-w-[320px] h-full flex flex-col min-h-0'
      }
    >
      <header className={`${TITLE_BAR} justify-start min-w-0`}>
        {open.model && <ModelBadge badge={open.model} modelId={open.modelId} />}
        <span className="flex-1 min-w-0">
          <strong className="block text-sm truncate" data-testid="work-name">
            {open.name}
          </strong>
          <span className="block text-2xs text-text-muted truncate">
            {kindLabel(open.kind)}
            {w.title ? ` · ${w.title}` : ''}{t('work.readOnlySuffix')}
          </span>
        </span>
        <Button size="icon_md" aria-label={t('common.close')} onClick={close}>
          ×
        </Button>
      </header>
      <div
        ref={list}
        className={`flex-1 min-h-0 overflow-y-auto ${WINDOW_PAD}`}
        data-testid="work-body"
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {w.error ? (
          <p className="text-sm text-danger" role="alert" data-testid="work-error">
            {w.error}
          </p>
        ) : waiting ? (
          <p className="text-sm text-text-muted">{t('messenger.loading')}</p>
        ) : (
          body
        )}
      </div>
      <footer className="shrink-0 border-t-2 border-border px-12 py-8 flex gap-8 justify-end">
        {open.leadId !== null && (
          <Button
            size="sm"
            className="text-xs"
            data-testid="work-go-lead"
            onClick={() => {
              staffFocus(open.leadId!);
              close();
            }}
          >
            {t('work.goToLead')}
          </Button>
        )}
        <Button size="sm" className="text-xs" data-testid="work-close" onClick={close}>
          {t('common.close')}
        </Button>
      </footer>
    </section>
  );
}
