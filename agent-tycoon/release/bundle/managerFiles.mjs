import fs from 'node:fs';
import path from 'node:path';

/** Repository-relative files needed by the installed manager and its CLI scripts. */
export function managerFiles(root) {
  const install = fs
    .readdirSync(path.join(root, 'agent-tycoon', 'install'))
    .filter((file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs'))
    .map((file) => `agent-tycoon/install/${file}`);
  const bin = fs
    .readdirSync(path.join(root, 'agent-tycoon', 'bin'))
    .filter((file) => !file.endsWith('.test.mjs'))
    .map((file) => `agent-tycoon/bin/${file}`);
  return [
    ...install,
    ...bin,
    'agent-tycoon/release/bundle/verify.mjs',
    'core/src/exposureLedger.mjs',
    'core/src/remoteSetupPlan.mjs',
    'core/src/agent-tycoon/configPath.cjs',
    'core/src/agent-tycoon/controlIdentity.cjs',
  ];
}
