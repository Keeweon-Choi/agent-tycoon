'use strict';
// The one place the product's display name and its default command are spelled for people.
// A rebrand changes these two lines (and the twin server/src/agent-tycoon/cliName.ts, pinned by
// agent-tycoon/bin/brand.test.mjs). The scripts in this folder are named after CLI_NAME (`agty`, `agty-login`, ...).
module.exports = Object.freeze({
  PRODUCT_NAME: 'Agent Tycoon',
  CLI_NAME: 'agty',
});
