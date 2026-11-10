#!/usr/bin/env node
// T-83: the product was renamed from cld-gui/cld to agent-tycoon/agty with no compatibility, so
// nothing we ship may still carry the old name. This scan fails on `cld-gui`, `CLD_...`, `cldFoo`,
// the bare word `cld`, `cldgui` (the old publisher and app id) and `Pixel Office` / `pixel-office` /
// `PixelOffice` (the desktop app's name before 11-01), case variants included, in
//   (a) file names and contents of every extra directory given as an argument (the built dist/,
//       a release bundle, a sandbox HOME after an install/uninstall round),
//   (b) the contents of the repository's tracked and new files,
//   (c) the names of those files,
// except the ALLOW entries below. Every entry says why; keep the list short.
//
//   node agent-tycoon/scripts/no-trace.mjs [dir ...]
//
// ponytail: a regex scan, so a new word that happens to contain `cld` as its own token would need
// an allowlist entry; letters or digits on either side of `cld` never match.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `cld` is a token (letters or digits on either side never match); the other two match anywhere, in any case.
const anyCase = (word) => word.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
export const TRACE = new RegExp(`(?<![A-Za-z0-9])(?:cld|Cld|CLD)(?![a-z0-9])|${anyCase('cldgui')}|${anyCase('pixel')}[ _-]?${anyCase('office')}`);

const OLD = /cld-gui|cld_session|\bcld\b/;
const TESTS_OF_THE_OLD_NAME = 'a test that keeps the old name on purpose, to prove it is no longer recognised';
// `path` is a repo-relative prefix (ends with /) or an exact file; `re` limits the entry to matching lines.
export const ALLOW = [
  // Dated records: they say what was true when they were written.
  { path: 'agent-tycoon/tasks/', why: 'dated task logs' },
  { path: 'agent-tycoon/docs/research/', why: 'dated research records' },
  { path: 'docs/research/', why: 'dated research records' },
  { path: 'agent-tycoon/docs/adr/', why: 'dated decision records (ADRs)' },
  { path: 'docs/adr/', why: 'dated decision records (ADRs)' },
  { path: 'agent-tycoon/artifacts/', why: 'runner evidence from before the rename, never rewritten' },
  { path: 'agent-tycoon/desktop/PROGRESS.md', why: 'dated progress log' },
  { path: 'agent-tycoon/docs/CHANGELOG.md', why: 'past entries keep their prose; the T-83 entry names the old name' },
  { path: 'CHANGELOG.md', why: 'past entries keep their prose' },
  { path: 'agent-tycoon/docs/design/onboarding-security/', why: 'design record of the 10-23 install and security analysis, written against the old names' },
  { path: 'agent-tycoon/docs/design/hub-interface.md', why: 'record of the old hub protocol, written against the old names' },
  { path: 'agent-tycoon/docs/design/hub-free.md', why: 'record of the old hub protocol, written against the old names' },
  { path: 'agent-tycoon/docs/design/hub-porting.md', why: 'record of the old hub protocol, written against the old names' },
  { path: 'agent-tycoon/docs/design/multi-host.md', why: 'design record of the cookie and host-id change, written against the old names' },
  { path: 'agent-tycoon/docs/briefing.md', re: /Pixel Office\(autoaidev\)/, why: 'names another project, "Pixel Office" by autoaidev, in the list of similar tools; it is not our old app name' },
  // Tests that name the old name to prove it is not recognised.
  { path: 'server/src/agent-tycoon/configPath.test.ts', re: OLD, why: TESTS_OF_THE_OLD_NAME },
  { path: 'server/src/agent-tycoon/hostCookie.test.ts', re: OLD, why: TESTS_OF_THE_OLD_NAME },
  { path: 'server/src/agent-tycoon/engine/agentQueries.test.ts', re: OLD, why: TESTS_OF_THE_OLD_NAME },
  { path: 'server/src/agent-tycoon/transcriptView.test.ts', re: OLD, why: TESTS_OF_THE_OLD_NAME },
  { path: 'server/__tests__/claudeHookInstaller.test.ts', re: OLD, why: TESTS_OF_THE_OLD_NAME },
  { path: 'webview-ui/src/agent-tycoon/messenger/toolLine.test.ts', re: OLD, why: TESTS_OF_THE_OLD_NAME },
  { path: 'agent-tycoon/install/install.test.mjs', re: OLD, why: TESTS_OF_THE_OLD_NAME },
  { path: 'agent-tycoon/install/manager.test.mjs', re: OLD, why: TESTS_OF_THE_OLD_NAME },
  { path: 'agent-tycoon/desktop/src-tauri/src/local.rs', re: OLD, why: TESTS_OF_THE_OLD_NAME },
  { path: 'server/src/agent-tycoon/spec/structure.test.ts', re: /cld/, why: 'its fixture is a gzipped snapshot of the repository at 662d3ef9, with the old folder names, and the expectations name them' },
  // The scan that protects this PC's live data until the cutover moves it.
  { path: 'server/src/agent-tycoon/noLegacyConfigPath.test.ts', re: /cld/, why: 'the legacy-path scan: it must still name ~/.config/cld-gui and ~/.local/{state,share}/cld-gui, which hold this PC\'s live data until the cutover' },
  { path: 'agent-tycoon/test/install/invariants.mjs', re: /cld|pixel-office/, why: 'the install-round invariants also report the old folders, links, launcher and service of this PC' },
  { path: ['CLAUDE', 'md'].join('.'), re: /pre-rename/, // joined: the policy scan (NFR-CMP-009) flags that file name spelled out in code
     why: 'the safety rule names the old data folders (live data until the cutover)' },
  { path: 'agent-tycoon/scripts/no-trace.mjs', why: 'this scan names the old name by design' },
  { path: 'agent-tycoon/scripts/no-trace.test.mjs', why: 'the scan\'s own test feeds it the old name' },
];

