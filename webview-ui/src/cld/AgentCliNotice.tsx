/**
 * AGENT-CLI: the plain office (the daemon found no Claude Code) says what to install and how, with a
 * 다시 찾기 button for a viewer that may change things. It can fold out of the terminal's way.
 * It is shown inline (no toast layer): a plain office is not in cld mode.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '../components/ui/Button.js';
import {
  AGENT_CLI_RESTART_CLOCK_MS,
  AGENT_CLI_RESTART_HEALTH_MAX_ATTEMPTS,
  AGENT_CLI_RESTART_HEALTH_POLL_MS,
  AGENT_CLI_RESTART_PROGRESS_ARIA_MAX,
  AGENT_CLI_RESTART_PROGRESS_ARIA_MIN,
  AGENT_CLI_RESTART_PROGRESS_BORDER_COLOR,
  AGENT_CLI_RESTART_PROGRESS_BORDER_PX,
  AGENT_CLI_RESTART_PROGRESS_FILL_COLOR,
  AGENT_CLI_RESTART_PROGRESS_HEIGHT_PX,
  AGENT_CLI_RESTART_PROGRESS_RADIUS_PX,
  AGENT_CLI_RESTART_SLOW_MS,
} from '../constants.js';
import { t } from '../i18n/index.js';
import { transport } from '../transport/index.js';
import type { TransportState } from '../transport/types.js';
import { agentCliInstallSteps } from './agentCliInstall.js';
import {
  agentCliRestartProgress,
  agentCliRestartStage,
  requestAgentCliRecheck,
} from './agentCliRestartProgress.js';
import { useCldStore } from './officeStore.js';
import { OPEN_TERMINAL_EVENT, requestShellWithInput } from './terminal/workspaceStore.js';

export function AgentCliNotice() {
  const { agentCli, hostInfo, officeReadOnly } = useCldStore();
  const [folded, setFolded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connectionDropped, setConnectionDropped] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [restartStartedAt, setRestartStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const previousAgentCli = useRef(agentCli);
  const restarting = agentCli?.state === 'restarting';

  useEffect(() => {
    setFolded(false);
  }, [agentCli?.again, agentCli?.state]);

  // A reply always creates a new agentCliState snapshot; do not keep the button busy after it.
  useEffect(() => {
    if (previousAgentCli.current !== agentCli) setChecking(false);
    previousAgentCli.current = agentCli;
  }, [agentCli]);

  useEffect(() => {
    if (!restarting) return;
    setConnectionDropped(transport.state !== 'connected');
    setEngineReady(false);
    return transport.onStateChange((state: TransportState) => {
      if (state !== 'connected') setConnectionDropped(true);
    });
  }, [restarting]);

  useEffect(() => {
    if (!restarting || !connectionDropped) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const checkHealth = async () => {
      attempts += 1;
      controller = new AbortController();
      try {
        const response = await fetch('/api/health', { signal: controller.signal });
        if (!cancelled && response.ok) {
          setEngineReady(true);
          return;
        }
      } catch {
        // The daemon is expected to refuse this while it is stopped.
      }
      if (!cancelled && attempts < AGENT_CLI_RESTART_HEALTH_MAX_ATTEMPTS) {
        timer = setTimeout(checkHealth, AGENT_CLI_RESTART_HEALTH_POLL_MS);
      }
    };
    void checkHealth();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [connectionDropped, restarting]);

  useEffect(() => {
    if (!restarting) {
      setRestartStartedAt(null);
      return;
    }
    const startedAt = Date.now();
    setRestartStartedAt(startedAt);
    setNow(startedAt);
    const timer = setInterval(() => setNow(Date.now()), AGENT_CLI_RESTART_CLOCK_MS);
    return () => clearInterval(timer);
  }, [restarting]);

  if (!agentCli) return null;
  const steps = agentCliInstallSteps(agentCli.command, hostInfo?.os);
  const windows = steps.length === 2;
  const macOS = hostInfo?.os === 'darwin';
  const recheck = () =>
    requestAgentCliRecheck(() => transport.send({ type: 'agentCliRecheck' }), setChecking);
  const elapsedMs = restartStartedAt === null ? 0 : Math.max(0, now - restartStartedAt);
  const stage = agentCliRestartStage(connectionDropped, engineReady);
  const progress = agentCliRestartProgress(elapsedMs);
  const bar = (
    <div
      role="status"
      data-testid="agent-cli-bar"
      className="fixed left-1/2 -translate-x-1/2 top-[calc(var(--cld-safe-top)+16px)] z-[60] pixel-panel flex items-center gap-4 px-6 py-4 text-sm max-w-[calc(100vw-32px)]"
    >
      <strong className="min-w-0 flex-1 break-words">{t('agentCli.barTitle')}</strong>
      {/* Owner 10-27: the terminal stays reachable while Claude Code is missing (the plain office has no dock). */}
      {!officeReadOnly && (
        <Button
          size="sm"
          className="shrink-0"
          data-testid="agent-cli-terminal"
          onClick={() => window.dispatchEvent(new Event(OPEN_TERMINAL_EVENT))}
        >
          {t('hud.terminal')}
        </Button>
      )}
      {!officeReadOnly && (
        <Button
          size="sm"
          variant="active"
          className="shrink-0"
          data-testid="agent-cli-again"
          aria-busy={checking}
          disabled={checking}
          onClick={recheck}
        >
          {checking ? t('agentCli.progress.checkingButton') : t('agentCli.again')}
        </Button>
      )}
      <Button
        size="sm"
        className="shrink-0"
        data-testid="agent-cli-expand"
        aria-label={t('agentCli.expand')}
        title={t('agentCli.expand')}
        onClick={() => setFolded(false)}
      >
        {t('agentCli.expand')}
      </Button>
      {checking && <span data-testid="agent-cli-checking">{t('agentCli.progress.checking')}</span>}
    </div>
  );
  if (folded) return typeof document === 'undefined' ? bar : createPortal(bar, document.body);
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
          aria-label={t('agentCli.fold')}
          title={t('agentCli.fold')}
          onClick={() => setFolded(true)}
        >
          ×
        </Button>
      </div>
      {restarting ? (
        <>
          <span>{t('agentCli.restarting')}</span>
          <div className="flex items-center justify-between gap-4" data-testid="agent-cli-restart-stage">
            <strong>{t(`agentCli.progress.stage.${stage}`)}</strong>
            <span data-testid="agent-cli-restart-elapsed">
              {t('agentCli.progress.elapsed', { seconds: Math.floor(elapsedMs / 1_000) })}
            </span>
          </div>
          <div
            aria-label={t('agentCli.progress.elapsed', { seconds: Math.floor(elapsedMs / 1_000) })}
            aria-valuemax={AGENT_CLI_RESTART_PROGRESS_ARIA_MAX}
            aria-valuemin={AGENT_CLI_RESTART_PROGRESS_ARIA_MIN}
            aria-valuenow={progress}
            className="w-full overflow-hidden"
            data-testid="agent-cli-restart-progress"
            role="progressbar"
            style={{
              border: `${AGENT_CLI_RESTART_PROGRESS_BORDER_PX}px solid ${AGENT_CLI_RESTART_PROGRESS_BORDER_COLOR}`,
              borderRadius: AGENT_CLI_RESTART_PROGRESS_RADIUS_PX,
              height: AGENT_CLI_RESTART_PROGRESS_HEIGHT_PX,
            }}
          >
            <div
              style={{
                backgroundColor: AGENT_CLI_RESTART_PROGRESS_FILL_COLOR,
                height: '100%',
                imageRendering: 'pixelated',
                width: `${progress}%`,
              }}
            />
          </div>
          {elapsedMs >= AGENT_CLI_RESTART_SLOW_MS && (
            <span data-testid="agent-cli-restart-slow">{t('agentCli.progress.slow')}</span>
          )}
        </>
      ) : (
        <>
          {checking && <span data-testid="agent-cli-checking">{t('agentCli.progress.checking')}</span>}
          {agentCli.state === 'failed' && <span>{t('agentCli.failed')}</span>}
          {/* ponytail: Git is always shown on Windows and macOS (not probed); users who find it noisy can ask for a probe. */}
          {steps.map((step) => (
            <div key={step.id} className="flex flex-col gap-4">
              <span>
                {t(
                  step.id === 'git'
                    ? macOS
                      ? 'agentCli.install.macGit'
                      : 'agentCli.install.git'
                    : macOS
                      ? 'agentCli.install.macClaude'
                      : !windows
                        ? 'agentCli.installOnly.claude'
                        : 'agentCli.install.claude',
                )}
              </span>
              {step.id === 'git' && (
                <span data-testid="agent-cli-git">
                  {macOS ? (
                    t('agentCli.macGit')
                  ) : (
                    <>
                      {t('agentCli.git')}{' '}
                      <a className="underline" href="https://git-scm.com/download/win">
                        {t('agentCli.gitLink')}
                      </a>
                    </>
                  )}
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
                    if (hostInfo) {
                      requestShellWithInput(hostInfo.home, `${step.command}\r`);
                      setFolded(true);
                    }
                  }}
                >
                  {t(step.id === 'git' && macOS ? 'agentCli.installButton.macGit' : `agentCli.installButton.${step.id}`)}
                </Button>
              )}
            </div>
          ))}
          <span>{t(windows ? 'agentCli.afterInstallWindows' : 'agentCli.afterInstall')}</span>
          {agentCli.again && <strong data-testid="agent-cli-still">{t('agentCli.stillMissing')}</strong>}
          {!officeReadOnly && (
            <Button
              size="sm"
              variant="active"
              className="self-start"
              data-testid="agent-cli-again"
              aria-busy={checking}
              disabled={checking}
              onClick={recheck}
            >
              {checking ? t('agentCli.progress.checkingButton') : t('agentCli.again')}
            </Button>
          )}
        </>
      )}
    </div>
  );
  // (no document when the tests render it to markup)
  return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}
