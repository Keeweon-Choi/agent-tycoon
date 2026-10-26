'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEGACY_FOLDER = 'cld-gui';
const SETTINGS_FOLDER = 'agent-tycoon';

/**
 * The settings directory for this home. A pre-rename installation keeps its data in the legacy
 * directory for good, also when the new one appears beside it (a stray or empty agent-tycoon
 * folder must never move an install off its logins, device keys and engine state); only a home
 * without the legacy directory uses the new name. Moving an old install is a separate, explicit step.
 */
function configDirectory(home) {
  const legacy = legacyConfigDirectory(home);
  return fs.existsSync(legacy) ? legacy : path.join(home, '.config', SETTINGS_FOLDER);
}

function legacyConfigDirectory(home) {
  return path.join(home, '.config', LEGACY_FOLDER);
}

module.exports = { configDirectory, legacyConfigDirectory };
