#!/bin/sh
# Agent Tycoon one-line installer for Linux, macOS and WSL (H §2.2, §5.4; roadmap P4). No Node needed.
#
#   curl -fsSL <release>/install.sh | sh
#   sh install.sh [--yes] [--gui yes|no] [--launch yes|no] [--port N] [--service KIND] [--add-path] [--remote]
#   sh install.sh --from <release folder> --pub <agent-tycoon-release.pub>     (a gh release download folder)
#
# This copy in the repository is a template; cld/release/stamp-installers.mjs fills in the values
# below for a release. The script only (1) fetches the daemon bundle for this OS/CPU into a fresh temp
# dir (HTTPS only), (2) checks its SHA-256 against the table stamped below before unpacking anything,
# (3) unpacks the bundle's own Node and manager and hands over to the manager's wizard
# (cld/install/wizard.mjs), which checks the Ed25519 signature of SHA256SUMS with the stamped key,
# pins that key as release.pub and asks every question. The temp dir is removed afterwards.
# Unstamped, it downloads nothing: --from <folder> --pub <key> only. Then OpenSSL 3 checks the folder's
# SHA256SUMS.sig with --pub before anything is unpacked, and the bundle is checked against that SHA256SUMS.
# --base-url <url> overrides the release URL (tests); plain http is allowed only to 127.0.0.1 or
# localhost, and only with --insecure-localhost.
#
# Everything runs inside main(), called on the last line: a truncated download runs nothing.
set -eu

AT_STAMPED='@@STAMPED@@'
AT_VERSION='@@VERSION@@'
AT_BASE_URL='@@BASE_URL@@'
AT_BUNDLES='@@BUNDLES@@'
AT_PUBKEY='@@PUBKEY@@'

say() { printf '%s\n' "$*"; }
die() { printf 'agty install: %s\n' "$*" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else die 'sha256sum or shasum is needed to check the download'
  fi
}

# fetch <url> <file>: curl only (wget follows an https -> http redirect); HTTPS only, redirects
# included, unless the URL passed the localhost check.
fetch() {
  case $1 in https://*) proto='=https' ;; *) proto='=http' ;; esac
  command -v curl >/dev/null 2>&1 || die 'curl is needed to download the release'
  curl -fsSL --proto "$proto" --proto-redir "$proto" -o "$2" "$1" || die "download failed: $1"
}

# verify_sums <SHA256SUMS> <SHA256SUMS.sig> <public key>: the Ed25519 signature sign.mjs writes (raw 64
# bytes over SHA256SUMS, SPKI PEM key), checked by OpenSSL 3 before anything is unpacked or run.
verify_sums() {
  command -v openssl >/dev/null 2>&1 || die 'openssl (OpenSSL 3) is needed to check SHA256SUMS.sig with --pub; nothing was unpacked'
  openssl pkeyutl -help 2>&1 | grep -q -- '-rawin' || die "this openssl ($(openssl version 2>/dev/null)) cannot check Ed25519 signatures (OpenSSL 3 is needed); nothing was unpacked"
  [ -f "$3" ] || die "--pub $3: no such file"
  [ -f "$2" ] || die "$2 is missing"
  openssl pkeyutl -verify -pubin -inkey "$3" -rawin -in "$1" -sigfile "$2" >/dev/null 2>&1 ||
    die "refused $1: SHA256SUMS.sig is not a valid signature by --pub $3; nothing was unpacked"
}

check_url() {
  case $1 in
    https://*) return 0 ;;
    http://*)
      [ "$2" = 1 ] || die "refusing $1: plain http is allowed only to 127.0.0.1/localhost with --insecure-localhost"
      hostport=${1#http://}; hostport=${hostport%%/*}
      case $hostport in
        *@*) die "refusing $1: user info in the URL" ;;
        127.0.0.1 | localhost) return 0 ;;
        127.0.0.1:* | localhost:*)
          case ${hostport#*:} in '' | *[!0-9]*) die "refusing $1: not a port" ;; esac
          return 0 ;;
      esac
      die "refusing $1: plain http is allowed only to 127.0.0.1 or localhost" ;;
  esac
  die "refusing $1: downloads are HTTPS only"
}

