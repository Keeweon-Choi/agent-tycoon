import { useSyncExternalStore } from 'react';

import { en, type TranslationKey } from './en.js';
import { ko } from './ko.js';

export type { TranslationKey } from './en.js';

export type Language = 'en' | 'ko';
const STORAGE_KEY = 'cld.lang';
const listeners = new Set<() => void>();

function preferredLanguage(): Language {
  if (typeof window === 'undefined') return 'en';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ko') return saved;
  } catch {
    // Private browsing may disallow storage; browser preference still works.
  }
  return navigator.languages?.some((locale) => /^ko(?:-|$)/i.test(locale)) ? 'ko' : 'en';
}

let language: Language = preferredLanguage();
if (typeof document !== 'undefined') document.documentElement.lang = language;

export function getLanguage(): Language {
  return language;
}

export function setLanguage(next: Language): void {
  language = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Keep the chosen language until this page closes.
  }
  listeners.forEach((listener) => listener());
}

/** For stores that hold daemon texts: told when the language changes. */
export function subscribeLanguage(listener: () => void): () => void {
  return subscribe(listener);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, () => 'en');
}

export function translate(
  key: TranslationKey,
  vars?: Record<string, string | number>,
  selected: Language = language,
  korean: Partial<Record<TranslationKey, string>> = ko,
): string {
  const template = (selected === 'ko' ? korean[key] : undefined) ?? en[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars?.[name] === undefined ? match : String(vars[name]),
  );
}

export const t = (key: TranslationKey, vars?: Record<string, string | number>): string =>
  translate(key, vars);
