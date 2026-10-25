[CmdletBinding()]
param(
    [string]$Target,
    [int]$SshPort = 2233,
    [int]$LocalPort = 18240,
    [int]$RemotePort = 18240,
    [string]$RemoteLogin = '~/projects/cld-gui/cld/bin/cld-gui-login',
    [switch]$CreateShortcut
)

$ErrorActionPreference = 'Stop'
# Runs from a hidden-window shortcut, so errors must be shown in a dialog.
function Fail([string]$Message) {
    [void](New-Object -ComObject WScript.Shell).Popup($Message, 0, 'Pixel Office', 16)
    exit 1
}
function Test-Daemon([int]$Port) {
    try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/api/health").StatusCode -eq 200 } catch { return $false }
}
$configPath = Join-Path $env:USERPROFILE '.cld-gui.json'
$config = $null
if (Test-Path -LiteralPath $configPath) {
    try { $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json } catch { $config = $null }
}
if (-not $Target) {
    if ($config -and $config.Target) { $Target = [string]$config.Target }
    else { Fail 'SSH 대상이 없습니다. -Target을 지정해 주세요.' }
}

function Test-LocalPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        return $async.AsyncWaitHandle.WaitOne(300) -and $client.Connected
    } catch { return $false } finally { $client.Close() }
}

$tunnelPid = $null
if ($config -and $config.LocalPort -eq $LocalPort -and $config.Target -eq $Target) { $tunnelPid = $config.TunnelPid }
if (-not (Test-LocalPort $LocalPort)) {
    $sshArgs = @('-N', '-L', "${LocalPort}:127.0.0.1:${RemotePort}", '-p', "$SshPort", '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'BatchMode=yes', $Target)
    try {
        $tunnel = Start-Process -FilePath 'ssh.exe' -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
        $tunnelPid = $tunnel.Id
    } catch { Fail 'SSH 터널을 시작할 수 없습니다.' }
}

$delays = @(1, 2, 5, 5, 10, 10, 10, 30, 30)
$ready = Test-Daemon $LocalPort
foreach ($delay in $delays) {
    if ($ready) { break }
    Start-Sleep -Seconds $delay
    $ready = Test-Daemon $LocalPort
}
if (-not $ready) { Fail '호스트에 닿지 않음' }

try {
    $code = ((& ssh.exe -p $SshPort -o BatchMode=yes $Target $RemoteLogin) | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $code) { throw 'login code request failed' }
} catch { Fail '로그인 코드를 가져올 수 없습니다.' }

$config = [pscustomobject]@{ Target = $Target; LocalPort = $LocalPort; TunnelPid = $tunnelPid }
$config | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $configPath
$url = "http://localhost:$LocalPort/login?code=$code"
# msedge.exe is registered under App Paths, not on PATH, so Get-Command misses it.
$edge = (Get-ItemProperty -ErrorAction SilentlyContinue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe').'(default)'
if ($edge -and (Test-Path -LiteralPath $edge)) { Start-Process -FilePath $edge -ArgumentList @('--app=' + $url) }
else { Start-Process $url }

if ($CreateShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop 'Pixel Office.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $shortcut.Arguments = '-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
    $shortcut.WorkingDirectory = Split-Path -Parent $PSCommandPath
    $icon = Join-Path (Split-Path -Parent $PSCommandPath) 'cld-gui.ico'
    if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = $icon }
    $shortcut.Save()
}
