import { formatDate, t } from './i18n';

/** Only scheduling metadata crosses IPC; no response body or credentials. */
export interface RateLimitInfo {
  retryAt: number;
  resource: string;
  kind: 'primary' | 'secondary';
  authenticated: boolean;
}

export const RATE_LIMIT_CODE = 'github_rate_limited' as const;

export function isRateLimitInfo(value: unknown): value is RateLimitInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Partial<RateLimitInfo>;
  return typeof info.retryAt === 'number' && Number.isFinite(info.retryAt) && info.retryAt > 0
    && info.retryAt <= 8_640_000_000_000_000
    && typeof info.resource === 'string' && /^[a-z][a-z0-9_.:-]{0,79}$/.test(info.resource)
    && (info.kind === 'primary' || info.kind === 'secondary') && typeof info.authenticated === 'boolean';
}

export function getRateLimitInfo(error: unknown): RateLimitInfo | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; rateLimit?: unknown };
  return candidate.code === RATE_LIMIT_CODE && isRateLimitInfo(candidate.rateLimit) ? candidate.rateLimit : undefined;
}

export function rateLimitMessage(info: RateLimitInfo): string {
  const time = formatDate(info.retryAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (info.kind === 'secondary') return t('GitHub 暂时限制了请求频率，已停止继续请求。请在 {{time}} 后重试。', { time });
  return info.authenticated
    ? t('GitHub 请求额度暂时用尽，已停止继续请求。请在 {{time}} 后重试。', { time })
    : t('GitHub 访客请求额度暂时用尽，已停止继续请求。请登录 GitHub 后重试，或在 {{time}} 后重试。', { time });
}

/** Decorate the client's own error class so existing status/instanceof checks remain valid. */
export function withRateLimit<T extends Error>(error: T, info: RateLimitInfo): T & { code: typeof RATE_LIMIT_CODE; rateLimit: RateLimitInfo } {
  return Object.assign(error, { code: RATE_LIMIT_CODE, rateLimit: { ...info } });
}
