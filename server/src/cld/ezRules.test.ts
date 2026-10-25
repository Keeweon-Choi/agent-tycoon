import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { EZ_TEXT_MAX, EzRulesFile, ezRulesPath, parseEzRules } from './ezRules.js';

const log = () => {
  const lines: string[] = [];
  return { lines, note: (line: string) => void lines.push(line) };
};
const phrase = { emoji: '🚀', text: '배포하는 중' };

describe('ez-rules.json: a valid file', () => {
  it('keeps every rule in file order; one string stands for a list', () => {
    const { lines, note } = log();
    const rules = parseEzRules(
      JSON.stringify({
        v: 1,
        tools: [
          { tool: 'WebFetch', emoji: '🌐', text: '자료 찾는 중' },
          { tool: ['Read', ' NotebookRead '], ...phrase },
        ],
        commands: [
          { program: 'make', sub: 'deploy', ...phrase },
          {
            program: ['kubectl', 'helm'],
            sub: ['apply'],
            subContains: ['roll'],
            has: ['-f', 'prod'],
            contains: ['x'],
            ...phrase,
          },
        ],
      }),
      note,
    );
    expect(lines).toEqual([]);
    expect(rules).toEqual({
      tools: [
        { tool: ['WebFetch'], emoji: '🌐', text: '자료 찾는 중' },
        { tool: ['Read', 'NotebookRead'], ...phrase },
      ],
      commands: [
        { program: ['make'], sub: ['deploy'], ...phrase },
        {
          program: ['kubectl', 'helm'],
          sub: ['apply'],
          subContains: ['roll'],
          has: ['-f', 'prod'],
          contains: ['x'],
          ...phrase,
        },
      ],
    });
  });

  it('accepts either section alone, an empty file object and the longest allowed text', () => {
    const { lines, note } = log();
    const text = '가'.repeat(EZ_TEXT_MAX);
    expect(parseEzRules('{}', note)).toEqual({ tools: [], commands: [] });
    expect(
      parseEzRules(JSON.stringify({ commands: [{ program: 'a', emoji: '1', text }] }), note),
    ).toMatchObject({ commands: [{ text }], tools: [] });
    expect(lines).toEqual([]);
  });
});

