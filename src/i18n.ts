import { useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale, t } from '../shared/i18n';

export { t, getLocale, setLocale, resolveLocale, formatDate, formatNumber } from '../shared/i18n';
export type { AppLocale, UiLanguage, TranslationParams } from '../shared/i18n';

export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

export function useTranslation() {
  const locale = useLocale();
  return { t, locale };
}
