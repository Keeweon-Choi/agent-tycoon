import { describe, expect, it, vi } from 'vitest';

import { AgentChoicesCache, parseClaudeHelp, parseCodexConfig } from './agentCapabilities.js';

describe('installed agent choices', () => {
  it('parses old and new Claude help choices', () => {
    expect(
      parseClaudeHelp(
        "--model <model> aliases: 'opus', 'sonnet'; full: 'claude-opus-4-5'\n--effort <level> (low, medium, high)",
      ),
    ).toEqual({
      models: ['opus', 'sonnet', 'claude-opus-4-5'],
      efforts: ['low', 'medium', 'high'],
    });
    expect(
      parseClaudeHelp(
        "--model <model> (e.g. 'fable', 'opus', or 'sonnet') or a model's full name\n--effort <level> (low, medium, high, xhigh, max)",
      ),
    ).toEqual({
      models: ['fable', 'opus', 'sonnet'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  it('D3b: lists the --permission-mode choices the help quotes, none when it lists none', () => {
    expect(
      parseClaudeHelp(
        '--effort <level> (low)\n--permission-mode <mode>  Permission mode to use for the session (choices: "acceptEdits", "default", "plan")\n--print',
      ).permissionModes,
    ).toEqual(['acceptEdits', 'default', 'plan']);
    expect(parseClaudeHelp('--permission-mode <mode>  Permission mode').permissionModes).toBeUndefined();
  });

  it('reads Codex defaults and profile models, never credentials, and refreshes after binary mtime changes', () => {
    const readFileSync = vi.fn((file: string) => {
      if (file.endsWith('settings.json')) return '{"model":"sonnet"}';
      if (file.endsWith('config.toml'))
        return 'model = "gpt-5.2-codex"\nmodel_reasoning_effort = "high"\n[profiles.fast]\nmodel = "gpt-5.1-codex-mini"';
      throw new Error('missing');
    });
    let mtime = 1;
    const disk = { readFileSync, statSync: vi.fn(() => ({ mtimeMs: mtime })) } as never;
    const run = vi.fn((_: string, args: string[]) => ({
      status: 0,
      stdout:
        args[0] === '--help'
          ? "--model <model> aliases: 'opus'\n--effort <level> (low, max)"
          : '2.1.0',
    }));
    const cache = new AgentChoicesCache(
      '/home/test',
      { PATH: '/bin' },
      disk,
      run,
      (command) => `/bin/${command}`,
    );
    expect(cache.discover()).toEqual({
      claude: {
        version: '2.1.0',
        models: ['opus'],
        efforts: ['low', 'max'],
        defaultModel: 'sonnet',
      },
      codex: {
        version: '2.1.0',
        models: ['gpt-5.2-codex', 'gpt-5.1-codex-mini'],
        efforts: ['low', 'medium', 'high', 'xhigh'], // D5: every Codex effort; the config's is the default
        defaultModel: 'gpt-5.2-codex',
        defaultEffort: 'high',
      },
    });
    expect(readFileSync.mock.calls.map(([file]) => file)).not.toContain(
      '/home/test/.claude/.credentials.json',
    );
    expect(readFileSync.mock.calls.map(([file]) => file)).not.toContain(
      '/home/test/.codex/auth.json',
    );
    cache.discover();
    expect(run).toHaveBeenCalledTimes(3);
    mtime = 2;
    cache.discover();
    expect(run).toHaveBeenCalledTimes(6);
  });

  it('parses a config fixture without treating comments as values', () => {
    expect(
      parseCodexConfig(
        '# model = "no"\nmodel = "gpt-5" # current\nmodel_reasoning_effort = "max"\n[profiles.review]\nmodel = "gpt-5-codex"',
      ),
    ).toEqual({
      models: ['gpt-5', 'gpt-5-codex'],
      efforts: ['max'],
      defaultModel: 'gpt-5',
      defaultEffort: 'max',
    });
  });
});