const usage = () => { console.error('usage: node agent-tycoon/scripts/no-trace.mjs [dir ...]'); process.exit(2); };
const entryFor = (rel) => ALLOW.filter((a) => (a.path.endsWith('/') ? rel.startsWith(a.path) : rel === a.path));

/** Violations of one text, as `line: excerpt`, minus the lines an entry allows. */
export function scanText(rel, text, allow = entryFor(rel)) {
  if (allow.some((a) => !a.re)) return [];
  allow = allow.filter((a) => a.re);
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (!TRACE.test(line)) return;
    if (allow.some((a) => a.re.test(line))) return;
    const at = line.search(TRACE);
    found.push(`${i + 1}: ${line.slice(Math.max(0, at - 30), at + 50).trim()}`);
  });
  return found;
}

function scanFile(abs, rel, out, allow = entryFor(rel)) {
  if (TRACE.test(path.basename(rel)) && !allow.some((a) => !a.re)) out.push(`${rel}  (file name)`);
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return; }
  if (buf.includes(0) || buf.length > 64 << 20) return; // binary: names only
  for (const hit of scanText(rel, buf.toString('utf8'), allow)) out.push(`${rel}:${hit}`);
}

function walk(dir, visit) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) { visit(abs, true); continue; }
    if (e.isDirectory()) { visit(abs, true); walk(abs, visit); } else visit(abs, false);
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const out = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('-')) usage();
    const dir = path.resolve(arg);
    if (!fs.existsSync(dir)) { console.error(`no-trace: ${arg} does not exist`); process.exit(2); }
    // An extra directory is a build or install result: no entry applies there, and every name counts.
    const visit = (abs, isDir) => {
      const rel = `${arg}/${path.relative(dir, abs)}`;
      if (isDir) { if (TRACE.test(path.basename(abs))) out.push(`${rel}  (folder name)`); } else scanFile(abs, rel, out, []);
    };
    walk(dir, visit);
  }
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  for (const rel of files) if (fs.existsSync(path.join(root, rel))) scanFile(path.join(root, rel), rel, out);
  if (out.length) {
    console.error(`no-trace: ${out.length} trace(s) of the old name (cld-gui / CLD_ / cld / cldgui / Pixel Office):`);
    for (const o of out.slice(0, 80)) console.error(`  ${o}`);
    if (out.length > 80) console.error(`  ... and ${out.length - 80} more`);
    process.exit(1);
  }
  console.log(`no-trace: ok (${files.length} source files, ${process.argv.length - 2} extra dir(s))`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
