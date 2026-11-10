import assert from 'node:assert/strict';
import test from 'node:test';

import { ALLOW, scanText, TRACE } from './no-trace.mjs';

test('the old name matches as a token, never inside another word', () => {
  for (const s of ['cld-gui', 'CLD_BIN', 'x.cldRest', 'a cld b', '~/.config/cld-gui', 'cldFoo', 'Cld']) assert.ok(TRACE.test(s), s);
  for (const s of ['child', 'SUCLDX', 'cld1', 'Cldr', 'agent-tycoon', 'GCGOT0JKCLDGrq2bQ']) assert.ok(!TRACE.test(s), s);
});

test('the old publisher and the old app name match in any spelling, and the new name never does', () => {
  for (const s of ['cldgui', 'dev.cldgui.pixeloffice', 'Software\\CLDGUI\\x', 'Pixel Office', 'pixel office', 'pixel-office', 'pixel_office', 'PixelOffice', 'PIXELOFFICE', 'pixeloffice_1.0.0_x64.dmg']) assert.ok(TRACE.test(s), s);
  for (const s of ['Agent Tycoon', 'agent-tycoon', 'dev.agenttycoon.app', 'pixel-agents', 'pixel art office', 'Pixel Agents', 'pixels in the office']) assert.ok(!TRACE.test(s), s);
});

test('an entry with a line pattern frees only those lines; a plain entry frees the file', () => {
  const text = 'ok\nthe cld-gui folder is not read\nbut cld-gui here is a trace?';
  assert.equal(scanText('x', text, []).length, 2);
  assert.equal(scanText('x', text, [{ re: /not read/ }]).length, 1);
  assert.deepEqual(scanText('x', text, [{ path: 'x' }]), []);
});

test('every allowlist entry says why', () => {
  for (const a of ALLOW) assert.ok(a.why && a.why.length > 10, a.path);
});
