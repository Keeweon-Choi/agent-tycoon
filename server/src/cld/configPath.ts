const { configDirectory, legacyConfigDirectory } = require('../../../core/src/cld/configPath.cjs') as {
  configDirectory: (home: string) => string;
  legacyConfigDirectory: (home: string) => string;
};

export { configDirectory, legacyConfigDirectory };
