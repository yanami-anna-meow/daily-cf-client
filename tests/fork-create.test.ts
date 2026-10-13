import { describe, expect, it, vi } from 'vitest';
import { GitHubClient, GitHubError, type GitHubClientOptions } from '../electron/github';
import { validateForkName } from '../shared/fork';
import { UPSTREAM } from '../shared/types';

const upstreamName = `${UPSTREAM.owner}/${UPSTREAM.repo}`;
const upstreamPath = `/repos/${upstreamName}`;
const requestedName = 'daily-cf-personal';
const targetPath = `/repos/alice/${requestedName}`;
const defaultSha = 'a'.repeat(40);
interface Repository {
  id?: number;
  name: string;
  full_name: string;
  default_branch: string;
  fork: boolean;
  owner: { login: string };
  parent?: { full_name: string };
  source?: { full_name: string };
  permissions?: { push: boolean };
}
const repository = (name = requestedName): Repository => ({
  id: 123, name, full_name: `alice/${name}`, default_branch: 'main', fork: true,
  owner: { login: 'alice' }, parent: { full_name: upstreamName }, permissions: { push: true },
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
interface ServerOptions {
  name?: string;
  occupied?: Repository;
  postRepository?: Repository;
  pollRepository?: Repository;
  pollRepositories?: Repository[];
  postFailure?: number | 'lost' | 'timeout';
  createdOnFailure?: boolean;
  pendingRepositoryReads?: number;
  pendingRefReads?: number[];
  refBody?: unknown;
  oldBinding?: string;
}

/** Models the target independently of the POST response, including a lost acceptance. */
function server(options: ServerOptions = {}) {
  const name = options.name ?? requestedName;
  const path = `/repos/alice/${name}`;
  const postRepository = options.postRepository ?? repository(name);
  const pollRepository = options.pollRepository ?? postRepository;
  const pollRepositories = options.pollRepositories ?? [pollRepository];
  const oldFork = { ...repository(options.oldBinding ?? 'previous-renamed-fork'), id: 77 };
  const upstream = { name: UPSTREAM.repo, full_name: upstreamName, default_branch: 'main', fork: false, owner: { login: UPSTREAM.owner } };
  let accepted = false;
  let pollIndex = 0;
  let pendingRepositoryReads = options.pendingRepositoryReads ?? 0;
  const pendingRefReads = [...(options.pendingRefReads ?? [])];
  const requests: { method: string; path: string; body: unknown }[] = [];
  const unexpected: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe('https://api.github.com');
    expect(init?.redirect).toBe('error');
    const requestPath = decodeURIComponent(parsed.pathname);
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: requestPath, body });
    if (requestPath === '/user' && method === 'GET') return response({ login: 'alice', name: 'Alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
    if (requestPath === `${upstreamPath}/forks` && method === 'POST') {
      accepted = !options.postFailure || options.createdOnFailure === true;
      if (options.postFailure === 'lost') throw new Error('Connection reset after the server accepted the request');
      if (options.postFailure === 'timeout') {
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('Request timed out', 'AbortError'));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      if (typeof options.postFailure === 'number') return response({ message: 'The server rejected creation' }, options.postFailure);
      return response(postRepository, 202);
    }
    if (requestPath === path && method === 'GET') {
      if (options.occupied) return response(options.occupied);
      if (!accepted || pendingRepositoryReads-- > 0) return response({ message: 'Not Found' }, 404);
      return response(pollRepositories[Math.min(pollIndex++, pollRepositories.length - 1)]);
    }
    if (requestPath === `${path}/git/ref/heads/${pollRepository.default_branch}` && method === 'GET') {
      const status = pendingRefReads.shift();
      if (status) return response({ message: 'The fork is still being prepared' }, status);
      return response(options.refBody ?? { ref: `refs/heads/${pollRepository.default_branch}`, object: { sha: defaultSha, type: 'commit' } });
    }
    if (options.oldBinding && requestPath === upstreamPath && method === 'GET') return response(upstream);
    if (options.oldBinding && requestPath === `/repos/${oldFork.full_name}` && method === 'GET') return response(oldFork);
    if (options.oldBinding && requestPath === `${upstreamPath}/pulls` && method === 'GET') {
      return response([oldFork, pollRepository].map((fork, index) => ({
        number: index + 1, title: index ? 'New fork PR' : 'Already bound PR', html_url: `${UPSTREAM.url}/pull/${index + 1}`,
        state: 'open', merged_at: null, body: 'Handwritten PR', user: { login: 'alice' },
        head: { ref: 'solution', sha: defaultSha, user: { login: 'alice' }, repo: fork }, base: { ref: 'main', repo: upstream },
      })));
    }
    unexpected.push(`${method} ${requestPath}${parsed.search}`);
    return response({ message: 'Unexpected request in creation test' }, 500);
  });
  const sleep = vi.fn(async (_milliseconds: number) => {});
  const clientOptions: GitHubClientOptions = {
    fetch: fetcher as typeof fetch, sleep, timeoutMs: 5,
    ...(options.oldBinding ? { forkRepository: oldFork.full_name } : {}),
  };
  const client = new GitHubClient('test-token', clientOptions);
  const writes = () => requests.filter(request => request.method !== 'GET');
  const targetReads = () => requests.filter(request => request.path === path && request.method === 'GET');
  const refReads = () => requests.filter(request => request.path.includes('/git/ref/'));
  return { client, clientOptions, requests, writes, targetReads, refReads, unexpected, fetcher, sleep };
}

