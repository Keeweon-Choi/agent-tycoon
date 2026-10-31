import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Settings/modal helpers drive the standalone browser page. */
type WebviewSurface = Page;

const WEBVIEW_TIMEOUT_MS = 30_000;

export interface WebviewSettings {
  watchAllSessions?: boolean;
  hooksEnabled?: boolean;
  alwaysShowLabels?: boolean;
  ghostHeadlessAgents?: boolean;
  debugView?: boolean;
  /** Persisted permission posture the host applies to every launch. */
  bypassPermissions?: boolean;
  /** Standalone: list the server's start directory in the launch drawer. */
  showStartDirectory?: boolean;
}

/** Settings-modal label of the persistent skip-permissions toggle. */
export const SKIP_PERMISSIONS_LABEL = 'Skip Permissions';

/** Settings-modal label of standalone's host-Directory toggle. */
export const SHOW_START_DIRECTORY_LABEL = 'Show Start Directory';

/**
 * Launch an agent through the launch button: a plain press opens the Directory
 * drawer (it never launches by itself), and the launch is the click on a row.
 * Clicks the first row — the only one in a single-Directory office.
 */
export async function clickAddAgent(surface: WebviewSurface): Promise<void> {
  const btn = surface.locator('button', { hasText: '+ Agent' });
  await expect(btn).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await btn.click();
  const drawer = getLaunchDrawer(surface);
  await expect(drawer).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  // The DropdownItem is the row's first button (a pencil may follow it).
  await drawer.locator('[data-testid="directory-row"]').first().locator('button').first().click();
}

/** The launch button's drawer, once opened. */
export function getLaunchDrawer(surface: WebviewSurface): Locator {
  return surface.locator('[data-testid="launch-drawer"]');
}

/**
 * Open the launch drawer with the desktop secondary gesture (hovering the
 * launch button) and return it. Rows are buttons named after their Directory,
 * so callers select one with `drawer.getByRole('button', { name, exact: true })`.
 */
export async function openLaunchDrawer(surface: WebviewSurface): Promise<Locator> {
  const btn = surface.locator('button', { hasText: '+ Agent' });
  await expect(btn).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await btn.hover();
  const drawer = getLaunchDrawer(surface);
  await expect(drawer).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  return drawer;
}

/** The Directory modal, once opened from the drawer's `+ Directory` / pencil. */
export function getDirectoryModal(surface: WebviewSurface): Locator {
  return surface.locator('[data-testid="directory-modal"]');
}

/** Open the drawer's `+ Directory` row and return the modal it opens. */
export async function openDirectoryModal(surface: WebviewSurface): Promise<Locator> {
  const drawer = await openLaunchDrawer(surface);
  await drawer.getByRole('button', { name: '+ Directory', exact: true }).click();
  const modal = getDirectoryModal(surface);
  await expect(modal).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  return modal;
}

export interface DirectoryModalValues {
  name: string;
  path: string;
  /** Areas to tick in the modal's multi-select (the Directory→Area mapping). */
  areas?: string[];
}

/**
 * Fill the open Directory modal and press Save. The host validates the path, so
 * this returns without asserting the outcome: callers assert either the new
 * drawer row (accepted) or the modal's inline error (refused).
 */
export async function submitDirectoryModal(
  modal: Locator,
  values: DirectoryModalValues,
): Promise<void> {
  await modal.getByPlaceholder('Project name').fill(values.name);
  await modal.getByPlaceholder('~/code/my-project').fill(values.path);
  for (const area of values.areas ?? []) {
    await getDirectoryAreas(modal).getByRole('button', { name: area, exact: true }).click();
  }
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
}

/** Add a Directory end to end: open the modal, fill it, and wait for the row to
 *  appear in the drawer (the rebroadcast list is the success signal). */