describe('ez-rules.json: a file that cannot be used is ignored whole, with one log line', () => {
  it.each([
    ['broken JSON', '{"commands": [', 'not valid JSON'],
    ['an empty file', '', 'not valid JSON'],
    ['a list', '[]', 'expected an object'],
    ['null', 'null', 'expected an object'],
    ['a newer version', '{"v": 2, "commands": []}', 'unsupported v=2'],
  ])('%s', (_what, text, why) => {
    const { lines, note } = log();
    expect(parseEzRules(text, note)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[cld] ez-rules.json');
    expect(lines[0]).toContain(why);
  });
});

describe('ez-rules.json: a bad entry is dropped, its neighbours stay', () => {
  const good = { program: 'git', ...phrase };
  const cases: Array<[string, unknown, string]> = [
    [
      'text over 16 characters',
      { program: 'a', emoji: '1', text: '가'.repeat(17) },
      'longer than 16',
    ],
    ['no text', { program: 'a', emoji: '1' }, 'text must be a string'],
    ['empty text', { program: 'a', emoji: '1', text: '  ' }, 'text is empty'],
    ['no emoji', { program: 'a', text: 'x' }, 'emoji must be a string'],
    ['a long emoji', { program: 'a', emoji: 'x'.repeat(13), text: 'x' }, 'emoji is longer'],
    ['no program', { emoji: '1', text: 'x' }, '"program" is missing'],
    [
      'a program that is not text',
      { program: 7, emoji: '1', text: 'x' },
      'program must be a string',
    ],
    ['an empty list', { program: [], emoji: '1', text: 'x' }, 'program is empty'],
    ['an empty word', { program: 'a', sub: [' '], emoji: '1', text: 'x' }, 'sub is empty'],
    ['a long list', { program: Array(17).fill('a'), emoji: '1', text: 'x' }, 'more than 16'],
    ['a long word', { program: 'a'.repeat(65), emoji: '1', text: 'x' }, 'longer than 64'],
    [
      'an unknown field',
      { program: 'a', programme: 'b', emoji: '1', text: 'x' },
      'unknown field "programme"',
    ],
    ['a control character', { program: 'a', emoji: '1', text: 'a\nb' }, 'control character'],
    ['a text line break', { program: 'a', emoji: '1', text: 'a\u2028b' }, 'control character'],
    ['a string instead of an object', 'git push', 'not an object'],
    ['null', null, 'not an object'],
    ['a list instead of an object', [], 'not an object'],
  ];
  it.each(cases)('%s', (_what, bad, why) => {
    const { lines, note } = log();
    const rules = parseEzRules(
      JSON.stringify({ commands: [good, bad, { ...good, program: 'npm' }] }),
      note,
    );
    expect(rules?.commands.map((c) => c.program)).toEqual([['git'], ['npm']]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('commands[1]');
    expect(lines[0]).toContain(why);
  });

  it('tool rules are checked the same way', () => {
    const { lines, note } = log();
    const rules = parseEzRules(
      JSON.stringify({
        tools: [
          { tool: 'Read', emoji: '1', text: 'x'.repeat(17) },
          { emoji: '1', text: 'x' },
          { tool: 'Read', program: 'x', emoji: '1', text: 'x' },
          { tool: 'Skill', ...phrase },
        ],
      }),
      note,
    );
    expect(rules?.tools).toEqual([{ tool: ['Skill'], ...phrase }]);
    expect(lines.map((l) => l.match(/tools\[(\d)\]/)?.[1])).toEqual(['0', '1', '2']);
  });

  it('a section that is not a list, and a field nobody knows, are logged and skipped', () => {
    const { lines, note } = log();
    const rules = parseEzRules(JSON.stringify({ tools: {}, commands: [good], extra: 1 }), note);
    expect(rules).toEqual({ tools: [], commands: [good].map((c) => ({ ...c, program: ['git'] })) });
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('"tools" must be a list');
    expect(lines.join('\n')).toContain('unknown field "extra"');
  });

  it('keeps the first 200 rules of a section and says so once', () => {
    const { lines, note } = log();
    const commands = Array.from({ length: 230 }, (_, i) => ({ program: `p${i}`, ...phrase }));
    const rules = parseEzRules(JSON.stringify({ commands }), note);
    expect(rules?.commands).toHaveLength(200);
    expect(rules?.commands[199].program).toEqual(['p199']);
    expect(lines).toHaveLength(1);
  });
});

describe('ez-rules.json: fatigue numbers (T-0026)', () => {
  it('keeps the valid numbers and logs each bad or unknown one', () => {
    const { lines, note } = log();
    const rules = parseEzRules(
      JSON.stringify({
        fatigue: { tired: 60, rest: 90, yawn: 101, restCompactions: 3, perCompaction: 15, nap: 3 },
      }),
      note,
    );
    expect(rules).toEqual({ tools: [], commands: [], fatigue: { tired: 60, rest: 90 } });
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).toContain('fatigue.yawn: not a whole number 0..100');
    expect(lines.join('\n')).toContain('fatigue.restCompactions: unknown field');
    // T-0045: compactions no longer weigh in, so the old number is just unknown.
    expect(lines.join('\n')).toContain('fatigue.perCompaction: unknown field');
    expect(lines.join('\n')).toContain('fatigue.nap: unknown field');
  });

  it('a fatigue that is not an object, or holds nothing valid, is left out', () => {
    const { lines, note } = log();
    expect(parseEzRules(JSON.stringify({ fatigue: [70] }), note)).toEqual({
      tools: [],
      commands: [],
    });
    expect(parseEzRules(JSON.stringify({ fatigue: { tired: 'x' } }), note)).toEqual({
      tools: [],
      commands: [],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"fatigue" must be an object');
  });
});

describe('the file on disk', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const setup = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-ez-'));
    dirs.push(home);
    const file = ezRulesPath(home);
    const { lines, note } = log();
    const write = (body: string, bump = 0) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      if (bump) fs.utimesSync(file, new Date(), new Date(Date.now() + bump));
    };
    return { home, file, lines, write, source: new EzRulesFile(file, note) };
  };
  const one = JSON.stringify({ commands: [{ program: 'make', ...phrase }] });

  it('lives under ~/.config/cld-gui/', () => {
    expect(ezRulesPath('/home/me')).toBe(
      path.join('/home/me', '.config', 'cld-gui', 'ez-rules.json'),
    );
  });

  it('no file: nothing to send and nothing logged', () => {
    const { source, lines } = setup();
    expect(source.message()).toBeNull();
    expect(source.message()).toBeNull();
    expect(lines).toEqual([]);
  });

  it('a valid file becomes the ezRules message', () => {
    const { source, write, lines } = setup();
    write(one);
    expect(source.message()).toEqual({
      type: 'ezRules',
      tools: [],
      commands: [{ program: ['make'], ...phrase }],
    });
    expect(lines).toEqual([]);
  });

  it('fatigue numbers alone are sent too', () => {
    const { source, write } = setup();
    write(JSON.stringify({ fatigue: { tired: 50 } }));
    expect(source.message()).toEqual({
      type: 'ezRules',
      tools: [],
      commands: [],
      fatigue: { tired: 50 },
    });
  });

  it('an edit is picked up by the next client; the file is not parsed again while it is unchanged', () => {
    const { source, write, lines } = setup();
    write(
      JSON.stringify({
        commands: [
          { program: 'make', ...phrase },
          { program: 'x', emoji: '1' },
        ],
      }),
    );
    expect(source.message()?.commands).toHaveLength(1);
    expect(source.message()?.commands).toHaveLength(1);
    expect(source.message()?.commands).toHaveLength(1);
    expect(lines).toHaveLength(1); // the bad entry is logged once, not once per client
    write(
      JSON.stringify({
        commands: [
          { program: 'make', ...phrase },
          { program: 'cargo', ...phrase },
        ],
      }),
      5000,
    );
    expect(source.message()?.commands.map((c) => c.program[0])).toEqual(['make', 'cargo']);
    expect(lines).toHaveLength(1);
  });

  it('deleting the file goes back to the built-in table', () => {
    const { source, write, file } = setup();
    write(one);
    expect(source.message()).not.toBeNull();
    fs.rmSync(file);
    expect(source.message()).toBeNull();
  });

  it.each([
    ['broken JSON', '{nope'],
    ['no valid rule in it', JSON.stringify({ commands: [{ program: 'a', emoji: '1' }] })],
    ['nothing in it', '{}'],
  ])('%s: nothing to send, the daemon carries on', (_what, body) => {
    const { source, write } = setup();
    write(body);
    expect(source.message()).toBeNull();
  });

  it('a directory in its place, or a file over 64 KiB, is ignored with one line', () => {
    const a = setup();
    fs.mkdirSync(a.file, { recursive: true });
    expect(a.source.message()).toBeNull();
    expect(a.source.message()).toBeNull();
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0]).toContain('not a regular file');

    const b = setup();
    b.write(
      JSON.stringify({ commands: [{ program: 'a', ...phrase }], pad: 'x'.repeat(70 * 1024) }),
    );
    expect(b.source.message()).toBeNull();
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toContain('larger than 64 KiB');
  });
});
