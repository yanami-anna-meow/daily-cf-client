import { t } from './i18n';
import { getRateLimitInfo, type RateLimitInfo } from './rate-limit';
import type { ApiResult } from './types';

function publicLimit(info: RateLimitInfo): RateLimitInfo {
  return { retryAt: info.retryAt, resource: info.resource, kind: info.kind, authenticated: info.authenticated };
}

/** Keep credentials, response bodies and arbitrary error properties inside the main process. */
export function serializeApiError(error: unknown): ApiResult<never> {
  const limit = getRateLimitInfo(error);
  return { ok: false, error: error instanceof Error ? error.message : t('操作失败，请重试。'),
    ...(limit ? { code: 'github_rate_limited' as const, rateLimit: publicLimit(limit) }
      : error && typeof error === 'object' && 'code' in error && (error.code === 'submission_base_changed' || error.code === 'library_content_missing')
        ? { code: error.code } : {}),
  };
}

export function apiResultError(result: ApiResult<unknown>): Error {
  const error = new Error(result.error || t('操作失败，请重试。'));
  const limit = getRateLimitInfo(result);
  return Object.assign(error, limit ? { code: 'github_rate_limited', rateLimit: publicLimit(limit) }
    : result.code === 'submission_base_changed' || result.code === 'library_content_missing' ? { code: result.code } : {});
}
