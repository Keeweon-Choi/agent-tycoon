'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEGACY_FOLDER = 'cld-gui';
const SETTINGS_FOLDER = 'agent-tycoon';
const OFFICE_FOLDER = 'office';
/** The upstream Pixel Agents folder our office files lived in until 2026-11. Its VS Code
 *  extension may share it: we read our own files there, never move or rewrite theirs. */
const LEGACY_OFFICE_FOLDER = '.pixel-agents';

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

/** The daemon's office files (config.json, standalone-state.json, layout.json, the server token,
 *  server.json, servers/, hooks/) in their own subfolder, apart from the settings files. */
function officeDirectory(home) {
  return path.join(configDirectory(home), OFFICE_FOLDER);
}

/** Where those files lived before 2026-11 (see LEGACY_OFFICE_FOLDER). */
function legacyOfficeDirectory(home) {
  return path.join(home, LEGACY_OFFICE_FOLDER);
}

module.exports = {
  configDirectory,
  legacyConfigDirectory,
  officeDirectory,
  legacyOfficeDirectory,
  SETTINGS_FOLDERS: [LEGACY_FOLDER, SETTINGS_FOLDER],
  OFFICE_FOLDER,
  LEGACY_OFFICE_FOLDER,
};
