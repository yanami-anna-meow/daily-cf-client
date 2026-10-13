import { describe, expect, it } from 'vitest';
import { serializeApiError, apiResultError } from '../shared/api-errors';
import { getRateLimitInfo, withRateLimit, type RateLimitInfo } from '../shared/rate-limit';
import { shouldExpireGitHubSession } from '../electron/ipc-errors';
import { GitHubError } from '../electron/github';

const limit: RateLimitInfo = { retryAt: 1_800_000_000_000, resource: 'core', kind: 'primary', authenticated: false };

describe('rate limit IPC boundary', () => {
  it('round-trips cooldown metadata without exposing unrelated backend properties', () => {
    const original = withRateLimit(new GitHubError('Wait for GitHub', 403), limit);
    Object.assign(original, { token: 'must-stay-in-main', response: { sensitive: true } });
    Object.assign(original.rateLimit, { token: 'also-private' });
    const result = serializeApiError(original);
    expect(result).toEqual({ ok: false, error: 'Wait for GitHub', code: 'github_rate_limited', rateLimit: limit });
    const renderer = apiResultError(result);
    expect(renderer.message).toBe('Wait for GitHub');
    expect(getRateLimitInfo(renderer)).toEqual(limit);
    expect(renderer).not.toHaveProperty('token');
    expect(renderer).not.toHaveProperty('response');
    expect(shouldExpireGitHubSession('month', original, 'same-account', 'same-account')).toBe(false);
  });

  it.each([NaN, Infinity, -1, 'tomorrow'])('does not forward malformed retryAt %s', retryAt => {
    const result = serializeApiError(Object.assign(new Error('Invalid metadata'), {
      code: 'github_rate_limited', rateLimit: { ...limit, retryAt },
    }));
    expect(result).toEqual({ ok: false, error: 'Invalid metadata' });
    expect(getRateLimitInfo(apiResultError(result))).toBeUndefined();
  });

  it('retains the existing explicit submission recovery code', () => {
    const error = Object.assign(new Error('Preview again'), { code: 'submission_base_changed' });
    expect(apiResultError(serializeApiError(error))).toMatchObject({ message: 'Preview again', code: 'submission_base_changed' });
  });

  it('expires only a rejected active GitHub session while preserving replacement sessions and failed sign-in attempts', () => {
    const expired = Object.assign(new Error('expired'), { status: 401 });
    expect(shouldExpireGitHubSession('contributions', expired, 'same-session', 'same-session')).toBe(true);
    expect(shouldExpireGitHubSession('contributions', expired, 'old-session', 'new-session')).toBe(false);
    expect(shouldExpireGitHubSession('contributions', expired)).toBe(false);
    expect(shouldExpireGitHubSession('token', expired, 'same-session', 'same-session')).toBe(false);
    expect(shouldExpireGitHubSession('login', expired, 'same-session', 'same-session')).toBe(false);
    expect(shouldExpireGitHubSession('contributions', null, 'same-session', 'same-session')).toBe(false);
  });

  it('retains a confirmed deletion through worker and renderer boundaries without leaking private fields', () => {
    const original = Object.assign(new Error('The reference was removed'), {
      code: 'library_content_missing', repositoryPath: 'private/local/library', response: { private: true }, token: 'never-exposed',
    });
    const workerResult = serializeApiError(original);
    expect(workerResult).toEqual({ ok: false, error: 'The reference was removed', code: 'library_content_missing' });
    const mainError = apiResultError(workerResult);
    const rendererResult = serializeApiError(mainError);
    expect(rendererResult).toEqual(workerResult);
    const rendererError = apiResultError(rendererResult);
    expect(rendererError).toMatchObject({ message: 'The reference was removed', code: 'library_content_missing' });
    expect(Object.keys(rendererError)).toEqual(['code']);
    expect(original).toHaveProperty('repositoryPath', 'private/local/library');
  });

  it('does not classify a transport failure or arbitrary error code as confirmed missing content', () => {
    const failure = Object.assign(new Error('Network unavailable'), { code: 'ENETUNREACH', path: 'private/local/path' });
    expect(serializeApiError(failure)).toEqual({ ok: false, error: 'Network unavailable' });
    expect(apiResultError(serializeApiError(failure))).not.toHaveProperty('code');
  });

  it('does not mutate or share the original metadata object', () => {
    const original = withRateLimit(new Error('wait'), limit);
    const result = serializeApiError(original);
    const renderer = apiResultError(result);
    getRateLimitInfo(renderer)!.retryAt++;
    expect(result.rateLimit).toEqual(limit);
    expect(original.rateLimit).toEqual(limit);
  });
});
