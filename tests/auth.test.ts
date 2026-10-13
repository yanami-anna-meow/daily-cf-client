import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubAuth } from '../electron/auth';

const DEVICE = {
  device_code: 'private_device_code', user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
};
const TOKEN = { access_token: 'gho_private_token', token_type: 'bearer', scope: 'public_repo' };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function setup(responses: unknown[] = []) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const body of responses) fetch.mockResolvedValueOnce(response(body));
  const onToken = vi.fn<(token: string, signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
  const onError = vi.fn<(message: string) => void>();
  const auth = new GitHubAuth({ fetch, onToken, onError });
  return { auth, fetch, onToken, onError };
}

describe('GitHub device authorization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T04:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('returns only display information and waits the full interval before exchanging the code', async () => {
    const { auth, fetch, onToken } = setup([DEVICE, TOKEN]);
    const login = await auth.begin('client_id');
    expect(login).toEqual({ userCode: 'ABCD-1234', verificationUri: DEVICE.verification_uri, expiresAt: Date.now() + 900_000 });
    expect(JSON.stringify(login)).not.toContain(DEVICE.device_code);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://github.com/login/device/code');
    expect(new URLSearchParams(options?.body as string).get('scope')).toBe('public_repo');
    expect(options).toMatchObject({ redirect: 'error', credentials: 'omit' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenOptions] = fetch.mock.calls[1];
    expect(tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(Object.fromEntries(new URLSearchParams(tokenOptions?.body as string))).toEqual({
      client_id: 'client_id', device_code: DEVICE.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    expect(onToken).toHaveBeenCalledWith(TOKEN.access_token, expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps pending polls spaced and applies cumulative slow_down intervals', async () => {
    const { auth, fetch, onToken } = setup([
      DEVICE, { error: 'authorization_pending' }, { error: 'slow_down' },
      { error: 'slow_down', interval: 20 }, TOKEN,
    ]);
    await auth.begin('client');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(onToken).toHaveBeenCalledTimes(1);
  });

  it('expires locally before another poll and reports expiry once', async () => {
    const { auth, fetch, onError, onToken } = setup([{ ...DEVICE, expires_in: 6 }, { error: 'authorization_pending' }]);
    await auth.begin('client');
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onToken).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('过期'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['access_denied', '取消'], ['expired_token', '过期'], ['token_expired', '过期'],
    ['device_flow_disabled', 'Device Flow'], ['incorrect_client_credentials', 'Client ID'],
  ])('stops polling on %s and gives an actionable message', async (error, message) => {
    const { auth, fetch, onError, onToken } = setup([DEVICE, { error }]);
    await auth.begin('client');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message));
    expect(onToken).not.toHaveBeenCalled();
  });

  it('cancels a pending wait without subsequent callbacks or network requests', async () => {
    const { auth, fetch, onError, onToken } = setup([DEVICE, TOKEN]);
    await auth.begin('client');
    auth.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards a late token from a fetch implementation that ignores abort', async () => {
    const { auth, fetch, onToken, onError } = setup([DEVICE]);
    const late = deferred<Response>();
    fetch.mockReturnValueOnce(late.promise);
    await auth.begin('client');
    await vi.advanceTimersByTimeAsync(5000);
    const requestSignal = fetch.mock.calls[1][1]?.signal;
    auth.cancel();
    expect(requestSignal?.aborted).toBe(true);
    late.resolve(response(TOKEN));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onToken).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('cancels an unfinished begin and allows only the replacement session to log in', async () => {
    const { auth, fetch, onToken, onError } = setup();
    const oldDevice = deferred<Response>();
    fetch.mockReturnValueOnce(oldDevice.promise);
    const oldBegin = auth.begin('old_client');
    const rejected = expect(oldBegin).rejects.toMatchObject({ name: 'AbortError' });
    fetch.mockResolvedValueOnce(response(DEVICE)).mockResolvedValueOnce(response(TOKEN));
    await auth.begin('new_client');
    oldDevice.resolve(response({ ...DEVICE, user_code: 'ZZZZ-9999' }));
    await rejected;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new URLSearchParams(fetch.mock.calls[2][1]?.body as string).get('client_id')).toBe('new_client');
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('aborts the active token callback when the user cancels', async () => {
    const { auth, onToken, onError } = setup([DEVICE, TOKEN]);
    const saved = deferred<void>();
    onToken.mockImplementationOnce(async (_token, signal) => {
      await saved.promise;
      if (signal.aborted) throw new Error('Cancelled while verifying account');
    });
    await auth.begin('client');
    await vi.advanceTimersByTimeAsync(5000);
    const signal = onToken.mock.calls[0][1];
    auth.cancel();
    expect(signal.aborted).toBe(true);
    saved.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('times out even when fetch ignores AbortSignal, without exposing network details', async () => {
    const { auth, fetch, onError } = setup([DEVICE]);
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    await auth.begin('client');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('超时'));
    expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops after a network failure and does not echo secrets in error messages', async () => {
    const { auth, fetch, onError } = setup([DEVICE]);
    fetch.mockRejectedValueOnce(new Error('failed device_code=private_device_code access_token=gho_private_token'));
    await auth.begin('client');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('网络'));
    expect(JSON.stringify(onError.mock.calls)).not.toContain('private_');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { verification_uri: 'https://github.com.evil.example/login/device' },
    { verification_uri: 'javascript:alert(1)' },
    { expires_in: -1 }, { expires_in: Infinity }, { interval: 0 },
    { user_code: '<script>' }, { device_code: '' },
  ])('rejects untrusted or malformed device response %j', async (invalid) => {
    const { auth, fetch, onToken, onError } = setup([{ ...DEVICE, ...invalid }]);
    await expect(auth.begin('client')).rejects.toThrow('无效');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    { token_type: 'mac' }, { access_token: 'contains whitespace' },
    { scope: '' }, { scope: 'read:user' }, { scope: undefined },
  ])('rejects invalid or insufficiently scoped tokens %j', async (invalid) => {
    const { auth, onToken, onError } = setup([DEVICE, { ...TOKEN, ...invalid }]);
    await auth.begin('client');
    await vi.advanceTimersByTimeAsync(5000);
    expect(onToken).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('uses the RFC default interval and accepts the containing repo scope granted previously', async () => {
    const { auth, onToken } = setup([{ ...DEVICE, interval: undefined }, { ...TOKEN, scope: 'repo,read:user' }]);
    await auth.begin('client');
    await vi.advanceTimersByTimeAsync(4999);
    expect(onToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onToken).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid client identifiers before making network requests', async () => {
    const { auth, fetch } = setup();
    await expect(auth.begin('')).rejects.toThrow('Client ID');
    await expect(auth.begin('client&scope=repo')).rejects.toThrow('Client ID');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not leak a failed credential-storage callback or emit an unhandled rejection', async () => {
    const { auth, onToken, onError } = setup([DEVICE, TOKEN]);
    onToken.mockRejectedValueOnce(new Error(TOKEN.access_token));
    onError.mockImplementation(() => { throw new Error('UI closed'); });
    await auth.begin('client');
    await vi.advanceTimersByTimeAsync(5000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('凭据保存失败'));
    expect(JSON.stringify(onError.mock.calls)).not.toContain(TOKEN.access_token);
  });

  it('supports injected time and delay without changing the production polling rules', async () => {
    let now = 1000;
    const delays: number[] = [];
    const gate = deferred<void>();
    const onToken = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(DEVICE)).mockResolvedValueOnce(response(TOKEN));
    const auth = new GitHubAuth({
      fetch, onToken, onError: vi.fn(), now: () => now,
      delay: async (milliseconds) => { delays.push(milliseconds); await gate.promise; now += milliseconds; },
    });
    expect((await auth.begin('client')).expiresAt).toBe(901_000);
    expect(delays).toEqual([5000]);
    expect(onToken).not.toHaveBeenCalled();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(onToken).toHaveBeenCalledTimes(1);
  });
});
