#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIREMENT = /\b(?:(?:FR|NFR|IR)-[A-Z]{2,5}-\d{3}|CON-\d{3})\b/g;
const REQUIRED_KEYS = ['id', 'title', 'version', 'status', 'updated'];
const NORMAL_STATUSES = new Set(['draft', 'review', 'approved', 'superseded']);
const ADR_STATUSES = new Set(['proposed', 'accepted', 'rejected', 'superseded']);
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(args) {
  let root = DEFAULT_ROOT;
  let writeTrace = false;
  let strict = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root' && args[index + 1]) root = path.resolve(args[++index]);
    else if (args[index] === '--write-trace') writeTrace = true;
    else if (args[index] === '--strict') strict = true;
    else throw new Error(`unknown option: ${args[index]}`);
  }
  return { root, writeTrace, strict };
}

function walkMarkdown(directory, root) {
  if (!fs.existsSync(directory)) return [];
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkMarkdown(filename, root);
    return entry.isFile() && entry.name.endsWith('.md') ? [path.relative(root, filename).replaceAll(path.sep, '/')] : [];
  });
}

function unquote(value) {
  const trimmed = value.trim();
  return (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1) : trimmed;
}

function frontMatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { lines, data: null, end: 0 };
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end === -1) return { lines, data: null, end: 0 };
  const data = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (match) data[match[1].trim()] = unquote(match[2]);
  }
  return { lines, data, end: end + 1 };
}

function markdownCells(line) {
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const character of line.trim()) {
    if (escaped) { cell += character; escaped = false; }
    else if (character === '\\') escaped = true;
    else if (character === '|') { cells.push(cell); cell = ''; }
    else cell += character;
  }
  if (escaped) cell += '\\';
  cells.push(cell);
  if (line.trimStart().startsWith('|')) cells.shift();
  if (line.trimEnd().endsWith('|')) cells.pop();
  return cells;
}

function plainCell(value) {
  let result = value.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of ['`', '**']) {
      if (result.startsWith(marker) && result.endsWith(marker) && result.length >= marker.length * 2) {
        result = result.slice(marker.length, -marker.length).trim();
        changed = true;
      }
    }
  }
  return result;
}

