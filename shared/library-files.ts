import { validateDate } from './domain';
import { t } from './i18n';
import type { LocalLibraryViewRequest } from './types';
import { extensionLanguageLabel, importExtension, normalizeExtension } from './file-formats';

export const MAX_LIBRARY_FILE_BYTES = 1024 * 1024;

export function libraryMonth(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(t('月份格式应为 YYYY-MM，例如 2026-10。'));
  validateDate(`${value}-01`);
  return value;
}

export function libraryProblemId(value: string): string {
  if (typeof value !== 'string' || !/^cf\d+[a-z]\d*$/.test(value)) throw new Error(t('题号无效，请从每日题单中选择题目。'));
  return value;
}

export function referenceInfo(path: string): { date: string; name: string; language: string } {
  if (typeof path !== 'string' || path.length > 512 || /[%\\\x00-\x1f]/.test(path)) throw new Error(t('参考代码路径无效。'));
  const match = /^daily_problems\/(\d{4})\/(\d{2})\/(\d{4})\/personal_submission\/(cf\d+[a-z]\d*_[^/]+\.[^/]+)$/.exec(path);
  if (!match || match[2] !== match[3].slice(0, 2)) {
    throw new Error(t('只能读取每日一题 personal_submission 目录中的解答文件。'));
  }
  const date = validateDate(`${match[1]}-${match[2]}-${match[3].slice(2)}`);
  const extension = normalizeExtension(importExtension(match[4]));
  return { date, name: match[4], language: extensionLanguageLabel(extension) };
}

/** Whitelist the read-only preview request at both IPC and worker boundaries. */
export function localLibraryViewInput(value: unknown): LocalLibraryViewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('题库读取请求无效。'));
  const request = value as Record<string, unknown>;
  if (request.kind === 'day') {
    return { kind: 'day', ...(request.date === undefined ? {} : { date: validateDate(request.date as string) }) };
  }
  if (request.kind === 'archive' && (request.scope === 'month' || request.scope === 'all')) {
    return { kind: 'archive', scope: request.scope, ...(request.month === undefined ? {} : { month: libraryMonth(request.month as string) }) };
  }
  if (request.kind === 'resources') {
    return { kind: 'resources', date: validateDate(request.date as string), problemId: libraryProblemId(request.problemId as string) };
  }
  if (request.kind === 'reference') {
    referenceInfo(request.path as string);
    return { kind: 'reference', path: request.path as string };
  }
  throw new Error(t('题库读取请求无效。'));
}
