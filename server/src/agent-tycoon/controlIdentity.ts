// SEC-CONTROL: the owner token and the caller's identity, shared with the CLI and the manager.
const shared = require('../../../core/src/agent-tycoon/controlIdentity.cjs') as {
  JOB_ID_RE: RegExp;
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

export const { JOB_ID_RE, callerIdentity, ensureOwnerToken, jobsFolder, ownerTokenMatches, ownerTokenPath, readOwnerToken } = shared;
