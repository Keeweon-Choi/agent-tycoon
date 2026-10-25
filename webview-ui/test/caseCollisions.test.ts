import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

const gitLsFiles = (): string => {
  try {
    return execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8' });
  } catch (error) {
    const result = error as { status?: number; stdout?: string };
    if (result.status === 0 && typeof result.stdout === 'string') return result.stdout;
    throw error;
  }
};

const trackedSourceFiles = (): string[] =>
  gitLsFiles()
    .split('\0')
    .filter((file) => sourceExtensions.has(path.extname(file)));

const caseInsensitiveCollisions = (files: string[]): string[][] => {
  const filesByModuleName = new Map<string, string[]>();

  for (const file of files) {
    const extension = path.extname(file);
    const moduleName = path.join(path.dirname(file), path.basename(file, extension)).toLowerCase();
    const matches = filesByModuleName.get(moduleName) ?? [];
    matches.push(file);
    filesByModuleName.set(moduleName, matches);
  }

  return [...filesByModuleName.values()].filter((matches) => matches.length > 1);
};

describe('tracked source files', () => {
  it('has no module names that differ only by case', () => {
    const collisions = caseInsensitiveCollisions(trackedSourceFiles());
    const pairs = collisions.map((matches) => matches.join(' <-> ')).join('\n');

    expect(collisions, `Case-insensitive module-name collisions:\n${pairs}`).toEqual([]);
  });
});
