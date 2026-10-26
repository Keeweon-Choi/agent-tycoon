import fs from 'node:fs';
import path from 'node:path';

/** Repository-relative files needed by the installed manager and its CLI scripts. */
export function managerFiles(root) {
  const install = fs
    .readdirSync(path.join(root, 'cld', 'install'))
    .filter((file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs'))
    .map((file) => `cld/install/${file}`);
  const bin = fs
    .readdirSync(path.join(root, 'cld', 'bin'))
    .filter((file) => !file.endsWith('.test.mjs'))
    .map((file) => `cld/bin/${file}`);
  return [
    ...install,
    ...bin,
    'cld/release/bundle/verify.mjs',
    'core/src/exposureLedger.mjs',
    'core/src/remoteSetupPlan.mjs',
    'core/src/cld/configPath.cjs',
  ];
}
