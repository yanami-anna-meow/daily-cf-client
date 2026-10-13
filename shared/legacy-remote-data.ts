import { validateDate } from './domain';

/** The only remote-data keys persisted by earlier application versions. */
export function isLegacyRemoteDataKey(value: string): boolean {
  if (value === 'library' || value === 'day-latest') return true;
  const date = /^day-(\d{4}-\d{2}-\d{2})$/.exec(value)?.[1];
  if (!date) return false;
  try { validateDate(date); return true; } catch { return false; }
}

export function isLegacyRemoteDataFile(value: string): boolean {
  const key = /^(.*)\.json(?:\.tmp)?$/.exec(value)?.[1];
  return key !== undefined && isLegacyRemoteDataKey(key);
}
