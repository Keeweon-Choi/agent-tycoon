import { describe, expect, it } from 'vitest';

import { MCP_SERVER_NAME, mcpConfig } from './claude.js';

describe('Claude session MCP config (T-80)', () => {
  it('names the engine tool server agty, so tool ids read mcp__agty__<tool>', () => {
    expect(MCP_SERVER_NAME).toBe('agty');
    const cfg = mcpConfig('/opt/agent-tycoon/bin/agty', '/usr/bin/node');
    expect(Object.keys(cfg.mcpServers)).toEqual(['agty']);
    expect(cfg.mcpServers.agty).toEqual({
      command: '/usr/bin/node',
      args: ['/opt/agent-tycoon/bin/agty-mcp.js'],
    });
  });
});
