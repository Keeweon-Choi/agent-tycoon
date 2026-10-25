import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeRules,
  handleAgentRules,
  rulesLanguage,
  useBuiltInRules,
  userRulesPath,
  writeCombinedRules,
} from './agentRules.js';
import { configDir } from './events.js';

let home: string;
let rulesDir: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  rulesDir = path.join(home, 'shipped');
  fs.mkdirSync(rulesDir);
  fs.writeFileSync(path.join(rulesDir, 'default.ko.md'), 'KO-DEFAULT\n');
  fs.writeFileSync(path.join(rulesDir, 'default.en.md'), 'EN-DEFAULT\n');
});
const playbooks = () => {
  for (const role of ['lead', 'worker', 'reviewer']) fs.writeFileSync(path.join(rulesDir, `${role}.en.md`), `EN-${role}\n`);
};
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const send = () => {
  const out: Record<string, unknown>[] = [];
  return { out, fn: (m: Record<string, unknown>) => void out.push(m) };
};
const user = (text: string) => {
  fs.mkdirSync(configDir(home), { recursive: true });
  fs.writeFileSync(userRulesPath(home), text);
};

describe('language', () => {
  it('known UI language wins, else a Korean host locale, else English', () => {
    expect(rulesLanguage(home, { LANG: 'ko_KR.UTF-8' })).toBe('ko');
    expect(rulesLanguage(home, { LANG: 'en_US.UTF-8' })).toBe('en');
    fs.mkdirSync(configDir(home), { recursive: true });
    fs.writeFileSync(path.join(configDir(home), 'ui-language'), 'en\n');
    expect(rulesLanguage(home, { LANG: 'ko_KR.UTF-8' })).toBe('en');
  });
});

describe('composition', () => {
  it('uses the enabled built-in default, then user, then project, in that order', () => {
    user('USER\n');
    const project = path.join(home, 'p.md');
    fs.writeFileSync(project, 'PROJECT\n');
    expect(composeRules({ home, rulesDir, projectRulesFile: project, env: { LANG: 'ko_KR' } })).toBe(
      'KO-DEFAULT\n\nUSER\n\nPROJECT',
    );
    expect(composeRules({ home, rulesDir, env: { LANG: 'C' } })).toBe('EN-DEFAULT\n\nUSER');
    expect(useBuiltInRules(home)).toBe(true);
  });

  it('omits the built-in layer when the host turned it off', () => {
    user('USER\n');
    const project = path.join(home, 'p.md');
    fs.writeFileSync(project, 'PROJECT\n');
    const s = send();
    handleAgentRules(
      { language: 'en', useBuiltInRules: false },
      s.fn,
      { home, rulesDir, privileged: true, readOnly: false },
    );
    expect(s.out[0]).toMatchObject({ useBuiltInRules: false });
    expect(useBuiltInRules(home)).toBe(false);
    expect(composeRules({ home, rulesDir, projectRulesFile: project, env: { LANG: 'ko_KR' } })).toBe(
      'USER\n\nPROJECT',
    );
    fs.rmSync(userRulesPath(home));
    expect(writeCombinedRules({ home, rulesDir, name: 'empty', log: () => undefined })).toBeNull();
  });

  it('missing layers are skipped; nothing at all gives no file', () => {
    expect(composeRules({ home, rulesDir: null, projectRulesFile: '/nope.md' })).toBe('');
    expect(writeCombinedRules({ home, rulesDir: null, name: 'a', log: () => undefined })).toBeNull();
    fs.rmSync(path.join(rulesDir, 'default.en.md'));
    expect(composeRules({ home, rulesDir, env: { LANG: 'C' } })).toBe('KO-DEFAULT');
  });

  it('C7a: shared defaults, then the role playbook (Lead when unset), then user and own rules', () => {
    playbooks();
    user('USER\n');
    const env = { LANG: 'C' };
    expect(composeRules({ home, rulesDir, env })).toBe('EN-DEFAULT\n\nEN-lead\n\nUSER');
    expect(composeRules({ home, rulesDir, role: 'worker', env })).toBe('EN-DEFAULT\n\nEN-worker\n\nUSER');
    expect(composeRules({ home, rulesDir, role: 'reviewer', env })).toBe('EN-DEFAULT\n\nEN-reviewer\n\nUSER');
    // A missing playbook leaves the shared part.
    fs.rmSync(path.join(rulesDir, 'reviewer.en.md'));
    expect(composeRules({ home, rulesDir, role: 'reviewer', env })).toBe('EN-DEFAULT\n\nUSER');
  });

  it('built-in off: no shared part, no playbook, no playbook version; nothing else gives no file', () => {
    playbooks();
    const o = { home, rulesDir, role: 'worker' as const, builtin: false, env: { LANG: 'C' }, name: 'w', log: () => undefined };
    expect(composeRules(o)).toBe('');
    expect(writeCombinedRules(o)).toBeNull();
    user('USER\n');
    const w = writeCombinedRules(o)!;
    expect(fs.readFileSync(w.file, 'utf8')).toBe('USER\n');
    expect(w.playbook).toBeNull();
  });

  it('the playbook version names the role and changes with the shipped text', () => {
    playbooks();
    const o = { home, rulesDir, role: 'worker' as const, env: { LANG: 'C' }, name: 'w', log: () => undefined };
    const v1 = writeCombinedRules(o)!.playbook!;
    expect(v1).toMatch(/^worker-[0-9a-f]{8}$/);
    fs.writeFileSync(path.join(rulesDir, 'worker.en.md'), 'EN-worker v2\n');
    expect(writeCombinedRules(o)!.playbook).not.toBe(v1);
  });

  it('writes one 0600 file per project and never touches the user file', () => {
    user('USER\n');
    const before = fs.readFileSync(userRulesPath(home), 'utf8');
    const a = writeCombinedRules({ home, rulesDir, name: 'proj/a', log: () => undefined })!.file;
    const b = writeCombinedRules({ home, rulesDir, name: 'proj_a', log: () => undefined })!.file;
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.join(configDir(home), 'rules-combined'));
    expect(fs.readFileSync(a, 'utf8')).toContain('USER');
    expect(fs.statSync(a).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(userRulesPath(home), 'utf8')).toBe(before);
  });
});

