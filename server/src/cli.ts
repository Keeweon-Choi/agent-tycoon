#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixel-agents`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import * as os from 'os';
import * as path from 'path';

import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import { findClaude } from './cld/agentCli.js';
import { ChatManager } from './cld/chat.js';
import { configDirectory } from './cld/configPath.js';
import { customFurnitureDir, registerFurnitureRoutes } from './cld/customFurniture.js';
import { CLD_BIN_DIR, type EngineMode } from './cld/engine/engine.js';
import { readGpuConfig } from './cld/engine/gpu.js';
import { cldHooks } from './cld/hooks.js';
import { findNvidiaSmi } from './cld/hw/nvidiaSmi.js';
import { startOffice } from './cld/office.js';
import { PlainOffice, restartDaemon } from './cld/plainOffice.js';
import { type Connector, isConnector, startRemote, testRemoteDeps } from './cld/remote/index.js';
import { runSelfTest } from './cld/selfTest.js';
import type { AssetCache, ReloadAssetsSideEffect } from './clientMessageHandler.js';
import { readConfig } from './configPersistence.js';
import {
  AGENT_CLI_RESTART_EXIT_CODE,
  MAX_PORT,
  MIN_PORT,
  SHUTDOWN_DEADLINE_MS,
  TERMINAL_DISABLED_BY_FLAG_REASON,
  WILDCARD_HOSTNAMES,
} from './constants.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { claudeProvider } from './providers/index.js';
import { PixelAgentsServer } from './server.js';
import { PtySessionManager } from './terminal/ptySessionManager.js';
import { normalizeHostname } from './wsAuth.js';

// ── Argument parsing ──────────────────────────────────────────

export interface CliArgs {
  /** Unset -> ephemeral (OS-assigned) port, so multiple standalone instances
   *  can run at once without a collision. --port picks a fixed one. */
  port?: number;
  host: string;
  /** False when --no-terminal was passed: the office only watches agents; the
   *  browser can neither launch them nor attach to their terminals. */
  terminal: boolean;
  /** --allowed-host names (repeatable): extra Host names, beyond loopback and a
   *  specific --host, that a tokened browser session is privileged under --
   *  typically a reverse proxy's public name. See wsAuth.privilegedHostnames. */
  allowedHosts: string[];
  /** An old trust flag was supplied; it is accepted but deliberately ignored. */
  legacyTailscaleTrust: boolean;
  /** --rotate-token: replace the persisted server token before starting. */
  rotateToken: boolean;
  /** cld-gui: the office changes nothing (no project, job or repository write). On by
   *  default; --allow-actions turns it off, --read-only back on (the last of the two wins). */
  readOnly: boolean;
  /** cld-gui --allow-chat: logged-in browsers may open `claude attach` on background sessions. */
  chat: boolean;
  /** Host explicitly permits trusted devices to open login shells. */
  allowTerminal: boolean;
  /** cld-gui --chat-attaches <n>: `claude attach` processes at once (~150 MB each; default 1). */
  chatAttaches?: number;
  /** cld-gui --allow-approval-requests: a new device may ask a logged-in one (T-0022, off by default). */
  approvalRequests: boolean;
  /** cld-gui --engine auto|on|off: the built-in engine (auto = on). */
  engine: EngineMode;
  /** cld-gui --lhm-port <n>: read LibreHardwareMonitor's data.json on this port (Windows, WSL). */
  lhmPort?: number;
  /** cld-gui --nvidia-smi: the HW sampler may query an NVIDIA GPU with nvidia-smi (off by default). */
  nvidiaSmi?: boolean;
  /** cld-gui --connector (T-0024); unset: ~/.config/agent-tycoon/config.json, else local. */
  connector?: Connector;
  /** cld-gui --direct-port: the HTTPS port the router forwards 443 to (default 18443). */
  directPort?: number;
}

/** Thrown by parseArgs on an invalid --port. Kept separate from process.exit so
 *  the parsing logic stays a pure, unit-testable function -- main() is the only
 *  place that turns a bad argument into an exit code. */
