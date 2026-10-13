import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ForkSyncService, type ForkSyncAdapter, type ForkSyncRepository } from '../electron/fork-sync';

const sha = (name: string) => createHash('sha1').update(name).digest('hex');
const root = sha('root');
const old = sha('old upstream');
const base = sha('current upstream');
const future = sha('next upstream');
const ahead = sha('personal fork work');
const divergent = sha('divergent fork work');
const clone = <T>(value: T): T => structuredClone(value);
const branchPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');
type Request = { path: string; method: string; body?: any };
class ApiError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

/** A small immutable commit graph. Ref writes enforce ancestry independently of
 * the client, and comparisons are derived from reachable commits. */
function server(initial: 'synced' | 'behind' | 'ahead' | 'diverged' = 'behind', ownedUpstream = false) {
  const upstream: ForkSyncRepository = { full_name: 'maintainer/daily', default_branch: 'main', owner: { login: 'maintainer' } };
  const fork: ForkSyncRepository = ownedUpstream ? clone(upstream) : {
    full_name: 'alice/renamed-fork', default_branch: 'practice/main', owner: { login: 'alice' },
  };
  const remoteFork = clone(fork);
  const commits = new Map<string, string[]>([
    [root, []], [old, [root]], [base, [old]], [future, [base]], [ahead, [base]], [divergent, [old]],
  ]);
  const reachable = (start: string) => {
    if (!commits.has(start)) throw new ApiError('Unknown commit', 404);
    const result = new Set<string>();
    const pending = [start];
    while (pending.length) {
      const current = pending.pop()!;
      if (result.has(current)) continue;
      result.add(current);
      pending.push(...commits.get(current)!);
    }
    return result;
  };
  const upstreamRef = `/repos/${upstream.full_name}/git/ref/heads/${branchPath(upstream.default_branch)}`;
  const forkRef = `/repos/${fork.full_name}/git/ref/heads/${branchPath(fork.default_branch)}`;
  const forkWrite = forkRef.replace('/git/ref/', '/git/refs/');
  const refs = new Map<string, string>([[upstreamRef, base]]);
  if (!ownedUpstream) refs.set(forkRef, { synced: base, behind: old, ahead, diverged: divergent }[initial]);
  const requests: Request[] = [];
  const compare = (baseSha: string, headSha: string) => {
    const baseCommits = reachable(baseSha);
    const headCommits = reachable(headSha);
    const aheadBy = [...headCommits].filter(commit => !baseCommits.has(commit)).length;
    const behindBy = [...baseCommits].filter(commit => !headCommits.has(commit)).length;
    const mergeBase = [...headCommits].find(commit => baseCommits.has(commit));
    return {
      status: !aheadBy && !behindBy ? 'identical' : !behindBy ? 'ahead' : !aheadBy ? 'behind' : 'diverged',
      ahead_by: aheadBy, behind_by: behindBy, total_commits: aheadBy,
      base_commit: { sha: baseSha }, merge_base_commit: { sha: mergeBase },
      commits: [...headCommits].filter(commit => !baseCommits.has(commit)).map(sha => ({ sha })),
    };
  };
  const hooks: {
    before?: (request: Request) => unknown;
    after?: (request: Request, response: any) => unknown;
  } = {};
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const call: Request = { path, method, body: clone(body) };
    requests.push(call);
    const intercepted = hooks.before?.(call);
    if (intercepted !== undefined) return clone(intercepted) as T;
    let response: unknown;
    if (method === 'GET' && (path === upstreamRef || path === forkRef)) {
      const refSha = refs.get(path);
      if (!refSha) throw new ApiError('Reference not found', 404);
      const branch = path === upstreamRef ? upstream.default_branch : fork.default_branch;
      response = { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: refSha } };
    } else if (method === 'GET' && path === `/repos/${fork.full_name}`) {
      response = clone(remoteFork);
    } else if (method === 'GET' && path.startsWith(`/repos/${fork.full_name}/compare/`)) {
      const [baseSha, headSha] = path.slice(path.lastIndexOf('/') + 1).split('...').map(decodeURIComponent);
      response = compare(baseSha, headSha);
    } else if (method === 'PATCH' && path === forkWrite) {
      const update = body as { sha?: string; force?: boolean };
      if (update.force !== false || !update.sha || !reachable(update.sha).has(refs.get(forkRef)!)) {
        throw new ApiError('Reference update is not a fast-forward', 422);
      }
      refs.set(forkRef, update.sha);
      response = { ref: `refs/heads/${fork.default_branch}`, object: { type: 'commit', sha: update.sha } };
    } else throw new Error(`Unexpected API call: ${method} ${path}`);
    const replacement = hooks.after?.(call, response);
    return clone(replacement === undefined ? response : replacement) as T;
  };
  const adapter: ForkSyncAdapter = { request, error: (message, status) => new ApiError(message, status) };
  return {
    service: new ForkSyncService(adapter), upstream, fork, remoteFork, requests, refs, hooks,
    upstreamRef, forkRef, forkWrite, compare,
    writes: () => requests.filter(call => call.method !== 'GET'),
  };
}

