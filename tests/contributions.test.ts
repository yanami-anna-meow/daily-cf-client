import { describe, expect, it } from 'vitest';
import { latestPullRequests } from '../shared/contributions';
import type { RemotePullRequest } from '../shared/types';

function pull(overrides: Partial<RemotePullRequest> = {}): RemotePullRequest {
  return { id: 'pr-1', number: 1, title: 'Solution', url: 'https://github.com/example/problems/pull/1',
    state: 'open', createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T01:00:00Z', filesTruncated: false,
    problems: [{ date: '2026-10-07', problemId: 'cf1234a', path: 'cf1234a_example.cpp' }], ...overrides };
}

describe('current PR snapshots', () => {
  it.each([false, true])('selects the newest revision independently of page order (reversed=%s)', reverse => {
    const old = pull(), current = pull({ state: 'merged', updatedAt: '2026-10-07T02:00:00Z', problems: [] });
    const input = reverse ? [current, old] : [old, current];
    expect(latestPullRequests(input)).toEqual([current]);
    expect(input[reverse ? 1 : 0].problems).toHaveLength(1);
  });

  it('compares timestamp instants, rather than lexicographic offsets', () => {
    const newer = pull({ updatedAt: '2026-10-07T01:00:00Z', state: 'merged' });
    const older = pull({ updatedAt: '2026-10-07T08:30:00+08:00', state: 'open' });
    expect(latestPullRequests([newer, older])).toEqual([newer]);
  });

  it('retains a complete same-revision snapshot and otherwise uses the later observation', () => {
    const complete = pull(), partial = pull({ filesTruncated: true, problems: [] });
    expect(latestPullRequests([complete, partial])).toEqual([complete]);
    expect(latestPullRequests([partial, complete])).toEqual([complete]);
    const later = pull({ state: 'closed' });
    expect(latestPullRequests([complete, later])).toEqual([later]);
  });

  it('does not mix old files into a newer incomplete snapshot', () => {
    const old = pull(), current = pull({ updatedAt: '2026-10-07T02:00:00Z', filesTruncated: true, problems: [] });
    expect(latestPullRequests([old, current])).toEqual([current]);
  });

  it('falls back to creation time and never drops distinct PRs with the same problem', () => {
    const older = pull({ updatedAt: '', createdAt: '2026-10-06T00:00:00Z' });
    const newer = pull({ updatedAt: '', createdAt: '2026-10-07T00:00:00Z' });
    const another = pull({ id: 'pr-2', number: 2, state: 'merged' });
    expect(latestPullRequests([older, another, newer])).toEqual([newer, another]);
  });
});