export class CliArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    host: '127.0.0.1',
    terminal: false,
    allowedHosts: [],
    legacyTailscaleTrust: false,
    rotateToken: false,
    readOnly: true,
    chat: false,
    allowTerminal: false,
    approvalRequests: false,
    engine: 'auto',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new CliArgsError(
          `Missing value for ${argv[i]}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --port "${raw}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.port = parsed;
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--allowed-host') {
      const raw = argv[i + 1];
      const name = normalizeHostname(raw);
      if (name === null || (WILDCARD_HOSTNAMES as readonly string[]).includes(name)) {
        throw new CliArgsError(
          raw === undefined
            ? 'Missing value for --allowed-host: expected a host name, e.g. my-mac.tailnet.ts.net.'
            : `Invalid --allowed-host "${raw}": expected a host name, e.g. my-mac.tailnet.ts.net.`,
        );
      }
      args.allowedHosts.push(raw as string);
      i++;
    } else if (argv[i] === '--engine') {
      const raw = argv[i + 1];
      if (raw !== 'auto' && raw !== 'on' && raw !== 'off') {
        throw new CliArgsError(`Invalid --engine "${raw ?? ''}": expected auto, on or off.`);
      }
      args.engine = raw;
      i++;
    } else if (argv[i] === '--connector') {
      const raw = argv[i + 1];
      if (!isConnector(raw)) {
        throw new CliArgsError(
          `Invalid --connector "${raw ?? ''}": expected local, lan, tailscale or direct.`,
        );
      }
      args.connector = raw;
      i++;
    } else if (argv[i] === '--direct-port') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
        throw new CliArgsError(`Invalid --direct-port "${argv[i + 1] ?? ''}".`);
      }
      args.directPort = n;
      i++;
    } else if (argv[i] === '--read-only') {
      args.readOnly = true;
    } else if (argv[i] === '--allow-actions') {
      args.readOnly = false;
    } else if (argv[i] === '--allow-chat') {
      args.chat = true;
    } else if (argv[i] === '--allow-terminal') {
      args.allowTerminal = true;
    } else if (argv[i] === '--allow-approval-requests') {
      args.approvalRequests = true;
    } else if (argv[i] === '--chat-attaches') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        throw new CliArgsError(
          `Invalid --chat-attaches "${argv[i + 1] ?? ''}": expected an integer from 1 to 10.`,
        );
      }
      args.chatAttaches = n;
      i++;
    } else if (argv[i] === '--lhm-port') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --lhm-port "${argv[i + 1] ?? ''}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.lhmPort = n;
      i++;
    } else if (argv[i] === '--nvidia-smi') {
      args.nvidiaSmi = true;
    } else if (argv[i] === '--rotate-token') {
      args.rotateToken = true;
    } else if (argv[i] === '--trust-tailscale-user') {
      // S4: tolerate old service commands, but never turn a header into a session.
      args.legacyTailscaleTrust = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    } else if (argv[i] === '--no-terminal') {
      // Retained for scripts that already pass it; it never overrides the
      // separate trusted-device shell opt-in.
      args.terminal = false;
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixel-agents [options]

Options:
  --port, -p <number>   Port to listen on (default: OS-assigned ephemeral port)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --allowed-host <name> Allow this reverse-proxy host for browser WebSockets.
                        Repeatable.
  --rotate-token        Replace the server token used only to mint login codes
  --no-terminal         Disable upstream agent terminals
  --allow-terminal      Allow trusted devices to open login shells (default off)
  --read-only           The office changes nothing: no project, job or
                        repository action (default)
  --allow-actions       Allow those actions from the office (the last of
                        these two flags wins)
  --allow-chat          Let logged-in browsers open a Claude background session's
                        terminal (\`claude attach <id>\`; default off)
  --chat-attaches <n>   \`claude attach\` processes at once, ~150 MB each
                        (default 1)
  --allow-approval-requests
                        Let a device without a session ask a logged-in one to
                        approve it, by typing its code (default off)
  --engine <auto|on|off>
                        Built-in engine: projects whose sessions run as Claude
                        Code background sessions (default auto: on). Its
                        actions also need --allow-actions
  --lhm-port <n>        Read temperatures from LibreHardwareMonitor's web
                        server on this port (Windows, WSL; set by the
                        installer's --hw-sensors step)
  --nvidia-smi          Let the HW panel query an NVIDIA GPU with nvidia-smi
                        when no other source has it (default off; also
                        "nvidiaSmi": true in ~/.config/agent-tycoon/gpu.json)
  --connector <local|lan|tailscale|direct>
                        How other devices reach the office (default: the
                        connector in ~/.config/agent-tycoon/config.json, else local)
  --direct-port <n>     HTTPS port the router forwards 443 to (default 18443)
  --help                Show this help message`);
      process.exit(0);
    }
  }
  return args;
}

