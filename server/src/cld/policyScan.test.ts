/**
 * NFR-CMP-009 / ADR-0014 (TC-168): the product ships mechanisms; the policies
 * (a rules file, model assignments, GPU budgets, CPU pinning, this PC's
 * tab and project names) are the user's to bring. This scan fails when one of
 * those markers shows up in our code (ADR-0011, ADR-0014 item 4).
 *
 * A marker that is fine somewhere goes in ALLOWED with the reason; the list is
 * short on purpose. Tests and fixtures name what they forbid, so they are exempt.
 * Upstream pixel-agents code is not ours to scan (its Claude provider knows model
 * names by design), only the fork's own files are.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { REPO_ROOT } from './testHome.js';

/** Where our code lives, relative to the repo (or whatever root is scanned). */
const ROOTS = [
  'server/src/cld',
  'server/src/cli.ts',
  'webview-ui/src/cld',
  'webview-ui/src/App.tsx',
  'webview-ui/src/hooks/useExtensionMessages.ts',
  'webview-ui/src/office/components/ToolOverlay.tsx',
  'webview-ui/src/office/engine/renderer.ts',
  'webview-ui/src/components/SettingsModal.tsx',
  'cld/install',
  'cld/bin',
  'cld/rules',
  'cld/deploy',
  'cld/scripts',
  'cld/desktop/ui',
  'cld/desktop/src-tauri/src',
  '.claude/skills',
];

/** The public export omits private agent skills, but its export tool is omitted too. */
const scanRoots = (root: string) =>
  fs.existsSync(path.join(root, 'cld/release/export.mjs'))
    ? ROOTS
    : ROOTS.filter((r) => r !== '.claude/skills');

interface Marker {
  id: string;
  why: string;
  re: RegExp;
}

const MARKERS: Marker[] = [
  {
    id: 'rules-file',
    why: "a rules.md and CLAUDE.md files are the user's to keep, not ours to name",
    re: /rules\.md|CLAUDE\.md/i,
  },
  {
    id: 'session-injection',
    why: 'nothing we start passes a system prompt or settings unless the user chose it for that project',
    re: /append-system-prompt|--settings\b/i,
  },
  {
    id: 'model-name',
    why: 'model names come from the data source (Codex, the project settings), never from a table of ours',
    re: /\b(opus|sonnet|haiku|astra|sol|terra|luna)\b|\bgpt-\d/i,
  },
  {
    id: 'pc-name',
    why: "this PC's tab and project names: a name is read from the provider's data",
    re: /\borch-pofol\b|\b(pofol|wayfinder|aixon|savetax|smartglass|keeweon-portfolio)\b/i,
  },
  {
    id: 'gpu-threshold',
    why: "GPU budgets come from the user's config or shares of the GPU's size",
    re: /\b(4\.5|6)\s*gi?b\b|\b(exclusive_gib|shared_budget_gib|live_limit_gib)\b/i,
  },
  {
    id: 'cpu-pinning',
    why: 'how the user runs heavy commands (nice, taskset) is theirs; we only read past such wrappers',
    re: /\btaskset\s+-c\b|\bnice\s+-n\s*\d/i,
  },
];

interface Allowed {
  path: RegExp;
  markers: 'all' | string[];
  why: string;
}

const ALLOWED: Allowed[] = [
  {
    path: /\.test\.[cm]?[jt]sx?$/,
    markers: 'all',
    why: 'tests name what they forbid',
  },
  {
    path: /^server\/src\/cld\/engine\/importProjects\.ts$/,
    markers: ['rules-file'],
    why: "T-0104 only checks whether a folder has a CLAUDE.md to tell a project apart; it never reads, writes or names the file's contents",
  },
  {
    path: /^server\/src\/cld\/engine\/agentRules\.ts$/,
    markers: ['rules-file'],
    why: "RULES-DEFAULT (owner 10-24): the product ships generic default rules and the settings page edits the user's own global rules file; no PC's own rules",
  },
  {
    path: /^webview-ui\/src\/cld\/modelBadges\.ts$/,
    markers: ['model-name'],
    why: "T-0041 badges show, as a letter, the model a store already names (a spawn's model input, a Codex task's model field); nothing is chosen or assigned by them",
  },
  {
    path: /^server\/src\/cld\/engine\/gpu\.ts$/,
    markers: ['gpu-threshold'],
    why: "`cld-gui gpu --json` keeps HIF §9's field names for the limits, filled from the user's gpu.json, else from shares of the GPU's size (null when neither exists)",
  },
  {
    path: /^cld\/scripts\/check\.sh$/,
    markers: ['cpu-pinning'],
    why: 'the developer check tiers lower their own priority (`nice`) so a check never starves the machine it runs on; no core is pinned and nothing ships to users',
  },
  {
    path: /^server\/src\/cld\/engine\//,
    markers: ['session-injection'],
    why: "the engine hands a project's own rules file, or hook settings, to a session only when the user chose it for that project; the default is none (FR-ENG-002). Its own plumbing rides the same --settings: CLD_BIN/PATH/token env and the usage status line, which chains to the user's own (ENV-2)",
  },
];

const SKIP_DIRS = new Set(['node_modules', 'target', 'icons', 'dist']);
const SKIP_FILES = /\.(png|ico|icns|lock|map)$|package-lock\.json$/;
const COMMENT_EXT = /\.(ts|tsx|mjs|js|rs|sh|ps1|css)$/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#)/;

