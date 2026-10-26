import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { configDirectory } from './configPath.js';

const shared = require('../../../core/src/cld/configPath.cjs') as {
  configDirectory: (home: string) => string;
  legacyConfigDirectory: (home: string) => string;
};

describe('configDirectory', () => {
  it('uses Agent Tycoon settings for a new home and preserves an old-only directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tycoon-config-'));
    try {
      expect(configDirectory).toBe(shared.configDirectory);
      expect(configDirectory(home)).toBe(path.join(home, '.config', 'agent-tycoon'));
      fs.mkdirSync(shared.legacyConfigDirectory(home), { recursive: true });
      expect(configDirectory(home)).toBe(shared.legacyConfigDirectory(home));
      // a new folder beside it never moves an existing install off its data
      fs.mkdirSync(path.join(home, '.config', 'agent-tycoon'), { recursive: true });
      expect(configDirectory(home)).toBe(shared.legacyConfigDirectory(home));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
