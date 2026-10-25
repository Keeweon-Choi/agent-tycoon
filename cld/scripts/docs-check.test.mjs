import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs-check.mjs');
const frontMatter = (id, status = 'draft') => `---\nid: ${id}\ntitle: ${id}\nversion: 0.1\nstatus: ${status}\nupdated: 2026-10-21\n---\n`;

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-check-'));
  for (const [name, content] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  }
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
}

function cleanFiles({ stage = '1', testReference = true } = {}) {
  const requirement = '| FR-ORC-001 | orchestrate | ' + stage + ' | user | unit |\n';
  return {
    'docs/product/PRD.md': frontMatter('PRD') + '# PRD\n',
    'docs/requirements/SRS.md': frontMatter('SRS') + '# SRS\n\n| ID | 요구사항 | 단계 | 출처 | 검증 |\n|---|---|---|---|---|\n' + requirement,
    'docs/design/architecture.md': frontMatter('SAD') + '# Design\nFR-ORC-001\n',
    'docs/design/hub-porting.md': frontMatter('HPM') + '# Hub\n\n| 기능 | 설명 |\n|---|---|\n| a1 | mapped |\n| g | mapped |\n',
    'docs/test/test-plan.md': frontMatter('TP') + '# Tests\n' + (testReference ? 'FR-ORC-001\n' : ''),
    'docs/adr/0001-good.md': frontMatter('ADR-0001', 'accepted') + '# Decision\n',
    'docs/research/hub.md': '# Hub\n\n## (a)\n### a1. feature\n\n## (g)\n',
  };
}

test('clean minimal documentation fixture succeeds', () => {
  const result = run(fixture(cleanFiles()));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /docs-check: 0 errors, 0 warnings/);
});

test('duplicate requirement definition reports E3', () => {
  const files = cleanFiles();
  files['docs/requirements/SRS.md'] += '| FR-ORC-001 | again | 1 | user | unit |\n';
  const result = run(fixture(files));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E3/);
});

test('undefined requirement reference reports E4', () => {
  const files = cleanFiles();
  files['docs/product/PRD.md'] += 'FR-XYZ-999\n';
  const result = run(fixture(files));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E4/);
});

test('stage one coverage is an error and later-stage coverage is a warning', () => {
  let result = run(fixture(cleanFiles({ stage: '1', testReference: false })));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E5 .*no test reference/);
  result = run(fixture(cleanFiles({ stage: '2', testReference: false })));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /WARN W5 .*no test reference/);
});

test('broken links report E6 while links in fenced code are ignored', () => {
  const files = cleanFiles();
  files['docs/product/PRD.md'] += '[missing](missing.md)\n```md\n[ignored](also-missing.md)\n```\n';
  const result = run(fixture(files));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E6 .*missing\.md/);
  assert.doesNotMatch(result.stdout, /also-missing/);
});

test('invalid ADR status and filename/id mismatch report E7', () => {
  const files = cleanFiles();
  files['docs/adr/0001-good.md'] = frontMatter('ADR-0002', 'draft') + '# Decision\n';
  const result = run(fixture(files));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E7 .*id must be ADR-0001/);
  assert.match(result.stdout, /ERROR E7 .*invalid ADR status/);
});

test('missing hub feature mapping reports E8', () => {
  const files = cleanFiles();
  files['docs/design/hub-porting.md'] = frontMatter('HPM') + '| 기능 | 설명 |\n|---|---|\n| a1 | mapped |\n';
  const result = run(fixture(files));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E8 .*hub feature g is not mapped/);
});

test('front matter reports missing keys, duplicate ids, and missing superseded_by', () => {
  const files = cleanFiles();
  files['docs/product/PRD.md'] = '---\nid: PRD\ntitle: PRD\nstatus: draft\nupdated: 2026-10-21\n---\n';
  files['docs/design/duplicate.md'] = frontMatter('PRD') + '# duplicate\n';
  files['docs/design/old.md'] = frontMatter('OLD', 'superseded') + '# old\n';
  const result = run(fixture(files));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E1 .*missing required key version/);
  assert.match(result.stdout, /ERROR E2 .*duplicate document id PRD/);
  assert.match(result.stdout, /ERROR E1 .*superseded documents require superseded_by/);
});

test('write trace creates deterministic rows in SRS order', () => {
  const files = cleanFiles();
  files['docs/requirements/SRS.md'] += '| NFR-SEC-002 | secure | 2 | user | unit |\n';
  const root = fixture(files);
  let result = run(root, '--write-trace');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const trace = path.join(root, 'docs/requirements/traceability.md');
  const first = fs.readFileSync(trace, 'utf8');
  assert.match(first, /\| FR-ORC-001 \| 1 \| architecture\.md \| test-plan\.md \| OK \|/);
  assert.match(first, /\| NFR-SEC-002 \| 2 \| - \| - \| 설계·시험 누락 \|/);
  result = run(root, '--write-trace');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(trace, 'utf8'), first);
});

// Run a modified clean fixture; `change` mutates the file map in place.
function runWith(change, ...args) {
  const files = cleanFiles();
  change(files);
  return run(fixture(files), ...args);
}
const withFM = (id, status, extra = '') => frontMatter(id, status).replace(/\n---\n$/, `\n${extra}---\n`);

