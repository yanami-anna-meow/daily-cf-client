import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../electron/github';
import { buildSubmissionPreview, submissionPath } from '../shared/domain';
import { UPSTREAM, type SubmissionInput } from '../shared/types';

const input: SubmissionInput = {
  date: '2026-10-07', problemId: 'cf106744g', language: 'cpp', author: 'alice', code: 'int main() { return 0; }', notes: '',
};
const markdown = '| Difficulty | Problems | Hints | Solution |\n| *1000 | [GYM106744G](https://codeforces.com/gym/106744/problem/G) | Greedy. | [Editorial](solution/cf106744g.md) |';
const upstreamName = `${UPSTREAM.owner}/${UPSTREAM.repo}`;
const upstreamPath = `/repos/${upstreamName}`;
const UPSTREAM_SHA = 'a'.repeat(40);
const FORK_AHEAD_SHA = 'c'.repeat(40);
const encodeFile = (code: string, sha = 'file-sha') => ({ type: 'file', encoding: 'base64', content: Buffer.from(code).toString('base64'), sha, size: Buffer.byteLength(code) });
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe('GitHub submission-list file inspection', () => {
  const path = submissionPath(input);
  const upstream = { name: UPSTREAM.repo, full_name: upstreamName, owner: { login: UPSTREAM.owner }, default_branch: 'main', fork: false };
  function inspectionServer(options: { solutionPath?: string; exists?: boolean; fileStatus?: number; fileBody?: unknown; repositoryStatus?: number; refStatus?: number; refBody?: unknown; failure?: 'network' } = {}) {
    let read = 0;
    const requests: { path: string; method: string; ref: string | null; headers: Headers; cache?: RequestCache; redirect?: RequestRedirect }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.origin).toBe('https://api.github.com');
      requests.push({ path: parsed.pathname, method: init?.method ?? 'GET', ref: parsed.searchParams.get('ref'), headers: new Headers(init?.headers), cache: init?.cache, redirect: init?.redirect });
      if (options.failure) throw new Error('connection interrupted');
      if (parsed.pathname === upstreamPath) {
        read++;
        return options.repositoryStatus ? response({ message: 'Not Found' }, options.repositoryStatus) : response({ ...upstream, default_branch: read === 1 ? 'main' : 'trunk' });
      }
      if (parsed.pathname === `${upstreamPath}/git/ref/heads/${read === 1 ? 'main' : 'trunk'}`) {
        return options.refStatus ? response({ message: 'Not Found' }, options.refStatus) : response(options.refBody ?? { object: { sha: read === 1 ? UPSTREAM_SHA : FORK_AHEAD_SHA } });
      }
      if (decodeURIComponent(parsed.pathname) === `${upstreamPath}/contents/${options.solutionPath ?? path}`) {
        const status = options.fileStatus ?? (options.exists ? 200 : 404);
        return status === 200 ? response(options.fileBody ?? encodeFile('already committed code')) : response({ message: 'file read failed' }, status);
      }
      throw new Error(`Unexpected request: ${parsed.pathname}`);
    }) as unknown as typeof fetch;
    return { client: new GitHubClient(undefined, { fetch: fetcher }), requests };
  }

  it.each([true, false])('reports existence=%s without requiring login, credentials or a Fork', async exists => {
    const mock = inspectionServer({ exists });
    await expect(mock.client.inspectSubmissionFile(input)).resolves.toEqual({ path, exists });
    expect(mock.requests.map(request => request.path)).toEqual([
      upstreamPath, `${upstreamPath}/git/ref/heads/main`, `${upstreamPath}/contents/${path}`,
    ]);
    expect(mock.requests.every(request => request.method === 'GET' && !request.headers.has('Authorization') && request.cache === 'no-store' && request.redirect === 'error')).toBe(true);
  });

  it('reads current metadata and pins each inspection to its freshly resolved commit', async () => {
    const mock = inspectionServer({ exists: true });
    await mock.client.inspectSubmissionFile(input);
    await mock.client.inspectSubmissionFile(input);
    expect(mock.requests.filter(request => request.path === upstreamPath)).toHaveLength(2);
    expect(mock.requests.filter(request => request.path.includes('/contents/')).map(request => request.ref)).toEqual([UPSTREAM_SHA, FORK_AHEAD_SHA]);
    expect(mock.requests.some(request => request.path.endsWith('/git/ref/heads/trunk'))).toBe(true);
  });

  it.each([
    ['c', 'c'], ['C', 'C'], ['cc', 'cc'], ['cxx', 'cxx'], ['d.ts', 'd.ts'],
    ['c++', 'c%2B%2B'], ['custom.v2', 'custom.v2'], ['答 案+v2', '%E7%AD%94%20%E6%A1%88%2Bv2'],
  ])('inspects the actual .%s file, independently of the selected language', async (extension, encodedExtension) => {
    const solutionPath = `daily_problems/2026/10/1007/personal_submission/cf106744g_alice.${extension}`;
    const mock = inspectionServer({ solutionPath, exists: true });
    // The explicit suffix, rather than a legacy language field, identifies the file.
    await expect(mock.client.inspectSubmissionFile({ ...input, language: 'py', extension })).resolves.toEqual({ path: solutionPath, exists: true });
    const reads = mock.requests.filter(request => request.path.includes('/contents/'));
    expect(reads).toHaveLength(1);
    expect(reads[0].path).toBe(`${upstreamPath}/contents/daily_problems/2026/10/1007/personal_submission/cf106744g_alice.${encodedExtension}`);
    expect(reads[0].ref).toBe(UPSTREAM_SHA);
    expect(mock.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it.each([
    { date: '2026-02-30' }, { problemId: '../outside' }, { author: '../outside' },
    { author: '' }, { language: 'unknown' }, { code: '' }, { code: 'code\0data' },
    { extension: '../cpp' }, { extension: 'cpp/other' }, { extension: 'cpp\\other' }, { extension: '' },
  ])('rejects invalid input before requesting remote content: %j', async invalid => {
    const mock = inspectionServer();
    await expect(mock.client.inspectSubmissionFile({ ...input, ...invalid } as SubmissionInput)).rejects.toThrow();
    expect(mock.requests).toEqual([]);
  });

  it.each([401, 403, 429, 500, 503])('does not disguise file-read HTTP %s as a missing file', async fileStatus => {
    const mock = inspectionServer({ fileStatus });
    await expect(mock.client.inspectSubmissionFile(input)).rejects.toMatchObject({ status: fileStatus });
  });

  it.each([{ repositoryStatus: 404 }, { refStatus: 404 }])('does not interpret an unavailable repository or ref as an absent submission: %j', async options => {
    const mock = inspectionServer(options);
    await expect(mock.client.inspectSubmissionFile(input)).rejects.toMatchObject({ status: 404 });
    expect(mock.requests.some(request => request.path.includes('/contents/'))).toBe(false);
  });

  it('propagates transport errors instead of assuming a file is absent', async () => {
    await expect(inspectionServer({ failure: 'network' }).client.inspectSubmissionFile(input)).rejects.toThrow();
  });

  it.each([{}, { object: {} }, { object: { sha: 'main' } }, { object: { sha: 'z'.repeat(40) } }])('rejects unverified repository versions without an unpinned content request: %j', async refBody => {
    const mock = inspectionServer({ refBody });
    await expect(mock.client.inspectSubmissionFile(input)).rejects.toThrow('上游题单版本');
    expect(mock.requests.some(request => request.path.includes('/contents/'))).toBe(false);
  });

  it.each([[], { type: 'dir' }, { type: 'symlink' }, { type: 'file', encoding: 'none', content: '' }, { type: 'file', encoding: 'base64' }])('reports unreadable content rather than treating it as a safe absent path: %j', async fileBody => {
    const mock = inspectionServer({ exists: true, fileBody });
    await expect(mock.client.inspectSubmissionFile(input)).rejects.toThrow('普通文件');
  });
});

describe('GitHub read and Fork boundaries', () => {
  it('discovers renamed personal Forks and excludes unrelated repositories without mutations', async () => {
    const fork = { name: 'my-daily-practice', full_name: 'alice/my-daily-practice', owner: { login: 'alice' }, default_branch: 'main', fork: true, parent: { full_name: upstreamName } };
    const other = { ...fork, name: 'other', full_name: 'alice/other', parent: { full_name: 'elsewhere/other' } };
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.cache).toBe('no-store');
      requests.push(parsed.pathname);
      if (parsed.pathname === '/user') return response({ login: 'alice' });
      if (parsed.pathname === upstreamPath) return response({ name: UPSTREAM.repo, full_name: upstreamName, default_branch: 'main', owner: { login: UPSTREAM.owner }, fork: false });
      if (parsed.pathname === '/user/repos') return response(parsed.searchParams.get('page') === '1' ? [fork, other, { ...other, fork: false }] : []);
      if (parsed.pathname === `/repos/${fork.full_name}`) return response(fork);
      if (parsed.pathname === `/repos/${other.full_name}`) return response(other);
      throw new Error(`Unexpected Fork request: ${parsed.pathname}`);
    }) as unknown as typeof fetch;
    const client = new GitHubClient('test-token', { fetch: fetcher });
    await expect(client.getForks()).resolves.toEqual([{ fullName: fork.full_name, url: `https://github.com/${fork.full_name}`, defaultBranch: 'main', ownedUpstream: false }]);
    await expect(client.validateFork(fork.full_name)).resolves.toMatchObject({ fullName: fork.full_name });
    await expect(client.validateFork(other.full_name)).rejects.toThrow();
    expect(requests).toContain(`/repos/${fork.full_name}`);
  });

  it.each([
    [401, 'Bad credentials', {}, '登录已失效'],
    [403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' }, '请求额度暂时用尽'],
  ] as const)('reports HTTP %i without exposing the credential', async (status, message, headers, expected) => {
    const client = new GitHubClient('secret-test-token', { fetch: vi.fn(async () => response({ message }, status, headers)) });
    const error = await client.getUser().catch(error => error);
    expect(error.message).toContain(expected);
    expect(error.message).not.toContain('secret-test-token');
    expect(error.status).toBe(status);
  });
});

