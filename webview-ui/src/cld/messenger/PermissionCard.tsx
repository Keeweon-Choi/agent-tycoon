/**
 * PERM-PROMPT: a lead's session waits on a Claude Code permission dialog. The card says so, names
 * the asking sub-agent and the open call (tool, its description or its command's first line), and
 * offers 허용 / 거부 (privileged; the daemon presses a key only when the dialog on screen is about
 * that call) and 터미널에서 보기. A view-only client sees the card without the buttons.
 * PERM-CARD-FIT: the command sits in a box with its own scroll (a share of the visible height on
 * a phone, keyboard included) and folds behind a toggle (long ones start folded on a phone); the
 * buttons stay sticky at the card's foot so they never scroll away.
 */
import { useState } from 'react';

import type { PermissionWait } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { employeeName } from '../employees.js';
import { messengerAnswerPermission, useMessenger } from './messengerStore.js';
import { permissionDetailMaxHeight, permissionStartsFolded } from './permissionFit.js';

export function PermissionCard({
  agentId,
  card,
  canAnswer,
  openTerminal,
  visualViewportHeight,
}: {
  agentId: number;
  card: PermissionWait;
  canAnswer: boolean;
  openTerminal: (() => void) | null;
  visualViewportHeight?: number | null;
}) {
  const phone = useIsMobile();
  // The owner's toggle belongs to one call; a new call starts from the default again.
  const [toggled, setToggled] = useState<{ toolId: string; folded: boolean } | null>(null);
  const folded =
    toggled?.toolId === card.toolId
      ? toggled.folded
      : permissionStartsFolded(card.detail, phone);
  const answer = useMessenger().permissionAnswers[agentId];
  const mine = answer?.toolId === card.toolId ? answer : undefined;
  const busy = !!mine && !mine.result && !mine.error;
  const answerable = canAnswer && !!card.toolId;
  const press = (allow: boolean) =>
    messengerAnswerPermission((m) => transport.send(m), agentId, card.toolId, allow);
  return (
    <div
      className="mb-6 border-2 border-accent bg-bg-dark px-8 py-6 text-xs flex flex-col gap-4"
      role="status"
      data-testid="permission-card"
    >
      <span className="text-accent-text">{t('permPrompt.title')}</span>
      {card.asker && (
        <span>{t('permPrompt.asker', { name: employeeName({ nameId: card.asker }) })}</span>
      )}
      {card.tool ? (
        <span className="flex flex-col gap-2 min-w-0" data-testid="permission-call">
          <span className="[overflow-wrap:anywhere]">{card.tool}</span>
          {card.detail && !folded && (
            <span
              className="whitespace-pre-wrap [overflow-wrap:anywhere] max-h-256 overflow-y-auto text-text-muted"
              style={{
                maxHeight: permissionDetailMaxHeight(
                  phone,
                  visualViewportHeight ?? undefined,
                  window.innerHeight,
                ),
              }}
              data-testid="permission-detail"
              tabIndex={0}
            >
              {card.detail}
            </span>
          )}
        </span>
      ) : (
        <span className="text-text-muted">{t('permPrompt.unknownCall')}</span>
      )}
      {mine && (busy || mine.error || mine.result !== 'answered') && (
        <span
          className={mine.error ? 'text-danger' : 'text-text-muted'}
          data-testid="permission-result"
        >
          {busy ? t('permPrompt.sending') : (mine.error ?? t(`permPrompt.result.${mine.result!}`))}
        </span>
      )}
      <span
        className="flex flex-wrap gap-8 sticky bottom-0 bg-bg-dark"
        data-testid="permission-actions"
      >
        {answerable && (
          <>
            <Button size="sm" variant="accent" disabled={busy} onClick={() => press(true)}>
              {t('permPrompt.allow')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => press(false)}>
              {t('permPrompt.deny')}
            </Button>
          </>
        )}
        {card.detail && (
          <Button
            size="sm"
            aria-expanded={!folded}
            data-testid="permission-fold"
            onClick={() => setToggled({ toolId: card.toolId, folded: !folded })}
          >
            {folded ? t('permPrompt.expand') : t('permPrompt.collapse')}
          </Button>
        )}
        {openTerminal && (
          <Button size="sm" onClick={openTerminal}>
            {t('permPrompt.terminal')}
          </Button>
        )}
      </span>
    </div>
  );
}
