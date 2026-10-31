const shared = require('../../../core/src/cld/configPath.cjs') as {
  configDirectory: (home: string) => string;
  legacyConfigDirectory: (home: string) => string;
  officeDirectory: (home: string) => string;
  legacyOfficeDirectory: (home: string) => string;
  SETTINGS_FOLDERS: readonly string[];
  OFFICE_FOLDER: string;
  LEGACY_OFFICE_FOLDER: string;
};

export const {
  configDirectory,
  legacyConfigDirectory,
  officeDirectory,
  legacyOfficeDirectory,
  SETTINGS_FOLDERS,
  OFFICE_FOLDER,
  LEGACY_OFFICE_FOLDER,
} = shared;
