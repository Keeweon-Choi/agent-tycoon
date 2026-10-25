/**
 * T-0033b (user 10-22 19:59: "배포할 때 오피스 타이쿤 안에는 Hub 관련 코드, 설정은 다 없어야돼"):
 * the shipped code never runs `hub`, reads hub's files, takes a `--hub` flag or answers a hub action.
 * Scans server/src, webview-ui/src, cld/install, cld/bin and core/ (not cld/tasks, which are internal
 * notes); this file is the one place that names the patterns.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './testHome.js';

const ROOTS = ['server/src', 'webview-ui/src', 'cld/install', 'cld/bin', 'core'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const MAX_BYTES = 2 * 1024 * 1024;

/** What must not appear: hub's files, running `hub`, its flag and its client API. */
export const FORBIDDEN: Array<{ id: string; re: RegExp }> = [
  { id: 'hub-word', re: /(?<![A-Za-z])hub/i },
  { id: 'hub-bin-path', re: /\.local\/bin\/hub/ },
  { id: 'hub-data-path', re: /\.local\/share\/hub/ },
  { id: 'hub-spawn', re: /\b(?:spawn|exec|execFile|fork)\w*\(\s*['"`]hub['"`]/ },
  { id: 'hub-argv', re: /['"`]hub['"`]\s*,\s*\[/ },
  { id: 'hub-flag', re: /--hub\b/ },
  { id: 'HubCli', re: /HubCli/ },
  { id: 'hubAction', re: /hubAction|HubAction/ },
  { id: 'hub-ops-restart', re: /hub-ops restart/ },
];

/** The ids of every forbidden pattern a text matches. */
export function hubTraces(text: string): string[] {
  return FORBIDDEN.filter(({ re }) => re.test(text)).map(({ id }) => id);
}

function* files(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile()) yield file;
  }
}

/** `file:line [id]` for every trace in the scanned trees. */
export function scan(root = REPO_ROOT): string[] {
  const self = path.join(root, 'server/src/cld/noHub.test.ts');
  const found: string[] = [];
  for (const sub of ROOTS) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const file of files(dir)) {
      if (
        file === self ||
        path.relative(root, file) === 'webview-ui/src/changelogData.ts' ||
        fs.statSync(file).size > MAX_BYTES
      ) continue;
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8192).includes(0)) continue; // a binary
      buf
        .toString('utf-8')
        .split('\n')
        .forEach((line, i) => {
          for (const id of hubTraces(line))
            found.push(`${path.relative(root, file)}:${i + 1} [${id}]`);
        });
    }
  }
  return found;
}

describe('no hub in the tycoon', () => {
  it('the shipped trees hold no hub path, spawn, flag or action', () => {
    expect(scan()).toEqual([]);
  });

  it('the patterns do catch each trace (negative control)', () => {
    expect(hubTraces("spawn('hub', ['version'])")).toEqual(expect.arrayContaining(['hub-spawn', 'hub-word']));
    expect(hubTraces('execFileSync(`hub`, args)')).toEqual(expect.arrayContaining(['hub-spawn', 'hub-word']));
    expect(hubTraces("run('hub', ['ls'])")).toEqual(expect.arrayContaining(['hub-argv', 'hub-word']));
    expect(hubTraces('path.join(home, ".local/bin/hub")')).toEqual(expect.arrayContaining(['hub-bin-path', 'hub-word']));
    expect(hubTraces('~/.local/share/hub/run/hw.json')).toEqual(expect.arrayContaining(['hub-data-path', 'hub-word']));
    expect(hubTraces("argv[i] === '--hub'")).toEqual(expect.arrayContaining(['hub-flag', 'hub-word']));
    expect(hubTraces('new HubCli()')).toEqual(expect.arrayContaining(['HubCli', 'hub-word']));
    expect(hubTraces("msg.type === 'hubAction'")).toEqual(expect.arrayContaining(['hubAction', 'hub-word']));
    expect(hubTraces('type HubActionKind')).toEqual(expect.arrayContaining(['hubAction', 'hub-word']));
    expect(hubTraces('hub-ops restart')).toEqual(expect.arrayContaining(['hub-ops-restart', 'hub-word']));
    expect(hubTraces('const hubX = 1')).toContain('hub-word');
    expect(hubTraces('// the old Hub panel')).toContain('hub-word');
    expect(hubTraces('github.com')).toEqual([]);
    expect(hubTraces('GitHubIcon')).toEqual([]);
  });

  it('a trace planted in a scanned tree is reported with its file and line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-nohub-'));
    try {
      fs.mkdirSync(path.join(root, 'cld/install'), { recursive: true });
      fs.writeFileSync(path.join(root, 'cld/install/a.mjs'), "ok\nspawn('hub', ['version']);\n");
      fs.mkdirSync(path.join(root, 'cld/tasks'), { recursive: true });
      fs.writeFileSync(path.join(root, 'cld/tasks/note.md'), 'spawn(`hub`, [])\n');
      expect(scan(root)).toEqual([
        'cld/install/a.mjs:2 [hub-word]',
        'cld/install/a.mjs:2 [hub-spawn]',
        'cld/install/a.mjs:2 [hub-argv]',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
