import * as path from 'node:path';

/** Names whose contents commonly contain credentials. */
export function sensitiveFile(file: string): boolean {
  const name = path.basename(file).toLowerCase();
  return (
    name.startsWith('.env') ||
    name.endsWith('.pem') ||
    name.endsWith('.key') ||
    ['.kdbx', '.p12', '.pfx', '.ovpn'].some((ext) => name.endsWith(ext)) ||
    name.includes('.keychain') ||
    name.endsWith('_history') ||
    name.startsWith('id_') ||
    name.includes('credentials') ||
    name.includes('.secret') ||
    ['.netrc', '.npmrc', '.pypirc', '.pgpass'].includes(name)
  );
}