interface SearchPull {
  id: number; number: number; title: string; body: string | null; repository_url: string; user: { login: string };
  state: 'open' | 'closed'; created_at: string; updated_at: string; pull_request?: { merged_at?: string | null };
}
const searchPull = (number: number, patch: Partial<SearchPull> = {}): SearchPull => ({
  id: number + 1000, number, title: 'Manual contribution', body: null,
  repository_url: `https://api.github.com${upstreamPath}`, user: { login: 'alice' }, state: 'open',
  created_at: '2026-10-07T06:00:00Z', updated_at: '2026-10-07T07:00:00Z', pull_request: { merged_at: null }, ...patch,
});
interface ContributionFile { filename: string; status: string; previous_filename?: string; }
function contributionsServer(options: {
  items?: SearchPull[]; pages?: Record<number, SearchPull[]>; total?: number; open?: number; merged?: number;
  incomplete?: 'all' | 'open' | 'merged'; fallbackMerged?: Record<number, string | null>;
  deletedHeads?: number[];
  files?: Record<number, ContributionFile[]>; changedFiles?: Record<number, number>;
  filePageFailure?: { number: number; page: number; status: number };
  failure?: number; rateLimited?: boolean;
} = {}) {
  const requests: { path: string; method: string; query: URLSearchParams }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const path = decodeURIComponent(parsed.pathname);
    const method = init?.method ?? 'GET';
    expect(parsed.origin).toBe('https://api.github.com');
    requests.push({ path, method, query: parsed.searchParams });
    if (options.failure) return response({ message: options.rateLimited ? 'API rate limit exceeded' : 'failed' }, options.failure,
      options.rateLimited ? { 'x-ratelimit-remaining': '0' } : {});
    if (path === '/user') return response({ login: 'alice', name: 'Alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
    if (path === '/search/issues') {
      const query = parsed.searchParams.get('q') ?? '';
      const kind = query.includes('is:open') ? 'open' : query.includes('is:merged') ? 'merged' : 'all';
      const items = options.pages?.[Number(parsed.searchParams.get('page') ?? 1)] ?? options.items ?? [];
      const count = kind === 'open' ? options.open ?? 0 : kind === 'merged' ? options.merged ?? 0 : options.total ?? items.length;
      return response({ total_count: count, incomplete_results: options.incomplete === kind, items: kind === 'all' ? items : [] });
    }
    if (path.startsWith(`${upstreamPath}/pulls/`)) {
      const suffix = path.slice(`${upstreamPath}/pulls/`.length);
      const number = Number(suffix.split('/')[0]);
      const files = options.files?.[number] ?? [];
      if (suffix.endsWith('/files')) {
        const page = Number(parsed.searchParams.get('page') ?? 1);
        const perPage = Number(parsed.searchParams.get('per_page') ?? 30);
        if (options.filePageFailure?.number === number && options.filePageFailure.page === page) return response({ message: 'failed to fetch files' }, options.filePageFailure.status);
        return response(files.slice((page - 1) * perPage, page * perPage));
      }
      const issue = [...(options.items ?? []), ...Object.values(options.pages ?? {}).flat()].find(item => item.number === number);
      if (!issue && (!options.fallbackMerged || !Object.hasOwn(options.fallbackMerged, number))) return response({}, 404);
      const mergedAt = options.fallbackMerged && Object.hasOwn(options.fallbackMerged, number) ? options.fallbackMerged[number] : issue?.pull_request?.merged_at ?? null;
      return response({
        number, state: issue?.state ?? 'closed', merged_at: mergedAt, user: { login: 'alice' }, changed_files: options.changedFiles?.[number] ?? files.length,
        updated_at: issue?.updated_at,
        head: { user: options.deletedHeads?.includes(number) ? null : { login: 'alice' }, ref: 'manual-submission', repo: options.deletedHeads?.includes(number) ? null : { full_name: `alice/${UPSTREAM.repo}` } },
        base: { ref: 'main', repo: { full_name: upstreamName } },
      });
    }
    throw new Error(`Unexpected contributions request: ${method} ${path}`);
  }) as unknown as typeof fetch;
  return { client: new GitHubClient('test-token', { fetch: fetcher }), requests };
}

