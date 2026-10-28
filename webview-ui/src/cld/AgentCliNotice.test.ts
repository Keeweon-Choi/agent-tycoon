import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let AgentCliNotice: typeof import('./AgentCliNotice.js').AgentCliNotice;
let agentCliInstallSteps: typeof import('./agentCliInstall.js').agentCliInstallSteps;
let GIT_INSTALL_COMMAND: typeof import('./agentCliInstall.js').GIT_INSTALL_COMMAND;
let MACOS_GIT_INSTALL_COMMAND: typeof import('./agentCliInstall.js').MACOS_GIT_INSTALL_COMMAND;
let WINDOWS_CLAUDE_INSTALL_COMMAND: typeof import('./agentCliInstall.js').WINDOWS_CLAUDE_INSTALL_COMMAND;
let cldHandleMessage: typeof import('./officeStore.js').cldHandleMessage;
let cldResetForTests: typeof import('./officeStore.js').cldResetForTests;
let setLanguage: typeof import('../i18n/index.js').setLanguage;
let t: typeof import('../i18n/index.js').t;
let agentCliRestartProgress: typeof import('./agentCliRestartProgress.js').agentCliRestartProgress;
let agentCliRestartStage: typeof import('./agentCliRestartProgress.js').agentCliRestartStage;
let requestAgentCliRecheck: typeof import('./agentCliRestartProgress.js').requestAgentCliRecheck;
const POSIX_CLAUDE_INSTALL_COMMAND =
  'curl -fsSL https://claude.ai/install.sh | bash && { case "$SHELL:$(uname)" in */zsh:*) p="$HOME/.zprofile";; */bash:Darwin) p="$HOME/.bash_profile";; *) p="$HOME/.profile";; esac; grep -q \'\\.local/bin\' "$p" 2>/dev/null || printf \'%s\\n\' \'export PATH="$HOME/.local/bin:$PATH" # Added by Agent Tycoon (Claude Code)\' >> "$p"; export PATH="$HOME/.local/bin:$PATH"; claude auth status >/dev/null 2>&1 || claude auth login; }';

