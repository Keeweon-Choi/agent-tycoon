/** Installer lines typed into a trusted shell from the plain-office notice. */
export const GIT_INSTALL_COMMAND = 'winget install --id Git.Git -e --source winget';
export const WINDOWS_CLAUDE_INSTALL_COMMAND =
  'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"';

export interface AgentCliInstallStep {
  id: 'git' | 'claude';
  command: string;
}

/** Windows shells open through cmd.exe, so run the PowerShell installer explicitly. */
export function agentCliInstallSteps(command: string): AgentCliInstallStep[] {
  if (command.startsWith('irm '))
    return [
      { id: 'git', command: GIT_INSTALL_COMMAND },
      { id: 'claude', command: WINDOWS_CLAUDE_INSTALL_COMMAND },
    ];
  return [{ id: 'claude', command }];
}
