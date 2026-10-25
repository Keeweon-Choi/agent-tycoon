/** The install wizard's words (H §5.4), Korean and English. `lang(env)` picks one; nothing else here. */

/** Korean when the first set of LC_ALL, LC_MESSAGES, LANG (POSIX precedence) starts with `ko`. */
export function lang(env = process.env) {
  const value = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v) ?? '';
  return value.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

const en = {
  banner: ['  ╭────────────────────────────────────╮', '  │       ✦  AGENT TYCOON  ✦           │', '  │       Your AI, Your Empire.        │', '  ╰────────────────────────────────────╯'],
  system: (s) => `✓ ${s} detected`,
  found: (name) => `✓ ${name} found`,
  missing: (name) => `· ${name} not found (install it later; the office works without it)`,
  noTty: 'No terminal to ask in: taking the defaults (desktop app: skip, open the office: no; choose with --gui/--launch, --yes silences this).',
  where: 'Where should your agents work?',
  whereWsl: (distro) => `🐧 ${distro} (WSL2) — Recommended`,
  whereNative: '🪟 Windows Native',
  whereRemote: '🌐 Connect to remote host',
  choose: (n) => `Choose 1-${n} [1]:`,
  yesNo: (def) => (def ? '[Y/n]' : '[y/N]'),
  remote: [
    'Nothing was installed on this computer (no daemon, no runtime).',
    'Open the office of the host your agents run on: on a device that is already signed in, use "Add device" (or run cld-gui-login --qr on the host) and open the link or QR it gives you here.',
  ],
  wslRun: (distro) => `→ installing the daemon inside ${distro} (WSL2) with the same release`,
  wslFailed: (distro, code) => `WSL install in ${distro} failed (exit ${code})`,
  wslNoInstaller: 'install.sh for WSL is missing (install.ps1 passes it): run install.sh inside the distro yourself',
  desktopAsk: '◇ Install Agent Tycoon Desktop?',
  desktopNone: '· no desktop app in this release yet',
  desktopSkip: '· desktop app skipped',
  desktopRun: (name) => `◇ ${name} matches the signed SHA256SUMS. Run it now?`,
  desktopDone: (where) => `✓ desktop app installed: ${where}`,
  desktopFailed: (why) => `! desktop app not installed: ${why} (the daemon is installed; nothing else changed)`,
  policyAsk: 'When should Agent Tycoon run?',
  policyOnDemand: 'Only when needed — starts when you open the office (recommended)',
  policyAlways: 'Always — starts at Windows logon / boot, phones can reach it any time',
  policyManual: 'Manually — never starts by itself',
  lingerAsk: '◇ Keep the daemon running while you are logged out (loginctl enable-linger; uninstall turns it off again)?',
  launchAsk: '◇ Launch Agent Tycoon now?',
  launchFailed: (why) => `! could not open the office: ${why} (run agty open later)`,
  ready: '🏢 Your office is ready!',
};

const ko = {
  ...en,
  system: (s) => `✓ ${s} 확인`,
  found: (name) => `✓ ${name} 있음`,
  missing: (name) => `· ${name} 없음 (나중에 설치해도 됩니다. 사무실은 없이도 열립니다)`,
  noTty: '물어볼 터미널이 없어 기본값으로 진행합니다 (데스크톱 앱: 건너뜀, 사무실 열기: 안 함. --gui·--launch 로 정하고, --yes 는 이 안내를 끕니다).',
  where: '에이전트가 어디서 일할까요?',
  whereWsl: (distro) => `🐧 ${distro} (WSL2) — 추천`,
  whereNative: '🪟 Windows 에서 바로',
  whereRemote: '🌐 다른 컴퓨터(호스트)에 연결',
  choose: (n) => `1-${n} 중 고르세요 [1]:`,
  remote: [
    '이 컴퓨터에는 아무것도 설치하지 않았습니다 (데몬·런타임 없음).',
    '에이전트가 도는 호스트의 사무실을 여세요: 이미 로그인한 기기의 "기기 추가"(또는 호스트에서 cld-gui-login --qr)가 주는 링크나 QR 을 이 기기에서 여세요.',
  ],
  wslRun: (distro) => `→ ${distro} (WSL2) 안에 같은 릴리스로 데몬을 설치합니다`,
  wslFailed: (distro, code) => `${distro} 안의 설치가 실패했습니다 (종료 코드 ${code})`,
  wslNoInstaller: 'WSL 용 install.sh 가 없습니다 (install.ps1 이 넘겨 줍니다): 배포판 안에서 install.sh 를 직접 실행하세요',
  desktopAsk: '◇ 🎮 픽셀 사무실 앱도 설치할까요?',
  desktopNone: '· 이 릴리스에는 아직 데스크톱 앱이 없습니다',
  desktopSkip: '· 데스크톱 앱은 건너뜁니다',
  desktopRun: (name) => `◇ ${name} 가 서명된 SHA256SUMS 와 맞습니다. 지금 실행할까요?`,
  desktopDone: (where) => `✓ 데스크톱 앱 설치: ${where}`,
  desktopFailed: (why) => `! 데스크톱 앱은 설치하지 못했습니다: ${why} (데몬은 설치됐고 다른 것은 바뀌지 않았습니다)`,
  policyAsk: 'Agent Tycoon 을 언제 실행할까요?',
  policyOnDemand: '필요할 때만 — 사무실을 열면 시작 (추천)',
  policyAlways: '항상 — Windows 로그인·부팅 때 시작, 휴대폰이 언제든 들어옴',
  policyManual: '수동 — 저절로 시작하지 않음',
  lingerAsk: '◇ 로그아웃해도 데몬이 계속 돌게 할까요? (loginctl enable-linger, 제거하면 다시 끕니다)',
  launchAsk: '◇ 🎉 당신의 AI 사무실이 준비됐어요! 지금 사무실에 입장할까요?',
  launchFailed: (why) => `! 사무실을 열지 못했습니다: ${why} (나중에 agty open)`,
  ready: '🏢 사무실이 준비됐어요!',
};

export const TEXT = { en, ko };