// ── Terminal status reporting ─────────────────────────────────

/**
 * Log one clear line about terminal availability, plus a security warning when
 * a working terminal is bound to a non-loopback address.
 *
 * The reason string matters: the most likely failure (npm >=11.16 gating
 * node-pty's install scripts, so it imports but can't spawn) is invisible
 * otherwise -- the user would just see a + Agent button that does nothing.
 *
 * Opting out with --no-terminal is not a failure, so it gets a quiet
 * confirmation instead of the reinstall hint, and skips the non-loopback shell
 * warning (there is no shell surface to warn about).
 */
function reportTerminalStatus(
  ptyManager: PtySessionManager,
  _host: string,
  _enabledByFlag: boolean,
): void {
  void ptyManager;
  console.log('[Pixel Agents] Terminal disabled in cld-gui.');
}

async function issueLoginCode(
  server: PixelAgentsServer,
  config: { port: number; token: string },
): Promise<{ code: string; expiresIn: number }> {
  const local = server.createLoginCode();
  if (local) return local;

  // A compatible standalone server may have been reused. Its auth state lives
  // in that process, so ask its bearer-protected endpoint to mint the code.
  const response = await fetch(`http://127.0.0.1:${String(config.port)}/api/login-code`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}` },
  });
  const body: unknown = await response.json();
  if (
    !response.ok ||
    !body ||
    typeof body !== 'object' ||
    typeof (body as { code?: unknown }).code !== 'string' ||
    typeof (body as { expiresIn?: unknown }).expiresIn !== 'number'
  ) {
    throw new Error('Could not create standalone login code.');
  }
  return body as { code: string; expiresIn: number };
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) process.exit(runSelfTest(__dirname));
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;
  const staticDir = path.join(distRoot, 'webview');

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  console.log('[Pixel Agents] Loading assets...');
  // CH-6b: the user's redrawn furniture is always an asset folder of the daemon.
  const customFurniture = customFurnitureDir();
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
    customFurniture,
  );
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[Pixel Agents] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  // ── Create server ──
  const server = new PixelAgentsServer();

  // Terminals for agents this server launches. Construction is cheap -- the
  // native module is resolved (and probed) lazily on first use, so a user who
  // never opens a terminal never pays for it. With --no-terminal, a disabled
  // manager reports "unavailable" through the same plumbing (availability
  // broadcast, session route, launcher), so nothing downstream special-cases it.
  const ptyManager = PtySessionManager.disabled(TERMINAL_DISABLED_BY_FLAG_REASON);

  try {
    // Create runtime first (before server.start, so we can pass it in)
    const runtime = new AgentRuntime(store, claudeProvider);

    // cld-gui chat (T-0014): off unless asked for, and only with a claude to attach.
    // The same attach manager types cld-gui sends (T-0019); nothing runs until used.
    const claudePath = findClaude();
    if (args.chat && !claudePath) console.log('[cld] chat off: claude not found');
    const attach = claudePath
      ? new ChatManager({
          claudePath,
          maxPtys: args.chatAttaches,
          settingsFile: path.join(configDirectory(os.homedir()), 'terminal.json'),
        })
      : undefined;
    const chat = args.chat ? attach : undefined;
    // cld-gui HW (T-0030): nvidia-smi only when asked for (--nvidia-smi, or gpu.json's
    // nvidiaSmi, T-0021), and only when it exists.
    const wantSmi = args.nvidiaSmi || readGpuConfig().nvidiaSmi === true;
    const nvidiaSmiPath = wantSmi ? findNvidiaSmi() : null;
    if (wantSmi && !nvidiaSmiPath) console.log('[cld] nvidia-smi: asked for, but not found');

    // cld-gui: characters from Claude Code (+ the engine's projects), started
    // before the server so the first client already sees the whole office.
    const office = await startOffice({
      runtime,
      store,
      readOnly: args.readOnly,
      chat: chat !== undefined,
      attaching: () => (attach?.size ?? 0) > 0,
      engineMode: args.engine,
      typist: attach,
      defaultLayout: assetCache.defaultLayout,
      catalog: () => assetCache.furniture?.catalog ?? [],
      lhmPort: args.lhmPort ?? null,
      nvidiaSmi: nvidiaSmiPath,
      // T-0039: Web Push keys and subscriptions beside the login stores.
      pushFile: path.join(configDirectory(os.homedir()), 'push.json'),
      pushHost: args.allowedHosts[0],
    });

    // AGENT-CLI: no Claude Code at start: the plain office tells its viewers to install it, and
    // restarts the daemon once a look (a viewer connecting, the button) finds it.
    if (!office) {
      const exitForSupervisor = () => void shutdown(AGENT_CLI_RESTART_EXIT_CODE);
      const plain = new PlainOffice({
        find: () => findClaude(),
        // Browser runners play the supervisor (cld/test/run-agent-cli.ts); unset in every install.
        restart: async () =>
          process.env.CLD_GUI_TEST_RESTART === 'exit'
            ? (exitForSupervisor(), true)
            : restartDaemon({ binDir: CLD_BIN_DIR, exitForSupervisor }),
      });
      Object.assign(cldHooks, plain.hooks());
    }

    // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });

    // onReloadAssets side effect: re-run the shared loaders (bundled + external
    // dirs) after an external-asset-directory change, then re-broadcast the
    // updated sprites to the requesting client. Mutates the assetCache object in
    // place so already-open sockets (which captured the same reference) and
    // future webviewReady handshakes both observe the new assets. Only
    // characters/pets/furniture can come from external dirs, so only those three
    // are reloaded and re-sent (mirrors the VS Code reload path).
    const onReloadAssets: ReloadAssetsSideEffect = async (send): Promise<void> => {
      const externalDirs = readConfig().externalAssetDirectories;
      const [characters, pets, furniture] = await Promise.all([
        loadAllCharacters(distRoot, externalDirs),
        loadAllPets(distRoot, externalDirs),
        loadAllFurniture(distRoot, externalDirs, customFurniture),
      ]);
      assetCache.characters = characters;
      assetCache.pets = pets;
      assetCache.furniture = furniture;
      if (characters) {
        send({ type: 'characterSpritesLoaded', characters: characters.characters });
      }
      if (pets) {
        send({
          type: 'petSpritesLoaded',
          pets: pets.pets,
          petNames: pets.manifests.map((m) => m.name),
        });
      }
      if (furniture) {
        send({
          type: 'furnitureAssetsLoaded',
          catalog: furniture.catalog,
          sprites: Object.fromEntries(furniture.sprites),
        });
      }
      console.log('[Pixel Agents] Assets reloaded (external directory change)');
    };

    // cld-gui remote (T-0024): LAN and public listeners, invitations' address.
    const hostToken: { current?: string } = {};
    const remote = startRemote({
      connector: args.connector,
      port: args.port,
      directPort: args.directPort,
      allowedHosts: args.allowedHosts,
      readOnly: args.readOnly,
      configDir: configDirectory(os.homedir()),
      token: hostToken,
      legacyTailscaleTrust: args.legacyTailscaleTrust,
      // Browser runners' fake network (cld/test/run-access.ts); unset in every install.
      deps: testRemoteDeps(process.env.CLD_GUI_TEST_REMOTE),
    });

    // CH-6b: save/remove a redrawn furniture item, then every client gets the new catalog.
    const previousRoutes = cldHooks.registerRoutes;
    cldHooks.registerRoutes = (app, auth, ...rest) => {
      previousRoutes?.(app, auth, ...rest);
      registerFurnitureRoutes(app, auth, {
        dir: customFurniture,
        catalog: () => assetCache.furniture?.catalog ?? [],
        reload: async () => {
          const furniture = await loadAllFurniture(
            distRoot,
            readConfig().externalAssetDirectories,
            customFurniture,
          );
          assetCache.furniture = furniture;
          if (furniture)
            store.broadcast({
              type: 'furnitureAssetsLoaded',
              catalog: furniture.catalog,
              sprites: Object.fromEntries(furniture.sprites),
            });
        },
      });
    };

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      port: args.port,
      staticDir,
      assetCache,
      onReloadAssets,
      ptyManager,
      allowedHosts: args.allowedHosts,
      rotateToken: args.rotateToken,
      chat,
      allowTerminal: args.allowTerminal,
      allowApprovalRequests: args.approvalRequests,
    });
    office?.setDaemonPort(config.port);
    hostToken.current = config.token;
    if (args.rotateToken) {
      console.log(
        '[Pixel Agents] Server token rotated: URLs carrying the old token no longer grant access. Open the new URL below on each device.',
      );
    }

    reportTerminalStatus(ptyManager, args.host, args.terminal);

    // Sync runtime refs with persisted settings BEFORE first scan tick. The
    // runtime's single hooksEnabled ref follows the Claude provider until the
    // scanners grow per-provider awareness alongside the Settings UI.
    runtime.hooksEnabled.current = false;
    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

    console.log('[Pixel Agents] Hooks disabled in cld-gui.');

    // Start scanning for external sessions (Claude running in user's terminal)
    const cwd = process.cwd();
    const dirs = claudeProvider.getSessionDirs?.(cwd);
    if (dirs && dirs[0]) {
      const projectDir = dirs[0];
      // cld-gui: the office's providers own the characters; adopting the cwd's
      // sessions as well would duplicate them.
      if (!office) {
        console.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
        runtime.startProjectScan(projectDir);
      }
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }

    // The login link is short-lived and keeps the long-lived server token out
    // of browser URLs and history. Only on a terminal: under systemd or nohup
    // stdout is a log, and a code never goes into a log (the installer and
    // cld-gui-login mint their own over /api/login-code).
    if (process.stdout.isTTY) {
      const displayHost =
        args.host === '0.0.0.0' || args.host === '::' || args.host === '' ? '127.0.0.1' : args.host;
      const login = await issueLoginCode(server, config);
      console.log(
        `\n  Pixel Agents login: http://${displayHost}:${config.port}/login?code=${login.code}\n`,
      );
    } else {
      console.log(
        '[Pixel Agents] Login link not printed: stdout is not a terminal (POST /api/login-code with the server token mints one).',
      );
    }

    // ── Graceful shutdown ──
    let shuttingDown = false;
    async function shutdown(exitCode = 0): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\nShutting down...');
      // A step that hangs must not hold a deploy until systemd's SIGKILL (10-22).
      setTimeout(() => {
        console.log('Shutdown took too long; exiting');
        process.exit(exitCode);
      }, SHUTDOWN_DEADLINE_MS).unref();
      // Kill child terminals before the runtime tears their agents down, and
      // wait for them: exiting now would cancel the SIGKILL escalation and
      // leave a child that ignores SIGHUP orphaned on a dead server.
      await ptyManager.disposeAll();
      await attach?.disposeAll();
      await remote.dispose();
      office?.dispose();
      runtime.dispose();
      server.stop();
      process.exit(exitCode);
    }

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only auto-run when this file is executed directly (`node dist/cli.js`), not
// when it's imported for its exports (e.g. `parseArgs` in tests) -- importing
// it unconditionally used to start a real server and install real Claude
// hooks as a side effect of module load.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
