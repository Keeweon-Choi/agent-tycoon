import { describe, expect, it } from 'vitest';

import { AgentStateStore } from './agentStateStore.js';
import { handleClientMessage } from './clientMessageHandler.js';

describe('officeAccess', () => {
  it('includes the standalone web build when known', () => {
    const sent: Array<Record<string, unknown>> = [];

    handleClientMessage(
      { type: 'webviewReady' },
      (message) => sent.push(message),
      {
        store: new AgentStateStore(),
        cache: null,
        privileged: true,
        standalone: true,
        webBuild: 'assets/index-ABC.js',
      },
    );

    expect(sent[0]).toEqual({
      type: 'officeAccess',
      readOnly: false,
      webBuild: 'assets/index-ABC.js',
    });
  });
});