describe('settings page messages', () => {
  const ctx = (o: Partial<Parameters<typeof handleAgentRules>[2]> = {}) => ({
    home,
    rulesDir,
    privileged: true,
    readOnly: false,
    ...o,
  });

  it('an unprivileged save is refused and writes nothing; it reads the defaults only', () => {
    user('SECRET\n');
    const s = send();
    handleAgentRules({ language: 'en', text: 'EVIL' }, s.fn, ctx({ privileged: false }));
    expect(s.out[0]).toMatchObject({ type: 'agentRules', error: 'read_only', defaults: 'EN-DEFAULT', text: '' });
    expect(fs.readFileSync(userRulesPath(home), 'utf8')).toBe('SECRET\n');
    expect(fs.existsSync(path.join(configDir(home), 'ui-language'))).toBe(false);
  });

  it('an unprivileged built-in-rules change is refused', () => {
    const s = send();
    handleAgentRules({ useBuiltInRules: false }, s.fn, ctx({ privileged: false }));
    expect(s.out[0]).toMatchObject({ error: 'read_only', useBuiltInRules: true });
    expect(useBuiltInRules(home)).toBe(true);
  });

  it('a remote save needs a fresh step-up', () => {
    const s = send();
    handleAgentRules({ language: 'ko', text: 'X' }, s.fn, ctx({ stepUp: { remote: true, fresh: () => false } }));
    expect(s.out[0]).toMatchObject({ error: 'stepup' });
    expect(fs.existsSync(userRulesPath(home))).toBe(false);
    handleAgentRules({ language: 'ko', text: 'X' }, s.fn, ctx({ stepUp: { remote: true, fresh: () => true } }));
    expect(s.out[1]).toMatchObject({ text: 'X', defaults: 'KO-DEFAULT' });
    expect(fs.readFileSync(userRulesPath(home), 'utf8')).toBe('X\n');
  });

  it('empty text removes the file; too long is refused', () => {
    user('OLD\n');
    const s = send();
    handleAgentRules({ language: 'en', text: '  ' }, s.fn, ctx());
    expect(fs.existsSync(userRulesPath(home))).toBe(false);
    handleAgentRules({ language: 'en', text: 'x'.repeat(40_000) }, s.fn, ctx());
    expect(s.out[1]).toMatchObject({ error: 'too_long' });
  });

  it('showing remembers the language for the next session start', () => {
    handleAgentRules({ language: 'en' }, send().fn, ctx());
    expect(rulesLanguage(home, { LANG: 'ko_KR' })).toBe('en');
  });
});
