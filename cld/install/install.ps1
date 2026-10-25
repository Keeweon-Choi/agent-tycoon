# Agent Tycoon one-line installer for Windows (design H 2.2 and 5.4; roadmap P4). Windows PowerShell 5.1 and PowerShell 7. No Node needed.
# Plain ASCII on purpose: Windows PowerShell 5.1 reads a script file without a BOM in the ANSI code page.
#
#   irm <release>/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install.ps1 [--yes] [--gui yes|no] [--launch yes|no] [--port N] [--add-path] [--remote]
#   powershell -ExecutionPolicy Bypass -File install.ps1 --from <release folder> --pub <agent-tycoon-release.pub>
#   ... --allow-second-host --port 18250   (TEST ONLY: a Windows native host beside a live WSL one on another port; P7)
#
# Same trust model as install.sh: this repository copy is a template that cld/release/stamp-installers.mjs
# fills in for a release. The script fetches the win-x64 daemon bundle into a fresh temp dir (HTTPS only,
# every redirect hop checked), checks its SHA-256 against the table stamped below before unpacking anything,
# unpacks the bundle's own Node and manager and hands over to the manager's wizard, which checks the Ed25519
# signature of SHA256SUMS with the stamped key, pins it, and asks every question (including WSL or Windows
# native). For WSL it also fetches the release's install.sh, checked against its stamped SHA-256, which the
# wizard runs inside the chosen distro. Unstamped, it downloads nothing (--from <folder> --pub <key> only),
# and OpenSSL 3 (openssl.exe on PATH) checks the folder's SHA256SUMS.sig with --pub before anything is unpacked.
# --base-url overrides the release URL (tests); plain http only to 127.0.0.1/localhost with --insecure-localhost.
#
# Everything runs in one script block: after `irm | iex` nothing of it (preferences, functions, LANG) stays
# in the caller's session.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  function Stop-Install([string]$Message) {
    throw "agty install: $Message"
  }

  function Test-ReleaseUrl([string]$Url, [bool]$Insecure) {
    $u = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$u)) { Stop-Install "not a URL: $Url" }
    if ($u.Scheme -eq 'https') { return }
    if ($u.Scheme -eq 'http' -and $Insecure -and -not $u.UserInfo -and ($u.Host -eq '127.0.0.1' -or $u.Host -eq 'localhost')) { return }
    Stop-Install "refusing ${Url}: downloads are HTTPS only (plain http only to 127.0.0.1/localhost with --insecure-localhost)"
  }

  # Redirects are followed here, not by .NET: each hop must pass Test-ReleaseUrl (Windows PowerShell 5.1
  # Invoke-WebRequest would follow an https -> http redirect).
  function Get-ReleaseFile([string]$Url, [string]$File, [bool]$Insecure) {
    for ($hop = 0; $hop -le 5; $hop++) {
      Test-ReleaseUrl $Url $Insecure
      $req = [Net.HttpWebRequest]::Create($Url)
      $req.AllowAutoRedirect = $false
      $req.UserAgent = 'agent-tycoon-install'
      try { $res = $req.GetResponse() } catch [Net.WebException] {
        $res = $_.Exception.Response
        if (-not $res) { Stop-Install "download failed: $Url ($($_.Exception.Message))" }
      }
      try {
        $code = [int]$res.StatusCode
        if ($code -ge 300 -and $code -lt 400) {
          $location = $res.Headers['Location']
          if (-not $location) { Stop-Install "download failed: $Url (HTTP $code without Location)" }
          $Url = (New-Object Uri -ArgumentList ([Uri]$Url), $location).AbsoluteUri
          continue
        }
        if ($code -ne 200) { Stop-Install "download failed: $Url (HTTP $code)" }
        $out = [IO.File]::Create($File)
        try { $res.GetResponseStream().CopyTo($out) } finally { $out.Dispose() }
        return
      } finally { $res.Dispose() }
    }
    Stop-Install "download failed: too many redirects ($Url)"
  }

  function Get-Sha256([string]$File) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant()
  }

  # The Ed25519 signature sign.mjs writes (raw 64 bytes over SHA256SUMS, SPKI PEM key), checked by OpenSSL 3.
  function Test-SumsSignature([string]$Sums, [string]$Sig, [string]$Pub) {
    $openssl = Get-Command openssl.exe -ErrorAction SilentlyContinue
    if (-not $openssl) { Stop-Install 'openssl.exe (OpenSSL 3) is needed on PATH to check SHA256SUMS.sig with --pub; nothing was unpacked' }
    if (-not ((& $openssl.Source pkeyutl -help 2>&1 | Out-String) -match '-rawin')) { Stop-Install 'this openssl cannot check Ed25519 signatures (OpenSSL 3 is needed); nothing was unpacked' }
    foreach ($f in @($Pub, $Sig)) { if (-not (Test-Path -LiteralPath $f)) { Stop-Install "$f is missing" } }
    & $openssl.Source pkeyutl -verify -pubin -inkey $Pub -rawin -in $Sums -sigfile $Sig 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Install "refused ${Sums}: SHA256SUMS.sig is not a valid signature by --pub $Pub; nothing was unpacked" }
  }

  function Install-AgentTycoon {
    $stamped = '@@STAMPED@@' -eq '1'
    $version = '@@VERSION@@'
    $baseUrl = '@@BASE_URL@@'
    $bundles = @'
@@BUNDLES@@
'@
    $pubKey = @'
@@PUBKEY@@
'@
    $installShSha256 = '@@INSTALL_SH_SHA256@@'

    $from = $null; $pub = $null; $insecure = $false; $second = $false
    $pass = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $args.Count; $i++) {
      $a = [string]$args[$i]
      if ($a -eq '--from' -or $a -eq '--pub' -or $a -eq '--base-url') {
        if ($i + 1 -ge $args.Count) { Stop-Install "$a needs a value" }
        $i++
        $v = [string]$args[$i]
        if ($a -eq '--from') { $from = $v } elseif ($a -eq '--pub') { $pub = $v } else { $baseUrl = $v }
      } elseif ($a -eq '--insecure-localhost') { $insecure = $true }
      elseif ($a -eq '--allow-second-host') { $second = $true }
      elseif ($a -eq '--bundle' -or $a -eq '--sums' -or $a -eq '--sig' -or $a -eq '--wsl-installer') { Stop-Install "$a is set by install.ps1 itself, not on the command line" }
      else { $pass.Add($a) }
    }

    if ($stamped) {
      $table = $bundles
      if ($pub) { Write-Host "! --pub ignored: this install.ps1 carries the release key of $version" }
    } else {
      if (-not $from) { Stop-Install 'this install.ps1 is not stamped by a release, so it downloads nothing. Use: install.ps1 --from <release folder> --pub <agent-tycoon-release.pub>' }
      if (-not $pub) { Stop-Install '--from needs --pub <release public key file>' }
      $sumsFile = Join-Path $from 'SHA256SUMS'
      if (-not (Test-Path -LiteralPath $sumsFile)) { Stop-Install "$sumsFile is missing" }
      Test-SumsSignature $sumsFile (Join-Path $from 'SHA256SUMS.sig') $pub
      $table = Get-Content -Raw -LiteralPath $sumsFile
      Write-Host "! unstamped install.ps1 (dev/private use): it carries no release key; $from\SHA256SUMS.sig was checked with --pub $pub (openssl) and the bundle is checked against that SHA256SUMS"
    }

    # ponytail: one bundle for Windows, x64 (arm64 Windows runs it emulated); add win-arm64 when it is built.
    $lines = @($table -split "`r?`n" | Where-Object { $_ -match '^[0-9a-f]{64}  agent-tycoon-daemon-\S+-win-x64\.tar\.(gz|zst)$' })
    if ($lines.Count -ne 1) { Stop-Install "the release lists $($lines.Count) daemon bundles for win-x64 (needs exactly one)" }
    $want, $name = $lines[0] -split '  ', 2

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('agent-tycoon-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $oldLang = $env:LANG
    $oldSecond = $env:AGENT_TYCOON_SECOND_HOST
    try {
      if ($from) {
        $dir = (Resolve-Path -LiteralPath $from).Path
      } else {
        Test-ReleaseUrl $baseUrl $insecure
        $baseUrl = $baseUrl.TrimEnd('/')
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $dir = Join-Path $tmp 'release'
        New-Item -ItemType Directory -Path $dir | Out-Null
        Write-Host "-> $baseUrl/$name"
        foreach ($f in @($name, 'SHA256SUMS', 'SHA256SUMS.sig')) { Get-ReleaseFile "$baseUrl/$f" (Join-Path $dir $f) $insecure }
      }

      $got = Get-Sha256 (Join-Path $dir $name)
      if ($got -ne $want) { Stop-Install "refused ${name}: SHA-256 $got does not match $want; nothing was unpacked" }
      Write-Host "OK ${name}: SHA-256 matches"

      # The install.sh a WSL distro runs: from the release, checked against the hash stamped here.
      $wslInstaller = $null
      if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        $sh = Join-Path $dir 'install.sh'
        if (-not $from) { Get-ReleaseFile "$baseUrl/install.sh" $sh $insecure }
        if (Test-Path -LiteralPath $sh) {
          if ($stamped -and (Get-Sha256 $sh) -ne $installShSha256) { Stop-Install "refused install.sh: its SHA-256 does not match the one stamped in install.ps1" }
          $wslInstaller = $sh
        }
      }

      # Windows tar.exe (bsdtar) reads .tar.gz; it has no zstd.
      $run = Join-Path $tmp 'run'
      New-Item -ItemType Directory -Path $run | Out-Null
      & "$env:SystemRoot\System32\tar.exe" -xf (Join-Path $dir $name) -C $run node cld core package.json
      if ($LASTEXITCODE -ne 0) { Stop-Install "could not unpack $name (tar.exe exit $LASTEXITCODE)" }
      $node = Join-Path $run 'node\node.exe'
      $wizard = Join-Path $run 'cld\install\wizard.mjs'
      if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $wizard)) { Stop-Install "$name did not unpack a runtime and manager" }

      if ($stamped) {
        $pub = Join-Path $tmp 'release.pub'
        [IO.File]::WriteAllText($pub, $pubKey.Trim() + "`n")
      }
      $wizardArgs = @('--bundle', (Join-Path $dir $name), '--pub', $pub) + $pass.ToArray()
      if (-not $from) { $wizardArgs += @('--base-url', $baseUrl); if ($insecure) { $wizardArgs += '--insecure-localhost' } }
      if ($wslInstaller) { $wizardArgs += @('--wsl-installer', $wslInstaller) }
      if (-not $env:LANG -and (Get-UICulture).Name -like 'ko*') { $env:LANG = 'ko_KR.UTF-8' }
      # The manager's test mode (it still needs --port, another than the live host's); the wizard has no such option.
      if ($second) { $env:AGENT_TYCOON_SECOND_HOST = '1' }
      & $node $wizard @wizardArgs
      $status = $LASTEXITCODE
    } finally {
      $env:LANG = $oldLang
      $env:AGENT_TYCOON_SECOND_HOST = $oldSecond
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($status -ne 0) { Stop-Install "the wizard stopped (exit $status)" }
  }

  Install-AgentTycoon @args
} @args
