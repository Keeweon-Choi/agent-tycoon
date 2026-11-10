import { describe, expect, it } from 'vitest';

import { askOwnerFollow, cameraMode, setCameraMode } from './cameraMode.js';

describe('askOwnerFollow (my-character button)', () => {
  it('clears the selection, switches to the auto camera and asks to follow the owner', () => {
    setCameraMode('free');
    const office = { selectedAgentId: 7 as number | null, hoveredAgentId: 7 as number | null };
    const want = { wantOwner: false as boolean | 'first' };
    askOwnerFollow(office, want);
    expect(office.selectedAgentId).toBeNull();
    expect(office.hoveredAgentId).toBeNull();
    expect(cameraMode()).toBe('auto');
    expect(want.wantOwner).toBe(true);
  });
});
