/**
 * `node dist/cli.js --self-test` (P1): proves an installed or unpacked daemon
 * bundle can run -- every runtime module loads, the files beside dist/ are there,
 * the config dirs are readable -- without starting a server or writing anything.
 * Exit 0 = runnable; 1 = something the daemon needs is missing or broken.
 * node-pty is optional (the terminal degrades), so its absence is reported, not fatal.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SERVER_HEALTH_PROTOCOL_VERSION } from '../constants.js';
import { resolvePtyModule } from '../terminal/ptyModule.js';
import { configDirectory } from './configPath.js';

/** The modules esbuild leaves in node_modules (esbuild.js buildCli externals, plus
 *  uqr for cld/bin/cld-gui-qr.mjs). node-pty is checked separately. */
const RUNTIME_MODULES = [
  'fastify',
  '@fastify/websocket',
  '@fastify/static',
  '@fastify/cors',
  'acme-client',
  'uqr',
];

/** Paths relative to dist/ that a bundle must carry. */
const REQUIRED_FILES = [
  'webview/index.html',
  'assets',
  'hooks/claude-hook.js',
  'cld-worker.js',
  'login/login.js',
  '../cld/bin/cld-gui',
  '../cld/release/version.json',
  '../package.json',
];

/** Same indirection as ptyModule: a runtime lookup esbuild must not bundle. */
function requireAtRuntime(id: string): unknown {
  const req: NodeRequire = require;
  return req(id);
}

/** The version in the module's own package.json, found by walking up from its entry
 *  (many packages do not export `./package.json`). */
function moduleVersion(id: string): string {
  try {
    const req: NodeRequire = require;
    for (
      let dir = path.dirname(req.resolve(id));
      dir !== path.dirname(dir);
      dir = path.dirname(dir)
    ) {
      const file = path.join(dir, 'package.json');
      if (!fs.existsSync(file)) continue;
      const pkg = JSON.parse(fs.readFileSync(file, 'utf-8')) as { name?: string; version?: string };
      if (pkg.name === id) return pkg.version ?? '?';
    }
  } catch {
    // unresolvable by require (ESM-only exports): the module itself loaded
  }
  return '?';
}

/** Read-only look at a config dir: list it and parse config.json. Never creates it. */
function checkConfigDir(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  fs.accessSync(dir, fs.constants.R_OK);
  fs.readdirSync(dir);
  const file = path.join(dir, 'config.json');
  if (fs.existsSync(file)) JSON.parse(fs.readFileSync(file, 'utf-8'));
  return 'readable';
}

export function runSelfTest(distRoot: string): number {
  let failed = false;
  const line = (status: 'ok' | 'warn' | 'FAIL', what: string, detail: string): void => {
    if (status === 'FAIL') failed = true;
    console.log(`${status.padEnd(4)} ${what}: ${detail}`);
  };

  line(
    'ok',
    'cld-gui',
    `${process.env.CLD_GUI_VERSION ?? '?'} (protocol ${SERVER_HEALTH_PROTOCOL_VERSION})`,
  );
  line(
    'ok',
    'node',
    `${process.version} ${process.platform}-${process.arch} at ${process.execPath}`,
  );

  for (const id of RUNTIME_MODULES) {
    try {
      requireAtRuntime(id);
      line('ok', id, moduleVersion(id));
    } catch (err) {
      line('FAIL', id, err instanceof Error ? err.message.split('\n')[0] : String(err));
    }
  }

  const pty = resolvePtyModule();
  if (pty.module) line('ok', 'node-pty', `${pty.moduleId} ${moduleVersion(pty.moduleId ?? '')}`);
  else line('warn', 'node-pty', `unavailable, terminals off (${pty.reason ?? ''})`);

  for (const rel of REQUIRED_FILES) {
    const file = path.join(distRoot, rel);
    if (fs.existsSync(file)) line('ok', 'file', path.normalize(rel));
    else line('FAIL', 'file', `${path.normalize(rel)} missing (${file})`);
  }

  for (const dir of [
    configDirectory(os.homedir()),
    path.join(os.homedir(), '.pixel-agents'),
  ]) {
    try {
      line('ok', 'config', `${dir} ${checkConfigDir(dir) ?? 'absent (fresh install)'}`);
    } catch (err) {
      line('FAIL', 'config', `${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(failed ? 'self-test FAILED' : 'self-test passed');
  return failed ? 1 : 0;
}
