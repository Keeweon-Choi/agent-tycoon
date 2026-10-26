'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { CLI_NAME } = require('./cld-brand');
const { configDirectory } = require('../../core/src/cld/configPath.cjs');

const BACKUP_FORMAT = 'agent-tycoon-backup';
const BACKUP_VERSION = 1;
const MAX_FILE_SIZE = 32 * 1024 * 1024;
const MAX_EVENTS_SIZE = 8 * 1024 * 1024;
const ALLOW_LIST = Object.freeze([
  'projects.json', 'assignments.json', 'tasks.json', 'groups/**', 'memos.json', 'pins.json',
  'levels.json', 'characters.json', 'characters/**', 'building.json', 'decor.json',
  'worktrees.json', 'job-history.json', 'rules-engine.md', 'events.jsonl',
  'pixel-agents/layout.json',
]);

const CONFIG_FILES = new Set(ALLOW_LIST.filter((name) => !name.endsWith('/**') && !name.startsWith('pixel-agents/')));
const CONFIG_TREES = ['groups/', 'characters/'];
let temporaryNumber = 0;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function timestamp(now, withSeconds = false) {
  const date = new Date(now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${withSeconds ? pad(date.getSeconds()) : ''}`;
}

function realDeps(overrides = {}) {
  const home = overrides.home ?? os.homedir();
  return {
    fs,
    home,
    cwd: process.cwd(),
    hostname: os.hostname(),
    now: () => Date.now(),
    daemonRunning: async () => {
      let port = 18240;
      try {
        const config = JSON.parse(fs.readFileSync(path.join(configDirectory(home), 'config.json'), 'utf8'));
        if (Number.isInteger(config.port)) port = config.port;
      } catch { /* use the normal port */ }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
      } catch { return false; }
    },
    ...overrides,
  };
}

function isAllowedPath(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) return false;
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return false;
  if (relative === 'pixel-agents/layout.json') return true;
  return CONFIG_FILES.has(relative) || CONFIG_TREES.some((prefix) => relative.startsWith(prefix) && relative.length > prefix.length);
}

function archivePath(home, relative) {
  if (relative === 'pixel-agents/layout.json') return path.join(home, '.pixel-agents', 'layout.json');
  return path.join(configDirectory(home), ...relative.split('/'));
}

function regularFile(deps, file) {
  try { return deps.fs.lstatSync(file).isFile(); } catch { return false; }
}

function filesUnder(deps, base, prefix) {
  const found = [];
  let names;
  try { names = deps.fs.readdirSync(base); } catch { return found; }
  for (const name of names.sort()) {
    const file = path.join(base, name);
    let stat;
    try { stat = deps.fs.lstatSync(file); } catch { continue; }
    if (stat.isDirectory()) found.push(...filesUnder(deps, file, `${prefix}${name}/`));
    else if (stat.isFile()) found.push({ relative: `${prefix}${name}`, file, size: stat.size });
  }
  return found;
}

function allowedFiles(deps) {
  const found = [];
  const config = configDirectory(deps.home);
  for (const relative of [...CONFIG_FILES, 'pixel-agents/layout.json']) {
    const file = archivePath(deps.home, relative);
    if (!regularFile(deps, file)) continue;
    const size = deps.fs.lstatSync(file).size;
    if (size > MAX_FILE_SIZE && relative !== 'events.jsonl') continue;
    found.push({ relative, file, size });
  }
  for (const prefix of CONFIG_TREES) found.push(...filesUnder(deps, path.join(config, prefix.slice(0, -1)), prefix));
  return found.filter((entry) => entry.size <= MAX_FILE_SIZE).sort((a, b) => a.relative.localeCompare(b.relative));
}

function temporaryPath(file) {
  temporaryNumber += 1;
  return path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${temporaryNumber}`);
}