beforeAll(async () => {
  vi.stubGlobal('window', {
    location: { protocol: 'http:', host: 'localhost', search: '?cldMock=1' },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  ({ AgentCliNotice } = await import('./AgentCliNotice.js'));
  ({ agentCliInstallSteps, GIT_INSTALL_COMMAND, MACOS_GIT_INSTALL_COMMAND, WINDOWS_CLAUDE_INSTALL_COMMAND } =
    await import('./agentCliInstall.js'));
  ({ cldHandleMessage, cldResetForTests } = await import('./officeStore.js'));
  ({ setLanguage, t } = await import('../i18n/index.js'));
  ({ agentCliRestartProgress, agentCliRestartStage, requestAgentCliRecheck } =
    await import('./agentCliRestartProgress.js'));
});

beforeEach(() => {
  cldResetForTests();
  setLanguage('en');
});

describe('agent CLI install commands', () => {
  it('accepts winget agreements and uses PowerShell from Windows cmd.exe, after the Git step', () => {
    expect(GIT_INSTALL_COMMAND).toBe(
      'winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements',
    );
    expect(agentCliInstallSteps('irm https://claude.ai/install.ps1 | iex')).toEqual([
      { id: 'git', command: GIT_INSTALL_COMMAND },
      { id: 'claude', command: WINDOWS_CLAUDE_INSTALL_COMMAND },
    ]);
  });

  it('puts Claude Code on the user PATH before its installer runs, then in this cmd window, then signs in', () => {
    // The installer may end its PowerShell with exit: a step after it would never run.
    expect(WINDOWS_CLAUDE_INSTALL_COMMAND.indexOf("SetEnvironmentVariable('Path'")).toBeGreaterThan(-1);
    expect(WINDOWS_CLAUDE_INSTALL_COMMAND.indexOf("SetEnvironmentVariable('Path'")).toBeLessThan(
      WINDOWS_CLAUDE_INSTALL_COMMAND.indexOf('irm https://claude.ai/install.ps1'),
    );
    expect(
      WINDOWS_CLAUDE_INSTALL_COMMAND.endsWith(
        '" && set "PATH=%PATH%;%USERPROFILE%\\.local\\bin" && (claude auth status >nul 2>&1 || claude auth login)',
      ),
    ).toBe(true);
  });

  it('adds the Xcode Git step before Claude Code only on macOS', () => {
    expect(agentCliInstallSteps(POSIX_CLAUDE_INSTALL_COMMAND, 'darwin')).toEqual([
      { id: 'git', command: MACOS_GIT_INSTALL_COMMAND },
      { id: 'claude', command: POSIX_CLAUDE_INSTALL_COMMAND },
    ]);
    expect(agentCliInstallSteps(POSIX_CLAUDE_INSTALL_COMMAND, 'linux')).toEqual([
      { id: 'claude', command: POSIX_CLAUDE_INSTALL_COMMAND },
    ]);
  });
});

describe('AgentCliNotice install controls', () => {
  const markup = (
    readOnly: boolean,
    os: 'linux' | 'darwin' = 'linux',
    command = 'irm https://claude.ai/install.ps1 | iex',
  ) => {
    cldHandleMessage({ type: 'officeAccess', readOnly, terminal: true });
    cldHandleMessage({ type: 'hostInfo', home: '/home/person', os, pathStyle: 'posix', sep: '/', caseInsensitive: false, utcOffsetMin: 0 });
    cldHandleMessage({
      type: 'agentCliState',
      state: 'missing',
      command,
    });
    return renderToStaticMarkup(createElement(AgentCliNotice));
  };

  it('shows one install button for every Windows step to a privileged viewer', () => {
    const html = markup(false);
    expect(html).toContain('data-testid="agent-cli-install-git"');
    expect(html).toContain('data-testid="agent-cli-install-claude"');
    expect(html).toContain('https://git-scm.com/download/win');
  });

  it('shows Xcode Command Line Tools before Claude Code on macOS', () => {
    const html = markup(false, 'darwin', POSIX_CLAUDE_INSTALL_COMMAND);
    expect(html).toContain('Xcode Command Line Tools (Git)');
    expect(html).toContain(MACOS_GIT_INSTALL_COMMAND);
    expect(html.indexOf('agent-cli-command-git')).toBeLessThan(
      html.indexOf('agent-cli-command-claude'),
    );
  });

  it('shows only the Claude Code step on Linux', () => {
    const html = markup(false, 'linux', POSIX_CLAUDE_INSTALL_COMMAND);
    expect(html).not.toContain('agent-cli-install-git');
    expect(html).toContain('agent-cli-install-claude');
    expect(html).not.toContain('agent-cli-command-git');
  });

  it('does not expose installer or recheck controls to a read-only viewer', () => {
    const html = markup(true);
    expect(html).not.toContain('agent-cli-install-');
    expect(html).not.toContain('agent-cli-again');
  });
});

describe('AgentCliNotice restart progress', () => {
  it('shows checking immediately when Find again is pressed, before its next state reply', () => {
    const sent = vi.fn();
    const setChecking = vi.fn();

    requestAgentCliRecheck(sent, setChecking);

    expect(setChecking).toHaveBeenCalledWith(true);
    expect(sent).toHaveBeenCalledOnce();
    expect(t('agentCli.progress.checking')).toBe('Checking Claude Code…');
  });

  it('renders the first restart stage and its pixel progress bar', () => {
    cldHandleMessage({ type: 'officeAccess', readOnly: false, terminal: true });
    cldHandleMessage({ type: 'agentCliState', state: 'restarting', command: 'claude' });

    const html = renderToStaticMarkup(createElement(AgentCliNotice));

    expect(html).toContain('Closing the office program');
    expect(html).toContain('data-testid="agent-cli-restart-progress"');
    expect(html).toContain('0s');
  });

  it('moves from closing to starting after a disconnect, then to engine preparation after health succeeds', () => {
    expect(agentCliRestartStage(false, false)).toBe('closing');
    // Simulated WebSocket close: reconnecting is distinct from the new daemon answering health.
    expect(agentCliRestartStage(true, false)).toBe('starting');
    expect(agentCliRestartStage(true, true)).toBe('engine');
  });

  it('reaches a nearly-full progress bar after the expected minute without claiming completion', async () => {
    const { AGENT_CLI_RESTART_EXPECTED_MS, AGENT_CLI_RESTART_PROGRESS_MAX_PERCENT } =
      await import('../constants.js');

    expect(agentCliRestartProgress(AGENT_CLI_RESTART_EXPECTED_MS)).toBe(
      AGENT_CLI_RESTART_PROGRESS_MAX_PERCENT,
    );
    expect(agentCliRestartProgress(AGENT_CLI_RESTART_EXPECTED_MS * 10)).toBe(
      AGENT_CLI_RESTART_PROGRESS_MAX_PERCENT,
    );
  });
});