describe('GitHub daily problem snapshots', () => {
  const repository = (defaultBranch: string) => ({ name: UPSTREAM.repo, full_name: upstreamName, owner: { login: UPSTREAM.owner }, default_branch: defaultBranch, fork: false });

  it('reads and inspects a repository leap day in 2128 while the current clock remains in 2026', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
      const futureDate = '2128-02-29';
      const dayPath = 'daily_problems/2128/02/0229';
      const solutionPath = `${dayPath}/personal_submission/cf106744g_alice.cpp`;
      const fork = { ...repository('main'), full_name: `alice/${UPSTREAM.repo}`, owner: { login: 'alice' }, fork: true, parent: { full_name: upstreamName } };
      const requests: { path: string; ref: string | null; method: string }[] = [];
      const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(String(url));
        const path = decodeURIComponent(parsed.pathname);
        requests.push({ path, ref: parsed.searchParams.get('ref'), method: init?.method ?? 'GET' });
        if (path === '/user') return response({ login: 'alice', name: 'Alice', avatar_url: 'https://example.com/alice.png' });
        if (path === upstreamPath) return response(repository('main'));
        if (path === `/repos/${fork.full_name}`) return response(fork);
        if ([`${upstreamPath}/git/ref/heads/main`, `/repos/${fork.full_name}/git/ref/heads/main`].includes(path)) return response({ object: { sha: UPSTREAM_SHA } });
        if (path === `/repos/${fork.full_name}/compare/${UPSTREAM_SHA}...${UPSTREAM_SHA}`) return response({
          status: 'identical', ahead_by: 0, behind_by: 0, base_commit: { sha: UPSTREAM_SHA }, merge_base_commit: { sha: UPSTREAM_SHA },
        });
        if (path === `${upstreamPath}/contents/README.md`) return response(encodeFile(
          `[Future editorial](${dayPath}/solution/cf106744g.md)\n[Older editorial](daily_problems/2026/10/1007/solution/cf106744g.md)`,
        ));
        if (path === `${upstreamPath}/contents/${dayPath}/problems.md`) return response(encodeFile(markdown));
        if (path === `${upstreamPath}/contents/${solutionPath}`) return response({}, 404);
        if (path === `${upstreamPath}/pulls`) return response([]);
        throw new Error(`Unexpected future-date request: ${path}`);
      }) as unknown as typeof fetch;
      const client = new GitHubClient('test-token', { fetch: fetcher, forkRepository: fork.full_name });
      const latest = await client.getDay();
      expect(latest).toMatchObject({ date: futureDate, fetchedAt: '2026-10-07T12:00:00.000Z', problems: [{ id: 'cf106744g' }] });
      expect((await client.getDay(futureDate, true)).date).toBe(futureDate);
      expect(await client.inspectSubmissionFile({ ...input, date: futureDate })).toEqual({ path: solutionPath, exists: false });
      expect(requests.filter(request => request.path.includes('/contents/')).every(request => request.ref === UPSTREAM_SHA)).toBe(true);
      expect(requests.every(request => request.method === 'GET')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('fetches metadata on every read and immediately follows a changed default branch without a refresh flag', async () => {
    let metadataReads = 0;
    const requests: { path: string; ref: string | null; method: string }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      requests.push({ path: parsed.pathname, ref: parsed.searchParams.get('ref'), method: init?.method ?? 'GET' });
      if (parsed.pathname === upstreamPath) return response(repository(++metadataReads === 1 ? 'main' : 'trunk'));
      if (parsed.pathname === `${upstreamPath}/git/ref/heads/main`) return response({ object: { sha: UPSTREAM_SHA } });
      if (parsed.pathname === `${upstreamPath}/git/ref/heads/trunk`) return response({ object: { sha: FORK_AHEAD_SHA } });
      if (parsed.pathname === `${upstreamPath}/contents/daily_problems/2026/10/1007/problems.md`) return response(encodeFile(markdown));
      throw new Error(`Unexpected snapshot request: ${parsed.pathname}`);
    }) as unknown as typeof fetch;
    const client = new GitHubClient(undefined, { fetch: fetcher });
    expect((await client.getDay(input.date)).sourceUrl).toBe(`${UPSTREAM.url}/blob/main/daily_problems/2026/10/1007/problems.md`);
    expect((await client.getDay(input.date)).sourceUrl).toBe(`${UPSTREAM.url}/blob/trunk/daily_problems/2026/10/1007/problems.md`);
    expect(metadataReads).toBe(2);
    expect((await client.getDay(input.date, true)).sourceUrl).toBe(`${UPSTREAM.url}/blob/trunk/daily_problems/2026/10/1007/problems.md`);
    expect(metadataReads).toBe(3);
    expect(requests.filter(request => request.path.includes('/contents/')).map(request => request.ref)).toEqual([UPSTREAM_SHA, FORK_AHEAD_SHA, FORK_AHEAD_SHA]);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('keeps README and latest problem date on one commit when the clock and upstream advance across midnight', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T15:59:59Z'));
      let head = UPSTREAM_SHA;
      const fileReads: { path: string; ref: string | null }[] = [];
      const fetcher = vi.fn(async (url: string | URL | Request) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === upstreamPath) return response(repository('main'));
        if (parsed.pathname === `${upstreamPath}/git/ref/heads/main`) return response({ object: { sha: head } });
        const ref = parsed.searchParams.get('ref');
        fileReads.push({ path: parsed.pathname, ref });
        if (parsed.pathname === `${upstreamPath}/contents/README.md`) {
          const day = ref === UPSTREAM_SHA ? '1007' : '1008';
          head = FORK_AHEAD_SHA;
          vi.setSystemTime(new Date('2026-10-07T16:00:01Z'));
          return response(encodeFile(`[Today's editorial](daily_problems/2026/10/${day}/solution/cf106744g.md)`));
        }
        if (parsed.pathname === `${upstreamPath}/contents/daily_problems/2026/10/${ref === UPSTREAM_SHA ? '1007' : '1008'}/problems.md`) return response(encodeFile(markdown));
        throw new Error(`Unexpected date or snapshot: ${parsed.pathname}?ref=${ref}`);
      }) as unknown as typeof fetch;
      const client = new GitHubClient(undefined, { fetch: fetcher });
      const previous = await client.getDay();
      expect(previous.date).toBe('2026-10-07');
      expect(previous.fetchedAt).toBe('2026-10-07T16:00:01.000Z');
      expect((await client.getDay()).date).toBe('2026-10-08');
      expect(fileReads).toEqual([
        { path: `${upstreamPath}/contents/README.md`, ref: UPSTREAM_SHA },
        { path: `${upstreamPath}/contents/daily_problems/2026/10/1007/problems.md`, ref: UPSTREAM_SHA },
        { path: `${upstreamPath}/contents/README.md`, ref: FORK_AHEAD_SHA },
        { path: `${upstreamPath}/contents/daily_problems/2026/10/1008/problems.md`, ref: FORK_AHEAD_SHA },
      ]);
    } finally { vi.useRealTimers(); }
  });

  it('keeps overlapping requests on separate snapshots and reads metadata again after both complete', async () => {
    const pending: ((result: Response) => void)[] = [];
    const branchReads: string[] = [];
    const fileRefs: (string | null)[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === upstreamPath) return new Promise<Response>(resolve => { pending.push(resolve); });
      if (parsed.pathname.startsWith(`${upstreamPath}/git/ref/heads/`)) {
        const branch = parsed.pathname.slice(`${upstreamPath}/git/ref/heads/`.length);
        branchReads.push(branch);
        return response({ object: { sha: branch === 'old-default' ? UPSTREAM_SHA : FORK_AHEAD_SHA } });
      }
      if (parsed.pathname === `${upstreamPath}/contents/daily_problems/2026/10/1007/problems.md`) {
        fileRefs.push(parsed.searchParams.get('ref'));
        return response(encodeFile(markdown));
      }
      throw new Error(`Unexpected concurrent snapshot request: ${parsed.pathname}`);
    }) as unknown as typeof fetch;
    const client = new GitHubClient(undefined, { fetch: fetcher });
    const oldRequest = client.getDay(input.date);
    const newRequest = client.getDay(input.date);
    expect(pending).toHaveLength(2);
    pending[1](response(repository('new-default')));
    expect((await newRequest).sourceUrl).toContain('/blob/new-default/');
    pending[0](response(repository('old-default')));
    expect((await oldRequest).sourceUrl).toContain('/blob/old-default/');
    const nextRequest = client.getDay(input.date);
    expect(pending).toHaveLength(3);
    pending[2](response(repository('latest-default')));
    expect((await nextRequest).sourceUrl).toContain('/blob/latest-default/');
    expect(branchReads).toEqual(['new-default', 'old-default', 'latest-default']);
    expect(fileRefs).toEqual([FORK_AHEAD_SHA, UPSTREAM_SHA, FORK_AHEAD_SHA]);
  });
});

