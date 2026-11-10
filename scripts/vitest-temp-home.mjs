/**
 * Vitest globalSetup for server/ and webview-ui/ (T-87): the whole run gets a fresh temp home, so a
 * test that forgets its own can never write the real ~/.config/agent-tycoon (the live daemon's
 * files). Runs in the main process before workers spawn, so os.homedir() sees it in every worker.
 * A test that needs a specific HOME still sets its own.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export default function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-vitest-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  for (const name of [
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
  ]) {
    delete process.env[name];
  }
  return () => fs.rmSync(home, { recursive: true, force: true });
}
