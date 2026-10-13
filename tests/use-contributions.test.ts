import { describe, expect, it, vi } from 'vitest';
import type { ClientAPI, ContributionPage, RemotePullRequest } from '../shared/types';
vi.mock('../src/bridge', () => ({ api: {} }));
import { ContributionsController } from '../src/useContributions';

const repository = 'example/problems';
const login = 'alice';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function pull(number: number, overrides: Partial<RemotePullRequest> = {}): RemotePullRequest {
  return { id: `pr-${number}`, number, title: `PR ${number}`, url: `https://github.com/${repository}/pull/${number}`,
    state: 'open', createdAt: '2026-10-07', updatedAt: '2026-10-07', filesTruncated: false,
    problems: [{ date: '2026-10-07', problemId: `cf${number}a`, path: `cf${number}a_signature.cpp` }], ...overrides };
}
function page(number = 1, items: RemotePullRequest[] = [pull(number)], overrides: Partial<ContributionPage> = {}): ContributionPage {
  return { items, totalCount: items.length, openCount: items.length, mergedCount: 0, closedCount: 0,
    page: number, pageSize: 50, hasMore: false, truncated: false, incomplete: false,
    login, repository, fetchedAt: '2026-10-07', ...overrides };
}
function setup() {
  const client = { getContributions: vi.fn<ClientAPI['getContributions']>().mockResolvedValue(page()) };
  return { client, controller: new ContributionsController(client) };
}
async function settle() { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); }

