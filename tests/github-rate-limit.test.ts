import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient, GitHubError } from '../electron/github';
import { GitHubRateLimitGate, rateLimitResponseDetail } from '../electron/github-rate-limit';
import { LibraryError, ProblemLibrary } from '../electron/library';
import { shouldExpireGitHubSession } from '../electron/ipc-errors';
import { getRateLimitInfo, isRateLimitInfo, rateLimitMessage, withRateLimit, type RateLimitInfo } from '../shared/rate-limit';
import { setLocale } from '../shared/i18n';
import { UPSTREAM } from '../shared/types';

const now = Date.UTC(2026, 9, 9, 8);
const api = 'https://api.github.com';
const repo = `${api}/repos/${UPSTREAM.owner}/${UPSTREAM.repo}`;
const core = `${api}/user`;
const search = `${api}/search/issues?q=repo:test/test`;
const raw = 'https://raw.githubusercontent.com/test/test/main/example.cpp';
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers });
const primaryHeaders = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 120_000) / 1000) };

afterEach(() => setLocale('zh-CN'));

describe('GitHub API cooldown scheduling', () => {
  it.each(['core', 'search'])('isolates the %s primary allowance from the other bucket and raw files', resource => {
    const gate = new GitHubRateLimitGate({ now: () => now });
    const url = resource === 'core' ? core : search;
    const other = resource === 'core' ? search : core;
    const failure = gate.observe(url, json({}, 403, { ...primaryHeaders, 'x-ratelimit-resource': resource }), '', false);
    expect(failure).toEqual({ retryAt: now + 120_000, kind: 'primary', resource, authenticated: false });
    expect(gate.blocked(url)).toEqual(failure);
    expect(gate.blocked(other)).toBeUndefined();
    expect(gate.blocked(raw)).toBeUndefined();
  });

  it('allows the response that spends the last request and blocks only subsequent work', () => {
    let clock = now;
    const gate = new GitHubRateLimitGate({ now: () => clock });
    expect(gate.observe(core, json({ login: 'alice' }, 200, primaryHeaders), '', true)).toBeUndefined();
    expect(gate.blocked(core)?.retryAt).toBe(now + 120_000);
    clock = now + 119_999;
    expect(gate.blocked(core)).toBeDefined();
    clock++;
    expect(gate.blocked(core)).toBeUndefined();
  });

  it('honors retry-after before the primary reset and does not shorten an existing cooldown', () => {
    const gate = new GitHubRateLimitGate({ now: () => now });
    gate.observe(core, json({}, 403, { ...primaryHeaders, 'retry-after': '180' }), '', true);
    const late = gate.observe(core, json({}, 403, { ...primaryHeaders, 'retry-after': '10' }), '', true);
    expect(late?.retryAt).toBe(now + 180_000);
    expect(gate.blocked(core)?.retryAt).toBe(now + 180_000);
  });

  it.each([
    { status: 403, headers: {}, detail: 'You have exceeded a secondary rate limit.' },
    { status: 403, headers: {}, detail: 'You have triggered an abuse detection mechanism.' },
    { status: 403, headers: { 'retry-after': '60' }, detail: '' },
    { status: 429, headers: {}, detail: '' },
  ])('pauses both API buckets for a secondary limit: %j', ({ status, headers, detail }) => {
    const gate = new GitHubRateLimitGate({ now: () => now });
    const info = gate.observe(search, json({}, status, headers as Record<string, string>), detail, true);
    expect(info).toMatchObject({ kind: 'secondary', retryAt: now + 60_000, resource: 'search' });
    expect(gate.blocked(core)).toEqual(info);
    expect(gate.blocked(search)).toEqual(info);
    expect(gate.blocked(raw)).toBeUndefined();
  });

  it('uses secondary retry-after without confusing a still available primary reset', () => {
    const gate = new GitHubRateLimitGate({ now: () => now });
    const info = gate.observe(core, json({}, 429, { 'retry-after': '12', 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': String((now + 3600_000) / 1000) }), '', true);
    expect(info?.retryAt).toBe(now + 12_000);
    expect(info?.kind).toBe('secondary');
  });

  it.each([undefined, '', '-1', '0', 'NaN', 'Infinity', '9'.repeat(400), String((now - 10_000) / 1000)])('uses a finite fallback when reset is unusable: %s', reset => {
    const gate = new GitHubRateLimitGate({ now: () => now });
    const headers: Record<string, string> = { 'x-ratelimit-remaining': '0' };
    if (reset !== undefined) headers['x-ratelimit-reset'] = reset;
    expect(gate.observe(core, json({}, 403, headers), '', false)).toMatchObject({ kind: 'primary', retryAt: now + 60_000 });
  });

  it('recognizes a primary message even when headers are unavailable', () => {
    const gate = new GitHubRateLimitGate({ now: () => now });
    expect(gate.observe(core, json({}, 403), 'API rate limit exceeded for user', true)).toMatchObject({ kind: 'primary', retryAt: now + 60_000 });
  });

  it.each([401, 403, 404, 422, 500])('does not treat ordinary HTTP %s failures as rate limits', status => {
    const gate = new GitHubRateLimitGate({ now: () => now });
    expect(gate.observe(core, json({}, status), 'Permission denied', true)).toBeUndefined();
    expect(gate.blocked(core)).toBeUndefined();
  });

  it('keeps raw-host throttling separate from the API allowance', () => {
    const gate = new GitHubRateLimitGate({ now: () => now });
    const info = gate.observe(raw, json({}, 429, { 'retry-after': '120' }), '', false);
    expect(info).toMatchObject({ resource: 'raw', kind: 'secondary', retryAt: now + 120_000 });
    expect(gate.blocked(raw)).toEqual(info);
    expect(gate.blocked(core)).toBeUndefined();
    expect(gate.blocked(search)).toBeUndefined();
  });

  it('does not let a caller mutate stored metadata', () => {
    const gate = new GitHubRateLimitGate({ now: () => now });
    const info = gate.observe(core, json({}, 403, primaryHeaders), '', true)!;
    info.retryAt = now;
    const read = gate.blocked(core)!;
    read.retryAt = now;
    expect(gate.blocked(core)?.retryAt).toBe(now + 120_000);
  });

  it('bounds the inspected error page and cancels the remaining stream', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(20_000))); }, cancel,
    }), { status: 403 });
    expect((await rateLimitResponseDetail(response)).length).toBe(16_384);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('rate-limit errors cross the client boundary without repeated network requests', () => {
  it.each(['github', 'library'])('preserves a header-confirmed limit when the %s error body is unreadable', async client => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('truncated response body')); },
    }), { status: 403, headers: primaryHeaders }));
    const rateLimitGate = new GitHubRateLimitGate({ now: () => now });
    const operation = client === 'github'
      ? new GitHubClient('test-token', { fetch: fetcher, rateLimitGate }).getUser()
      : new ProblemLibrary('test-token', { fetch: fetcher, rateLimitGate }).getArchiveMonths();
    await expect(operation).rejects.toMatchObject({ status: 403, code: 'github_rate_limited', rateLimit: { retryAt: now + 120_000 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares an exhausted core allowance between clients and resumes only after expiry', async () => {
    let clock = now;
    const gate = new GitHubRateLimitGate({ now: () => clock });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ message: 'API rate limit exceeded' }, 403, primaryHeaders));
    const github = new GitHubClient('test-token', { fetch: fetcher, rateLimitGate: gate });
    const library = new ProblemLibrary('test-token', { fetch: fetcher, rateLimitGate: gate });
    const first = await github.getUser().catch(error => error);
    expect(first).toBeInstanceOf(GitHubError);
    expect(first).toMatchObject({ status: 403, code: 'github_rate_limited', rateLimit: { authenticated: true } });
    const second = await library.getArchiveMonths().catch(error => error);
    expect(second).toBeInstanceOf(LibraryError);
    expect(getRateLimitInfo(second)).toEqual(getRateLimitInfo(first));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(shouldExpireGitHubSession('archive-months', second, 'test-token', 'test-token')).toBe(false);
    clock += 120_000;
    fetcher.mockImplementation(async () => json({ login: 'alice', name: null, avatar_url: '' }));
    await expect(github.getUser()).resolves.toMatchObject({ login: 'alice' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains the successful final response, then blocks the next call locally', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ login: 'alice', name: null, avatar_url: '' }, 200, primaryHeaders));
    const github = new GitHubClient('test-token', { fetch: fetcher, rateLimitGate: new GitHubRateLimitGate({ now: () => now }) });
    await expect(github.getUser()).resolves.toMatchObject({ login: 'alice' });
    await expect(github.getUser()).rejects.toMatchObject({ code: 'github_rate_limited', status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('detects secondary 403 message bodies in the library and does not reissue requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ message: 'You have exceeded a secondary rate limit.' }, 403));
    const library = new ProblemLibrary(undefined, { fetch: fetcher, now: () => now });
    await expect(library.getArchiveMonths()).rejects.toMatchObject({ name: 'LibraryError', status: 403, rateLimit: { kind: 'secondary', retryAt: now + 60_000 } });
    await expect(library.getArchiveMonths()).rejects.toMatchObject({ code: 'github_rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not carry the guest cooldown into a newly authenticated client', async () => {
    const guestFetch = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 403, primaryHeaders));
    const guest = new ProblemLibrary(undefined, { fetch: guestFetch, now: () => now });
    await expect(guest.getArchiveMonths()).rejects.toMatchObject({ rateLimit: { authenticated: false } });
    const accountFetch = vi.fn<typeof fetch>().mockImplementation(async () => json({ login: 'alice' }));
    const account = new GitHubClient('test-token', { fetch: accountFetch });
    await expect(account.getUser()).resolves.toMatchObject({ login: 'alice' });
    expect(accountFetch).toHaveBeenCalledTimes(1);
  });

  it('stops scheduling more raw files after a parallel month load fails', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let rawCalls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      const parsed = new URL(String(url));
      if (String(url) === repo) return json({ default_branch: 'main' });
      if (parsed.pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'a'.repeat(40) } });
      if (parsed.pathname.endsWith('/contents/daily_problems/2026/10')) return json(Array.from({ length: 8 }, (_, i) => ({ type: 'dir', name: `10${String(i + 1).padStart(2, '0')}` })));
      rawCalls++;
      if (rawCalls === 1) return json({}, 429, { 'retry-after': '60' });
      await pending;
      return new Response('');
    });
    const library = new ProblemLibrary(undefined, { fetch: fetcher, concurrency: 4, now: () => now });
    await expect(library.getMonth('2026-10')).rejects.toMatchObject({ code: 'github_rate_limited', rateLimit: { resource: 'raw' } });
    expect(rawCalls).toBe(4);
    release();
    // Let already in-flight workers settle; they must not schedule the other four files.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(rawCalls).toBe(4);
  });
});

