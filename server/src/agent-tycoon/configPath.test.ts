import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { configDirectory, stateDirectory } from './configPath.js';

const shared = require('../../../core/src/agent-tycoon/configPath.cjs') as {
  configDirectory: (home: string) => string;
};

describe('configDirectory', () => {
  it('is Agent Tycoon settings, and a pre-rename cld-gui folder beside it is not recognised', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tycoon-config-'));
    try {
      expect(configDirectory).toBe(shared.configDirectory);
      expect(configDirectory(home)).toBe(path.join(home, '.config', 'agent-tycoon'));
      // T-83: the old name never moves an install onto it, even when it is the only folder
      fs.mkdirSync(path.join(home, '.config', 'cld-gui'), { recursive: true });
      expect(configDirectory(home)).toBe(path.join(home, '.config', 'agent-tycoon'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps runtime state in agent-tycoon state folders, never in the bundle install root', () => {
    expect(stateDirectory('/h', 'linux')).toBe(path.join('/h', '.local', 'state', 'agent-tycoon'));
    expect(stateDirectory('/h', 'win32', { LOCALAPPDATA: 'C:/L' })).toBe(path.join('C:/L', 'agent-tycoon'));
    expect(stateDirectory('/h', 'win32', {})).toBe(path.join('/h', 'AppData', 'Local', 'agent-tycoon'));
  });
});
