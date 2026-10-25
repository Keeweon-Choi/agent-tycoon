import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import {
  hasLegacyTailscaleTrust,
  startRemote,
  TAILSCALE_AUTOLOGIN_RETIRED,
} from './index.js';

let configDir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

it('reads old Tailscale trust configuration, ignores it, and warns once at startup', async () => {
  expect(hasLegacyTailscaleTrust({ trustedTailscaleUsers: ['old@example.com'] })).toBe(true);
  expect(hasLegacyTailscaleTrust({ tailscaleUsers: ['old@example.com'] })).toBe(true);
  expect(hasLegacyTailscaleTrust({ allowedHosts: ['office.tail0000.ts.net'] })).toBe(false);
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-legacy-trust-'));
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ trustedTailscaleUsers: ['old@example.com'] }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const remote = startRemote({
    connector: 'local', allowedHosts: [], readOnly: true, configDir, token: {},
    deps: { lanIp: null, wslMode: async () => null },
  });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(`[cld auth] ${TAILSCALE_AUTOLOGIN_RETIRED}`);
  await remote.dispose();
});
