#!/usr/bin/env bash
# Focused, merge-gate, and release-candidate checks for cld-gui.
set -uo pipefail

usage() {
  echo "usage: $0 <fast|integration|release> [base-ref] [browser-runner ...]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
tier=$1
shift

case "$tier" in
  fast|integration|release) ;;
  *) usage ;;
esac

failures=0
declare -a skipped=()

pass() {
  echo "PASS $1"
}

fail() {
  echo "FAIL $1"
  failures=$((failures + 1))
}

skip() {
  local step=$1
  local reason=$2
  echo "SKIP $step ($reason)"
  skipped+=("$step")
}

run() {
  local step=$1
  shift
  if nice -n 10 "$@"; then
    pass "$step"
  else
    fail "$step"
  fi
}

run_in() {
  local step=$1
  local directory=$2
  shift 2
  if (cd "$directory" && nice -n 10 "$@"); then
    pass "$step"
  else
    fail "$step"
  fi
}

finish() {
  local label=${tier^^}
  local status=PASS
  (( failures == 0 )) || status=FAIL
  if (( ${#skipped[@]} )); then
    local joined
    joined=$(printf '%s, ' "${skipped[@]}")
    joined=${joined%, }
    echo "CHECK $label $status (skipped: $joined)"
  else
    echo "CHECK $label $status"
  fi
  (( failures == 0 ))
}

default_base() {
  if git rev-parse --verify --quiet origin/main >/dev/null && git merge-base HEAD origin/main; then
    return
  else
    git merge-base HEAD main
  fi
}

declare -a changed=()
collect_changes() {
  local base=$1
  local changes
  if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
    return 1
  fi
  changes=$(
    {
      git diff --name-only "$base...HEAD"
      git diff --name-only
      git diff --name-only --cached
      git ls-files --others --exclude-standard
    } | LC_ALL=C sort -u
  ) || return 1
  if [[ -n $changes ]]; then
    mapfile -t changed <<<"$changes"
  fi
}

run_fast() {
  local base=${1:-}
  if [[ -z $base ]]; then
    if ! base=$(default_base); then
      fail change-set
      skip lint-root "change set unavailable"
      skip lint-webview "change set unavailable"
      skip types-server "change set unavailable"
      skip types-webview "change set unavailable"
      skip test-server-related "change set unavailable"
      skip test-webview-related "change set unavailable"
      skip test-install "change set unavailable"
      skip test-core "change set unavailable"
      skip docs-check "change set unavailable"
      return
    fi
  fi
  if collect_changes "$base"; then
    pass change-set
  else
    fail change-set
    skip lint-root "change set unavailable"
    skip lint-webview "change set unavailable"
    skip types-server "change set unavailable"
    skip types-webview "change set unavailable"
    skip test-server-related "change set unavailable"
    skip test-webview-related "change set unavailable"
    skip test-install "change set unavailable"
    skip test-core "change set unavailable"
    skip docs-check "change set unavailable"
    return
  fi

  local file relative
  declare -a root_lint=() web_lint=() server_files=() web_files=()
  local server_or_core=false web_or_core=false install_changed=false core_test_changed=false docs_changed=false
  for file in "${changed[@]}"; do
    case "$file" in
      server/*|core/*) server_or_core=true ;;
    esac
    case "$file" in
      webview-ui/*|core/*) web_or_core=true ;;
    esac
    [[ $file == cld/install/* ]] && install_changed=true
    [[ $file == cld/docs/* ]] && docs_changed=true
    [[ $file =~ ^core/src/[^/]+\.mjs$ ]] && core_test_changed=true
    if [[ -f $file ]]; then
      case "$file" in
        adapters/vscode/*|server/*|core/*)
          case "$file" in
            *.ts|*.tsx|*.mjs|*.js) root_lint+=("$file") ;;
          esac
          ;;
        webview-ui/*)
          case "$file" in
            *.ts|*.tsx|*.mjs|*.js)
              relative=${file#webview-ui/}
              web_lint+=("$relative")
              ;;
          esac
          ;;
      esac
      [[ $file == server/* ]] && server_files+=("${file#server/}")
      [[ $file == webview-ui/* ]] && web_files+=("${file#webview-ui/}")
    fi
  done

  if (( ${#root_lint[@]} )); then
    run lint-root npx eslint -- "${root_lint[@]}"
  else
    skip lint-root "no changed linted files under adapters/vscode, server, or core"
  fi
  if (( ${#web_lint[@]} )); then
    run_in lint-webview webview-ui npx eslint -- "${web_lint[@]}"
  else
    skip lint-webview "no changed linted files under webview-ui"
  fi
  if [[ $server_or_core == true ]]; then
    run types-server npx tsc --noEmit -p server/tsconfig.test.json
  else
    skip types-server "no changed files under server or core"
  fi
  if [[ $web_or_core == true ]]; then
    run_in types-webview webview-ui npx tsc -b
  else
    skip types-webview "no changed files under webview-ui or core"
  fi
  if (( ${#server_files[@]} )); then
    run_in test-server-related server npx vitest related --run "${server_files[@]}"
  else
    skip test-server-related "no changed files under server"
  fi
  if (( ${#web_files[@]} )); then
    run_in test-webview-related webview-ui npx vitest related --run "${web_files[@]}"
  else
    skip test-webview-related "no changed files under webview-ui"
  fi
  if [[ $install_changed == true ]]; then
    run test-install node --test cld/install/*.test.mjs
  else
    skip test-install "no changed files under cld/install"
  fi
  if [[ $core_test_changed == true ]]; then
    run test-core node --test core/src/*.test.mjs
  else
    skip test-core "no changed core/src/*.mjs files"
  fi
  if [[ $docs_changed == true ]]; then
    run docs-check node cld/scripts/docs-check.mjs --root cld
  else
    skip docs-check "no changed files under cld/docs"
  fi
}

run_integration() {
  if nice -n 10 npm run -s asyncapi:generate && git diff --exit-code --stat core/src/messages.ts; then
    pass asyncapi-drift
  else
    fail asyncapi-drift
  fi
  if nice -n 10 npm run -s e2e:inventory && git diff --exit-code --stat e2e/README.md; then
    pass e2e-inventory-drift
  else
    fail e2e-inventory-drift
  fi
  run check-types npm run -s check-types
  run lint npm run -s lint
  run_in types-webview webview-ui npx tsc -b
  run test-server npm run -s test:server
  run test-webview npm run -s test:webview
  run test-install node --test cld/install/*.test.mjs
  run test-core node --test core/src/*.test.mjs
  run test-bundle node --test cld/release/bundle/*.test.mjs
  run docs-check node cld/scripts/docs-check.mjs --root cld
}

run_browser_runner() {
  local name=$1
  local file="cld/test/${name}.ts"
  if [[ ! $name =~ ^run-[A-Za-z0-9-]+$ || ! -f $file ]]; then
    fail "browser-$name"
    return
  fi
  case "$name" in
    run-access|run-device-login|run-hw-panel|run-notices|run-t0021|run-terminal)
      run "browser-$name" npx tsx "$file" 18258 18259
      ;;
    run-office)
      run "browser-$name" npx tsx "$file" fake 18258 S-8 S-8 on integration
      ;;
    run-remote-setup)
      run "browser-$name" npx tsx "$file" 18256 18257
      ;;
    run-hw)
      skip "browser-$name" "requires an explicit LibreHardwareMonitor port"
      ;;
    *)
      run "browser-$name" npx tsx "$file" 18258
      ;;
  esac
}

case "$tier" in
  fast)
    [[ $# -le 1 ]] || usage
    run_fast "${1:-}"
    ;;
  integration)
    if [[ ${1:-} == run-* ]]; then
      browser_runners=("$@")
    else
      [[ $# -gt 0 ]] && shift
      browser_runners=("$@")
    fi
    run_integration
    for runner in "${browser_runners[@]}"; do
      run_browser_runner "$runner"
    done
    ;;
  release)
    [[ $# -le 1 ]] || usage
    run_integration
    run build-extension node esbuild.js
    run build-webview npm run -s build:webview
    run browser-all npx tsx cld/test/run-all.ts 18258 18259
    # run-all deliberately omits hardware sampling without an LHM endpoint.
    skip browser-run-hw "run-all requires --lhm-port to run it"
    if git checkout -q -- cld/artifacts && git clean -fdq -- cld/artifacts; then
      pass restore-artifacts
    else
      fail restore-artifacts
    fi
    ;;
esac

finish