describe('IPC-safe metadata and localization', () => {
  const info: RateLimitInfo = { retryAt: now + 60_000, resource: 'core', kind: 'primary', authenticated: false };

  it('only recognizes the explicit rate-limit code and validated fields', () => {
    expect(isRateLimitInfo(info)).toBe(true);
    expect(getRateLimitInfo(withRateLimit(new Error('failed'), info))).toEqual(info);
    expect(getRateLimitInfo({ rateLimit: info })).toBeUndefined();
    for (const value of [null, {}, { ...info, retryAt: NaN }, { ...info, retryAt: Infinity }, { ...info, retryAt: -1 },
      { ...info, resource: '<script>' }, { ...info, kind: 'something' }, { ...info, authenticated: 'true' }]) {
      expect(isRateLimitInfo(value)).toBe(false);
    }
  });

  it('formats the message in the current locale without retaining credentials or server details', () => {
    expect(rateLimitMessage(info)).toContain('请登录 GitHub');
    setLocale('en');
    expect(rateLimitMessage(info)).toContain('Sign in to GitHub and retry');
    expect(rateLimitMessage({ ...info, authenticated: true })).toContain('API request allowance');
    expect(rateLimitMessage({ ...info, kind: 'secondary' })).toContain('limited the request rate');
  });
});
