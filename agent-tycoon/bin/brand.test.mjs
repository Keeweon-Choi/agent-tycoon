import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const brand = createRequire(import.meta.url)('./brand.js');

test('the server twin names the same command as the bin brand module', () => {
  const ts = fs.readFileSync(new URL('../../server/src/agent-tycoon/cliName.ts', import.meta.url), 'utf8');
  assert.equal(/CLI_NAME = '([^']+)'/.exec(ts)?.[1], brand.CLI_NAME);
});

test('the default command is not a brand-named alias', () => {
  assert.equal(brand.CLI_NAME, 'agty');
  assert.equal('LEGACY_CLI_NAME' in brand, false); // T-83: no old command name
  assert.ok(fs.existsSync(new URL(`./${brand.CLI_NAME}`, import.meta.url))); // the script is named after it
});
