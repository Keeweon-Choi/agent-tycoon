#!/bin/sh
# One fake for every outside command an INSTALL scenario could reach (systemctl, loginctl, wsl.exe, powershell.exe,
# schtasks, cmd.exe, wslpath, explorer.exe, xdg-open, sudo, claude, codex, ...), linked under each name first on PATH.
# It appends its name and argv (tab separated) to $AT_TEST_CTL/calls.log and acts out just enough; it never runs
# anything real. `systemctl --user` keeps units as plain processes: start runs the unit's ExecStart in the background
# (pid in $AT_TEST_CTL/systemd/<unit>.pid), stop kills that pid and only that one.
set -u
ctl=${AT_TEST_CTL:?AT_TEST_CTL is not set: this fake runs only inside an INSTALL scenario}
name=$(basename "$0")
{ printf '%s' "$name"; for a in "$@"; do printf '\t%s' "$a"; done; printf '\n'; } >>"$ctl/calls.log"

systemctl_user() {
  dir=$ctl/systemd
  mkdir -p "$dir"
  verb=${1:-}; [ $# -gt 0 ] && shift
  now=0; units=
  for a in "$@"; do case $a in --now) now=1 ;; --*) ;; *) units="$units ${a%.service}" ;; esac; done
  alive() { p=$(cat "$dir/$1.pid" 2>/dev/null) && [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
  stop() {
    if alive "$1"; then
      p=$(cat "$dir/$1.pid"); kill "$p" 2>/dev/null; i=0
      while kill -0 "$p" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
      kill -9 "$p" 2>/dev/null
    fi
    rm -f "$dir/$1.pid"
  }
  launch() {
    f=$HOME/.config/systemd/user/$1.service
    [ -f "$f" ] || { echo "Failed to start $1.service: Unit $1.service not found." >&2; return 5; }
    cmd=$(sed -n 's/^ExecStart=//p' "$f"); wd=$(sed -n 's/^WorkingDirectory=//p' "$f"); upath=$(sed -n 's/^Environment=PATH=//p' "$f")
    (cd "$wd" && exec setsid env PATH="$upath" sh -c "exec $cmd" >>"$dir/$1.log" 2>&1 </dev/null) &
    echo $! >"$dir/$1.pid"
  }
  rc=0
  case $verb in
    daemon-reload) ;;
    enable) for u in $units; do touch "$dir/$u.enabled"; done ;;
    disable) for u in $units; do rm -f "$dir/$u.enabled"; [ $now = 0 ] || stop "$u"; done ;;
    start) for u in $units; do alive "$u" || launch "$u" || rc=$?; done ;;
    restart) for u in $units; do stop "$u"; launch "$u" || rc=$?; done ;;
    stop) for u in $units; do stop "$u"; done ;;
    is-active) for u in $units; do if alive "$u"; then echo active; else echo inactive; rc=3; fi; done ;;
    is-enabled) for u in $units; do if [ -f "$dir/$u.enabled" ]; then echo enabled; else echo disabled; rc=1; fi; done ;;
  esac
  return $rc
}

case $name in
  systemctl)
    [ "${1:-}" = --user ] || { echo "fake systemctl: only --user is allowed in a test" >&2; exit 1; }
    shift; systemctl_user "$@"; exit $? ;;
  claude | codex) [ "${1:-}" = --version ] && echo "9.9.9 (fake $name)"; exit 0 ;;
  cmd.exe) case "$*" in *'echo %TEMP%'*) echo 'C:\Users\attest\AppData\Local\Temp' ;; esac; exit 0 ;;
  wslpath) mkdir -p "$ctl/wintemp"; echo "$ctl/wintemp"; exit 0 ;;
  powershell | powershell.exe | pwsh) case "$*" in *Get-ScheduledTask*) echo Ready ;; esac; exit 0 ;;
  schtasks | schtasks.exe) case "$*" in */Query*) exit 1 ;; esac; exit 0 ;;
  journalctl) echo '-- fake journal --'; exit 0 ;;
  sudo) echo 'fake sudo: never in a test' >&2; exit 1 ;;
  *) exit 0 ;;
esac
