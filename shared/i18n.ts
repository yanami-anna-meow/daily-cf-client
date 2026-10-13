import { en as app } from './locales/app';
import { en as appUpdateBackend } from './locales/app-update-backend';
import { en as appUpdateNative } from './locales/app-update-native';
import { en as appUpdateUi } from './locales/app-update-ui';
import { en as backend } from './locales/backend';
import { en as components } from './locales/components';
import { en as composer } from './locales/composer';
import { en as gitLibrary } from './locales/git-library';
import { en as gitRepository } from './locales/git-repository';
import { en as gitSyncUi } from './locales/git-sync-ui';
import { en as native } from './locales/native';
import { en as rateLimit } from './locales/rate-limit';
import { en as retainedContent } from './locales/retained-content';
import { en as libraryRetained } from './locales/library-retained';
import { en as shared } from './locales/shared';

export type AppLocale = 'zh-CN' | 'en';
export type UiLanguage = 'system' | AppLocale;
export type TranslationParams = Readonly<Record<string, string | number>>;

const english: Readonly<Record<string, string>> = Object.freeze(Object.assign(
  Object.create(null) as Record<string, string>,
  app, appUpdateBackend, appUpdateNative, appUpdateUi, backend, components, composer, gitLibrary, gitRepository, gitSyncUi, native, rateLimit, retainedContent, libraryRetained, shared,
));

// Production bootstraps explicitly apply the saved preference and system language.
// Keeping the initial source language also makes shared helpers deterministic in tests.
let locale: AppLocale = 'zh-CN';
const listeners = new Set<() => void>();

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === 'zh-CN' || value === 'en' ? value : 'system';
}

export function resolveLocale(preference: UiLanguage, systemLanguages: readonly string[]): AppLocale {
  const normalized = normalizeUiLanguage(preference);
  if (normalized !== 'system') return normalized;
  // An unsupported primary system language falls back to English. A secondary
  // preferred language must not unexpectedly override that choice.
  const primary = typeof systemLanguages?.[0] === 'string' ? systemLanguages[0].trim() : '';
  try {
    // Some operating systems expose underscores rather than BCP 47 hyphens.
    return new Intl.Locale(primary.replace(/_/g, '-')).language === 'zh' ? 'zh-CN' : 'en';
  } catch {
    return 'en';
  }
}

function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

export function setLocale(preference: UiLanguage, languages: readonly string[] = systemLanguages()): void {
  const next = resolveLocale(preference, languages);
  if (next === locale) return;
  locale = next;
  // Snapshot subscriptions so subscribing during notification waits for the next change.
  for (const listener of [...listeners]) listener();
}

export function getLocale(): AppLocale { return locale; }

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Translate application-owned messages only; user and repository content stay untouched. */
export function t(sourceZh: string, params?: TranslationParams): string {
  const message = locale === 'en' && Object.hasOwn(english, sourceZh) ? english[sourceZh] : sourceZh;
  if (!params) return message;
  // One pass preserves literal placeholders inside uploaded filenames or other values.
  // Own-property checks prevent inherited names such as "constructor" from resolving.
  return message.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (placeholder, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : placeholder);
}

export function formatNumber(value: number | bigint, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  // A repository YYYY-MM-DD is a calendar date, not a UTC instant. Preserve it
  // across system time zones instead of shifting to the previous/next day.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value;
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, options).format(date);
}
