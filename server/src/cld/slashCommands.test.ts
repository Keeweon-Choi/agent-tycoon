import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { slashTextProblem } from '../../../core/src/cld/slashText.js';
import { SLASH_MAX_COMMANDS, SlashCatalogue, slashRefusal } from './slashCommands.js';

const homes: string[] = [];
const make = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-slash-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-slash-project-'));
  homes.push(home, project);
  return { home, project };
};
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('slash catalogue', () => {
  it('lists the safe built-ins plus namespaced custom commands and invocable skills', () => {
    const { home, project } = make();
    write(
      path.join(home, '.claude/commands/release/check.md'),
      '---\ndescription: Release readiness\nargument-hint: <tag>\n---\nbody',
    );
    write(path.join(project, '.claude/commands/brief.md'), '# Short project briefing\nmore');
    write(
      path.join(home, '.claude/skills/ship/SKILL.md'),
      '---\nname: deploy\ndescription: Deploy safely\n---\nbody',
    );
    write(
      path.join(project, '.claude/skills/private/SKILL.md'),
      '---\nname: private\ndescription: Hidden\nuser-invocable: false\n---',
    );
    const commands = new SlashCatalogue({ home }).list(project);
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'compact', source: 'builtin' }),
        {
          name: 'release:check',
          args: '<tag>',
          description: 'Release readiness',
          source: 'user',
        },
        { name: 'brief', description: 'Short project briefing', source: 'project' },
        { name: 'deploy', description: 'Deploy safely', source: 'user' },
      ]),
    );
    expect(commands.find((command) => command.name === 'private')).toBeUndefined();
  });

  it('does not follow a command symlink outside its allowed root and caps the list', () => {
    const { home, project } = make();
    const outside = path.join(home, 'outside.md');
    write(outside, '---\ndescription: should not leak\n---');
    const commands = path.join(project, '.claude/commands');
    fs.mkdirSync(commands, { recursive: true });
    fs.symlinkSync(outside, path.join(commands, 'escape.md'));
    for (let index = 0; index < SLASH_MAX_COMMANDS + 20; index++) {
      write(path.join(commands, `command-${index}.md`), `description ${index}`);
    }
    const list = new SlashCatalogue({ home }).list(project);
    expect(list.find((command) => command.name === 'escape')).toBeUndefined();
    expect(list).toHaveLength(SLASH_MAX_COMMANDS);
  });

  it('skips names it could not send, exposes only name/args/description, never the body', () => {
    const { home, project } = make();
    const dir = path.join(project, '.claude/commands');
    write(path.join(dir, '9lives.md'), 'digit first');
    write(path.join(dir, 'a b.md'), 'space');
    write(path.join(dir, 'x;rm.md'), 'semicolon');
    write(path.join(dir, 'ok\u001b.md'), 'escape');
    write(path.join(dir, 'weird dir/inner.md'), 'dir with a space');
    write(path.join(dir, 'safe.md'), '---\ndescription: 안전해요\n---\nSECRET-BODY-LINE');
    const list = new SlashCatalogue({ home }).list(project);
    const custom = list.filter((command) => command.source !== 'builtin');
    expect(custom).toEqual([{ name: 'safe', description: '안전해요', source: 'project' }]);
    expect(JSON.stringify(list)).not.toContain('SECRET-BODY-LINE');
    for (const command of list) expect(slashTextProblem(`/${command.name}`)).toBeNull();
  });

  it('only a plain one-line command can be sent: no control character, tab or separator', () => {
    expect(slashTextProblem('/compact 요약해 줘')).toBeNull();
    for (const bad of [
      '/compact\r',
      '/compact a\tb',
      '/compact \x1b[31m',
      '/compact a\u2028b',
      '/compact \x85x',
      ' /compact',
      '/',
      '//x',
      '/9x',
      '/compact\x7f',
    ])
      expect(slashTextProblem(bad), JSON.stringify(bad)).not.toBeNull();
  });

  it('refuses unknown, multiline, oversized and missing required commands', () => {
    const { home, project } = make();
    const list = new SlashCatalogue({ home }).list(project);
    expect(slashRefusal(list, '/unknown')?.error).toBe('모르는 명령이에요');
    expect(slashRefusal(list, '/compact\nnext')?.error).toBe('여러 줄은 명령으로 보낼 수 없어요');
    expect(slashRefusal(list, `/compact ${'x'.repeat(500)}`)?.error).toBe(
      '/ 명령은 500자까지만 보낼 수 있어요',
    );
    expect(slashRefusal(list, '/model')?.error).toBe('/model에는 <모델>을(를) 함께 적어야 해요');
    expect(slashRefusal(list, '/compact 요약')).toBeNull();
  });
});
