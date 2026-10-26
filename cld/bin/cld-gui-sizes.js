'use strict';

// `cld-gui doctor`'s "data sizes" (U-42): read-only. The numbers repeat
// server/src/cld/engine/logPolicy.ts (the daemon does the pruning);
// logPrune.test.ts keeps the two in step.
const fs = require('fs');
const path = require('path');
const { configDirectory } = require('../../core/src/cld/configPath.cjs');

const LOG_KEEP_DAYS = 30;
const LOG_DIR_CAP_BYTES = 1024 ** 3;
const EVENTS_ROTATE_BYTES = 5 * 1024 * 1024;

/** Bytes of the plain files under `dir` (recursive, no symlinks followed); 0 when it is missing. */
function treeBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) total += treeBytes(file);
    else if (e.isFile()) { try { total += fs.statSync(file).size; } catch { /* gone */ } }
  }
  return total;
}
function fileBytes(file) { try { return fs.statSync(file).size; } catch { return 0; } }

function stateDir(platform, home, env = process.env) {
  return platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cld-gui')
    : path.join(home, '.local', 'state', 'cld-gui');
}

/** One row per data category: { name, bytes, rule }. */
function dataSizes(home, platform = process.platform, env = process.env) {
  const state = stateDir(platform, home, env);
  const conf = configDirectory(home);
  const events = fileBytes(path.join(conf, 'events.jsonl')) + fileBytes(path.join(conf, 'events.jsonl.1'));
  const daemon = fileBytes(path.join(conf, 'daemon.log')) + fileBytes(path.join(conf, 'daemon.log.1'));
  const mb = (n) => Math.round(n / 1024 / 1024);
  const prune = `끝난 것은 ${LOG_KEEP_DAYS}일 뒤, 폴더가 ${LOG_DIR_CAP_BYTES / 1024 ** 3} GiB 를 넘으면 오래된 것부터 데몬이 지운다`;
  return [
    { name: '작업 로그', bytes: treeBytes(path.join(state, 'jobs')), rule: `${prune}; 실행 중인 작업은 건드리지 않는다` },
    { name: 'Codex 로그', bytes: treeBytes(path.join(state, 'codex')), rule: prune },
    { name: '이벤트 기록', bytes: events, rule: `${mb(EVENTS_ROTATE_BYTES)} MB 에서 순환하고 이전 파일 1개를 둔다 (events.jsonl.1)` },
    { name: '데몬 로그', bytes: daemon, rule: `시작할 때 ${mb(EVENTS_ROTATE_BYTES)} MB 가 넘으면 순환하고 이전 파일 1개를 둔다` },
    {
      name: '대화·받은편지·에이전트·설정',
      bytes: Math.max(0, treeBytes(conf) - events - daemon) + treeBytes(path.join(home, '.pixel-agents')),
      rule: '사용자 데이터라 자동으로 지우지 않는다 (크기만 알린다)',
    },
    { name: 'H/W 모니터링 기록', bytes: 0, rule: '디스크에 쓰지 않는다 (화면 메모리에 최근 40개 표본만)' },
  ];
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function sizeLines(rows) {
  return ['데이터 크기:', ...rows.map((r) => `  ${r.name}: ${formatBytes(r.bytes)} · ${r.rule}`)];
}

module.exports = { dataSizes, sizeLines, formatBytes, LOG_KEEP_DAYS, LOG_DIR_CAP_BYTES, EVENTS_ROTATE_BYTES };