describe('GitHub batch submission public API', () => {
  it.each(['', ' \t '])('requires an explicitly entered author %j before any request', async author => {
    const fetcher = vi.fn();
    const client = new GitHubClient('test-token', { fetch: fetcher, forkRepository: `alice/${UPSTREAM.repo}` });
    const batch = { items: [{ ...input, author }], notes: '', requestId: 'submission-request-123456' };
    await expect(client.previewBatchSubmission(batch)).rejects.toThrow('署名');
    await expect(client.submitBatch(batch, 'alice')).rejects.toThrow('署名');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serializes submissions regardless of item count and releases the mutex after failure', async () => {
    let releaseFirst!: (result: Response) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let calls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(new URL(String(url)).pathname).toBe('/user');
      calls++;
      if (calls === 1) {
        signalStarted();
        return new Promise<Response>(resolve => { releaseFirst = resolve; });
      }
      return response({ message: 'Bad credentials' }, 401);
    }) as unknown as typeof fetch;
    const client = new GitHubClient('test-token', { fetch: fetcher, forkRepository: `alice/${UPSTREAM.repo}` });
    const batch = { items: [input, { ...input, author: 'alice-second' }], notes: '', requestId: 'submission-request-123456' };
    const first = client.submitBatch(batch, 'alice');
    const firstFailure = expect(first).rejects.toThrow('登录已失效');
    await started;
    await expect(client.submitBatch(batch, 'alice')).rejects.toThrow('已有提交正在进行');
    await expect(client.submitBatch({ items: [input], notes: '', requestId: 'single-request-123456' }, 'alice')).rejects.toThrow('已有提交正在进行');
    expect(calls).toBe(1);
    releaseFirst(response({ message: 'Bad credentials' }, 401));
    await firstFailure;
    await expect(client.submitBatch(batch, 'alice')).rejects.toThrow('登录已失效');
    expect(calls).toBe(2);
  });
});