function writeAtomic(deps, file, data, mode = 0o600) {
  const temp = temporaryPath(file);
  try {
    deps.fs.writeFileSync(temp, data, { mode });
    deps.fs.chmodSync(temp, mode);
    deps.fs.renameSync(temp, file);
    deps.fs.chmodSync(file, mode);
  } catch (error) {
    try { deps.fs.unlinkSync(temp); } catch { /* temporary file is already absent */ }
    throw error;
  }
}

function parseBackupArgs(argv) {
  const args = [...argv];
  let out = null;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--out' && args.length) out = args.shift();
    else return { error: `사용법: ${CLI_NAME} backup [--out <파일>]` };
  }
  return { out };
}

function parseRestoreArgs(argv) {
  const args = [...argv];
  let yes = false;
  let file = null;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--yes') yes = true;
    else if (!file) file = arg;
    else return { error: `사용법: ${CLI_NAME} restore <파일> [--yes]` };
  }
  return file ? { file, yes } : { error: `사용법: ${CLI_NAME} restore <파일> [--yes]` };
}

function backup(dependencies = {}, options = {}) {
  const deps = realDeps(dependencies);
  const destination = options.out ? path.resolve(deps.cwd, options.out) : path.join(deps.cwd, `agent-tycoon-backup-${timestamp(deps.now)}.json.gz`);
  const files = {};
  const skipped = [];
  for (const entry of allowedFiles(deps)) {
    if (entry.relative === 'events.jsonl' && entry.size > MAX_EVENTS_SIZE) {
      skipped.push('events.jsonl 은 8 MB를 넘어 건너뛰었습니다');
      continue;
    }
    const data = deps.fs.readFileSync(entry.file);
    files[entry.relative] = { sha256: sha256(data), size: data.length, data: data.toString('base64') };
  }
  const archive = {
    format: BACKUP_FORMAT,
    v: BACKUP_VERSION,
    createdAt: new Date(deps.now()).toISOString(),
    host: deps.hostname,
    files,
    sha256: sha256(canonicalJson(files)),
  };
  writeAtomic(deps, destination, zlib.gzipSync(Buffer.from(JSON.stringify(archive))), 0o600);
  const size = Object.values(files).reduce((sum, file) => sum + file.size, 0);
  return { ok: true, file: destination, files: Object.keys(files).length, size, skipped, lines: [...skipped, `${path.basename(destination)}: ${Object.keys(files).length}개 파일, ${size} bytes`] };
}

function verifyArchive(deps, archiveFile) {
  let parsed;
  try { parsed = JSON.parse(zlib.gunzipSync(deps.fs.readFileSync(archiveFile)).toString('utf8')); } catch { throw new Error('백업 파일을 읽을 수 없습니다'); }
  if (!parsed || parsed.format !== BACKUP_FORMAT || parsed.v !== BACKUP_VERSION || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files))
    throw new Error('지원하지 않는 백업 형식입니다');
  const files = Object.entries(parsed.files);
  for (const [relative, entry] of files) {
    if (!isAllowedPath(relative)) throw new Error(`허용되지 않은 경로입니다: ${relative}`);
    if (!entry || typeof entry !== 'object' || typeof entry.sha256 !== 'string' || !Number.isInteger(entry.size) || entry.size < 0 || typeof entry.data !== 'string')
      throw new Error(`파일 정보가 올바르지 않습니다: ${relative}`);
    const data = Buffer.from(entry.data, 'base64');
    if (data.toString('base64') !== entry.data || data.length !== entry.size || data.length > MAX_FILE_SIZE || (relative === 'events.jsonl' && data.length > MAX_EVENTS_SIZE) || sha256(data) !== entry.sha256)
      throw new Error(`파일 검증에 실패했습니다: ${relative}`);
  }
  if (typeof parsed.sha256 !== 'string' || sha256(canonicalJson(parsed.files)) !== parsed.sha256) throw new Error('백업 전체 검증에 실패했습니다');
  return files.map(([relative, entry]) => ({ relative, data: Buffer.from(entry.data, 'base64') }));
}

