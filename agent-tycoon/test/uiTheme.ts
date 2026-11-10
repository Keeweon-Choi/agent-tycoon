/**
 * FEAT-UI-MODERN-THEME: the runners' shared knobs for 화면 스타일 pictures. UI_THEME=modern|pixel stores the
 * setting before the page loads (the old 글꼴 key too, so a build from before the setting moved shows the same
 * look); OUT_DIR sends the pictures elsewhere; ports 18830-18839 and 18980-18989 are the spare ranges.
 */
const theme = process.env.UI_THEME;
export const UI_THEME_INIT = theme
  ? `try { localStorage.setItem('agty.ui-theme', ${JSON.stringify(theme)}); localStorage.setItem('agty.ui-font.v2', ${JSON.stringify(theme === 'pixel' ? 'pixel' : 'readable')}); } catch { /* about:blank */ }`
  : '';
export const outDir = (fallback: string): string => process.env.OUT_DIR ?? fallback;
export const themePort = (port: number): boolean => (port >= 18830 && port <= 18839) || (port >= 18980 && port <= 18989);
