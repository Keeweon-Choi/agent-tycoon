import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../agentStateStore.js';
import { handleClientMessage } from '../clientMessageHandler.js';

describe('cld-gui disabled standalone handlers', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { type: 'launchAgent' },
    { type: 'closeAgent', id: 1 },
    { type: 'setBypassPermissions', enabled: true },
    { type: 'openSessionsFolder' },
    { type: 'addExternalAssetDirectory', path: '/tmp/asset-pack' },
    { type: 'removeExternalAssetDirectory', path: '/tmp/asset-pack' },
    { type: 'hooksConsentResponse', providerId: 'claude', choice: 'install' },
    { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
  ])('makes $type a no-op with one disabled log', (message) => {
    const send = vi.fn();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new AgentStateStore();

    handleClientMessage(message, send, { store, cache: null, standalone: true, privileged: true });

    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disabled in cld-gui'));
  });
});
