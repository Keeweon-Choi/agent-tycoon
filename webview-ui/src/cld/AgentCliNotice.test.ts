import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let AgentCliNotice: typeof import('./AgentCliNotice.js').AgentCliNotice;
let agentCliInstallSteps: typeof import('./agentCliInstall.js').agentCliInstallSteps;
let GIT_INSTALL_COMMAND: typeof import('./agentCliInstall.js').GIT_INSTALL_COMMAND;
let WINDOWS_CLAUDE_INSTALL_COMMAND: typeof import('./agentCliInstall.js').WINDOWS_CLAUDE_INSTALL_COMMAND;
let cldHandleMessage: typeof import('./officeStore.js').cldHandleMessage;
let cldResetForTests: typeof import('./officeStore.js').cldResetForTests;
let setLanguage: typeof import('../i18n/index.js').setLanguage;

beforeAll(async () => {
  vi.stubGlobal('window', {
    location: { protocol: 'http:', host: 'localhost', search: '?cldMock=1' },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  ({ AgentCliNotice } = await import('./AgentCliNotice.js'));
  ({ agentCliInstallSteps, GIT_INSTALL_COMMAND, WINDOWS_CLAUDE_INSTALL_COMMAND } =
    await import('./agentCliInstall.js'));
  ({ cldHandleMessage, cldResetForTests } = await import('./officeStore.js'));
  ({ setLanguage } = await import('../i18n/index.js'));
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

  it('keeps the POSIX installer command as the only step', () => {
    expect(agentCliInstallSteps('curl -fsSL https://claude.ai/install.sh | bash')).toEqual([
      { id: 'claude', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
    ]);
  });
});

describe('AgentCliNotice install controls', () => {
  const markup = (readOnly: boolean) => {
    cldHandleMessage({ type: 'officeAccess', readOnly, terminal: true });
    cldHandleMessage({ type: 'hostInfo', home: '/home/person', os: 'linux', pathStyle: 'posix', sep: '/', caseInsensitive: false, utcOffsetMin: 0 });
    cldHandleMessage({
      type: 'agentCliState',
      state: 'missing',
      command: 'irm https://claude.ai/install.ps1 | iex',
    });
    return renderToStaticMarkup(createElement(AgentCliNotice));
  };

  it('shows one install button for every Windows step to a privileged viewer', () => {
    const html = markup(false);
    expect(html).toContain('data-testid="agent-cli-install-git"');
    expect(html).toContain('data-testid="agent-cli-install-claude"');
    expect(html).toContain('https://git-scm.com/download/win');
  });

  it('does not expose installer or recheck controls to a read-only viewer', () => {
    const html = markup(true);
    expect(html).not.toContain('agent-cli-install-');
    expect(html).not.toContain('agent-cli-again');
  });
});
