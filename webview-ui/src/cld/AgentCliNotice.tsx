/**
 * AGENT-CLI: the plain office (the daemon found no Claude Code) says what to install and how, with a
 * 다시 찾기 button for a viewer that may change things. Hidden for this visit with the close button.
 * It is shown inline (no toast layer): a plain office is not in cld mode.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { transport } from '../transport/index.js';
import { agentCliInstallSteps } from './agentCliInstall.js';
import { useCldStore } from './officeStore.js';
import { requestShellWithInput } from './terminal/workspaceStore.js';

export function AgentCliNotice() {
  const { agentCli, hostInfo, officeReadOnly } = useCldStore();
  const [hidden, setHidden] = useState(false);
  if (!agentCli || hidden) return null;
  const restarting = agentCli.state === 'restarting';
  const steps = agentCliInstallSteps(agentCli.command);
  const windows = steps.length === 2;
  // On the body, like Modal: the terminal it opens is a body-level modal (z 50-51), and inside
  // the app's stacking context this z-60 notice drew under it, its recheck button out of reach.
  const panel = (
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
          {/* ponytail: Git is always shown on Windows (not probed); users who find it noisy can ask for a probe. */}
          {steps.map((step) => (
            <div key={step.id} className="flex flex-col gap-4">
              <span>
                {t(
                  step.id === 'claude' && !windows
                    ? 'agentCli.installOnly.claude'
                    : `agentCli.install.${step.id}`,
                )}
              </span>
              {step.id === 'git' && (
                <span data-testid="agent-cli-git">
                  {t('agentCli.git')}{' '}
                  <a className="underline" href="https://git-scm.com/download/win">
                    {t('agentCli.gitLink')}
                  </a>
                </span>
              )}
              <code
                data-testid={`agent-cli-command-${step.id}`}
                className="block bg-btn-bg border-2 border-border py-4 px-8 select-all break-all"
              >
                {step.command}
              </code>
              {!officeReadOnly && (
                <Button
                  size="sm"
                  variant="active"
                  className="self-start"
                  data-testid={`agent-cli-install-${step.id}`}
                  disabled={!hostInfo}
                  onClick={() => {
                    if (hostInfo) requestShellWithInput(hostInfo.home, `${step.command}\r`);
                  }}
                >
                  {t(`agentCli.installButton.${step.id}`)}
                </Button>
              )}
            </div>
          ))}
          <span>{t('agentCli.afterInstall')}</span>
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
  // (no document when the tests render it to markup)
  return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}
