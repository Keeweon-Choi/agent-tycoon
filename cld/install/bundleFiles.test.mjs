import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { managerFiles } from '../release/bundle/managerFiles.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const SCRIPT_EXTENSIONS = ['.mjs', '.cjs', '.js'];
const RESOLVE_EXTENSIONS = ['', '.mjs', '.cjs', '.js'];

function specifiers(text) {
  const found = [];
  const add = (pattern) => {
    for (const match of text.matchAll(pattern)) found.push(match[2]);
  };
  add(/\bimport\s+(?:[^'";]*?\s+from\s+)?(['"])([^'"]+)\1/g);
  add(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g);
  add(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g);
  return found;
}

function resolved(root, file, specifier) {
  const base = path.resolve(root, path.dirname(file), specifier);
  return RESOLVE_EXTENSIONS.map((extension) => `${base}${extension}`).find((candidate) => fs.existsSync(candidate)) ?? base;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function missingDependencies(files) {
  const included = new Set(files);
  const missing = [];
  const check = (file, specifier) => {
    if (!specifier.startsWith('.')) return;
    const target = relative(root, resolved(root, file, specifier));
    if (!included.has(target) && target !== 'package.json')
      missing.push(`${file} imports ${specifier} (${target})`);
  };

  for (const file of files) {
    const absolute = path.join(root, file);
    const text = fs.readFileSync(absolute, 'utf8');
    const firstLine = text.slice(0, text.indexOf('\n'));
    if (SCRIPT_EXTENSIONS.includes(path.extname(file)) || (file.startsWith('cld/bin/') && /^#!.*\bnode\b/.test(firstLine)))
      for (const specifier of specifiers(text)) check(file, specifier);
    if (file.startsWith('cld/bin/') && /^#!.*\b(?:ba)?sh\b/.test(firstLine))
      for (const match of text.matchAll(/(?:\.\.\/)+core\/[\w./-]+/g)) check(file, match[0]);
  }
  return missing;
}

test('every manager import is included in the daemon bundle', () => {
  const missing = missingDependencies(managerFiles(root));
  assert.deepEqual(missing, [], `manager bundle misses dependencies:\n${missing.join('\n')}`);
});
