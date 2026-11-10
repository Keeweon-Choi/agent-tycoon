import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

// T-87: scripts/vitest-temp-home.mjs (globalSetup) keeps the run off the real home.
describe('vitest temp home guard', () => {
  it('points os.homedir() at a temp dir, not the passwd home of the invoking user', () => {
    const home = os.homedir();
    expect(home).not.toBe(os.userInfo().homedir);
    expect(home.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(home).startsWith('agty-vitest-home-')).toBe(true);
    expect(process.env.USERPROFILE).toBe(home);
  });
});