describe('GitHub remote contribution history', () => {
  it('recognizes all file signatures in the current account PR without using a signature as the contribution owner', async () => {
    const paths = ['old_handle', 'new-handle', 'teammate'].map(author =>
      buildSubmissionPreview({ ...input, author }, 'alice').path);
    const mock = contributionsServer({
      items: [searchPull(1)], total: 1, open: 1,
      files: { 1: paths.map(filename => ({ filename, status: 'added' })) },
    });
    const result = await mock.client.getContributions();
    expect(result).toMatchObject({ login: 'alice', totalCount: 1, openCount: 1, incomplete: false });
    expect(result.items[0].problems).toEqual(paths.map(path => ({
      date: input.date, problemId: input.problemId, language: input.language, path,
    })));
    expect(result.items[0].filesTruncated).toBe(false);
    expect(result.items[0].otherFiles ?? []).toEqual([]);
    const queries = mock.requests.filter(request => request.path === '/search/issues').map(request => request.query.get('q'));
    expect(queries).toHaveLength(3);
    expect(queries.every(query => query?.includes('author:alice') && !/old_handle|new-handle|teammate/.test(query))).toBe(true);
    expect(mock.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('recognizes future repository dates from actual PR files independently of its 2026 creation date and current clock', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
      const path = 'daily_problems/2128/02/0229/personal_submission/cf106744g_alice.cpp';
      const mock = contributionsServer({ items: [searchPull(1)], total: 1, open: 1, files: { 1: [{ filename: path, status: 'added' }] } });
      const record = (await mock.client.getContributions()).items[0];
      expect(record).toMatchObject({ createdAt: '2026-10-07T06:00:00Z', date: '2128-02-29', problemId: 'cf106744g', path, language: 'cpp' });
      expect(record.problems).toEqual([{ date: '2128-02-29', problemId: 'cf106744g', path, language: 'cpp' }]);
      expect(record.otherFiles ?? []).toEqual([]);
      expect(record.filesTruncated).toBe(false);
      expect(mock.requests.every(request => request.method === 'GET')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('includes manual and client PRs with accurate states and metadata derived only from actual files', async () => {
    const path = buildSubmissionPreview(input, 'alice').path;
    const mock = contributionsServer({
      items: [
        searchPull(1, { title: 'Small documentation cleanup' }),
        searchPull(2, { title: '20261007 cf106744g (C++) - alice', body: `File: \`${path}\`\n<!-- daily-cf-client:example -->`, state: 'closed', pull_request: { merged_at: '2026-10-08T00:00:00Z' } }),
        searchPull(3, { title: '20261006 GYM123456A implementation', state: 'closed', pull_request: { merged_at: null } }),
      ], files: { 1: [{ filename: 'README.md', status: 'modified' }], 2: [{ filename: path, status: 'added' }], 3: [] }, total: 3, open: 1, merged: 1,
    });
    const result = await mock.client.getContributions();
    expect(result).toMatchObject({ totalCount: 3, openCount: 1, mergedCount: 1, closedCount: 1, login: 'alice', repository: upstreamName, page: 1, pageSize: 50, hasMore: false, truncated: false, incomplete: false });
    expect(result.items.map(item => [item.number, item.state])).toEqual([[1, 'open'], [2, 'merged'], [3, 'closed']]);
    expect(result.items[0]).toMatchObject({ title: 'Small documentation cleanup', url: `${UPSTREAM.url}/pull/1`, createdAt: '2026-10-07T06:00:00Z', updatedAt: '2026-10-07T07:00:00Z' });
    expect(result.items[0].problemId).toBeUndefined();
    expect(result.items[0].date).toBeUndefined();
    expect(result.items[0].path).toBeUndefined();
    expect(result.items[0].language).toBeUndefined();
    expect(result.items[0].problems).toEqual([]);
    expect(result.items[0].filesTruncated).toBe(false);
    expect(result.items[0].otherFiles).toEqual([{ path: 'README.md', status: 'modified' }]);
    expect(result.items[1]).toMatchObject({ problemId: 'cf106744g', date: '2026-10-07', language: 'cpp', path });
    expect(result.items[1].problems).toEqual([{ problemId: 'cf106744g', date: '2026-10-07', language: 'cpp', path }]);
    expect(result.items[2].problemId).toBeUndefined();
    expect(result.items[2].date).toBeUndefined();
    expect(result.items[2].path).toBeUndefined();
    expect(result.items[2].language).toBeUndefined();
    expect(result.items[2].problems).toEqual([]);
    expect(mock.requests.every(request => request.method === 'GET')).toBe(true);
    expect(mock.requests.filter(request => request.path.endsWith('/files')).map(request => request.path).sort()).toEqual([1, 2, 3].map(number => `${upstreamPath}/pulls/${number}/files`));
    expect(mock.requests.filter(request => request.path.endsWith('/files')).every(request => request.query.get('per_page') === '100')).toBe(true);
    const searches = mock.requests.filter(request => request.path === '/search/issues');
    expect(searches).toHaveLength(3);
    expect(searches.every(request => request.query.get('q')?.includes(`repo:${upstreamName}`) && request.query.get('q')?.includes('is:pr') && request.query.get('q')?.includes('author:alice'))).toBe(true);
    expect(searches.filter(request => request.query.get('per_page') === '1')).toHaveLength(2);
  });

  it('returns every actual problem across dates and languages from one PR', async () => {
    const first = buildSubmissionPreview(input, 'alice').path;
    const second = 'daily_problems/2026/10/1006/personal_submission/cf1234a_alice.py';
    const third = first.replace(/\.cpp$/, '.rs');
    const mock = contributionsServer({ items: [searchPull(1)], total: 1, open: 1, files: { 1: [
      { filename: first, status: 'added' }, { filename: second, status: 'modified' },
      { filename: third, status: 'added' }, { filename: 'README.md', status: 'modified' },
    ] } });
    const result = (await mock.client.getContributions()).items[0];
    expect(result.problems).toEqual([
      { date: '2026-10-07', problemId: 'cf106744g', path: first, language: 'cpp' },
      { date: '2026-10-06', problemId: 'cf1234a', path: second, language: 'py' },
      { date: '2026-10-07', problemId: 'cf106744g', path: third, language: 'rs' },
    ]);
    expect(result.filesTruncated).toBe(false);
    expect(result.problemId).toBeUndefined();
    expect(result.date).toBeUndefined();
    expect(result.path).toBeUndefined();
    expect(result.language).toBeUndefined();
  });

  it('retains a unique problem identity for multiple language files without inventing a single path or language', async () => {
    const cpp = buildSubmissionPreview(input, 'alice').path;
    const py = cpp.replace(/\.cpp$/, '.py');
    const mock = contributionsServer({ items: [searchPull(1)], total: 1, open: 1, files: { 1: [
      { filename: cpp, status: 'added' }, { filename: py, status: 'added' },
    ] } });
    const result = (await mock.client.getContributions()).items[0];
    expect(result.problems).toHaveLength(2);
    expect(result).toMatchObject({ date: '2026-10-07', problemId: 'cf106744g' });
    expect(result.path).toBeUndefined();
    expect(result.language).toBeUndefined();
  });

  it('trusts actual files over misleading titles and body paths', async () => {
    const claimed = buildSubmissionPreview(input, 'alice').path;
    const actual = 'daily_problems/2026/09/0930/personal_submission/cf456a_alice.go';
    const mock = contributionsServer({ items: [searchPull(1, { title: '20261007 cf1234a (C++) - alice', body: `File: ${claimed}` })], total: 1, open: 1,
      files: { 1: [{ filename: actual, status: 'modified' }] } });
    const result = (await mock.client.getContributions()).items[0];
    expect(result.problems).toEqual([{ date: '2026-09-30', problemId: 'cf456a', path: actual, language: 'go' }]);
    expect(result).toMatchObject({ date: '2026-09-30', problemId: 'cf456a', path: actual, language: 'go' });
  });

  it.each([
    ['alice.c', 'c'], ['alice.C', 'cpp'], ['alice.cc', 'cpp'], ['alice.cxx', 'cpp'], ['alice.c++', 'cpp'],
    ['alice.d.ts', undefined], ['alice.d.mts', undefined], ['alice.custom.v2', undefined], ['alice.new+language', undefined],
    ['alice.py.rs', 'rs'], ['alice.name.cpp', 'cpp'], ['alice.constructor', undefined],
  ])('associates .%s without changing its path or confusing its signature with a language', async (filename, language) => {
    const path = `daily_problems/2026/10/1007/personal_submission/cf106744g_${filename}`;
    const mock = contributionsServer({ items: [searchPull(1)], total: 1, open: 1, files: { 1: [{ filename: path, status: 'added' }] } });
    const result = (await mock.client.getContributions()).items[0];
    expect(result.problems).toEqual([{ date: '2026-10-07', problemId: 'cf106744g', path, ...(language ? { language } : {}) }]);
    expect(result.path).toBe(path);
    expect(result.language).toBe(language);
    expect(result.otherFiles).toEqual([]);
  });

  it('associates current solution files, separates removed files, and ignores renamed source paths', async () => {
    const statuses = ['added', 'modified', 'renamed', 'removed'];
    const files = statuses.map((status, index) => ({
      filename: `daily_problems/2026/10/1007/personal_submission/cf${400 + index}a_alice.cpp`, status,
      ...(status === 'renamed' ? { previous_filename: 'daily_problems/2026/10/1006/personal_submission/cf999a_alice.cpp' } : {}),
    }));
    const mock = contributionsServer({ items: [searchPull(1)], total: 1, open: 1, files: { 1: files } });
    const result = (await mock.client.getContributions()).items[0];
    expect(result.problems.map(problem => problem.problemId)).toEqual(['cf400a', 'cf401a', 'cf402a']);
    expect(result.problems.map(problem => problem.path)).toEqual(files.slice(0, 3).map(file => file.filename));
    expect(result.otherFiles).toEqual([{ path: files[3].filename, status: 'removed' }]);
  });

  it('preserves unrecognized or invalid paths as other file changes without inventing problem metadata', async () => {
    const files = [
      { filename: 'README.md', status: 'modified' },
      { filename: 'daily_problems/2026/02/0230/personal_submission/cf123a_alice.cpp', status: 'added' },
      { filename: 'daily_problems/2026/10/1007/personal_submission/not_a_problem.cpp', status: 'added' },
      { filename: 'daily_problems/2026/10/1007/solution/cf123a_alice.c++', status: 'added' },
      { filename: 'daily_problems/2026/10/1007/personal_submission/cf123a_.cpp', status: 'added' },
      { filename: 'daily_problems/2026/10/1007/personal_submission/cf123a_.d.ts', status: 'added' },
      { filename: 'daily_problems/2026/10/1007/personal_submission/cf123a_alice', status: 'added' },
      { filename: 'daily_problems/2026/10/1007/personal_submission/cf123a_alice.', status: 'added' },
      { filename: 'daily_problems/2026/10/1007/personal_submission/cf123a_alice/nested.cpp', status: 'added' },
      { filename: 'daily_problems/2026/10/1007/personal_submission/cf123a_alice\\nested.cpp', status: 'added' },
    ];
    const mock = contributionsServer({ items: [searchPull(1, { title: '20261007 CF123A' })], total: 1, open: 1, files: { 1: files } });
    const result = (await mock.client.getContributions()).items[0];
    expect(result.problems).toEqual([]);
    expect(result.otherFiles).toEqual(files.map(file => ({ path: file.filename, status: file.status })));
    expect(result.problemId).toBeUndefined();
    expect(result.date).toBeUndefined();
  });

  it('reads successive 100-file pages so later problem files are not lost', async () => {
    const path = buildSubmissionPreview(input, 'alice').path;
    const files = [...Array.from({ length: 100 }, (_, index) => ({ filename: `docs/note-${index}.md`, status: 'modified' })), { filename: path, status: 'added' }];
    const mock = contributionsServer({ items: [searchPull(1)], total: 1, open: 1, files: { 1: files } });
    const result = (await mock.client.getContributions()).items[0];
    expect(result.problems).toEqual([{ date: '2026-10-07', problemId: 'cf106744g', path, language: 'cpp' }]);
    expect(result.filesTruncated).toBe(false);
    const fileRequests = mock.requests.filter(request => request.path.endsWith('/files'));
    expect(fileRequests.map(request => request.query.get('page'))).toEqual(['1', '2']);
    expect(fileRequests.every(request => request.query.get('per_page') === '100')).toBe(true);
  });

  it('marks a full thirtieth file page as truncated without requesting beyond the GitHub cap', async () => {
    const path = buildSubmissionPreview(input, 'alice').path;
    const files = Array.from({ length: 3000 }, (_, index) => ({ filename: index === 2999 ? path : `docs/note-${index}.md`, status: 'modified' }));
    const mock = contributionsServer({ items: [searchPull(1)], total: 1, open: 1, files: { 1: files } });
    const result = (await mock.client.getContributions()).items[0];
    expect(result.filesTruncated).toBe(true);
    expect(result.problems).toEqual([{ date: '2026-10-07', problemId: 'cf106744g', path, language: 'cpp' }]);
    expect(result.problemId).toBeUndefined();
    expect(result.date).toBeUndefined();
    expect(result.path).toBeUndefined();
    expect(result.language).toBeUndefined();
    const fileRequests = mock.requests.filter(request => request.path.endsWith('/files'));
    expect(fileRequests).toHaveLength(30);
    expect(fileRequests.at(-1)?.query.get('page')).toBe('30');
  });

  it('fails the contribution request when a later file page cannot be read instead of returning silent partial results', async () => {
    const files = Array.from({ length: 101 }, (_, index) => ({ filename: `docs/note-${index}.md`, status: 'modified' }));
    const mock = contributionsServer({ items: [searchPull(1)], total: 1, open: 1, files: { 1: files }, filePageFailure: { number: 1, page: 2, status: 500 } });
    await expect(mock.client.getContributions()).rejects.toThrow('GitHub 服务暂时不可用');
    expect(mock.requests.filter(request => request.path.endsWith('/files')).map(request => request.query.get('page'))).toEqual(['1', '2']);
    expect(mock.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it.each([null, '2026-10-08T00:00:00Z'])('resolves missing merged metadata from the PR endpoint (merged_at=%s)', async mergedAt => {
    const mock = contributionsServer({ items: [searchPull(4, { state: 'closed', pull_request: {} })], total: 1, merged: mergedAt ? 1 : 0, fallbackMerged: { 4: mergedAt } });
    const result = await mock.client.getContributions();
    expect(result.items[0].state).toBe(mergedAt ? 'merged' : 'closed');
    expect(mock.requests.filter(request => request.path === `${upstreamPath}/pulls/4`)).toHaveLength(1);
    expect(mock.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('retains the actual state and solution files of a historical PR whose source account and fork are gone', async () => {
    const path = buildSubmissionPreview(input, 'alice').path;
    const mock = contributionsServer({
      items: [searchPull(4, { state: 'closed', pull_request: {} })], total: 1, merged: 1,
      fallbackMerged: { 4: '2026-10-08T00:00:00Z' }, deletedHeads: [4], files: { 4: [{ filename: path, status: 'added' }] },
    });
    const result = await mock.client.getContributions();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ number: 4, state: 'merged', problems: [{ date: input.date, problemId: input.problemId, path, language: input.language }] });
    expect(mock.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('excludes results from another author or repository and marks the response incomplete', async () => {
    const mock = contributionsServer({ items: [
      searchPull(1), searchPull(2, { user: { login: 'bob' } }),
      searchPull(3, { repository_url: 'https://api.github.com/repos/elsewhere/other' }),
      searchPull(4, { repository_url: `https://api.github.com${upstreamPath}-other` }),
      searchPull(5, { pull_request: undefined }),
    ], total: 5, open: 5 });
    const result = await mock.client.getContributions();
    expect(result.items.map(item => item.number)).toEqual([1]);
    expect(result.incomplete).toBe(true);
    expect(mock.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('requests the selected page while retaining global contribution counts', async () => {
    const mock = contributionsServer({ pages: { 1: [searchPull(1)], 2: [searchPull(51)] }, total: 51, open: 20, merged: 25 });
    expect((await mock.client.getContributions(1)).hasMore).toBe(true);
    const result = await mock.client.getContributions(2);
    expect(result).toMatchObject({ page: 2, pageSize: 50, totalCount: 51, openCount: 20, mergedCount: 25, closedCount: 6, hasMore: false, truncated: false });
    expect(result.items.map(item => item.number)).toEqual([51]);
    const searches = mock.requests.filter(request => request.path === '/search/issues' && request.query.get('per_page') === '50');
    expect(searches.map(request => request.query.get('page'))).toEqual(['1', '2']);
    expect(searches.every(request => request.query.get('sort') === 'created' && request.query.get('order') === 'desc')).toBe(true);
  });

  it('reports the GitHub search cap and stops pagination after the twentieth page', async () => {
    const mock = contributionsServer({ pages: { 20: [searchPull(1000)] }, total: 1400, open: 100, merged: 1000 });
    const result = await mock.client.getContributions(20);
    expect(result).toMatchObject({ page: 20, totalCount: 1400, openCount: 100, mergedCount: 1000, closedCount: 300, truncated: true, hasMore: false });
    expect(result.items.map(item => item.number)).toEqual([1000]);
  });

  it.each(['all', 'open', 'merged'] as const)('reports incomplete %s search results', async incomplete => {
    const mock = contributionsServer({ items: [searchPull(1)], total: 1, open: 1, incomplete });
    expect((await mock.client.getContributions()).incomplete).toBe(true);
  });

  it('flags inconsistent search counts without displaying a negative closed count', async () => {
    const mock = contributionsServer({ items: [searchPull(1)], total: 2, open: 2, merged: 1 });
    expect(await mock.client.getContributions()).toMatchObject({ totalCount: 2, openCount: 2, mergedCount: 1, closedCount: 0, incomplete: true });
  });

  it('rejects expired authentication and rate limits without any mutation', async () => {
    const expired = contributionsServer({ failure: 401 });
    await expect(expired.client.getContributions()).rejects.toThrow('登录已失效');
    const limited = contributionsServer({ failure: 403, rateLimited: true });
    await expect(limited.client.getContributions()).rejects.toThrow('请求额度暂时用尽');
    expect([...expired.requests, ...limited.requests].every(request => request.method === 'GET')).toBe(true);
  });
});
