#!/bin/sh
# Agent Tycoon install evidence (P8): read-only. Collects versions, the install record, the service and daemon state,
# `agty doctor` (without --fix) and the invariant fingerprint into ONE text file to send back. It starts, stops,
# installs and changes nothing; the only file it writes is that report. Secrets are left out (tokens, keys, server.json).
#
#   sh cld/test/install/evidence.sh [report file]        default: ~/agent-tycoon-evidence-<date-time>.txt
#
# Every command has a time limit and may fail without stopping the rest (a missing tool is just noted).
# EVIDENCE_TEST=1 (the INSTALL harness only) leaves out what calls Windows by an absolute path a test cannot redirect:
# `agty doctor` (curl.exe on WSL) and the fingerprint's system part (reg.exe, crontab, the real daemon's port).
set -u
out=${1:-$HOME/agent-tycoon-evidence-$(date +%Y%m%d-%H%M%S).txt}
here=$(cd "$(dirname "$0")" && pwd)
root=${AGENT_TYCOON_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-tycoon}
data=$HOME/.config/cld-gui
port=$(sed -n 's/^ *"port": *\([0-9]*\).*/\1/p' "$data/config.json" 2>/dev/null | head -1)
port=${port:-18240}

section() { printf '\n===== %s =====\n' "$*"; }
run() { printf '$ %s\n' "$*"; timeout 30 "$@" 2>&1 | tr -d '\000'; printf '(exit %s)\n' "$?"; }
login() { printf '$ bash -lic %s\n' "$1"; MOTD_SHOWN=1 timeout 30 bash -lic "$1" </dev/null 2>/dev/null; }
hidden() { sed -E 's/("?[A-Za-z_]*([Tt]oken|[Ss]ecret|[Pp]assword|[Kk]ey)[A-Za-z_]*"? *[:=] *).*/\1"[숨김]"/'; }

{
  section "언제·어디서"
  date; uname -a
  sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null
  echo "WSL_DISTRO_NAME=${WSL_DISTRO_NAME:-} SHELL=${SHELL:-} USER=${USER:-}"
  [ -d /run/systemd/system ] && echo "systemd: 켜짐" || echo "systemd: 꺼짐"

  section "버전 (사용자 셸에서 찾은 것)"
  login 'for c in node npm pnpm yarn claude codex git tmux python3 agty cld-gui; do printf "%-8s %s\n" "$c" "$(command -v "$c")"; done; node -v; npm -v; claude --version; codex --version; git --version; tmux -V; python3 --version'

  section "설치 기록 ($root)"
  run ls -la "$root" "$root/versions" "$root/bin"
  run readlink "$root/current"
  if [ -f "$root/install.json" ]; then echo "\$ cat install.json"; hidden <"$root/install.json"; fi
  [ -f "$root/release.pub" ] && run sha256sum "$root/release.pub"
  [ -f "$root/manager.lock" ] && { echo "! manager.lock 있음:"; cat "$root/manager.lock"; echo; }
  run ls -la "$HOME/.local/bin/agty" "$HOME/.local/bin/cld-gui" "$HOME/.local/bin/cld"

  section "설정 (비밀 값은 숨김)"
  [ -f "$data/config.json" ] && hidden <"$data/config.json"
  run du -sh "$data" "$HOME/.local/state/cld-gui" "$HOME/.pixel-agents"
  run ls "$HOME/.config"

  section "서비스"
  for s in agent-tycoon cld-gui; do
    run systemctl --user is-enabled "$s"; run systemctl --user is-active "$s"
    run systemctl --user status "$s" --no-pager -n 15
    [ -f "$HOME/.config/systemd/user/$s.service" ] && { echo "\$ cat $s.service"; cat "$HOME/.config/systemd/user/$s.service"; }
  done
  [ -e "/var/lib/systemd/linger/${USER:-}" ] && echo "linger: 켜짐" || echo "linger: 꺼짐"

  section "데몬 (포트 $port)"
  run curl -fsS --max-time 3 "http://127.0.0.1:$port/api/health"; echo
  run ss -ltnp
  agty=$root/bin/agty; [ -x "$agty" ] || agty=$(command -v agty || command -v cld-gui || echo agty)
  run "$agty" status
  run "$agty" start-policy
  [ -n "${EVIDENCE_TEST:-}" ] || run "$agty" doctor

  if [ -n "${WSL_DISTRO_NAME:-}" ]; then
    section "Windows 쪽 (읽기만)"
    run wsl.exe -l -v
    run schtasks.exe /Query /TN "agent-tycoon-wsl-$WSL_DISTRO_NAME"
    run schtasks.exe /Query /TN cld-gui
  fi

  section "환경 불변 지문 (invariants.mjs, 해시만)"
  snap=$(mktemp)
  nodebin=$root/current/node/bin/node; [ -x "$nodebin" ] || nodebin=$(command -v node || echo node) # our private Node first
  if "$nodebin" "$here/invariants.mjs" snapshot "$snap" ${EVIDENCE_TEST:+--no-system} >/dev/null 2>&1; then cat "$snap"; else echo "(Node 를 찾지 못해 건너뜀)"; fi
  rm -f "$snap"
} >"$out" 2>&1

echo "증거 파일: $out"
echo "이 파일 하나를 보내 주세요. 비밀 값(토큰·키)은 넣지 않았어요."
