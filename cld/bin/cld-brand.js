'use strict';
// The one place the product's display name and its default command are spelled for people.
// A rebrand changes these two lines (and the twin server/src/cld/cliName.ts, pinned by
// cld/bin/cld-brand.test.mjs). Internals (paths, services, env vars, `cld-gui` itself) stay neutral.
module.exports = Object.freeze({
  PRODUCT_NAME: 'Agent Tycoon',
  CLI_NAME: 'agty',
  LEGACY_CLI_NAME: 'cld-gui',
});
