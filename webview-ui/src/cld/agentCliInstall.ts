/** Installer lines typed into a trusted shell from the plain-office notice. */
export const GIT_INSTALL_COMMAND =
  'winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements';
/**
 * Claude Code's installer only prints the PATH step: this puts %USERPROFILE%\.local\bin on the user PATH first
 * (once; a new terminal, VS Code included, sees it), then installs, then `set` gives this cmd window (ComSpec,
 * the office's Windows shell) the folder too, so `claude` works where it was installed.
 * ponytail: [Environment] stores the user Path as REG_SZ (its %VARS% written out, as Scoop does); keep REG_EXPAND_SZ if that ever bites.
 */
export const WINDOWS_CLAUDE_INSTALL_COMMAND =
  "powershell -NoProfile -Command \"$d=Join-Path $env:USERPROFILE '.local\\bin'; $p=[Environment]::GetEnvironmentVariable('Path','User'); " +
  "if(-not ($p -split ';' | Where-Object { $_.TrimEnd('\\') -ieq $d })){[Environment]::SetEnvironmentVariable('Path',$(if($p){$p.TrimEnd(';')+';'+$d}else{$d}),'User')}; " +
  'irm https://claude.ai/install.ps1 | iex" & set "PATH=%PATH%;%USERPROFILE%\\.local\\bin"';

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