function safeExistingTarget(deps, file) {
  try {
    const stat = deps.fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`일반 파일이 아닌 대상입니다: ${file}`);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function checkSafeDirectory(deps, directory) {
  let cursor = directory;
  while (true) {
    try {
      if (!deps.fs.lstatSync(cursor).isDirectory()) throw new Error(`안전하지 않은 폴더입니다: ${cursor}`);
      return;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
      } else throw error;
    }
  }
}

function ensureSafeDirectory(deps, directory) {
  checkSafeDirectory(deps, directory);
  const missing = [];
  let cursor = directory;
  while (true) {
    try {
      deps.fs.lstatSync(cursor);
      break;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      missing.push(cursor);
      cursor = path.dirname(cursor);
    }
  }
  for (const next of missing.reverse()) deps.fs.mkdirSync(next, { mode: 0o700 });
}

function restoreSaved(deps, saved, written) {
  for (const file of written) {
    try { deps.fs.unlinkSync(file); } catch { /* absent target needs no cleanup */ }
  }
  for (const entry of saved) {
    try {
      ensureSafeDirectory(deps, path.dirname(entry.target));
      deps.fs.copyFileSync(entry.saved, entry.target);
      deps.fs.chmodSync(entry.target, entry.mode);
    } catch { /* report the original write failure */ }
  }
}

async function restore(dependencies = {}, options = {}) {
  const deps = realDeps(dependencies);
  if (await deps.daemonRunning()) return { ok: false, error: 'cld-gui 를 멈춘 뒤 다시 하세요' };
  let files;
  try { files = verifyArchive(deps, options.file); } catch (error) { return { ok: false, error: error.message }; }
  const targets = files.map((entry) => ({ ...entry, target: archivePath(deps.home, entry.relative) }));
  try {
    for (const entry of targets) {
      checkSafeDirectory(deps, path.dirname(entry.target));
      entry.existed = safeExistingTarget(deps, entry.target);
    }
  } catch (error) { return { ok: false, error: error.message }; }
  if (!options.yes) return {
    ok: true,
    preview: true,
    files: targets.length,
    lines: [...targets.map((target) => `바꿀 파일: ${target.relative}`), `${targets.length}개 파일을 바꿉니다. 실행하려면 --yes를 붙이세요.`],
  };

  const savedDirectory = path.join(configDirectory(deps.home), `restore-saved-${timestamp(deps.now, true)}`);
  const saved = [];
  try {
    ensureSafeDirectory(deps, savedDirectory);
    for (const entry of targets.filter((target) => target.existed)) {
      const savedFile = path.join(savedDirectory, ...entry.relative.split('/'));
      ensureSafeDirectory(deps, path.dirname(savedFile));
      deps.fs.copyFileSync(entry.target, savedFile);
      deps.fs.chmodSync(savedFile, 0o600);
      saved.push({ target: entry.target, saved: savedFile, mode: deps.fs.statSync(entry.target).mode & 0o777 });
    }
  } catch (error) { return { ok: false, error: error.message }; }

  const written = [];
  try {
    for (const entry of targets) {
      ensureSafeDirectory(deps, path.dirname(entry.target)); // a fresh install (after uninstall --reset) has no groups/ or characters/ yet
      writeAtomic(deps, entry.target, entry.data, 0o600);
      written.push(entry.target);
    }
  } catch (error) {
    restoreSaved(deps, saved, written);
    return { ok: false, error: error.message, savedDirectory };
  }
  return { ok: true, files: targets.length, savedDirectory, lines: [`저장한 원본: ${savedDirectory}`] };
}

module.exports = {
  ALLOW_LIST, BACKUP_FORMAT, BACKUP_VERSION, MAX_EVENTS_SIZE, MAX_FILE_SIZE,
  allowedFiles, backup, canonicalJson, isAllowedPath, parseBackupArgs, parseRestoreArgs,
  realDeps, restore, verifyArchive,
};