function isFenced(line, fenced) {
  return /^\s*```/.test(line) ? !fenced : fenced;
}

function idsIn(text) {
  return [...text.matchAll(REQUIREMENT)].map((match) => match[0]);
}

function outsideFences(lines) {
  let fenced = false;
  return lines.filter((line) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return false; }
    return !fenced;
  }).join('\n');
}

function linkTargets(line) {
  const links = /\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  return [...line.matchAll(links)].map((match) => match[1] ?? match[2]);
}

function rel(root, filename) {
  return path.relative(root, filename).replaceAll(path.sep, '/');
}

function check(root, options = {}) {
  const findings = [];
  const add = (level, code, file, line, message) => findings.push({ level, code, file, line, message });
  const docsDirectory = path.join(root, 'docs');
  const files = walkMarkdown(docsDirectory, root);
  const excludedFrontMatter = (file) => file.startsWith('docs/research/') || file === 'docs/CHANGELOG.md' || file === 'docs/adr/template.md';
  const excludedReferences = (file) => file.startsWith('docs/research/') || file === 'docs/adr/template.md' || file === 'docs/requirements/traceability.md';
  const documents = new Map();

  for (const file of files) {
    const filename = path.join(root, file);
    const parsed = frontMatter(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    documents.set(file, { ...parsed, filename });
    if (excludedFrontMatter(file)) continue;
    if (!parsed.data) {
      add('ERROR', 'E1', file, 1, 'missing or unterminated front matter');
      continue;
    }
    for (const key of REQUIRED_KEYS) if (!parsed.data[key]) add('ERROR', 'E1', file, 1, `missing required key ${key}`);
    if (parsed.data.version && !/^\d+\.\d+$/.test(parsed.data.version)) add('ERROR', 'E1', file, 1, 'version must be MAJOR.MINOR');
    if (parsed.data.updated && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.data.updated)) add('ERROR', 'E1', file, 1, 'updated must be YYYY-MM-DD');
    const allowed = file.startsWith('docs/adr/') ? ADR_STATUSES : NORMAL_STATUSES;
    if (parsed.data.status && !allowed.has(parsed.data.status)) add('ERROR', 'E1', file, 1, 'invalid status');
    if (parsed.data.status === 'superseded' && !parsed.data.superseded_by) add('ERROR', 'E1', file, 1, 'superseded documents require superseded_by');
  }

  const ids = new Map();
  for (const [file, document] of documents) {
    if (excludedFrontMatter(file) || !document.data?.id) continue;
    if (!ids.has(document.data.id)) ids.set(document.data.id, []);
    ids.get(document.data.id).push(file);
  }
  for (const [id, names] of ids) if (names.length > 1) for (const file of names) add('ERROR', 'E2', file, 1, `duplicate document id ${id}`);
  for (const [file, document] of documents) {
    if (excludedFrontMatter(file) || document.data?.status !== 'superseded' || !document.data.superseded_by) continue;
    if (!ids.has(document.data.superseded_by) || document.data.superseded_by === document.data.id) add('ERROR', 'E1', file, 1, `superseded_by ${document.data.superseded_by} does not name a document`);
  }

  const srsFile = 'docs/requirements/SRS.md';
  const definitions = new Map();
  let definitionOrder = [];
  const srs = documents.get(srsFile);
  if (!srs) {
    add('WARN', 'W3', srsFile, null, 'missing');
  } else {
    let fenced = false;
    for (let index = 0; index < srs.lines.length; index += 1) {
      const line = srs.lines[index];
      if (/^\s*```/.test(line)) { fenced = isFenced(line, fenced); continue; }
      if (fenced || !line.trimStart().startsWith('|')) continue;
      const cells = markdownCells(line);
      const id = plainCell(cells[0] ?? '');
      if (!/^((?:FR|NFR|IR)-[A-Z]{2,5}-\d{3}|CON-\d{3})$/.test(id)) continue;
      const definition = { id, stage: plainCell(cells[2] ?? ''), line: index + 1 };
      if (!definitions.has(id)) definitions.set(id, []);
      definitions.get(id).push(definition);
      definitionOrder.push(definition);
      if (!['1', '2', '3', '4', '-'].includes(definition.stage)) add('ERROR', 'E3', srsFile, index + 1, `${id} has invalid stage ${definition.stage || '(empty)'}`);
    }
    for (const [id, entries] of definitions) if (entries.length > 1) for (const entry of entries) add('ERROR', 'E3', srsFile, entry.line, `${id} is defined more than once`);

    const definedIds = new Set(definitions.keys());
    for (const [file, document] of documents) {
      if (excludedReferences(file)) continue;
      let insideFence = false;
      for (let index = 0; index < document.lines.length; index += 1) {
        const line = document.lines[index];
        if (/^\s*```/.test(line)) { insideFence = isFenced(line, insideFence); continue; }
        if (insideFence) continue;
        let searchable = line;
        if (file === srsFile && line.trimStart().startsWith('|') && /^((?:FR|NFR|IR)-[A-Z]{2,5}-\d{3}|CON-\d{3})$/.test(plainCell(markdownCells(line)[0] ?? ''))) {
          searchable = line.replace(/^\s*\|(?:\\.|[^|])*/, '');
        }
        for (const id of idsIn(searchable)) if (!definedIds.has(id)) add('ERROR', 'E4', file, index + 1, `${id} is not defined in SRS`);
      }
    }

    for (const entry of definitionOrder) {
      if (entry.stage === '-') continue;
      const designFiles = [...documents].filter(([file, document]) => file.startsWith('docs/design/') && document.data?.status !== 'superseded' && idsIn(outsideFences(document.lines)).includes(entry.id)).map(([file]) => file);
      const test = documents.get('docs/test/test-plan.md');
      const testRefs = test ? idsIn(outsideFences(test.lines)).includes(entry.id) : false;
      const level = entry.stage === '1' ? 'ERROR' : 'WARN';
      const code = entry.stage === '1' ? 'E5' : 'W5';
      if (!designFiles.length) add(level, code, srsFile, entry.line, `${entry.id} has no design reference`);
      if (!testRefs) add(level, code, srsFile, entry.line, `${entry.id} has no test reference`);
    }
  }

  for (const [file, document] of documents) {
    let fenced = false;
    for (let index = 0; index < document.lines.length; index += 1) {
      const line = document.lines[index];
      if (/^\s*```/.test(line)) { fenced = isFenced(line, fenced); continue; }
      if (fenced) continue;
      for (const target of linkTargets(line)) {
        if (/^(?:https?:\/\/|mailto:|#)/.test(target)) continue;
        const clean = target.split(/[?#]/, 1)[0];
        let decoded;
        try { decoded = decodeURIComponent(clean); } catch { decoded = clean; }
        if (!fs.existsSync(path.resolve(path.dirname(document.filename), decoded))) add('ERROR', 'E6', file, index + 1, `link target ${target} does not exist`);
      }
    }
  }

  const adrNumbers = new Map();
  const adrIds = new Set([...documents.entries()].filter(([file]) => /^docs\/adr\/\d{4}-[a-z0-9-]+\.md$/.test(file)).map(([, document]) => document.data?.id).filter(Boolean));
  for (const [file, document] of documents) {
    if (!file.startsWith('docs/adr/')) continue;
    const match = /^docs\/adr\/(\d{4})-[a-z0-9-]+\.md$/.exec(file);
    if (!match) { if (file !== 'docs/adr/template.md') add('WARN', 'W7', file, null, 'unexpected ADR file'); continue; }
    const expected = `ADR-${match[1]}`;
    if (document.data?.id !== expected) add('ERROR', 'E7', file, 1, `id must be ${expected}`);
    if (!ADR_STATUSES.has(document.data?.status)) add('ERROR', 'E7', file, 1, 'invalid ADR status');
    if (!adrNumbers.has(match[1])) adrNumbers.set(match[1], []);
    adrNumbers.get(match[1]).push(file);
    if (document.data?.status === 'superseded' && !adrIds.has(document.data.superseded_by)) add('ERROR', 'E7', file, 1, 'superseded_by must name an ADR');
  }
  for (const [number, names] of adrNumbers) if (names.length > 1) for (const file of names) add('ERROR', 'E7', file, 1, `ADR number ${number} is duplicated`);

  const hub = documents.get('docs/research/hub.md');
  const porting = documents.get('docs/design/hub-porting.md');
  if (!hub) add('WARN', 'W8', 'docs/research/hub.md', null, 'missing');
  else if (!porting) add('ERROR', 'E8', 'docs/design/hub-porting.md', null, 'missing');
  else {
    const source = [];
    let group = null;
    const groups = new Map();
    for (const line of hub.lines) {
      const groupMatch = /^## \(([a-i])\)/.exec(line);
      if (groupMatch) { group = groupMatch[1]; if (!groups.has(group)) groups.set(group, false); }
      const feature = /^### ([a-i]\d+)\./.exec(line);
      if (feature) { source.push(feature[1]); if (group) groups.set(group, true); }
    }
    for (const [letter, hasFeatures] of groups) if (!hasFeatures) source.push(letter);
    const covered = new Set(porting.lines.filter((line) => line.trimStart().startsWith('|')).map((line) => plainCell(plainCell(markdownCells(line)[0] ?? '').split(/\s+/, 1)[0])));
    for (const id of source) if (!covered.has(id)) add('ERROR', 'E8', 'docs/design/hub-porting.md', null, `hub feature ${id} is not mapped`);
  }
  return { findings, definitions: definitionOrder, documents, srs };
}

function writeTrace(root) {
  const result = check(root);
  if (!result.srs?.data) return;
  const lines = [
    '---', 'id: TRC', 'title: 요구사항 추적표', `version: ${result.srs.data.version ?? ''}`, `status: ${result.srs.data.status ?? ''}`, `updated: ${result.srs.data.updated ?? ''}`, 'owner: scripts/docs-check.mjs', '---', '', '# 요구사항 추적표', '', '이 파일은 `node cld/scripts/docs-check.mjs --write-trace`가 만든다. 손으로 고치지 않는다.', '', '| ID | 단계 | 설계 문서 | 시험 계획 | 상태 |', '|---|---|---|---|---|',
  ];
  for (const entry of result.definitions) {
    const designs = [...result.documents].filter(([file, document]) => file.startsWith('docs/design/') && document.data?.status !== 'superseded' && idsIn(outsideFences(document.lines)).includes(entry.id)).map(([file]) => path.basename(file)).sort();
    const test = result.documents.get('docs/test/test-plan.md');
    const tests = test && idsIn(outsideFences(test.lines)).includes(entry.id) ? ['test-plan.md'] : [];
    const state = entry.stage === '-' ? '삭제' : designs.length && tests.length ? 'OK' : designs.length ? '시험 누락' : tests.length ? '설계 누락' : '설계·시험 누락';
    lines.push(`| ${entry.id} | ${entry.stage} | ${designs.join(', ') || '-'} | ${tests.join(', ') || '-'} | ${state} |`);
  }
  fs.mkdirSync(path.join(root, 'docs', 'requirements'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'requirements', 'traceability.md'), `${lines.join('\n')}\n`);
}

function format(finding) {
  return `${finding.level} ${finding.code} ${finding.file}${finding.line ? `:${finding.line}` : ''} ${finding.message}`;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.writeTrace) writeTrace(options.root);
  const { findings } = check(options.root);
  for (const finding of findings) console.log(format(finding));
  const errors = findings.filter((finding) => finding.level === 'ERROR').length;
  const warnings = findings.filter((finding) => finding.level === 'WARN').length;
  console.log(`docs-check: ${errors} errors, ${warnings} warnings`);
  process.exitCode = errors || (options.strict && warnings) ? 1 : 0;
} catch (error) {
  console.error(`ERROR E0 ${error.message}`);
  process.exitCode = 1;
}