main() {
  base_url=$AT_BASE_URL
  from=
  pub=
  insecure=0
  n=$#
  while [ "$n" -gt 0 ]; do
    a=$1; shift; n=$((n - 1))
    case $a in
      --from | --pub | --base-url)
        [ "$n" -gt 0 ] || die "$a needs a value"
        v=$1; shift; n=$((n - 1))
        case $a in --from) from=$v ;; --pub) pub=$v ;; *) base_url=$v ;; esac ;;
      --insecure-localhost) insecure=1 ;;
      --bundle | --sums | --sig | --wsl-installer) die "$a is set by install.sh itself, not on the command line" ;;
      -h | --help) sed -n '2,17p' "$0" 2>/dev/null || say 'see cld/INSTALL.md'; exit 0 ;;
      *) set -- "$@" "$a" ;; # the wizard's options
    esac
  done

  case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported system $(uname -s) (on Windows use install.ps1)" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported CPU $(uname -m)" ;;
  esac
  # A shell under Rosetta reports x86_64 on Apple silicon: take the native arm64 bundle.
  [ "$os-$arch" != darwin-x64 ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" != 1 ] || arch=arm64

  if [ "$AT_STAMPED" = 1 ]; then
    table=$AT_BUNDLES
    [ -z "$pub" ] || say "! --pub ignored: this install.sh carries the release key of $AT_VERSION"
  else
    [ -n "$from" ] || die 'this install.sh is not stamped by a release, so it downloads nothing. Use: sh install.sh --from <release folder> --pub <agent-tycoon-release.pub>'
    [ -n "$pub" ] || die '--from needs --pub <release public key file>'
    [ -f "$from/SHA256SUMS" ] || die "$from/SHA256SUMS is missing"
    verify_sums "$from/SHA256SUMS" "$from/SHA256SUMS.sig" "$pub"
    table=$(cat "$from/SHA256SUMS")
    say "! unstamped install.sh (dev/private use): it carries no release key; $from/SHA256SUMS.sig was checked with --pub $pub (openssl) and the bundle is checked against that SHA256SUMS"
  fi

  lines=$(printf '%s\n' "$table" | grep -E "^[0-9a-f]{64}  agent-tycoon-daemon-[^ ]+-$os-$arch\.tar\.(gz|zst)\$" || true)
  count=$(printf '%s' "$lines" | grep -c . || true)
  [ "$count" = 1 ] || die "the release lists $count daemon bundles for $os-$arch (needs exactly one)"
  want=${lines%% *}
  name=${lines#*  }

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/agent-tycoon-install.XXXXXX") || die 'could not make a temp dir'
  trap 'rm -rf "$tmp"' 0
  trap 'exit 1' HUP INT TERM PIPE # every exit path goes through the 0 trap (output piped into head included)

  if [ -n "$from" ]; then
    dir=$from
  else
    check_url "$base_url" "$insecure"
    base_url=${base_url%/}
    dir=$tmp/release
    mkdir "$dir"
    say "→ $base_url/$name"
    for f in "$name" SHA256SUMS SHA256SUMS.sig; do fetch "$base_url/$f" "$dir/$f"; done
  fi

  got=$(sha256 "$dir/$name")
  [ "$got" = "$want" ] || die "refused $name: SHA-256 $got does not match $want; nothing was unpacked"
  say "✓ $name: SHA-256 matches"

  run=$tmp/run
  mkdir "$run"
  case $name in
    *.tar.gz) gzip -dc "$dir/$name" | (cd "$run" && tar -xf - node cld core package.json) || die "could not unpack $name" ;;
    *.tar.zst)
      command -v zstd >/dev/null 2>&1 || die "zstd is needed to unpack $name"
      zstd -dcq "$dir/$name" | (cd "$run" && tar -xf - node cld core package.json) || die "could not unpack $name" ;;
  esac
  node=$run/node/bin/node
  [ -x "$node" ] && [ -f "$run/cld/install/wizard.mjs" ] || die "$name did not unpack a runtime and manager"

  if [ "$AT_STAMPED" = 1 ]; then
    pub=$tmp/release.pub
    printf '%s\n' "$AT_PUBKEY" >"$pub"
  fi
  set -- --bundle "$dir/$name" --pub "$pub" "$@"
  [ -n "$from" ] || set -- "$@" --base-url "$base_url"
  [ -n "$from" ] || [ "$insecure" = 0 ] || set -- "$@" --insecure-localhost

  # The script may be arriving on stdin (curl | sh): the wizard asks on the terminal, or not at all.
  status=0
  if (exec </dev/tty) 2>/dev/null; then "$node" "$run/cld/install/wizard.mjs" "$@" </dev/tty || status=$?
  else "$node" "$run/cld/install/wizard.mjs" "$@" </dev/null || status=$?
  fi
  exit "$status"
}

main "$@"
