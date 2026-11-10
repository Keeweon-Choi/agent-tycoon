import { afterEach, expect, it, vi } from 'vitest';

import { canRunAdminSetup, runAdminSetup } from './adminSetup.js';

afterEach(() => vi.unstubAllGlobals());

it('shows the administrator action only when the desktop bridge is present, and sends typed data', async () => {
  vi.stubGlobal('window', {});
  expect(canRunAdminSetup()).toBe(false);

  const invoke = vi.fn(async () => ({ ok: true, exitCode: 0 }));
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  expect(canRunAdminSetup()).toBe(true);
  await expect(runAdminSetup({ kind: 'relay', directPort: 18443, externalPort: 443 })).resolves.toEqual({ ok: true, exitCode: 0 });
  expect(invoke).toHaveBeenCalledWith('run_admin_setup', {
    request: { kind: 'relay', directPort: 18443, externalPort: 443 },
  });
});
