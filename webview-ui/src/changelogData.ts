import type { TranslationKey } from './i18n/index.js';

interface ChangelogSection {
  title: TranslationKey;
  items: TranslationKey[];
}

interface ChangelogEntry {
  version: string;
  sections: ChangelogSection[];
}

/** Extract "major.minor" from a semver string (e.g. "1.1.1" → "1.1") */
export function toMajorMinor(version: string): string {
  const parts = version.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version;
}

export const CHANGELOG_REPO_URL = 'https://github.com/Keeweon-Choi/agent-tycoon';

/** Newest first. A release's words live in i18n under `changelog.<version>.*`; only the text of
 *  the version the app reports (cld/release/version.json, major.minor) is shown, else the newest. */
export const changelogEntries: ChangelogEntry[] = [
  {
    version: '0.1',
    sections: [
      {
        title: 'changelog.0.1.features',
        items: [
          'changelog.0.1.messenger',
          'changelog.0.1.disk',
          'changelog.0.1.phoneCamera',
          'changelog.0.1.iso',
          'changelog.0.1.lounge',
          'changelog.0.1.characters',
          'changelog.0.1.autostart',
          'changelog.0.1.usage',
        ],
      },
      {
        title: 'changelog.0.1.install',
        items: [
          'changelog.0.1.winInstall',
          'changelog.0.1.winClaude',
          'changelog.0.1.mac',
          'changelog.0.1.noClaude',
        ],
      },
      {
        title: 'changelog.0.1.fixes',
        items: ['changelog.0.1.composer', 'changelog.0.1.iphone', 'changelog.0.1.shellKey'],
      },
    ],
  },
];