const invalidNames: unknown[] = [
  undefined, null, 42, {}, [], '', ' \t\n ', '.', '..', 'alice/repo', 'a\\b', 'repo name',
  'https://github.com/alice/repo', '仓库', 'résumé', 'a?b', 'a#b', 'a%b', 'a:b', 'a\nb',
  'a\u0000b', 'x'.repeat(101), 'repo.git', 'repo.GIT', '.git', ' .Git ',
];

describe('Fork name validation', () => {
  it.each(['a', 'A_b-c.d', '.hidden', '-leading', '_private', 'x'.repeat(100)])('accepts a valid GitHub repository name: %s', name => {
    expect(validateForkName(name)).toBe(name);
  });

  it('trims the exact name consistently at the form and main-process boundary', () => {
    expect(validateForkName(' \tMy_Daily-CF.2026\n')).toBe('My_Daily-CF.2026');
  });

  it.each(invalidNames.map((name, index) => ({ name, index })))('rejects invalid name case $index', ({ name }) => {
    expect(() => validateForkName(name)).toThrow();
  });
});

describe('explicit named Fork creation', () => {
  it('creates exactly the trimmed requested name and verifies its readable default branch', async () => {
    const mock = server();
    await expect(mock.client.createFork(` \t${requestedName}\n `)).resolves.toEqual({
      fullName: `alice/${requestedName}`, url: `https://github.com/alice/${requestedName}`, defaultBranch: 'main', ownedUpstream: false,
    });
    expect(mock.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /user', `GET ${targetPath}`, `POST ${upstreamPath}/forks`, `GET ${targetPath}`, `GET ${targetPath}/git/ref/heads/main`,
    ]);
    expect(mock.writes()).toEqual([{ method: 'POST', path: `${upstreamPath}/forks`, body: { name: requestedName, default_branch_only: true } }]);
    expect(mock.unexpected).toEqual([]);
  });

  it.each(invalidNames.map((name, index) => ({ name, index })))('rejects invalid case $index before any network request', async ({ name }) => {
    const mock = server();
    await expect(mock.client.createFork(name as string)).rejects.toThrow();
    expect(mock.fetcher).not.toHaveBeenCalled();
  });

  it('accepts the maximum-length valid name without silently truncating it', async () => {
    const name = 'x'.repeat(100);
    const mock = server({ name });
    await expect(mock.client.createFork(name)).resolves.toMatchObject({ fullName: `alice/${name}` });
    expect(mock.writes()[0].body).toEqual({ name, default_branch_only: true });
    expect(mock.unexpected).toEqual([]);
  });

  it('accepts case-insensitive identity while retaining the canonical server name', async () => {
    const postRepository = { ...repository(), name: requestedName.toUpperCase(), full_name: `ALICE/${requestedName.toUpperCase()}`, owner: { login: 'ALICE' } };
    const mock = server({ postRepository });
    await expect(mock.client.createFork(requestedName)).resolves.toMatchObject({ fullName: postRepository.full_name });
    expect(mock.targetReads()).toHaveLength(2);
    expect(mock.unexpected).toEqual([]);
  });

  it('uses the source network when the direct parent is another fork', async () => {
    const postRepository = { ...repository(), parent: { full_name: 'bob/intermediate-fork' }, source: { full_name: upstreamName } };
    const mock = server({ postRepository });
    await expect(mock.client.createFork(requestedName)).resolves.toMatchObject({ fullName: `alice/${requestedName}` });
    expect(mock.unexpected).toEqual([]);
  });

  it.each([true, false])('refuses an occupied exact target without POST, whether fork=%s', async fork => {
    const mock = server({ occupied: { ...repository(), fork } });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow(/同名|已存在|已有|占用/);
    expect(mock.writes()).toEqual([]);
    expect(mock.targetReads()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it('does not enumerate or block on an existing renamed fork and keeps that binding', async () => {
    const mock = server({ oldBinding: 'previous-renamed-fork' });
    const originalBinding = mock.clientOptions.forkRepository;
    await expect(mock.client.createFork(requestedName)).resolves.toMatchObject({ fullName: `alice/${requestedName}` });
    expect(mock.requests.some(request => request.path === '/user/repos')).toBe(false);
    expect(mock.requests.some(request => request.path === `/repos/${originalBinding}`)).toBe(false);
    expect(mock.clientOptions.forkRepository).toBe(originalBinding);
    await expect(mock.client.validateFork(originalBinding!)).resolves.toMatchObject({ fullName: originalBinding });
    expect(mock.clientOptions.forkRepository).toBe(originalBinding);
    expect(mock.unexpected).toEqual([]);
  });

  it('clearly rejects GitHub returning an existing differently named fork without recovery or polling', async () => {
    const mock = server({ postRepository: repository('already-existing-fork'), pollRepository: repository() });
    const error = await mock.client.createFork(requestedName).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/GitHub 返回已有 Fork/);
    expect(error.message).toMatch(/未创建新仓库/);
    expect(error.message).toMatch(/同账号/);
    expect(mock.targetReads()).toHaveLength(1);
    expect(mock.refReads()).toEqual([]);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.sleep).not.toHaveBeenCalled();
    expect(mock.unexpected).toEqual([]);
  });

  const invalidRepositories: { label: string; repository: Repository }[] = [
    { label: 'wrong owner', repository: { ...repository(), owner: { login: 'mallory' } } },
    { label: 'mismatched full name', repository: { ...repository(), full_name: 'mallory/daily-cf-personal' } },
    { label: 'non-fork repository', repository: { ...repository(), fork: false } },
    { label: 'unrelated fork network', repository: { ...repository(), parent: { full_name: 'unrelated/repository' } } },
    { label: 'missing default branch', repository: { ...repository(), default_branch: '' } },
    { label: 'read-only repository', repository: { ...repository(), permissions: { push: false } } },
  ];

  it.each(invalidRepositories.filter(item => item.label !== 'missing default branch'))('rejects POST metadata with $label before polling', async ({ repository: postRepository }) => {
    const mock = server({ postRepository, pollRepository: repository() });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.targetReads()).toHaveLength(1);
    expect(mock.refReads()).toEqual([]);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it.each(invalidRepositories)('revalidates $label during polling before returning success', async ({ repository: pollRepository }) => {
    const mock = server({ pollRepository });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.targetReads()).toHaveLength(2);
    expect(mock.refReads()).toEqual([]);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it('rejects a repository replaced with a new ID between creation and readiness polling', async () => {
    const mock = server({ pollRepository: { ...repository(), id: 456 } });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.refReads()).toEqual([]);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it('rejects a rename discovered during polling without following it to another repository path', async () => {
    const mock = server({ pollRepository: repository('renamed-during-creation') });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.targetReads()).toHaveLength(2);
    expect(mock.refReads()).toEqual([]);
    expect(mock.requests.some(request => request.path.includes('/renamed-during-creation'))).toBe(false);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it('rejects polling metadata that loses the repository ID established by the POST response', async () => {
    const pollRepository = repository();
    delete pollRepository.id;
    const mock = server({ pollRepository });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.refReads()).toEqual([]);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it.each(['changes', 'disappears'] as const)('pins the first polled repository ID and refuses it when it later %s', async change => {
    const postRepository = repository();
    delete postRepository.id;
    const laterRepository = repository();
    if (change === 'changes') laterRepository.id = 456;
    else delete laterRepository.id;
    const mock = server({ postRepository, pollRepositories: [repository(), laterRepository], pendingRefReads: [404] });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.targetReads()).toHaveLength(3);
    expect(mock.refReads()).toHaveLength(1);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it('allows the first polled repository ID to remain stable while its branch becomes ready', async () => {
    const postRepository = repository();
    delete postRepository.id;
    const mock = server({ postRepository, pollRepositories: [repository(), repository()], pendingRefReads: [404] });
    await expect(mock.client.createFork(requestedName)).resolves.toMatchObject({ fullName: `alice/${requestedName}` });
    expect(mock.targetReads()).toHaveLength(3);
    expect(mock.refReads()).toHaveLength(2);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it.each(['../main', 'main.lock', 'main\nother', '@', 'main//daily'])('refuses unsafe default branch metadata %j before requesting its ref', async default_branch => {
    const mock = server({ pollRepository: { ...repository(), default_branch } });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.refReads()).toEqual([]);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it('reads a valid slash-containing default branch with a 64-digit commit ID', async () => {
    const mock = server({ postRepository: { ...repository(), default_branch: 'daily/main' },
      refBody: { ref: 'refs/heads/daily/main', object: { sha: 'b'.repeat(64), type: 'commit' } } });
    await expect(mock.client.createFork(requestedName)).resolves.toMatchObject({ defaultBranch: 'daily/main' });
    expect(mock.refReads()).toHaveLength(1);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it('supports responses that omit optional repository ID and push permission', async () => {
    const postRepository = repository();
    delete postRepository.id;
    delete postRepository.permissions;
    const mock = server({ postRepository });
    await expect(mock.client.createFork(requestedName)).resolves.toMatchObject({ fullName: `alice/${requestedName}` });
    expect(mock.unexpected).toEqual([]);
  });

  it('waits for a valid default branch when the accepted POST has not populated it yet', async () => {
    const mock = server({ postRepository: { ...repository(), default_branch: '' }, pollRepository: repository() });
    await expect(mock.client.createFork(requestedName)).resolves.toMatchObject({ defaultBranch: 'main' });
    expect(mock.refReads()).toHaveLength(1);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });

  it('waits through delayed repository creation and default ref readiness without repeating POST', async () => {
    const mock = server({ pendingRepositoryReads: 2, pendingRefReads: [404, 409] });
    await expect(mock.client.createFork(requestedName)).resolves.toMatchObject({ fullName: `alice/${requestedName}` });
    expect(mock.writes()).toHaveLength(1);
    expect(mock.refReads()).toHaveLength(3);
    expect(mock.sleep).toHaveBeenCalled();
    expect(mock.unexpected).toEqual([]);
  });

  it('does not declare an accepted fork ready when its default branch never becomes readable', async () => {
    const mock = server({ pendingRefReads: Array.from({ length: 30 }, () => 404) });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.writes()).toHaveLength(1);
    expect(mock.refReads().length).toBeGreaterThan(0);
    expect(mock.refReads().length).toBeLessThanOrEqual(20);
    expect(mock.unexpected).toEqual([]);
  });

  it.each([
    {}, { object: null }, { object: {} }, { object: { sha: '' } }, { object: { sha: 'invalid' } },
    { object: { sha: defaultSha, type: 'tag' } },
    { ref: 'refs/heads/other-branch', object: { sha: defaultSha, type: 'commit' } },
  ])('rejects unreadable default ref metadata %j', async refBody => {
    const mock = server({ refBody });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.writes()).toHaveLength(1);
    expect(mock.unexpected).toEqual([]);
  });
});

describe('Fork creation failure recovery', () => {
  it.each(['lost', 'timeout', 500, 503] as const)('recovers an accepted creation after %s using only the exact requested target', async postFailure => {
    const mock = server({ postFailure, createdOnFailure: true });
    await expect(mock.client.createFork(requestedName)).resolves.toMatchObject({ fullName: `alice/${requestedName}` });
    expect(mock.writes()).toEqual([{ method: 'POST', path: `${upstreamPath}/forks`, body: { name: requestedName, default_branch_only: true } }]);
    expect(mock.targetReads().length).toBeGreaterThan(1);
    expect(mock.refReads()).toHaveLength(1);
    expect(mock.requests.filter(request => request.method === 'GET').every(request =>
      request.path === '/user' || request.path === targetPath || request.path === `${targetPath}/git/ref/heads/main`,
    )).toBe(true);
    expect(mock.unexpected).toEqual([]);
  });

  it.each(['lost', 'timeout', 503] as const)('refuses to invent success after %s when the target was not created', async postFailure => {
    const mock = server({ postFailure, createdOnFailure: false });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.writes()).toHaveLength(1);
    expect(mock.targetReads().length).toBeGreaterThan(1);
    expect(mock.refReads()).toEqual([]);
    expect(mock.unexpected).toEqual([]);
  });

  it.each([401, 403, 404, 409, 422, 429])('keeps HTTP %i fatal and does not turn an unrelated side effect into recovered success', async postFailure => {
    const mock = server({ postFailure, createdOnFailure: true });
    const error = await mock.client.createFork(requestedName).catch(error => error);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.status).toBe(postFailure);
    if (postFailure === 422) {
      expect(error.message).toMatch(/未接受创建 Fork/);
      expect(error.message).toMatch(/新仓库名称/);
      expect(error.message).toMatch(/同一个账号.*第二个 Fork/);
      expect(error.message).toMatch(/手动选择已有 Fork.*其他账号/);
    }
    expect(mock.targetReads()).toHaveLength(1);
    expect(mock.refReads()).toEqual([]);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.sleep).not.toHaveBeenCalled();
    expect(mock.unexpected).toEqual([]);
  });

  it.each([
    { label: 'wrong owner', value: { ...repository(), owner: { login: 'mallory' } } },
    { label: 'wrong network', value: { ...repository(), parent: { full_name: 'unrelated/repository' } } },
    { label: 'no push permission', value: { ...repository(), permissions: { push: false } } },
  ])('does not recover a target with $label', async ({ value: pollRepository }) => {
    const mock = server({ postFailure: 'lost', createdOnFailure: true, pollRepository });
    await expect(mock.client.createFork(requestedName)).rejects.toThrow();
    expect(mock.writes()).toHaveLength(1);
    expect(mock.refReads()).toEqual([]);
    expect(mock.unexpected).toEqual([]);
  });
});
