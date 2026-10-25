#!/bin/sh
# 에이전트 타이쿤의 복제·갱신용 설치 진입점. Node 최소 버전은 cld/install/install.mjs 의 prerequisites() 와 같게 유지한다.
DEFAULT_AGENT_TYCOON_REPO='https://github.com/Keeweon-Choi/agent-tycoon.git'
REQUIRED_NODE_MAJOR=22

set -u

required_node_major=$REQUIRED_NODE_MAJOR

repo=${AGENT_TYCOON_REPO:-$DEFAULT_AGENT_TYCOON_REPO}
install_dir=${AGENT_TYCOON_DIR:-"$HOME/agent-tycoon"}
log_file=${TMPDIR:-/tmp}/agent-tycoon-install.$$
trap 'rm -f "$log_file"' EXIT HUP INT TERM

failed=0
if command -v git >/dev/null 2>&1; then
  printf '%s\n' '✔ git 확인'
else
  printf '%s\n' '✖ git이 없습니다. macOS: brew install git / Ubuntu·WSL: sudo apt install git'
  failed=1
fi

if command -v node >/dev/null 2>&1; then
  node_version=$(node --version 2>/dev/null || true)
  node_major=${node_version#v}
  node_major=${node_major%%.*}
  case "$node_major" in
    ''|*[!0-9]*|0|1[0-9])
      printf '%s\n' "✖ Node.js ${required_node_major} 이상이 필요합니다. macOS: brew install node / Linux·WSL: nvm install ${required_node_major}"
      failed=1
      ;;
    *)
      if [ "$node_major" -ge "$required_node_major" ]; then
        printf '%s\n' "✔ Node.js ${node_version} 확인"
      else
        printf '%s\n' "✖ Node.js ${required_node_major} 이상이 필요합니다. macOS: brew install node / Linux·WSL: nvm install ${required_node_major}"
        failed=1
      fi
      ;;
  esac
else
  printf '%s\n' "✖ Node.js ${required_node_major} 이상이 필요합니다. macOS: brew install node / Linux·WSL: nvm install ${required_node_major}"
  failed=1
fi

if command -v npm >/dev/null 2>&1; then
  printf '%s\n' '✔ npm 확인'
else
  printf '%s\n' '✖ npm이 없습니다. Node.js를 다시 설치하세요: macOS는 brew install node, Linux·WSL은 nvm install node'
  failed=1
fi

if command -v claude >/dev/null 2>&1; then
  printf '%s\n' '✔ Claude Code CLI 확인'
else
  printf '%s\n' '✖ Claude Code CLI가 없습니다. https://docs.anthropic.com/en/docs/claude-code 에서 설치하세요'
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  printf '%s\n' '✖ 준비 조건을 갖춘 뒤 같은 명령으로 다시 실행하세요'
  exit 1
fi

run_step() {
  step_name=$1
  shift
  if "$@" >"$log_file" 2>&1; then
    printf '✔ %s\n' "$step_name"
    return 0
  fi
  reason=$(sed -n '1p' "$log_file")
  [ -n "$reason" ] || reason='명령이 실패했습니다'
  printf '✖ %s 실패: %s. 다시 실행: %s\n' "$step_name" "$reason" "$*"
  exit 1
}

if [ -e "$install_dir" ] && [ ! -d "$install_dir/.git" ]; then
  printf '✖ 설치 폴더를 쓸 수 없습니다: %s. 비어 있지 않은 폴더를 옮긴 뒤 sh get.sh 를 다시 실행하세요\n' "$install_dir"
  exit 1
fi

if [ -d "$install_dir/.git" ]; then
  run_step '저장소 업데이트' git -C "$install_dir" pull --ff-only
else
  parent_dir=$(dirname "$install_dir")
  run_step '설치 폴더 준비' mkdir -p "$parent_dir"
  run_step '저장소 받기' git clone "$repo" "$install_dir"
fi

cd "$install_dir" || { printf '✖ 설치 폴더로 이동하지 못했습니다: %s. sh get.sh 를 다시 실행하세요\n' "$install_dir"; exit 1; }
run_step '의존성 설치' env HUSKY=0 npm ci
# The installer builds what it serves (asyncapi, esbuild, the webview); `npm run build` would also
# type-check and lint, which a user's machine has no reason to run or fail on.

if node cld/install/install.mjs >"$log_file" 2>&1; then
  printf '%s\n' '✔ 에이전트 타이쿤 설치기 실행'
  cat "$log_file"
else
  reason=$(sed -n '1p' "$log_file")
  [ -n "$reason" ] || reason='설치기가 실패했습니다'
  printf '✖ 에이전트 타이쿤 설치 실패: %s. 다시 실행: cd %s && node cld/install/install.mjs\n' "$reason" "$install_dir"
  exit 1
fi
