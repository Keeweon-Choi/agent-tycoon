#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '사용법: %s [-t 대상] [-s SSH포트] [-l 로컬포트] [-r 원격포트] [-m 원격로그인] [-h]\n' "$0" >&2
}

TARGET=''
SSH_PORT=2233
LOCAL_PORT=18240
REMOTE_PORT=18240
REMOTE_LOGIN='~/projects/cld-gui/cld/bin/cld-gui-login'
while getopts ':t:s:l:r:m:h' opt; do
  case "$opt" in
    t) TARGET=$OPTARG ;;
    s) SSH_PORT=$OPTARG ;;
    l) LOCAL_PORT=$OPTARG ;;
    r) REMOTE_PORT=$OPTARG ;;
    m) REMOTE_LOGIN=$OPTARG ;;
    h) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

config_file="$HOME/.cld-gui.json"
if [[ -z "$TARGET" && -f "$config_file" ]]; then
  TARGET=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("Target", ""))' "$config_file" 2>/dev/null || true)
fi
if [[ -z "$TARGET" ]]; then
  printf '%s\n' 'SSH 대상이 없습니다. -t 대상 을 지정해 주세요.' >&2
  exit 1
fi

port_open() {
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$LOCAL_PORT" >/dev/null 2>&1
  else
    (echo >/dev/tcp/127.0.0.1/"$LOCAL_PORT") >/dev/null 2>&1
  fi
}

if ! port_open; then
  ssh -f -N -L "$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" -p "$SSH_PORT" \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o BatchMode=yes "$TARGET" || {
      printf '%s\n' 'SSH 터널을 시작할 수 없습니다.' >&2
      exit 1
    }
fi

daemon_up() { curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$LOCAL_PORT/api/health"; }
ready=false
for delay in 1 2 5 5 10 10 10 30 30; do
  if daemon_up; then ready=true; break; fi
  sleep "$delay"
done
if [[ "$ready" != true ]] && daemon_up; then ready=true; fi
if [[ "$ready" != true ]]; then
  printf '%s\n' '호스트에 닿지 않음' >&2
  exit 1
fi

if ! code=$(ssh -p "$SSH_PORT" -o BatchMode=yes "$TARGET" "$REMOTE_LOGIN") || [[ -z "$code" ]]; then
  printf '%s\n' '로그인 코드를 가져올 수 없습니다.' >&2
  exit 1
fi
python3 - "$config_file" "$TARGET" "$LOCAL_PORT" <<'PY'
import json, os, sys
path, target, port = sys.argv[1:]
tmp = path + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump({'Target': target, 'LocalPort': int(port)}, f)
    f.write('\n')
os.replace(tmp, path)
PY
url="http://localhost:$LOCAL_PORT/login?code=$code"
if [[ "$(uname -s)" == Darwin ]]; then
  open "$url"
else
  xdg-open "$url"
fi
