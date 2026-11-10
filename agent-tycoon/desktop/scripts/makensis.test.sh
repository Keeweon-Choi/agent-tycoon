#!/bin/sh
# Runs scripts/makensis against fake NSIS versions: the vendored include dir is added below 3.09 and only then.
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

check() { # version, expected: yes|no
  mkdir -p "$tmp/$1"
  cat > "$tmp/$1/makensis" <<EOF
#!/bin/sh
if [ "\$1" = -VERSION ]; then printf v$1; else echo "\$@"; fi
EOF
  chmod +x "$tmp/$1/makensis"
  out=$(PATH="$here:$tmp/$1:$PATH" makensis -V3 x.nsi)
  case $out in *"-X!addincludedir"*"nsis/include"*"-V3 x.nsi") got=yes ;; "-V3 x.nsi") got=no ;; *) got="? $out" ;; esac
  [ "$got" = "$2" ] || { echo "FAIL: NSIS $1 expected include=$2, got $got" >&2; exit 1; }
}

check 2.51 yes
check 3.0b3 yes
check 3.08-2 yes
check 3.09 no
check 3.10 no
check 3.13 no
echo ok
