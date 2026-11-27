import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { slashTextProblem } from '../../../core/src/agent-tycoon/slashText.js';
import type { SlashCommand } from '../../../core/src/messages.js';
import type { ClaudeCliCommand } from './cliCommands.js';
import {
  BUILTINS,
  mergeCliBuiltins,
  pickerCommands,
  SLASH_MAX_COMMANDS,
  SlashCatalogue,
  slashRefusal,
} from './slashCommands.js';

const cjsFs = createRequire(__filename)('fs') as typeof fs;
const homes: string[] = [];
const make = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-slash-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-slash-project-'));
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
  it('merges CLI commands without losing established Korean metadata or custom commands', async () => {
    const cli: ClaudeCliCommand[] = [
      { name: 'compact', description: 'English compact', argumentHint: 'ignored' },
      { name: 'clear', description: 'English clear', argumentHint: '[name]' },
      { name: 'model', description: 'English model', argumentHint: '[model]' },
      { name: 'doctor', description: 'English doctor', argumentHint: '[checkup]' },
      { name: 'effort', description: 'English effort', argumentHint: '<level>' },
      { name: '__remote-workflow', description: 'internal', argumentHint: '' },
      { name: 'heapdump', description: 'internal', argumentHint: '' },
      { name: 'workflow-launch-exec', description: 'internal', argumentHint: '' },
      { name: 'doctor', description: 'duplicate', argumentHint: '' },
    ];
    const merged = mergeCliBuiltins(cli);
    for (const name of ['compact', 'clear', 'model'] as const) {
      const expected = BUILTINS.find((command) => command.name === name)!;
      expect(merged.find((command) => command.name === name)).toMatchObject(expected);
    }
    // T-81 C: bare, it opens a picker: only a Lead in our PTY may send it so (pickerCommands).
    expect(merged.find((command) => command.name === 'model')).toMatchObject({
      argsRequired: true,
    });
    const pty = pickerCommands(merged);
    expect(pty.find((command) => command.name === 'model')).not.toHaveProperty('argsRequired');
    expect(pty.find((command) => command.name === 'add-dir')).toMatchObject({ argsRequired: true });
    expect(
      pickerCommands([
        { name: 'model', source: 'project', description: 'x', argsRequired: true },
      ])[0],
    ).toMatchObject({
      argsRequired: true,
    });
    expect(merged).toEqual(
      expect.arrayContaining([
        { name: 'doctor', args: '[checkup]', description: 'English doctor', source: 'builtin' },
        { name: 'effort', args: '<level>', description: 'English effort', source: 'builtin' },
      ]),
    );
    // The CLI does not list some established built-ins in print mode: they follow, unchanged.
    expect(merged.map((command) => command.name)).toEqual([
      'compact',
      'clear',
      'model',
      'doctor',
      'effort',
      ...BUILTINS.filter((command) => !['compact', 'clear', 'model'].includes(command.name)).map(
        (command) => command.name,
      ),
    ]);

    const { home, project } = make();
    write(path.join(home, '.claude/commands/user.md'), 'user command');
    write(path.join(project, '.claude/commands/project.md'), 'project command');
    let resolve!: (value: { version: string; commands: ClaudeCliCommand[]; models: [] }) => void;
    const catalogue = new SlashCatalogue({
      home,
      cliCommands: () => new Promise((done) => (resolve = done)),
    });
    const before = catalogue.list(project).map((command) => command.name);
    expect(before.slice(0, BUILTINS.length)).toEqual(BUILTINS.map((command) => command.name));
    expect(before).toEqual(expect.arrayContaining(['project', 'user']));
    expect(before).not.toContain('doctor');
    const updates: string[][] = [];
    catalogue.watch(project, (commands) => updates.push(commands.map((command) => command.name)));
    resolve({ version: 'test', commands: cli, models: [] });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual(expect.arrayContaining(['doctor', 'effort', 'user', 'project']));
    expect(new Set(updates[0]).size).toBe(updates[0].length);
    catalogue.dispose();
  });

  it('keeps the established built-ins a CLI answer omits, with their flags and send allow-list', async () => {
    const { home, project } = make();
    const catalogue = new SlashCatalogue({
      home,
      cliCommands: async () => ({
        version: 'test',
        commands: [{ name: 'doctor', description: 'English doctor', argumentHint: '' }],
        models: [],
      }),
    });
    catalogue.list(project);
    await vi.waitFor(() =>
      expect(catalogue.list(project).map((command) => command.name)).toContain('doctor'),
    );
    const list = catalogue.list(project);
    for (const name of ['export', 'add-dir', 'cost', 'review', 'pr-comments'])
      expect(list.find((command) => command.name === name)).toMatchObject({ source: 'builtin' });
    for (const name of ['export', 'add-dir'])
      expect(list.find((command) => command.name === name)).toMatchObject({ argsRequired: true });
    expect(slashRefusal(list, '/export')?.error).toContain('/export');
    expect(slashRefusal(list, '/cost')).toBeNull();
    catalogue.dispose();
  });

  it('warm starts one probe while none answered and does nothing once an answer is cached', async () => {
    const { home } = make();
    const names = [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5' }];
    const runner = vi.fn(async () => ({ version: 'test', commands: [], models: names }));
    const catalogue = new SlashCatalogue({ home, cliCommands: runner });
    catalogue.warm();
    catalogue.warm();
    expect(runner).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(catalogue.models()).toEqual(names));
    catalogue.warm();
    expect(runner).toHaveBeenCalledTimes(1);
    catalogue.dispose();
  });

  it('asks the CLI again after a failed answer, never twice at once, and never loops on the same answer', async () => {
    const { home, project } = make();
    const answer = {
      version: 'test',
      commands: [{ name: 'doctor', description: 'English doctor', argumentHint: '' }],
      models: [],
    };
    const answers: Array<typeof answer | null> = [null, answer];
    const runner = vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]));
    const cliChanged = vi.fn();
    const catalogue = new SlashCatalogue({ home, cliCommands: runner, cliChanged });
    const names = () => catalogue.list(project).map((command) => command.name);
    const updates: string[][] = [];
    catalogue.watch(project, (commands) => updates.push(commands.map((command) => command.name)));
    expect(names()).not.toContain('doctor');
    expect(runner).toHaveBeenCalledTimes(1); // list and watch while the first run is in flight
    await vi.waitFor(() => expect(names()).toContain('doctor'));
    expect(runner.mock.calls.length).toBeGreaterThan(1);
    // The cache hands back the same object for the same build: that is no change, so no callback.
    const settled = updates.length;
    for (let i = 0; i < 5; i++) {
      names();
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(updates).toHaveLength(settled);
    expect(updates.filter((update) => update.includes('doctor'))).toHaveLength(1);
    expect(cliChanged).toHaveBeenCalledTimes(1); // T-143: the engine view follows the one new answer
    catalogue.dispose();
  });

  it("watching walks only what the list reads: a skill folder's other files are not statted", () => {
    vi.useFakeTimers();
    try {
      const { home, project } = make();
      for (let skill = 0; skill < 5; skill++) {
        const dir = path.join(home, '.claude/skills', `skill-${skill}`);
        write(path.join(dir, 'SKILL.md'), `---\ndescription: skill ${skill}\n---`);
        for (let file = 0; file < 20; file++)
          write(path.join(dir, 'references', `r${file}.md`), 'x');
      }
      const catalogue = new SlashCatalogue({ home });
      const updates: string[] = [];
      const stats: string[] = [];
      const { statSync } = cjsFs;
      cjsFs.statSync = ((...a: Parameters<typeof statSync>) => (
        stats.push(String(a[0])),
        statSync(...a)
      )) as typeof statSync;
      syncBuiltinESMExports();
      try {
        const stop = catalogue.watch(project, (commands) =>
          updates.push(commands.find((command) => command.name === 'skill-0')?.description ?? ''),
        );
        vi.advanceTimersByTime(3_000);
        stop();
      } finally {
        Object.assign(cjsFs, { statSync });
        syncBuiltinESMExports();
      }
      expect(stats.filter((file) => file.includes(`${path.sep}references`))).toEqual([]);
      expect(stats.length).toBeLessThan(100); // 3 ticks x (5 folders + 5 SKILL.md) plus the watch start
      expect(updates).toEqual([]);
      catalogue.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a changed or new skill reaches the watcher within a few seconds', () => {
    vi.useFakeTimers();
    try {
      const { home, project } = make();
      const skill = path.join(home, '.claude/skills/alpha/SKILL.md');
      write(skill, '---\ndescription: before\n---');
      const catalogue = new SlashCatalogue({ home });
      const updates: SlashCommand[][] = [];
      catalogue.watch(project, (commands) => updates.push(commands));
      fs.writeFileSync(skill, '---\ndescription: after!\n---');
      fs.utimesSync(skill, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      vi.advanceTimersByTime(3_000);
      expect(updates.at(-1)?.find((command) => command.name === 'alpha')?.description).toBe(
        'after!',
      );
      write(path.join(home, '.claude/skills/beta/SKILL.md'), '---\ndescription: new\n---');
      vi.advanceTimersByTime(3_000);
      expect(updates.at(-1)?.map((command) => command.name)).toContain('beta');
      catalogue.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the list at the maximum when the CLI lists more, and does not run a CLI until asked', async () => {
    const { home, project } = make();
    const runner = vi.fn(async () => ({
      version: 'test',
      commands: Array.from({ length: SLASH_MAX_COMMANDS + 10 }, (_, index) => ({
        name: `command-${index}`,
        description: `command ${index}`,
        argumentHint: '',
      })),
      models: [],
    }));
    const catalogue = new SlashCatalogue({ home, cliCommands: runner });
    expect(runner).not.toHaveBeenCalled();
    catalogue.list(project);
    await vi.waitFor(() => expect(catalogue.list(project)).toHaveLength(SLASH_MAX_COMMANDS));
    expect(runner).toHaveBeenCalled();
    catalogue.dispose();
  });
  it('a user skill with the name of a CLI-only command keeps its own description and source', async () => {
    const { home, project } = make();
    write(
      path.join(home, '.claude/skills/debug/SKILL.md'),
      '---\ndescription: My own debug skill\n---\nbody',
    );
    const catalogue = new SlashCatalogue({
      home,
      cliCommands: async () => ({
        version: 'test',
        commands: [
          { name: 'debug', description: 'Bundled debug', argumentHint: '' },
          { name: 'doctor', description: 'English doctor', argumentHint: '' },
        ],
        models: [],
      }),
    });
    catalogue.list(project);
    await vi.waitFor(() =>
      expect(catalogue.list(project).map((command) => command.name)).toContain('doctor'),
    );
    const list = catalogue.list(project);
    expect(list.filter((command) => command.name === 'debug')).toEqual([
      { name: 'debug', description: 'My own debug skill', source: 'user' },
    ]);
    catalogue.dispose();
  });

  it('the cap cuts CLI-only commands first, never the established built-ins or the user rows', async () => {
    const { home, project } = make();
    const userNames = Array.from({ length: 20 }, (_, index) => `mine-${index}`);
    for (const name of userNames) write(path.join(home, `.claude/commands/${name}.md`), name);
    const catalogue = new SlashCatalogue({
      home,
      cliCommands: async () => ({
        version: 'test',
        commands: Array.from({ length: SLASH_MAX_COMMANDS + 10 }, (_, index) => ({
          name: `command-${index}`,
          description: `command ${index}`,
          argumentHint: '',
        })),
        models: [],
      }),
    });
    catalogue.list(project);
    await vi.waitFor(() =>
      expect(catalogue.list(project).map((command) => command.name)).toContain('command-0'),
    );
    const names = catalogue.list(project).map((command) => command.name);
    expect(names).toHaveLength(SLASH_MAX_COMMANDS);
    expect(names).toEqual(
      expect.arrayContaining([...BUILTINS.map((command) => command.name), ...userNames]),
    );
    catalogue.dispose();
  });

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
    expect(slashRefusal(list, '/add-dir')?.error).toBe('/add-dir에는 <경로>를 함께 적어야 해요');
    expect(slashRefusal(list, '/model')?.error).toBe('/model에는 <모델>을 함께 적어야 해요');
    expect(slashRefusal(pickerCommands(list), '/model')).toBeNull();
    expect(slashRefusal(list, '/compact 요약')).toBeNull();
  });
});
