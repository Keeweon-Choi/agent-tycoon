/** Strings of lazily loaded modules. They register themselves at load (specStrings.ts), so the main bundle carries none of them. */
export const extraEn: Record<string, string> = {};
export const extraKo: Record<string, string> = {};

/** Adding the same strings twice is harmless. */
export function addStrings(en: Record<string, string>, ko: Record<string, string>): void {
  Object.assign(extraEn, en);
  Object.assign(extraKo, ko);
}
