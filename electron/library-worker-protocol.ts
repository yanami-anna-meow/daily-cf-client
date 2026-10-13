import type { AppLocale } from '../shared/i18n';
import type { ApiResult, ClientAPI, LibrarySyncProgress } from '../shared/types';

export const LIBRARY_METHODS = ['syncLibrary', 'getLocalLibraryView', 'getDay', 'getArchiveMonths', 'getArchiveSnapshot',
  'getMonthFromSnapshot', 'getMonth', 'getResources', 'getReference'] as const;
export type LibraryMethod = typeof LIBRARY_METHODS[number];
export type LibraryReader = Pick<ClientAPI, LibraryMethod>;
export interface LibraryWorkerRequest {
  type: 'request';
  id: number;
  method: LibraryMethod;
  args: unknown[];
  locale: AppLocale;
}
export type LibraryWorkerInput = LibraryWorkerRequest | { type: 'locale'; locale: AppLocale };
export type LibraryWorkerOutput = { type: 'response'; id: number; result: ApiResult<unknown> }
  | { type: 'progress'; progress: LibrarySyncProgress };

/** Only public progress fields cross the worker/renderer boundaries. */
export function publicLibraryProgress(value: unknown): LibrarySyncProgress | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<LibrarySyncProgress>;
  if (!['checking', 'repairing', 'downloading', 'indexing', 'ready', 'error'].includes(item.phase ?? '') ||
    !['bytes', 'objects'].includes(item.unit ?? '') || typeof item.completed !== 'number' ||
    !Number.isSafeInteger(item.completed) || item.completed < 0) return null;
  return {
    phase: item.phase!, completed: item.completed, unit: item.unit!,
    ...(typeof item.total === 'number' && Number.isSafeInteger(item.total) && item.total >= 0 ? { total: item.total } : {}),
    ...(typeof item.message === 'string' ? { message: item.message.slice(0, 2000) } : {}),
    ...(typeof item.revision === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(item.revision) ? { revision: item.revision } : {}),
    ...(typeof item.updatedAt === 'string' && item.updatedAt.length <= 40 && Number.isFinite(Date.parse(item.updatedAt)) ? { updatedAt: item.updatedAt } : {}),
  };
}
