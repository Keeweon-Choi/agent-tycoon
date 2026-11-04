import { describe, expect, it } from 'vitest';

import type { AttachmentChip } from './attachments.js';
import { liveChips, storedChips } from './draftFiles.js';
import { DRAFT_TTL_MS } from './messengerStore.js';

const chip = (state: AttachmentChip['state']): AttachmentChip => ({
  id: state,
  name: 'note.txt',
  size: 5,
  type: 'text/plain',
  state,
  progress: state === 'ready' ? 100 : 40,
});

describe('REDEPLOY-STATE: the unsent files kept with the draft', () => {
  it('an upload cut short by the reload is to send again; the others stay as they were', () => {
    expect(storedChips([chip('uploading'), chip('pending'), chip('ready'), chip('failed')])).toEqual([
      { ...chip('uploading'), state: 'pending', progress: 0 },
      chip('pending'),
      chip('ready'),
      chip('failed'),
    ]);
  });

  it('files kept longer than a draft lives are dropped', () => {
    const now = 10 * DRAFT_TTL_MS;
    expect(liveChips({ at: now - 1000, chips: [chip('pending')] }, now)).toHaveLength(1);
    expect(liveChips({ at: now - DRAFT_TTL_MS, chips: [chip('pending')] }, now)).toEqual([]);
    expect(liveChips(undefined, now)).toEqual([]);
  });
});
