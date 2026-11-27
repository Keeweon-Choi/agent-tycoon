const shared = require('../../../core/src/agent-tycoon/configPath.cjs') as {
  configDirectory: (home: string) => string;
  officeDirectory: (home: string) => string;
  stateDirectory: (home: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv) => string;
  controlEndpoint: (home: string, platform?: NodeJS.Platform, user?: string) => string;
  legacyOfficeDirectory: (home: string) => string;
  legacyOfficeSkipFile: (home: string) => string;
  SETTINGS_FOLDER: string;
  OFFICE_FOLDER: string;
  LEGACY_OFFICE_FOLDER: string;
};

export const {
  configDirectory,
  officeDirectory,
  stateDirectory,
  controlEndpoint,
  legacyOfficeDirectory,
  legacyOfficeSkipFile,
  SETTINGS_FOLDER,
  OFFICE_FOLDER,
  LEGACY_OFFICE_FOLDER,
} = shared;
