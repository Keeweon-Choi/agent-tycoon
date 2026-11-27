'use strict';

const os = require('node:os');
const path = require('node:path');

const SETTINGS_FOLDER = 'agent-tycoon';
const OFFICE_FOLDER = 'office';
/** The upstream Pixel Agents folder our office files lived in until 2026-11. Its VS Code
 *  extension may share it: we read our own files there, never move or rewrite theirs. */
const LEGACY_OFFICE_FOLDER = '.pixel-agents';

/** The settings directory for this home: `~/.config/agent-tycoon`. */
function configDirectory(home) {
  return path.join(home, '.config', SETTINGS_FOLDER);
}

/** The daemon's office files (config.json, standalone-state.json, layout.json, the server token,
 *  server.json, servers/, hooks/) in their own subfolder, apart from the settings files. */
function officeDirectory(home) {
  return path.join(configDirectory(home), OFFICE_FOLDER);
}

/** Runtime state (jobs/, codex/, gpu/, hw.json): `~/.local/state/agent-tycoon`, on Windows
 *  `%LOCALAPPDATA%\\agent-tycoon` (beside the holder scripts). Not `~/.local/share/agent-tycoon`:
 *  that is the Linux bundle install root, which uninstall prunes. */
function stateDirectory(home, platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), SETTINGS_FOLDER)
    : path.join(home, '.local', 'state', SETTINGS_FOLDER);
}

/** The engine's control endpoint: `<settings>/engine.sock`, on Windows the per-user pipe
 *  `\\.\pipe\agent-tycoon-engine-<user>`. The daemon, the CLI and the manager all take it from here.
 *  ponytail: S4.4, a pipe name another local account can create first (squatting) and so read the
 *  CLI's tokens and forge a permission answer; follow-up T-127 S4.4: a nonce/HMAC challenge before tokens. */
function controlEndpoint(home, platform = process.platform, user) {
  if (platform !== 'win32') return path.join(configDirectory(home), 'engine.sock');
  const name = (user ?? os.userInfo().username).toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  return `\\\\.\\pipe\\${SETTINGS_FOLDER}-engine-${name}`;
}

/** Where those files lived before 2026-11 (see LEGACY_OFFICE_FOLDER). */
function legacyOfficeDirectory(home) {
  return path.join(home, LEGACY_OFFICE_FOLDER);
}

/** Left in the office folder by a full reset (agty uninstall --reset) that kept ~/.pixel-agents'
 *  config.json/layout.json (they may be upstream's): the daemon then neither copies nor reads them
 *  back, so the reset stays a reset. */
function legacyOfficeSkipFile(home) {
  return path.join(officeDirectory(home), 'pixel-agents-skipped');
}

module.exports = {
  configDirectory,
  officeDirectory,
  stateDirectory,
  controlEndpoint,
  legacyOfficeDirectory,
  legacyOfficeSkipFile,
  SETTINGS_FOLDER,
  OFFICE_FOLDER,
  LEGACY_OFFICE_FOLDER,
};