describe('ForkSyncService inspection', () => {
  it.each([
    ['synced', base, 0, 0], ['behind', old, 0, 1], ['ahead', ahead, 1, 0], ['diverged', divergent, 1, 1],
  ] as const)('reports %s from the actual commit graph without writes', async (state, forkSha, aheadBy, behindBy) => {
    const fixture = server(state);
    expect(await fixture.service.inspect(fixture.upstream, fixture.fork, base)).toEqual({
      state, repository: fixture.fork.full_name, branch: fixture.fork.default_branch,
      upstreamSha: base, forkSha, aheadBy, behindBy,
    });
    expect(fixture.writes()).toEqual([]);
  });

  it('reads slash-separated branch names through their exact ref path', async () => {
    const fixture = server();
    await fixture.service.inspect(fixture.upstream, fixture.fork, base);
    expect(fixture.requests.some(call => call.path === '/repos/alice/renamed-fork/git/ref/heads/practice/main')).toBe(true);
  });

  it('rejects a stale upstream snapshot without writes', async () => {
    const fixture = server();
    fixture.refs.set(fixture.upstreamRef, future);
    await expect(fixture.service.inspect(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.writes()).toEqual([]);
  });

  it('normalizes hexadecimal SHA casing without changing the selected commit', async () => {
    const fixture = server('synced');
    const status = await fixture.service.inspect(fixture.upstream, fixture.fork, base.toUpperCase());
    expect(status.upstreamSha).toBe(base);
    expect(status.forkSha).toBe(base);
    expect(fixture.writes()).toEqual([]);
  });

  it.each(['main', `${base}/../main`, 'a'.repeat(39), 'g'.repeat(40)])('rejects an invalid expected upstream SHA %s before requesting GitHub', async invalid => {
    const fixture = server();
    await expect(fixture.service.inspect(fixture.upstream, fixture.fork, invalid)).rejects.toThrow();
    expect(fixture.requests).toEqual([]);
  });

  it('rejects an absent fork default branch without creating it', async () => {
    const fixture = server();
    fixture.refs.delete(fixture.forkRef);
    await expect(fixture.service.inspect(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.writes()).toEqual([]);
  });

  it.each([
    ['invalid SHA', { object: { type: 'commit', sha: 'not-a-sha' } }],
    ['non-commit object', { object: { type: 'tag', sha: old } }],
    ['different reference', { ref: 'refs/heads/unrelated', object: { type: 'commit', sha: old } }],
  ])('rejects a ref response with %s', async (_name, response) => {
    const fixture = server();
    fixture.hooks.before = call => call.path === fixture.forkRef ? response : undefined;
    await expect(fixture.service.inspect(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.writes()).toEqual([]);
  });

  it.each([
    ['wrong base', { base_commit: { sha: future } }],
    ['invalid merge base', { merge_base_commit: { sha: 'broken' } }],
    ['wrong behind merge base', { merge_base_commit: { sha: root } }],
    ['negative count', { behind_by: -1 }],
    ['fractional count', { behind_by: 0.5 }],
    ['unsafe count', { behind_by: Number.MAX_SAFE_INTEGER + 1 }],
    ['non-finite count', { behind_by: Infinity }],
    ['missing count', { behind_by: undefined }],
    ['contradictory counts', { ahead_by: 1 }],
    ['unknown state', { status: 'mystery' }],
  ])('rejects an inconsistent comparison: %s', async (_name, patch) => {
    const fixture = server();
    fixture.hooks.after = (call, response) => call.path.includes('/compare/') ? { ...response, ...patch } : undefined;
    await expect(fixture.service.inspect(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.writes()).toEqual([]);
  });

  it.each([
    ['synced', { merge_base_commit: { sha: old } }],
    ['synced', { ahead_by: 1 }],
    ['ahead', { merge_base_commit: { sha: old } }],
    ['ahead', { behind_by: 1 }],
    ['diverged', { merge_base_commit: { sha: base } }],
    ['diverged', { merge_base_commit: { sha: divergent } }],
    ['diverged', { ahead_by: 0 }],
  ] as const)('rejects contradictory %s graph metadata', async (state, patch) => {
    const fixture = server(state);
    fixture.hooks.after = (call, response) => call.path.includes('/compare/') ? { ...response, ...patch } : undefined;
    await expect(fixture.service.inspect(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.writes()).toEqual([]);
  });
});

describe('ForkSyncService synchronization', () => {
  it('fast-forwards only the selected fork default branch and verifies the resulting graph', async () => {
    const fixture = server();
    const status = await fixture.service.synchronize(fixture.upstream, fixture.fork, base, old);
    expect(status.state).toBe('synced');
    expect(status.forkSha).toBe(base);
    expect(fixture.refs.get(fixture.forkRef)).toBe(base);
    expect(fixture.refs.get(fixture.upstreamRef)).toBe(base);
    expect(fixture.writes()).toEqual([{ path: fixture.forkWrite, method: 'PATCH', body: { sha: base, force: false } }]);
    const writeIndex = fixture.requests.findIndex(call => call.method === 'PATCH');
    expect(fixture.requests.slice(0, writeIndex).some(call => call.path === `/repos/${fixture.fork.full_name}`)).toBe(true);
    expect(fixture.requests.slice(writeIndex + 1).some(call => call.path === fixture.upstreamRef)).toBe(true);
    expect(fixture.requests.slice(writeIndex + 1).some(call => call.path === fixture.forkRef)).toBe(true);
  });

  it.each(['synced', 'ahead'] as const)('preserves an already %s fork without writes', async state => {
    const fixture = server(state);
    const previous = fixture.refs.get(fixture.forkRef);
    expect((await fixture.service.synchronize(fixture.upstream, fixture.fork, base)).state).toBe(state);
    expect(fixture.refs.get(fixture.forkRef)).toBe(previous);
    expect(fixture.writes()).toEqual([]);
  });

  it('refuses a divergent fork without discarding its independent commit', async () => {
    const fixture = server('diverged');
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.refs.get(fixture.forkRef)).toBe(divergent);
    expect(fixture.writes()).toEqual([]);
  });

  it('never writes when the configured owned repository is upstream itself', async () => {
    const fixture = server('synced', true);
    expect((await fixture.service.synchronize(fixture.upstream, fixture.fork, base)).state).toBe('synced');
    expect(fixture.writes()).toEqual([]);
  });

  it('rejects a fork head changed since the preview before any write', async () => {
    const fixture = server();
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base, root)).rejects.toThrow();
    expect(fixture.writes()).toEqual([]);
  });

  it('rejects upstream movement discovered after comparison before any write', async () => {
    const fixture = server();
    fixture.hooks.after = call => {
      if (call.path.includes('/compare/')) fixture.refs.set(fixture.upstreamRef, future);
    };
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.writes()).toEqual([]);
    expect(fixture.refs.get(fixture.forkRef)).toBe(old);
  });

  it('rejects fork movement between inspection and publication before any write', async () => {
    const fixture = server();
    fixture.hooks.after = call => {
      if (call.path.includes('/compare/')) fixture.refs.set(fixture.forkRef, divergent);
    };
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.writes()).toEqual([]);
    expect(fixture.refs.get(fixture.forkRef)).toBe(divergent);
  });

  it.each([
    ['default branch', { default_branch: 'changed-branch' }],
    ['repository name', { full_name: 'alice/different-fork' }],
    ['owner', { owner: { login: 'mallory' } }],
  ])('rejects changed fork %s metadata before publication', async (_name, patch) => {
    const fixture = server();
    Object.assign(fixture.remoteFork, patch);
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.writes()).toEqual([]);
  });

  it.each([
    ['replacement repository with the same name', 101, 202],
    ['repository ID omitted after inspection', 101, undefined],
    ['repository ID unknown at inspection', undefined, 101],
  ] as const)('rejects %s before any PATCH', async (_name, inspectedId, currentId) => {
    const fixture = server();
    fixture.fork.id = inspectedId;
    fixture.remoteFork.id = currentId;
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.refs.get(fixture.forkRef)).toBe(old);
    expect(fixture.writes()).toEqual([]);
  });

  it('fast-forwards when the freshly read repository ID matches the inspected ID', async () => {
    const fixture = server();
    fixture.fork.id = 101;
    fixture.remoteFork.id = 101;
    expect((await fixture.service.synchronize(fixture.upstream, fixture.fork, base)).state).toBe('synced');
    expect(fixture.refs.get(fixture.forkRef)).toBe(base);
    expect(fixture.writes()).toEqual([{ path: fixture.forkWrite, method: 'PATCH', body: { sha: base, force: false } }]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('rejects invalid repository ID %s before requesting GitHub', async id => {
    const fixture = server();
    fixture.fork.id = id;
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.requests).toEqual([]);
    expect(fixture.refs.get(fixture.forkRef)).toBe(old);
  });

  it('rejects an invalid repository ID received from GitHub before any PATCH', async () => {
    const fixture = server();
    fixture.fork.id = 101;
    fixture.remoteFork.id = -1;
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.refs.get(fixture.forkRef)).toBe(old);
    expect(fixture.writes()).toEqual([]);
  });

  it('uses non-force publication to preserve a concurrent divergent commit at the last instant', async () => {
    const fixture = server();
    fixture.hooks.before = call => {
      if (call.method === 'PATCH') fixture.refs.set(fixture.forkRef, divergent);
    };
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.refs.get(fixture.forkRef)).toBe(divergent);
    expect(fixture.writes()).toHaveLength(1);
    expect(fixture.writes()[0].body.force).toBe(false);
  });

  it('recovers a lost successful update response only by reading the exact published SHA', async () => {
    const fixture = server();
    fixture.hooks.after = call => {
      if (call.method === 'PATCH') throw new ApiError('Network timed out');
    };
    const status = await fixture.service.synchronize(fixture.upstream, fixture.fork, base);
    expect(status.state).toBe('synced');
    expect(status.forkSha).toBe(base);
    expect(fixture.writes()).toHaveLength(1);
  });

  it('verifies a malformed update response by independently reading the exact published SHA', async () => {
    const fixture = server();
    fixture.hooks.after = call => call.method === 'PATCH'
      ? { ref: 'refs/heads/wrong', object: { type: 'commit', sha: future } } : undefined;
    const status = await fixture.service.synchronize(fixture.upstream, fixture.fork, base);
    expect(status.state).toBe('synced');
    expect(status.forkSha).toBe(base);
    expect(fixture.writes()).toHaveLength(1);
  });

  it('rejects a misleading update response when the ref still points to the old commit', async () => {
    const fixture = server();
    fixture.hooks.before = call => call.method === 'PATCH'
      ? { object: { type: 'commit', sha: future } } : undefined;
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.refs.get(fixture.forkRef)).toBe(old);
    expect(fixture.writes()).toHaveLength(1);
  });

  it('does not report a timeout as success when the write never reached GitHub', async () => {
    const fixture = server();
    fixture.hooks.before = call => {
      if (call.method === 'PATCH') throw new ApiError('Network timed out');
    };
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.refs.get(fixture.forkRef)).toBe(old);
    expect(fixture.writes()).toHaveLength(1);
  });

  it('rejects unknown publication when recovery reads fail', async () => {
    const fixture = server();
    let lost = false;
    fixture.hooks.before = call => {
      if (lost && call.path === fixture.forkRef) throw new ApiError('Recovery read failed');
    };
    fixture.hooks.after = call => {
      if (call.method === 'PATCH') { lost = true; throw new ApiError('Network timed out'); }
    };
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.writes()).toHaveLength(1);
  });

  it.each([
    [401, 401, 401],
    [401, 503, 401],
    [401, undefined, 401],
    [403, undefined, 403],
    [429, undefined, 429],
    [0, 401, 401],
    [403, 401, 401],
    [429, 503, 429],
    [0, 503, 503],
  ] as const)('preserves failure status for PATCH %s and recovery GET %s as %s', async (writeStatus, recoveryStatus, expectedStatus) => {
    const fixture = server();
    let attempted = false;
    fixture.hooks.before = call => {
      if (call.method === 'PATCH') {
        attempted = true;
        throw new ApiError('Publication request failed', writeStatus);
      }
      if (attempted && call.path === fixture.forkRef && recoveryStatus !== undefined) {
        throw new ApiError('Recovery request failed', recoveryStatus);
      }
    };
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toMatchObject({
      status: expectedStatus,
      message: expect.stringContaining('尚未提交本次代码'),
    });
    expect(fixture.refs.get(fixture.forkRef)).toBe(old);
    expect(fixture.writes()).toEqual([{ path: fixture.forkWrite, method: 'PATCH', body: { sha: base, force: false } }]);
  });

  it.each([0, 401, 403, 429])('preserves post-publication verification status %s and reports the completed fast-forward', async status => {
    const fixture = server();
    let published = false;
    fixture.hooks.after = call => {
      if (call.method === 'PATCH') published = true;
    };
    fixture.hooks.before = call => {
      if (published && call.method === 'GET') throw new ApiError('Final verification failed', status);
    };
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toMatchObject({
      status,
      message: expect.stringContaining('已安全快进'),
    });
    expect(fixture.refs.get(fixture.forkRef)).toBe(base);
    expect(fixture.writes()).toEqual([{ path: fixture.forkWrite, method: 'PATCH', body: { sha: base, force: false } }]);
  });

  it('rejects recovery at a different SHA even when that commit contains the requested base', async () => {
    const fixture = server();
    fixture.hooks.after = call => {
      if (call.method === 'PATCH') {
        fixture.refs.set(fixture.forkRef, ahead);
        throw new ApiError('Network timed out');
      }
    };
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.refs.get(fixture.forkRef)).toBe(ahead);
    expect(fixture.writes()).toHaveLength(1);
  });

  it('detects upstream movement after a successful fast-forward instead of claiming current', async () => {
    const fixture = server();
    fixture.hooks.after = call => {
      if (call.method === 'PATCH') fixture.refs.set(fixture.upstreamRef, future);
    };
    await expect(fixture.service.synchronize(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.refs.get(fixture.forkRef)).toBe(base);
    expect(fixture.refs.get(fixture.upstreamRef)).toBe(future);
    expect(fixture.writes()).toHaveLength(1);
  });
});

describe('ForkSyncService read-only submission gates', () => {
  it.each(['synced', 'ahead'] as const)('allows a %s fork containing upstream', async state => {
    const fixture = server(state);
    expect((await fixture.service.assertCurrent(fixture.upstream, fixture.fork, base)).state).toBe(state);
    expect(fixture.writes()).toEqual([]);
  });

  it.each(['behind', 'diverged'] as const)('rejects a %s fork without automatically modifying it', async state => {
    const fixture = server(state);
    await expect(fixture.service.assertCurrent(fixture.upstream, fixture.fork, base)).rejects.toThrow();
    expect(fixture.writes()).toEqual([]);
  });

  it.each([base, ahead])('accepts an existing PR head that contains the exact base %s', async head => {
    const fixture = server();
    await fixture.service.assertContainsBase(fixture.fork, base, head);
    expect(fixture.writes()).toEqual([]);
  });

  it.each([old, divergent])('requires updating an existing PR whose head does not contain upstream %s', async head => {
    const fixture = server();
    await expect(fixture.service.assertContainsBase(fixture.fork, base, head)).rejects.toThrow(/GitHub/);
    expect(fixture.refs.get(fixture.forkRef)).toBe(old);
    expect(fixture.writes()).toEqual([]);
  });
});