test('stage-one requirement without design reference reports E5', () => {
  const result = runWith((f) => { f['docs/design/architecture.md'] = frontMatter('SAD') + '# Design\n'; });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E5 .*no design reference/);
});

test('superseded design doc and fenced IDs do not count as design references', () => {
  let result = runWith((f) => {
    f['docs/design/architecture.md'] = frontMatter('SAD') + '# Design\n';
    f['docs/design/old.md'] = withFM('OLD', 'superseded', 'superseded_by: SAD\n') + 'FR-ORC-001\n';
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E5 .*no design reference/);
  result = runWith((f) => { f['docs/design/architecture.md'] = frontMatter('SAD') + '```\nFR-ORC-001\n```\n'; });
  assert.match(result.stdout, /ERROR E5 .*no design reference/);
});

test('undefined IDs in fenced code are ignored by E4', () => {
  const result = runWith((f) => { f['docs/product/PRD.md'] += '```\nFR-XYZ-999\n```\n'; });
  assert.equal(result.status, 0, result.stdout);
});

test('escaped pipe stays inside an SRS cell', () => {
  const result = runWith((f) => {
    f['docs/requirements/SRS.md'] += '| FR-ORC-002 | a \\| b | 1 | user | unit |\n';
    f['docs/design/architecture.md'] += 'FR-ORC-002\n';
    f['docs/test/test-plan.md'] += 'FR-ORC-002\n';
  });
  assert.equal(result.status, 0, result.stdout);
});

test('invalid stage value reports E3', () => {
  const result = runWith((f) => { f['docs/requirements/SRS.md'] += '| FR-ORC-004 | x | 5 | user | unit |\n'; });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E3 .*invalid stage 5/);
});

test('unexpected ADR-folder file warns W7; --strict turns warnings into exit 1', () => {
  const add = (f) => { f['docs/adr/notes.md'] = frontMatter('NOTES', 'accepted'); };
  let result = runWith(add);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /WARN W7 docs\/adr\/notes\.md/);
  result = runWith(add, '--strict');
  assert.equal(result.status, 1);
});

test('link anchors and queries are stripped before the existence check', () => {
  const result = runWith((f) => { f['docs/product/PRD.md'] += '[x](../design/architecture.md#sec) [y](../design/architecture.md?q=1) [z](nope.md#sec)\n'; });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E6 .*nope\.md#sec/);
  assert.doesNotMatch(result.stdout, /architecture/);
});

test('CRLF files are parsed like LF files', () => {
  const files = cleanFiles();
  files['docs/product/PRD.md'] += '[missing](zz.md)\n```\n[ignored](yy.md)\n```\n';
  for (const name of Object.keys(files)) files[name] = files[name].replaceAll('\n', '\r\n');
  const result = run(fixture(files));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /docs-check: 1 errors, 0 warnings/);
  assert.match(result.stdout, /ERROR E6 .*zz\.md/);
});

test('UTF-8 BOM before front matter is accepted', () => {
  const result = runWith((f) => { f['docs/product/PRD.md'] = '﻿' + f['docs/product/PRD.md']; });
  assert.equal(result.status, 0, result.stdout);
});

test('generated traceability.md and docs/research are excluded from E1 and E4', () => {
  const result = runWith((f) => {
    f['docs/requirements/traceability.md'] = frontMatter('TRC') + 'FR-BAD-003\n';
    f['docs/research/hub.md'] += 'FR-BAD-001\n';
    f['docs/research/notes.md'] = 'no front matter FR-BAD-002\n';
  });
  assert.equal(result.status, 0, result.stdout);
});

test('superseded_by must name another existing document', () => {
  for (const target of ['NOPE', 'OLD']) {
    const result = runWith((f) => { f['docs/design/old.md'] = withFM('OLD', 'superseded', `superseded_by: ${target}\n`) + '# old\n'; });
    assert.equal(result.status, 1, target);
    assert.match(result.stdout, /ERROR E1 docs\/design\/old\.md.* does not name a document/, target);
  }
  const result = runWith((f) => { f['docs/design/old.md'] = withFM('OLD', 'superseded', 'superseded_by: SAD\n') + '# old\n'; });
  assert.equal(result.status, 0, result.stdout);
});

test('duplicate ADR number reports E7', () => {
  const result = runWith((f) => { f['docs/adr/0001-other.md'] = frontMatter('ADR-0001', 'accepted'); });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR E7 .*ADR number 0001 is duplicated/);
});

test('hub-porting first cell with backticked ID and trailing text maps the ID', () => {
  const result = runWith((f) => { f['docs/design/hub-porting.md'] = frontMatter('HPM') + '| 기능 | 설명 |\n|---|---|\n| `a1` 설명 | m |\n| **g** | m |\n'; });
  assert.equal(result.status, 0, result.stdout);
});

test('a repeated hub group heading does not turn the group into a bare-letter feature', () => {
  const result = runWith((f) => { f['docs/research/hub.md'] = '## (a)\n### a1. feature\n\n## (a)\n\n## (g)\n'; });
  assert.equal(result.status, 0, result.stdout);
});
