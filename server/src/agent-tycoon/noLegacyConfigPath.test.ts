import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './testHome.js';

const ROOTS = ['server/src', 'server/__tests__', 'webview-ui/src', 'agent-tycoon/install', 'agent-tycoon/bin', 'agent-tycoon/test', 'core'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const EXEMPT = new Set([
  'server/src/agent-tycoon/noLegacyConfigPath.test.ts',
  // the negative tests: each proves the old folder is not recognised
  'server/src/agent-tycoon/configPath.test.ts',
  'server/__tests__/claudeHookInstaller.test.ts',
  'agent-tycoon/install/install.test.mjs',
  'agent-tycoon/test/install/evidence.sh',
  'agent-tycoon/test/install/fake/daemon.cjs',
  'agent-tycoon/test/install/invariants.mjs',
]);
/** The pre-rename settings and state folders (`~/.config/cld-gui`, `~/.local/{state,share}/cld-gui`). */
const LEGACY_PATH = /(?:['"](?:\.config|state|share)['"]\s*,\s*['"]cld-gui['"]|(?:\.config|state|share)[\\/]cld-gui)/;

function* files(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile()) yield file;
  }
}

/** `file:line` for settings paths which bypass configDirectory. */
export function legacyConfigPathTraces(root = REPO_ROOT): string[] {
  const found: string[] = [];
  for (const sub of ROOTS) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const file of files(dir)) {
      const relative = path.relative(root, file);
      if (EXEMPT.has(relative) || fs.statSync(file).size > 2 * 1024 * 1024) continue;
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (LEGACY_PATH.test(line)) found.push(`${relative}:${i + 1}`);
      });
    }
  }
  return found;
}

describe('settings path resolver', () => {
  it('is the only scoped code that can name the legacy folder', () => {
    expect(legacyConfigPathTraces()).toEqual([]);
  });

  it('reports a bypass in a scanned tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-config-scan-'));
    try {
      fs.mkdirSync(path.join(root, 'agent-tycoon/install'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'agent-tycoon/install/a.mjs'),
        "path.join(home, '.config', 'cld-gui');\npath.join(home, '.local', 'state', 'cld-gui');\nconst f = '~/.local/share/cld-gui/hw.json';\n",
      );
      expect(legacyConfigPathTraces(root)).toEqual(['agent-tycoon/install/a.mjs:1', 'agent-tycoon/install/a.mjs:2', 'agent-tycoon/install/a.mjs:3']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
