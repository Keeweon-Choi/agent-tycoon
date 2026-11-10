import { expect, it } from 'vitest';

import { CHANGELOG_REPO_URL, changelogEntries, toMajorMinor } from '../src/changelogData.ts';
import { en } from '../src/i18n/en.js';
import { ko } from '../src/i18n/ko.js';

it('points the update log at Agent Tycoon, not the upstream project', () => {
  expect(CHANGELOG_REPO_URL).toBe('https://github.com/Keeweon-Choi/agent-tycoon');
});

it('has an English and a Korean text for every key the update log uses', () => {
  const keys = changelogEntries.flatMap((e) => e.sections.flatMap((s) => [s.title, ...s.items]));
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    expect((en as Record<string, string>)[key], key).toBeTruthy();
    expect(ko[key as keyof typeof ko], key).toBeTruthy();
  }
});

it('lists the version the product reports (agent-tycoon/release/version.json) as the newest entry', () => {
  expect(changelogEntries[0]?.version).toBe(toMajorMinor('0.1.0-rc.1'));
});

it('keeps pixel-agents leftovers out of the update log texts', () => {
  const texts = Object.entries(en)
    .filter(([k]) => k.startsWith('changelog.'))
    .map(([, v]) => v);
  expect(texts.join('\n')).not.toMatch(/pixel.?agents|discord\.gg|pablo/i);
});

it('answers the Discord button with a not-open-yet note in both languages, never a link', () => {
  expect(en['changelog.discordSoon']).toBe("Our Discord isn't open yet");
  expect(ko['changelog.discordSoon']).toBeTruthy();
  expect(changelogEntries.length).toBeGreaterThan(0);
});
