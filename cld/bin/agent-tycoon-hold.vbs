' Agent Tycoon logon holder (R1/P6, start policy "always"), written by the manager next to the Windows
' logon task and removed with it. It runs wsl.exe with the task's arguments in a hidden window (0: no
' console) and waits (True), so the WSL distro stays up while `agty start --hold` keeps the daemon.
Dim args, i, cmd
Set args = WScript.Arguments
cmd = "wsl.exe"
For i = 0 To args.Count - 1
  cmd = cmd & " """ & args(i) & """"
Next
WScript.Quit CreateObject("WScript.Shell").Run(cmd, 0, True)
