import * as fs from 'node:fs';
import * as path from 'node:path';

import { expect, it } from 'vitest';

import { startEngineOffice } from './officeTestKit.js';

it('suggests ~/projects until dismissed in server config, and refuses an unprivileged scan', async () => {
  const { home, office } = await startEngineOffice({ readOnly: false });
  fs.mkdirSync(path.join(home, 'projects'));
  const sent: Array<Record<string, unknown>> = [];
  const send = (message: Record<string, unknown>) => sent.push(message);
  office.onClientReady(send);
  expect(sent.find((m) => m.type === 'projectImportSuggestion')).toMatchObject({
    folder: path.join(home, 'projects'),
  });
  office.onClientMessage(
    { type: 'projectScan', requestId: 'read', folder: path.join(home, 'projects') },
    send,
    false,
  );
  expect(sent.find((m) => m.type === 'projectScanResult')).toMatchObject({
    ok: false,
    error: '이 접속에는 조작 권한이 없어요',
  });
  office.onClientMessage({ type: 'projectImportDismiss' }, send, true);
  expect(fs.existsSync(path.join(home, '.config/cld-gui/import-suggestion.json'))).toBe(true);
  const next: Array<Record<string, unknown>> = [];
  office.onClientReady((message) => next.push(message));
  expect(next.some((m) => m.type === 'projectImportSuggestion')).toBe(false);
});
