import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubAuth } from '../electron/auth';
import { BatchSubmissionEngine, type BatchAdapter } from '../electron/batch-submit';
import { GitHubClient, GitHubError } from '../electron/github';
import { ProblemLibrary } from '../electron/library';
import { setLocale } from '../shared/i18n';
import type { BatchSubmissionInput } from '../shared/types';

describe('localized backend operations', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => {
    setLocale('zh-CN');
    vi.useRealTimers();
  });

  it('uses the current language on an existing auth service without starting a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const auth = new GitHubAuth({ fetch: fetcher, onToken: vi.fn(), onError: vi.fn() });
    await expect(auth.begin('')).rejects.toThrow('Enter a valid GitHub OAuth App Client ID');
    setLocale('zh-CN');
    await expect(auth.begin('')).rejects.toThrow('请先在设置中填写有效的 GitHub OAuth App Client ID。');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports a pending login expiry in the new language and still stops polling', async () => {
    vi.useFakeTimers();
    setLocale('zh-CN');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      device_code: 'private-device-code', user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device', expires_in: 1, interval: 5,
    })));
    const onError = vi.fn();
    const onToken = vi.fn();
    const auth = new GitHubAuth({ fetch: fetcher, onToken, onError });
    await auth.begin('client-id');
    setLocale('en');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith('Your GitHub verification code has expired. Sign in again.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the library authentication status and no-store request policy in English', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    const library = new ProblemLibrary('test-token', { fetch: fetcher });
    await expect(library.getArchiveMonths()).rejects.toMatchObject({
      name: 'LibraryError', status: 401,
      message: 'Your GitHub session has expired. Sign in again and retry.',
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('api.github.com/repos/'), expect.objectContaining({
      cache: 'no-store', redirect: 'error',
    }));
  });

  it('interpolates an HTTP status without changing its machine-readable value', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 502 }));
    const library = new ProblemLibrary(undefined, { fetch: fetcher });
    await expect(library.getArchiveMonths()).rejects.toMatchObject({
      name: 'LibraryError', status: 502, message: 'Could not read from GitHub (HTTP 502). Try again later.',
    });
  });

  it('retains GitHub authorization error status and never retries a read as a write', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"message":"Bad credentials"}', { status: 401 }));
    const github = new GitHubClient('test-token', { fetch: fetcher });
    const failure = await github.getUser().catch(error => error as GitHubError);
    expect(failure).toBeInstanceOf(GitHubError);
    if (!(failure instanceof GitHubError)) throw new Error('Expected GitHub authorization to fail');
    expect(failure).toMatchObject({ status: 401 });
    expect(failure.message).toMatch(/GitHub/);
    expect(failure.message).not.toMatch(/\p{Script=Han}/u);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.github.com/user', expect.objectContaining({ method: 'GET' }));
  });

  it('rejects an empty batch in English before calling any repository capability', async () => {
    const request = vi.fn();
    const getUser = vi.fn();
    const engine = new BatchSubmissionEngine({
      request, getUser, error: (message: string) => new GitHubError(message),
    } as unknown as BatchAdapter);
    await expect(engine.preview({ target: { kind: 'new' }, items: [], notes: '', requestId: 'empty-batch-test-001' } as BatchSubmissionInput))
      .rejects.toThrow('Choose 1–50 code files');
    expect(request).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });
});
