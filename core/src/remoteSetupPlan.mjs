/** The shared, side-effect-free plan for exactly the option the person chose. */
export const REMOTE_CHOICES = Object.freeze(['local', 'direct', 'ssh', 'duckdns', 'tailscale', 'funnel', 'tunnel', 'lan']);

export function remoteSetupPlan(facts, choice) {
  if (!REMOTE_CHOICES.includes(choice)) throw new Error('알 수 없는 접속 방식이에요');
  if (choice === 'local') return [{ kind: 'switch', text: '이 PC에서만 열어요' }];
  if (choice === 'lan') return [firewallStep(facts), { kind: 'switch', text: '같은 와이파이에 열어요' }].filter(Boolean);
  if (choice === 'ssh') {
    const command = sshTunnelCommand({ port: facts.port ?? 18240, sshPort: facts.sshPort, user: facts.sshUser || '<user>', host: facts.sshHost || '<host>' });
    // An SSH server already answers (the read-only scan): nothing new to open.
    if (facts.sshFound)
      return [{ kind: 'ssh', text: '이미 있는 SSH로 붙어요: 새 포트를 열지 않는 가장 비공개인 길이에요', guide: '노트북 터미널에서 아래 명령을 실행하세요.', actions: [
        { kind: 'copy', text: command, label: 'SSH 명령 복사' },
      ] }];
    // WSL: the laptop reaches Windows' OpenSSH, whose 127.0.0.1 is the daemon in WSL (localhost forwarding, or mirrored).
    const windows = facts.platform === 'win32' || facts.platform === 'wsl';
    const serverCommand = windows
      ? 'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0\nStart-Service sshd\nSet-Service -Name sshd -StartupType Automatic'
      : facts.platform === 'darwin'
        ? 'sudo systemsetup -setremotelogin on'
        : 'sudo apt install -y openssh-server && sudo systemctl enable --now ssh';
    const guide = windows ? '노트북 터미널에서 연결하세요. SSH 서버가 없다면 Windows 관리자 PowerShell에서 아래 서버 명령을 실행하세요.'
      : facts.platform === 'darwin' ? '노트북 터미널에서 연결하세요. SSH가 꺼져 있다면 시스템 설정 > 일반 > 공유 > 원격 로그인을 켜세요 (아래 명령은 터미널에 전체 디스크 접근 권한이 있어야 해요).'
        : '노트북 터미널에서 연결하세요. SSH 서버가 없다면 이 PC에서 관리자 권한으로 서버를 켜세요.';
    return [{ kind: 'ssh', text: '노트북에서 SSH 터널을 열어요', guide, actions: [
      { kind: 'copy', text: command, label: 'SSH 명령 복사' },
      { kind: 'copy', text: serverCommand, label: 'SSH 서버 설치 명령 복사' },
    ] }];
  }
  if (facts.existingWorking === choice)
    return [{ kind: 'keep', text: `이미 작동하는 ${choice} 연결을 유지해요` }];
  if (choice === 'direct' || choice === 'duckdns') {
    if (facts.natKind === 'cgnat')
      return [{ kind: 'unavailable', text: '통신사 CGNAT에서는 공유기 직결 주소로 들어올 수 없어요.', suggest: 'tailscale' }];
    if (choice === 'duckdns' && !facts.duckdnsConfigured)
      return [{ kind: 'duckdns-account', text: 'DuckDNS 이름과 토큰을 넣으세요', guide: 'DuckDNS에 로그인해 서브도메인을 만들고 토큰을 아래에 넣으세요.', actions: [
        { kind: 'open', url: 'https://www.duckdns.org', label: 'DuckDNS 열기' },
      ] }];
    // NAT only: mirrored shares Windows' addresses and needs only the firewall step below.
    if (facts.wslMode === 'nat' && !facts.relayReady)
      return [{ kind: 'wsl-relay', text: 'Windows가 이 PC로 연결을 넘겨야 해요', guide: 'Windows 관리자 PowerShell에서 아래 명령을 실행하세요.\n설정 뒤 자동으로 다시 확인해요.', actions: [
        { kind: 'copy', text: facts.wslInstructions || 'Windows 포트 전달을 설정하세요', label: 'PowerShell 명령 복사' },
      ] }];
    const firewall = firewallStep(facts);
    if (firewall) return [firewall];
    return [{ kind: 'direct', text: choice === 'duckdns' ? '공유기를 열고 DuckDNS HTTPS 주소를 확인해요' : '공유기를 자동으로 열고 HTTPS 주소를 확인해요' }];
  }
  if (choice === 'tunnel') {
    if (!facts.cloudflaredInstalled)
      return [{ kind: 'cloudflared-install', text: 'cloudflared를 설치하세요', guide: '공식 설치 페이지에서 cloudflared를 설치하세요.\n설치되면 자동으로 다시 확인해요.', actions: [
        { kind: 'open', url: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/', label: '설치 페이지 열기' },
      ] }];
    return [{ kind: 'tunnel', text: '임시 공개 주소를 열어요. 주소는 실행할 때마다 바뀌고 오래 유지되지 않아요' }];
  }
  // WSL that drives Windows' tailscale.exe signs in with the Windows app, not a Linux command.
  const linux = (facts.platform === 'linux' || facts.platform === 'wsl' || !!facts.wslMode) && !facts.tailscaleWindows;
  // The page may be open on a phone: the download link names the PC's own platform.
  const download = linux ? 'linux' : facts.platform === 'darwin' ? 'mac' : facts.platform === 'win32' || facts.tailscaleWindows ? 'windows' : '';
  if (!facts.tailscaleInstalled)
    return [{ kind: 'tailscale-install', text: 'Tailscale을 설치하세요', guide: 'PC에 Tailscale을 설치하세요. 폰에도 앱과 같은 계정이 필요해요.', actions: [
      { kind: 'open', url: `https://tailscale.com/download${download ? `/${download}` : ''}`, label: 'Tailscale 설치 페이지 열기' },
      ...(linux ? [{ kind: 'copy', text: 'curl -fsSL https://tailscale.com/install.sh | sh', label: 'Linux 설치 명령 복사' }] : []),
    ] }];
  if (!facts.tailscaleLoggedIn)
    return [{ kind: 'tailscale-login', text: 'Tailscale에 한 번 로그인하세요', guide: 'PC에서 로그인하고 폰에도 Tailscale 앱을 설치해 같은 계정으로 로그인하세요.', actions: [
      { kind: 'open', url: facts.tailscaleLoginUrl || 'https://login.tailscale.com/start', label: 'Tailscale 로그인 열기' },
      ...(linux ? [{ kind: 'copy', text: 'sudo tailscale up --operator=$USER', label: '로그인 명령 복사' }] : []),
    ] }];
  if (choice === 'funnel') {
    if (facts.tailscaleFunnelAllowed === false)
      return [{ kind: 'tailscale-funnel-consent', text: '이 tailnet에서 Funnel을 한 번 허용하세요', guide: 'Tailscale 관리 콘솔에서 이 tailnet의 Funnel을 허용하세요.\n허용되면 자동으로 다시 확인해요.', actions: [
        { kind: 'open', url: facts.tailscaleFunnelUrl || 'https://login.tailscale.com/admin/acls/file', label: 'Tailscale 관리 콘솔 열기' },
      ] }];
    return [{ kind: 'tailscale-funnel', text: 'Tailscale Funnel로 인터넷에 열어요. 로그인은 필요해요' }];
  }
  return [{ kind: 'tailscale-serve', text: 'Tailscale Serve로 내 기기에만 열어요' }];
}

/** The laptop's one line: its own port `port` reaches this PC's 127.0.0.1:`port` through an SSH server. */
export function sshTunnelCommand({ port, sshPort, user, host }) {
  // A Windows account name may hold spaces: double quotes work in sh, cmd and PowerShell alike
  // (and Windows forbids " in account names).
  const target = /^[\w.-]+$/.test(user) ? `${user}@${host}` : `"${String(user).replaceAll('"', '')}@${host}"`;
  return `ssh -N -L ${port}:127.0.0.1:${port}${sshPort && sshPort !== 22 ? ` -p ${sshPort}` : ''} ${target}`;
}

const FIREWALL_TEXT = {
  windows: 'Windows 방화벽이 바깥에서 오는 연결을 막아요',
  'wsl-mirrored': 'WSL mirrored 모드라 Windows 방화벽(Hyper-V)이 바깥에서 오는 연결을 막아요',
  ufw: 'ufw 방화벽이 켜져 있어 바깥에서 오는 연결을 막아요',
  firewalld: 'firewalld 방화벽이 켜져 있어 바깥에서 오는 연결을 막아요',
  macos: 'macOS 방화벽이 켜져 있어 Node가 연결을 받도록 허용해야 해요',
};

/**
 * The host firewall step before a listener opens (facts.firewall, null when
 * none is in the way or its rule is already there). Windows rules are read
 * back, so the page re-checks by itself; a Linux or Mac rule needs root to
 * read, so the person says they ran it (`confirm`).
 */
function firewallStep(facts) {
  const fw = facts.firewall;
  if (!fw || fw.ready) return null;
  const windows = fw.kind === 'windows' || fw.kind === 'wsl-mirrored';
  const guide = [windows ? 'Windows 관리자 PowerShell에서 아래 명령을 실행하세요.' : '이 PC의 터미널에서 아래 명령을 실행하세요 (sudo 비밀번호를 물어요).',
    fw.confirm ? '실행했으면 "실행했어요"를 누르세요.' : '설정 뒤 자동으로 다시 확인해요.'].join('\n');
  return { kind: 'firewall', text: FIREWALL_TEXT[fw.kind], guide, actions: [
    { kind: 'copy', text: fw.add.join('\n'), label: windows ? 'PowerShell 명령 복사' : '터미널 명령 복사' },
  ], ...(fw.confirm ? { confirm: true } : {}) };
}
