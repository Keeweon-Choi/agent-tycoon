/**
 * AGENT-CLI: the plain office (the daemon found no Claude Code) says what to install and how, with a
 * 다시 찾기 button for a viewer that may change things. Hidden for this visit with the close button.
 * It is shown inline (no toast layer): a plain office is not in cld mode.
 */
import { useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { transport } from '../transport/index.js';
import { useCldStore } from './officeStore.js';

export function AgentCliNotice() {
  const { agentCli, officeReadOnly } = useCldStore();
  const [hidden, setHidden] = useState(false);
  if (!agentCli || hidden) return null;
  const windows = agentCli.command.startsWith('irm ');
  const restarting = agentCli.state === 'restarting';
  return (
    <div
      role="status"
      data-testid="agent-cli-notice"
      data-state={agentCli.state}
      className="fixed left-1/2 -translate-x-1/2 top-[calc(var(--cld-safe-top)+16px)] z-[60] pixel-panel flex flex-col gap-6 px-10 py-8 text-sm w-max max-w-[min(520px,calc(100vw-32px))]"
    >
      <div className="flex items-start gap-8">
        <strong className="min-w-0 flex-1 break-words">{t('agentCli.title')}</strong>
        <Button
          size="sm"
          className="shrink-0"
          aria-label={t('agentCli.close')}
          title={t('agentCli.close')}
          onClick={() => setHidden(true)}
        >
          ×
        </Button>
      </div>
      {restarting ? (
        <span>{t('agentCli.restarting')}</span>
      ) : (
        <>
          {agentCli.state === 'failed' && <span>{t('agentCli.failed')}</span>}
          {/* ponytail: always shown on Windows (not probed for git); a probe when users complain it is noise */}
          {windows && <span data-testid="agent-cli-git">{t('agentCli.git')}</span>}
          <span>{t('agentCli.step1', { os: t(windows ? 'agentCli.os.win32' : 'agentCli.os.posix') })}</span>
          <code
            data-testid="agent-cli-command"
            className="block bg-btn-bg border-2 border-border py-4 px-8 select-all break-all"
          >
            {agentCli.command}
          </code>
          <span>{t('agentCli.step2')}</span>
          <span>{t('agentCli.step3')}</span>
          {agentCli.again && <strong data-testid="agent-cli-still">{t('agentCli.stillMissing')}</strong>}
          {!officeReadOnly && (
            <Button
              size="sm"
              variant="active"
              className="self-start"
              data-testid="agent-cli-again"
              onClick={() => transport.send({ type: 'agentCliRecheck' })}
            >
              {t('agentCli.again')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