export async function addDirectory(
  surface: WebviewSurface,
  values: DirectoryModalValues,
): Promise<void> {
  const modal = await openDirectoryModal(surface);
  await submitDirectoryModal(modal, values);
  await expect(modal).toBeHidden({ timeout: WEBVIEW_TIMEOUT_MS });
  const drawer = await openLaunchDrawer(surface);
  await expect(drawer.getByRole('button', { name: values.name, exact: true })).toBeVisible({
    timeout: WEBVIEW_TIMEOUT_MS,
  });
}

/** The modal's tappable path suggestions (absent entirely when there are none). */
export function getDirectorySuggestions(modal: Locator): Locator {
  return modal.locator('[data-testid="directory-suggestions"]');
}

/** The modal's Area multi-select (absent entirely when the layout has no Areas). */
export function getDirectoryAreas(modal: Locator): Locator {
  return modal.locator('[data-testid="directory-areas"]');
}

async function setCheckbox(modal: Locator, label: string, checked: boolean): Promise<void> {
  const button = modal.locator('button', { hasText: label });
  await expect(button).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });

  const indicator = button.locator('span').last();
  const isChecked = ((await indicator.textContent()) ?? '').trim().toLowerCase() === 'x';
  if (isChecked !== checked) {
    await button.click();
  }
}

export async function openSettingsModal(frame: WebviewSurface): Promise<Locator> {
  const settingsButton = frame.locator('button', { hasText: 'Settings' });
  await expect(settingsButton).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await settingsButton.click();

  const settingsModal = frame
    .locator('div.fixed')
    .filter({ has: frame.getByText('Settings', { exact: true }) });
  await expect(settingsModal).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  return settingsModal;
}

async function closeSettingsModal(settingsModal: Locator): Promise<void> {
  const closeButton = settingsModal.getByRole('button', { name: 'x', exact: true });
  await expect(closeButton).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await closeButton.click();
  await expect(settingsModal).toBeHidden({ timeout: WEBVIEW_TIMEOUT_MS });
}

/**
 * Read the checked state of a Settings modal toggle without changing it.
 * Used by the settings-persistence test to assert state survives a panel reload.
 */
export async function getSettingChecked(frame: WebviewSurface, label: string): Promise<boolean> {
  const settingsModal = await openSettingsModal(frame);
  const button = settingsModal.locator('button', { hasText: label });
  await expect(button).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  const indicator = button.locator('span').last();
  const checked = ((await indicator.textContent()) ?? '').trim().toLowerCase() === 'x';
  await closeSettingsModal(settingsModal);
  return checked;
}

export async function setSettings(frame: WebviewSurface, settings: WebviewSettings): Promise<void> {
  const settingsModal = await openSettingsModal(frame);

  if (settings.watchAllSessions !== undefined) {
    await setCheckbox(settingsModal, 'Watch All Sessions', settings.watchAllSessions);
  }
  if (settings.hooksEnabled !== undefined) {
    await setCheckbox(settingsModal, 'Instant Detection (Hooks)', settings.hooksEnabled);
  }
  if (settings.alwaysShowLabels !== undefined) {
    await setCheckbox(settingsModal, 'Always Show Labels', settings.alwaysShowLabels);
  }
  if (settings.ghostHeadlessAgents !== undefined) {
    await setCheckbox(settingsModal, 'Display Headless as Ghosts', settings.ghostHeadlessAgents);
  }
  if (settings.debugView !== undefined) {
    await setCheckbox(settingsModal, 'Debug View', settings.debugView);
  }
  if (settings.bypassPermissions !== undefined) {
    await setCheckbox(settingsModal, SKIP_PERMISSIONS_LABEL, settings.bypassPermissions);
  }
  if (settings.showStartDirectory !== undefined) {
    await setCheckbox(settingsModal, SHOW_START_DIRECTORY_LABEL, settings.showStartDirectory);
  }

  await closeSettingsModal(settingsModal);

  // Allow the server to process settings updates before the test continues.
  await frame.waitForTimeout(500);
}