export interface Finding {
  file: string;
  line: number;
  marker: string;
  text: string;
}

/** Every marker on a non-comment line of our files that is not allowed there. */
export function scan(root: string, roots: string[] = ROOTS): Finding[] {
  const out: Finding[] = [];
  const visit = (rel: string) => {
    const abs = path.join(root, rel);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(rel))) return;
      for (const name of fs.readdirSync(abs).sort()) visit(path.posix.join(rel, name));
      return;
    }
    if (SKIP_FILES.test(rel)) return;
    const allowed = ALLOWED.filter((a) => a.path.test(rel));
    if (allowed.some((a) => a.markers === 'all')) return;
    const skipComments = COMMENT_EXT.test(rel);
    fs.readFileSync(abs, 'utf-8')
      .split('\n')
      .forEach((text, i) => {
        if (skipComments && COMMENT_LINE.test(text)) return;
        for (const m of MARKERS) {
          if (!m.re.test(text)) continue;
          if (allowed.some((a) => Array.isArray(a.markers) && a.markers.includes(m.id))) continue;
          out.push({ file: rel, line: i + 1, marker: m.id, text: text.trim().slice(0, 100) });
        }
      });
  };
  for (const r of roots) visit(r);
  return out;
}

const show = (findings: Finding[]) =>
  findings.map((f) => `${f.file}:${f.line} [${f.marker}] ${f.text}`);

describe('no policy in the product code (NFR-CMP-009, TC-168)', () => {
  it('finds no marker in our code', () => {
    expect(show(scan(REPO_ROOT, scanRoots(REPO_ROOT)))).toEqual([]);
  });

  it('scans files that exist: a renamed folder cannot quietly shrink the scan', () => {
    for (const r of scanRoots(REPO_ROOT)) expect(fs.existsSync(path.join(REPO_ROOT, r)), r).toBe(true);
  });

  it('explains every marker and allows it only with a reason', () => {
    for (const m of MARKERS) expect(m.why.length, m.id).toBeGreaterThan(20);
    for (const a of ALLOWED) expect(a.why.length).toBeGreaterThan(20);
  });
});

describe('the scan itself', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tree = (files: Record<string, string>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-scan-'));
    dirs.push(root);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
  };
  const roots = ['server/src/cld', 'webview-ui/src/cld'];

  // Negative control (NC-34): plant one marker in a module; only it is reported.
  it('fails on a marker planted in a module, and only there', () => {
    const planted = "const RULES = '~/notes/rules.md';\n";
    const root = tree({
      'server/src/cld/planted.ts': planted,
      'webview-ui/src/cld/clean.ts': 'export const x = 1;\n',
    });
    expect(show(scan(root, roots))).toEqual([
      "server/src/cld/planted.ts:1 [rules-file] const RULES = '~/notes/rules.md';",
    ]);
    fs.rmSync(path.join(root, 'server/src/cld/planted.ts'));
    expect(scan(root, roots)).toEqual([]);
  });

  // One representative policy line per marker, and a look-alike that is fine.
  it.each([
    ['rules-file', "const f = path.join(home, '.local/share/x/rules.md');", "const f = 'rules';"],
    ['session-injection', "args.push('--append-system-prompt-file', rules);", "args.push('--bg');"],
    ['session-injection', "args.push('--settings', file);", "args.push('--setting-sources');"],
    ['model-name', "const model = 'claude-opus-4';", "const x = 'solid';"],
    ['model-name', "const m = 'gpt-5.6-terra';", 'const gpt = 5;'],
    ['model-name', "{ label: 'Sol' }", 'const solar = 1; // terrain'],
    ['pc-name', "const room = 'orch-pofol';", "const room = 'orch-alpha';"],
    ['pc-name', "label: 'smartglass',", "label: 'glasses',"],
    ['pc-name', "const project = 'wayfinder';", "const project = 'compass';"],
    ['gpu-threshold', 'const SHARED_GIB = 4.5; // 4.5 GiB for sharing', 'const gap = 4.5;'],
    ['gpu-threshold', 'const live = j.live_limit_gib;', 'const live = j.limit;'],
    ['cpu-pinning', "run('nice -n 10 taskset -c 4,5 npm test');", "run('nice');"],
  ])('%s: catches `%s`, ignores `%s`', (id, bad, fine) => {
    const root = tree({ 'server/src/cld/a.ts': `${bad}\n`, 'server/src/cld/b.ts': `${fine}\n` });
    expect(scan(root, roots).map((f) => [f.file, f.marker])).toEqual([['server/src/cld/a.ts', id]]);
  });

  it('skips comment lines in code, not in prose; allows the engine its own switches only', () => {
    const root = tree({
      'server/src/cld/c.ts': '// the pofol agent\n/**\n * rules.md\n */\nconst x = 1;\n',
      'webview-ui/src/cld/notes.md': '# notes\nsee rules.md\n',
      'server/src/cld/engine/run.ts':
        "args.push('--append-system-prompt-file');\nconst r = 'rules.md';\n",
    });
    expect(show(scan(root, roots))).toEqual([
      "server/src/cld/engine/run.ts:2 [rules-file] const r = 'rules.md';",
      'webview-ui/src/cld/notes.md:2 [rules-file] see rules.md',
    ]);
  });
});
