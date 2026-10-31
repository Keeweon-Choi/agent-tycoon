// SEC-CONTROL: the owner token and the caller's identity, shared with the CLI and the manager.
const shared = require('../../../core/src/cld/controlIdentity.cjs') as {
  callerIdentity: (
    home: string,
    env?: NodeJS.ProcessEnv,
    o?: { proc?: string; pid?: number; platform?: NodeJS.Platform },
  ) => { token?: string; owner?: string };
  ensureOwnerToken: (home: string) => string;
  jobsFolder: (home: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv) => string;
  ownerTokenMatches: (home: string, given: unknown) => boolean;
  ownerTokenPath: (home: string) => string;
  readOwnerToken: (home: string) => string | null;
};

export const { callerIdentity, ensureOwnerToken, jobsFolder, ownerTokenMatches, ownerTokenPath, readOwnerToken } = shared;
