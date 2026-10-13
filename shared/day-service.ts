import { t } from './i18n';
import { PARSER_VERSION, validateDate } from './domain';
import type { ProblemDay } from './types';

type FetchDay = (date: string | undefined, refresh: boolean) => Promise<ProblemDay>;

function validDay(value: unknown, date?: string): value is ProblemDay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const day = value as ProblemDay;
  if (day.parserVersion !== PARSER_VERSION || typeof day.sourceUrl !== 'string' || typeof day.fetchedAt !== 'string' ||
      !Number.isFinite(Date.parse(day.fetchedAt)) || !Array.isArray(day.problems) || (date !== undefined && day.date !== date)) return false;
  try { validateDate(day.date); } catch { return false; }
  return day.problems.every(problem => !!problem && typeof problem === 'object' && typeof problem.id === 'string' &&
    typeof problem.label === 'string' && typeof problem.url === 'string' && typeof problem.hint === 'string');
}

/** Each call reads the remote source and validates its result without retaining data. */
export async function readProblemDay(fetchDay: FetchDay, value?: string, refresh?: boolean): Promise<ProblemDay> {
  const date = value === undefined ? undefined : validateDate(value);
  const day = await fetchDay(date, refresh === true);
  if (!validDay(day, date)) throw new Error(t('远程题单数据不完整或日期不匹配，请重试。'));
  return day;
}
