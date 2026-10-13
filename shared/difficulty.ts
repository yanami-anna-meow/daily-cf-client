import { t } from './i18n';
export interface DifficultyRange {
  minimum: number | null;
  maximum: number | null;
  active: boolean;
  error: string | null;
}

/** Bounds describe repository ratings, independently of stars, contest kind or today's date. */
export function parseDifficultyRange(minimumText: string, maximumText: string): DifficultyRange {
  const texts = [minimumText.trim(), maximumText.trim()];
  const values: Array<number | null> = [];
  for (const [index, text] of texts.entries()) {
    if (!text) { values.push(null); continue; }
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) {
      return { minimum: null, maximum: null, active: true,
        error: index === 0 ? t('最低难度请输入非负整数，或留空表示不限。') : t('最高难度请输入非负整数，或留空表示不限。') };
    }
    values.push(value);
  }
  const [minimum, maximum] = values;
  if (minimum !== null && maximum !== null && minimum > maximum) {
    return { minimum, maximum, active: true, error: t('最低难度不能大于最高难度。') };
  }
  return { minimum, maximum, active: minimum !== null || maximum !== null, error: null };
}

export function matchesDifficulty(rating: number | null, range: DifficultyRange): boolean {
  if (range.error) return false;
  if (rating === null) return !range.active;
  if (!Number.isFinite(rating)) return false;
  return (range.minimum === null || rating >= range.minimum)
    && (range.maximum === null || rating <= range.maximum);
}