describe('current-view contribution reads', () => {
  it('clears results immediately on refresh and does not restore them when page one fails', async () => {
    const { client, controller } = setup();
    await controller.enter(login, repository, 'today');
    expect(controller.getSnapshot().statusIndex.complete).toBe(true);
    const next = deferred<ContributionPage>();
    client.getContributions.mockReturnValueOnce(next.promise);
    const refresh = controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ statistics: null, items: [], indexedItems: [], loading: true });
    next.reject(new Error('GitHub 暂不可用'));
    await refresh;
    expect(controller.getSnapshot()).toMatchObject({ statistics: null, items: [], indexedItems: [], loading: false,
      error: 'GitHub 暂不可用', statusIndex: { complete: false, loading: false, error: 'GitHub 暂不可用', loaded: 0 } });
  });

  it('reads each page entry afresh and disables all reads outside a contribution scope', async () => {
    const { client, controller } = setup();
    await controller.enter(login, repository, 'today');
    await controller.enter(login, repository, 'archive');
    await controller.enter(login, repository, 'today');
    expect(client.getContributions.mock.calls).toEqual([[1], [1], [1]]);
    await controller.enter(login, repository, null);
    await controller.refresh(); await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ statistics: null, items: [], indexedItems: [], loading: false });
    expect(client.getContributions).toHaveBeenCalledTimes(3);
    await controller.enter(login, repository, 'history');
    expect(client.getContributions).toHaveBeenCalledTimes(4);
  });

  it.each(['today', 'detail:2026-10-07/cf1a'])('does not let an old %s response replace the new scope', async scope => {
    const { client, controller } = setup();
    const old = deferred<ContributionPage>();
    client.getContributions.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(1, [pull(2)]));
    const first = controller.enter(login, repository, scope);
    await settle();
    await controller.enter(login, repository, 'detail:2026-10-07/cf2a');
    old.resolve(page(1, [pull(1)], { hasMore: true, totalCount: 80 }));
    await first;
    expect(controller.getSnapshot().indexedItems.map(item => item.number)).toEqual([2]);
    expect(client.getContributions).toHaveBeenCalledTimes(2);
  });

  it('ignores an old account failure and accepts only the new account records', async () => {
    const { client, controller } = setup();
    const old = deferred<ContributionPage>();
    client.getContributions.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(1, [pull(2)], { login: 'bob' }));
    const first = controller.enter(login, repository, 'today');
    await settle();
    await controller.enter('bob', repository, 'today');
    old.reject(new Error('alice 的旧错误'));
    await first;
    expect(controller.getSnapshot()).toMatchObject({ error: '', items: [pull(2)], statusIndex: { complete: true, error: '' } });
  });

  it('clears logout data and does not request anonymous account history', async () => {
    const { client, controller } = setup();
    await controller.enter(login, repository, 'today');
    await controller.enter('', repository, 'today');
    await controller.refresh();
    expect(client.getContributions).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ statistics: null, items: [], indexedItems: [] });
  });

  it.each([{ login: 'another' }, { repository: 'another/problems' }])('rejects mismatched remote provenance: %j', async wrong => {
    const { client, controller } = setup();
    client.getContributions.mockResolvedValueOnce(page(1, [pull(2)], wrong));
    await controller.enter(login, repository, 'today');
    expect(controller.getSnapshot()).toMatchObject({ statistics: null, items: [], indexedItems: [] });
    expect(controller.getSnapshot().error).toContain('当前账号或仓库不一致');
  });

  it.each([{ page: 2 }, { pageSize: 0 }, { totalCount: -1 }])('rejects invalid pagination: %j', async wrong => {
    const { client, controller } = setup();
    client.getContributions.mockResolvedValueOnce(page(1, [pull(2)], wrong));
    await controller.enter(login, repository, 'history');
    expect(controller.getSnapshot().indexedItems).toEqual([]);
    expect(controller.getSnapshot().error).toContain('分页无效');
  });

  it('shares an in-flight page between visible pagination and background recognition', async () => {
    const { client, controller } = setup();
    const second = deferred<ContributionPage>();
    client.getContributions.mockResolvedValueOnce(page(1, [pull(1)], { totalCount: 2, hasMore: true }))
      .mockReturnValueOnce(second.promise);
    await controller.enter(login, repository, 'history');
    await settle();
    const more = controller.loadMore();
    await settle();
    expect(client.getContributions.mock.calls).toEqual([[1], [2]]);
    second.resolve(page(2, [pull(2)], { totalCount: 2 }));
    await more; await settle();
    expect(controller.getSnapshot()).toMatchObject({ items: [pull(1), pull(2)], indexedItems: [pull(1), pull(2)],
      loading: false, statusIndex: { complete: true, loading: false, loaded: 2 } });
  });

  it('rereads a completed background page when the user loads it and replaces removed PRs', async () => {
    const { client, controller } = setup();
    client.getContributions.mockResolvedValueOnce(page(1, [pull(1)], { totalCount: 2, hasMore: true }))
      .mockResolvedValueOnce(page(2, [pull(2)], { totalCount: 2 }))
      .mockResolvedValueOnce(page(2, [pull(3)], { totalCount: 2 }));
    await controller.enter(login, repository, 'history'); await settle();
    expect(controller.getSnapshot().items).toEqual([pull(1)]);
    expect(controller.getSnapshot().indexedItems).toEqual([pull(1), pull(2)]);
    await controller.loadMore();
    expect(client.getContributions.mock.calls).toEqual([[1], [2], [2]]);
    expect(controller.getSnapshot()).toMatchObject({ items: [pull(1), pull(3)], indexedItems: [pull(1), pull(3)],
      statusIndex: { complete: true } });
  });

  it('does not retain the completed background page when its later foreground reread fails', async () => {
    const { client, controller } = setup();
    client.getContributions.mockResolvedValueOnce(page(1, [pull(1)], { totalCount: 2, hasMore: true }))
      .mockResolvedValueOnce(page(2, [pull(2)], { totalCount: 2 }))
      .mockRejectedValueOnce(new Error('第二页读取失败'));
    await controller.enter(login, repository, 'history'); await settle();
    await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ items: [pull(1)], indexedItems: [pull(1)], error: '第二页读取失败',
      statusIndex: { complete: false, loading: false, error: '第二页读取失败', loaded: 1 } });
  });

  it('retries a failed background page through loadMore and resumes its current traversal without rereading successes', async () => {
    const { client, controller } = setup();
    client.getContributions.mockResolvedValueOnce(page(1, [pull(1)], { totalCount: 3, hasMore: true }))
      .mockRejectedValueOnce(new Error('第二页失败'))
      .mockResolvedValueOnce(page(2, [pull(2)], { totalCount: 3, hasMore: true }))
      .mockResolvedValueOnce(page(3, [pull(3)], { totalCount: 3 }));
    await controller.enter(login, repository, 'history'); await settle();
    expect(controller.getSnapshot().statusIndex).toMatchObject({ complete: false, error: '第二页失败', loaded: 1 });
    await controller.loadMore(); await settle();
    expect(client.getContributions.mock.calls).toEqual([[1], [2], [2], [3]]);
    expect(controller.getSnapshot()).toMatchObject({ items: [pull(1), pull(2)], indexedItems: [pull(1), pull(2), pull(3)],
      statusIndex: { complete: true, error: '', loaded: 3 } });
  });

  it('lets a refresh supersede a pending refresh without an old finally clearing the new spinner', async () => {
    const { client, controller } = setup();
    const old = deferred<ContributionPage>(), fresh = deferred<ContributionPage>();
    client.getContributions.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = controller.enter(login, repository, 'today'); await settle();
    const second = controller.refresh(); await settle();
    old.reject(new Error('旧刷新失败')); await first;
    expect(controller.getSnapshot()).toMatchObject({ loading: true, error: '', items: [], statusIndex: { loading: true } });
    fresh.resolve(page(1, [pull(3)])); await second;
    expect(controller.getSnapshot()).toMatchObject({ loading: false, error: '', items: [pull(3)] });
  });

  it('stops extending old background work after leaving and does not restore its late response', async () => {
    const { client, controller } = setup();
    const second = deferred<ContributionPage>();
    client.getContributions.mockResolvedValueOnce(page(1, [pull(1)], { totalCount: 3, hasMore: true }))
      .mockReturnValueOnce(second.promise);
    await controller.enter(login, repository, 'today'); await settle();
    await controller.enter(login, repository, null);
    second.resolve(page(2, [pull(2)], { totalCount: 3, hasMore: true })); await settle();
    expect(client.getContributions.mock.calls).toEqual([[1], [2]]);
    expect(controller.getSnapshot()).toMatchObject({ statistics: null, items: [], indexedItems: [], error: '' });
  });

  it.each([
    { incomplete: true }, { truncated: true }, { totalCount: 2 },
  ])('does not claim complete recognition from incomplete evidence: %j', async partial => {
    const { client, controller } = setup();
    client.getContributions.mockResolvedValueOnce(page(1, [pull(1)], partial));
    await controller.enter(login, repository, 'today');
    expect(controller.getSnapshot()).toMatchObject({ indexedItems: [pull(1)], statusIndex: { complete: false } });
  });

  it('marks truncated PR file lists incomplete and keeps the account evidence', async () => {
    const { client, controller } = setup();
    const record = pull(1, { filesTruncated: true });
    client.getContributions.mockResolvedValueOnce(page(1, [record]));
    await controller.enter(login, repository, 'today');
    expect(controller.getSnapshot()).toMatchObject({ indexedItems: [record], statusIndex: { complete: false, truncated: true } });
  });

  it('keeps duplicate page entries deduplicated and refuses to claim complete counts', async () => {
    const { client, controller } = setup();
    client.getContributions.mockResolvedValueOnce(page(1, [pull(1)], { totalCount: 2, hasMore: true }))
      .mockResolvedValueOnce(page(2, [pull(1, { state: 'merged' })], { totalCount: 2 }));
    await controller.enter(login, repository, 'history'); await settle();
    expect(controller.getSnapshot().indexedItems).toEqual([pull(1, { state: 'merged' })]);
    expect(controller.getSnapshot().statusIndex).toMatchObject({ complete: false, loaded: 1 });
  });

  it('does not let an older overlapping page undo a merge or restore removed problem files', async () => {
    const { client, controller } = setup();
    const current = pull(1, { state: 'merged', updatedAt: '2026-10-07T02:00:00Z', problems: [] });
    const old = pull(1, { state: 'open', updatedAt: '2026-10-07T01:00:00Z' });
    client.getContributions.mockResolvedValueOnce(page(1, [current], { totalCount: 2, hasMore: true }))
      .mockResolvedValueOnce(page(2, [old], { totalCount: 2 }))
      .mockResolvedValueOnce(page(2, [old], { totalCount: 2 }));
    await controller.enter(login, repository, 'history'); await settle();
    expect(controller.getSnapshot().indexedItems).toEqual([current]);
    await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ items: [current], indexedItems: [current],
      statusIndex: { complete: false, loaded: 1 } });
  });

  it('uses a newer overlapping page as a whole snapshot without retaining old file evidence', async () => {
    const { client, controller } = setup();
    const old = pull(1, { updatedAt: '2026-10-07T01:00:00Z' });
    const current = pull(1, { state: 'merged', updatedAt: '2026-10-07T02:00:00Z', problems: [] });
    client.getContributions.mockResolvedValueOnce(page(1, [old], { totalCount: 2, hasMore: true }))
      .mockResolvedValueOnce(page(2, [current], { totalCount: 2 }));
    await controller.enter(login, repository, 'today'); await settle();
    expect(controller.getSnapshot().indexedItems).toEqual([current]);
    expect(controller.getSnapshot().statusIndex.complete).toBe(false);
  });

  it('invalidates unmounted requests and starts a fresh read after reentry', async () => {
    const { client, controller } = setup();
    const old = deferred<ContributionPage>();
    client.getContributions.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(1, [pull(2)]));
    const first = controller.enter(login, repository, 'today'); await settle();
    controller.dispose();
    await controller.enter(login, repository, 'today');
    old.resolve(page(1, [pull(1)])); await first;
    expect(controller.getSnapshot().items).toEqual([pull(2)]);
  });

  it('does not start a queued network read after immediately leaving the view', async () => {
    const { client, controller } = setup();
    const entering = controller.enter(login, repository, 'today');
    await controller.enter(login, repository, null);
    await entering;
    expect(client.getContributions).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ error: '', indexedItems: [] });
  });

  it.each(['success', 'failure'])('ignores a pending tail %s after a fresh earlier page ends the results', async outcome => {
    const { client, controller } = setup();
    const tail = deferred<ContributionPage>();
    client.getContributions.mockResolvedValueOnce(page(1, [pull(1)], { totalCount: 3, hasMore: true }))
      .mockResolvedValueOnce(page(2, [pull(2)], { totalCount: 3, hasMore: true }))
      .mockReturnValueOnce(tail.promise)
      .mockResolvedValueOnce(page(2, [pull(4)], { totalCount: 2 }));
    await controller.enter(login, repository, 'history'); await settle();
    await controller.loadMore();
    if (outcome === 'success') tail.resolve(page(3, [pull(3)], { totalCount: 3 }));
    else tail.reject(new Error('被移除的第三页错误'));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ items: [pull(1), pull(4)], indexedItems: [pull(1), pull(4)],
      error: '', statusIndex: { complete: false, loading: false, error: '', loaded: 2 } });
    expect(client.getContributions.mock.calls).toEqual([[1], [2], [3], [2]]);
  });

  it('recognizes an empty account as complete without additional page requests', async () => {
    const { client, controller } = setup();
    client.getContributions.mockResolvedValueOnce(page(1, []));
    await controller.enter(login, repository, 'history');
    await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ items: [], indexedItems: [], statusIndex: { complete: true, total: 0 } });
    expect(client.getContributions.mock.calls).toEqual([[1]]);
  });

  it('stops at GitHub search limits and never reports the limited result set as complete', async () => {
    const { client, controller } = setup();
    client.getContributions.mockImplementation(async number => page(number, [pull(number ?? 1)], {
      totalCount: 1001, hasMore: true, truncated: true,
    }));
    await controller.enter(login, repository, 'history');
    for (let turn = 0; turn < 20; turn++) await settle();
    expect(client.getContributions.mock.calls.map(([number]) => number)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(controller.getSnapshot().statusIndex).toMatchObject({ complete: false, loading: false, truncated: true, loaded: 20 });
  });
});
