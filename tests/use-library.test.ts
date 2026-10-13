import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveMonth, ArchiveSnapshot, ClientAPI, LocalLibraryView, ProblemDay } from '../shared/types';
import { getLocale, setLocale } from '../shared/i18n';
vi.mock('../src/bridge', () => ({ api: {} }));
import { LibraryController } from '../src/useLibrary';

afterEach(() => { setLocale('zh-CN'); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const day = (date: string): ProblemDay => ({
  date, problems: [{ id: 'cf1000a', label: 'Problem', url: 'https://codeforces.com/problemset/problem/1000/A', rating: 1000, hint: '' }],
  sourceUrl: 'https://github.com/example/repo', fetchedAt: date,
});

describe('retained content and authoritative replacement', () => {
  it('restores the latest view immediately on return while performing a new remote check', async () => {
    const { library, client } = setup();
    await library.setView('today');
    await library.setView(null);
    const pending = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(pending.promise);
    const returning = library.setView('today');
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-01'), dayRetained: true, dayLoading: true });
    expect(client.getDay).toHaveBeenCalledTimes(2);
    pending.resolve(day('2024-03-02'));
    await returning;
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-02'), dayRetained: false, dayLoading: false });
  });

  it('shows a local latest day during first-page sync without serializing its remote request', async () => {
    const { library, client } = setup();
    const fresh = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(fresh.promise);
    client.getLocalLibraryView.mockResolvedValueOnce({ kind: 'day', revision: 'a'.repeat(40), day: day('2024-02-29') });
    const loading = library.setView('today');
    expect(client.getDay).toHaveBeenCalledTimes(1);
    expect(client.getLocalLibraryView).toHaveBeenCalledWith({ kind: 'day' });
    await tick();
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-02-29'), dayRetained: true, dayLoading: true });
    fresh.resolve(day('2024-03-01'));
    await loading;
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-01'), dayRetained: false, dayLoading: false });
  });

  it('does not wait for or apply a delayed local day after the fresh result succeeds', async () => {
    const { library, client } = setup();
    const local = deferred<LocalLibraryView | null>();
    client.getLocalLibraryView.mockReturnValueOnce(local.promise);
    await library.setView('today');
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-01'), dayLoading: false, dayRetained: false });
    local.resolve({ kind: 'day', revision: 'a'.repeat(40), day: day('2024-02-01') });
    await tick();
    expect(library.getSnapshot().today).toEqual(day('2024-03-01'));
  });

  it('a local day arriving after a network error remains useful and visibly unverified', async () => {
    const { library, client } = setup();
    const local = deferred<LocalLibraryView | null>();
    client.getLocalLibraryView.mockReturnValueOnce(local.promise);
    client.getDay.mockRejectedValueOnce(new Error('offline'));
    const loading = library.setView('today');
    await loading;
    expect(library.getSnapshot()).toMatchObject({ today: null, dayLoading: false, dayError: 'offline' });
    local.resolve({ kind: 'day', revision: 'a'.repeat(40), day: day('2024-02-29') });
    await tick();
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-02-29'), dayRetained: true, dayLoading: false, dayError: 'offline' });
  });

  it('authoritative removal clears a retained day and cannot be undone by a delayed local response', async () => {
    const { library, client } = setup();
    await library.setView('today');
    const missing = Object.assign(new Error('题库中暂无题单'), { code: 'library_content_missing' });
    client.getDay.mockRejectedValueOnce(missing);
    await library.loadLatest(true);
    expect(library.getSnapshot()).toMatchObject({ today: null, dayRetained: false, dayLoading: false, dayError: '题库中暂无题单' });
    const local = deferred<LocalLibraryView | null>();
    client.getLocalLibraryView.mockReturnValueOnce(local.promise);
    client.getDay.mockRejectedValueOnce(missing);
    await library.loadLatest(true);
    local.resolve({ kind: 'day', revision: 'a'.repeat(40), day: day('2024-02-29') });
    await tick();
    expect(library.getSnapshot()).toMatchObject({ today: null, dayRetained: false, dayError: '题库中暂无题单' });
  });

  it('local read failure does not prevent a fresh latest or archive load', async () => {
    const { library, client } = setup();
    client.getLocalLibraryView.mockRejectedValue(new Error('local unavailable'));
    await library.setView('today');
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-01'), dayError: '', dayRetained: false });
    await library.setView('archive');
    expect(library.getSnapshot()).toMatchObject({ archiveIndex: { '2024-03': [day('2024-03-01')] }, archiveError: '', archiveRetained: false });
  });

  it('keeps an entire previous full index and directory until every fresh month has finished', async () => {
    const { library, client } = setup(directory('2024-03', '2024-02'));
    await library.setView('archive');
    const old = library.getSnapshot();
    const freshSnapshot = snapshot(directory('2024-04', '2024-03'), 'b'.repeat(40));
    client.getArchiveSnapshot.mockResolvedValueOnce(freshSnapshot);
    const april = deferred<ProblemDay[]>(), march = deferred<ProblemDay[]>();
    client.getMonthFromSnapshot.mockReturnValueOnce(april.promise).mockReturnValueOnce(march.promise);
    const refresh = library.refreshArchive();
    await tick();
    april.resolve([day('2024-04-02')]);
    await tick();
    expect(library.getSnapshot()).toMatchObject({ months: old.months, archiveIndex: old.archiveIndex, archiveRetained: true, indexing: true, indexingCompleted: 1 });
    expect(Object.keys(library.getSnapshot().archiveIndex)).toEqual(['2024-03', '2024-02']);
    expect(Object.keys(old.archiveIndex)).toEqual(['2024-03', '2024-02']);
    march.resolve([day('2024-03-31')]);
    await refresh;
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, indexing: false,
      archiveIndex: { '2024-04': [day('2024-04-02')], '2024-03': [day('2024-03-31')] } });
    expect(library.getSnapshot().months.map(entry => entry.month)).toEqual(['2024-04', '2024-03']);
    expect(library.getSnapshot().archiveIndex['2024-02']).toBeUndefined();
  });

  it('failed full refresh keeps the complete old snapshot without mixing in successful new months', async () => {
    const { library, client } = setup(directory('2024-03', '2024-02'));
    await library.setView('archive');
    const old = library.getSnapshot();
    client.getArchiveSnapshot.mockResolvedValueOnce(snapshot(directory('2024-04', '2024-03'), 'b'.repeat(40)));
    client.getMonthFromSnapshot.mockResolvedValueOnce([day('2024-04-02')]).mockRejectedValueOnce(new Error('read failed'));
    await library.refreshArchive();
    expect(library.getSnapshot()).toMatchObject({ archiveIndex: old.archiveIndex, months: old.months, archiveRetained: true,
      indexing: false, indexingCompleted: 2, indexFailures: [{ month: '2024-03', error: 'read failed' }] });
    expect(library.getSnapshot().archiveIndex['2024-04']).toBeUndefined();
    await library.setView(null);
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    const returning = library.setView('archive');
    expect(library.getSnapshot().archiveIndex).toEqual(old.archiveIndex);
    library.stopRefresh();
    await returning;
    pending.resolve(snapshot([]));
  });

  it('stopping a full refresh retains the old full view, then ignores a late successful result', async () => {
    const { library, client } = setup(directory('2024-03'));
    await library.setView('archive');
    client.getArchiveSnapshot.mockResolvedValueOnce(snapshot(directory('2024-03'), 'b'.repeat(40)));
    const pending = deferred<ProblemDay[]>();
    client.getMonthFromSnapshot.mockReturnValueOnce(pending.promise);
    const refresh = library.refreshArchive();
    await tick();
    library.stopRefresh();
    await refresh;
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, indexing: false, indexStopped: true,
      archiveIndex: { '2024-03': [day('2024-03-01')] }, indexingError: '更新已停止，仍显示上次读取的内容。' });
    pending.resolve([]);
    await tick();
    expect(library.getSnapshot().archiveIndex['2024-03']).toEqual([day('2024-03-01')]);
  });

  it('a successful empty directory removes all old months and index entries, including after reentry', async () => {
    const { library, client } = setup(directory('2024-03'));
    await library.setView('archive');
    client.getArchiveSnapshot.mockResolvedValue(snapshot([], 'b'.repeat(40)));
    await library.refreshArchive();
    expect(library.getSnapshot()).toMatchObject({ months: [], archiveIndex: {}, archiveRetained: false, indexing: false });
    expect(Object.keys(library.getSnapshot().archiveIndex)).toEqual([]);
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    await library.setView(null);
    const switching = library.setView('archive');
    expect(library.getSnapshot()).toMatchObject({ months: [], archiveIndex: {}, archiveRetained: true });
    pending.resolve(snapshot([], 'b'.repeat(40)));
    await switching;
  });

  it('a successful empty month read removes old problems and retains the known empty view on the next check', async () => {
    const { library, client } = setup(directory('2024-03'));
    await library.setView('archive');
    client.getArchiveSnapshot.mockResolvedValueOnce(snapshot(directory('2024-03'), 'b'.repeat(40)));
    client.getMonthFromSnapshot.mockResolvedValueOnce([]);
    await library.refreshArchive();
    expect(library.getSnapshot()).toMatchObject({ months: [{ month: '2024-03', days: 0 }], archiveIndex: { '2024-03': [] }, archiveRetained: false });
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    const again = library.refreshArchive();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, directoryLoading: true });
    pending.reject(new Error('offline'));
    await again;
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, archiveError: 'offline' });
  });

  it('uses a complete local full view during startup and swaps it atomically after checking', async () => {
    const { library, client } = setup(directory('2024-03', '2024-02'));
    const localSnapshot = snapshot(directory('2024-01'), 'c'.repeat(40));
    client.getLocalLibraryView.mockResolvedValueOnce({ kind: 'archive', revision: localSnapshot.revision, snapshot: localSnapshot,
      month: '2024-01', days: [day('2024-01-01')], index: { '2024-01': [day('2024-01-01')] } });
    const remoteSnapshot = deferred<ArchiveSnapshot>();
    const monthRead = deferred<ProblemDay[]>();
    client.getArchiveSnapshot.mockReturnValueOnce(remoteSnapshot.promise);
    client.getMonthFromSnapshot.mockReturnValueOnce(monthRead.promise);
    const loading = library.setView('archive');
    await tick();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, archiveIndex: { '2024-01': [day('2024-01-01')] }, directoryLoading: true });
    remoteSnapshot.resolve(snapshot(directory('2024-03'), 'b'.repeat(40)));
    await tick();
    expect(library.getSnapshot().months.map(entry => entry.month)).toEqual(['2024-01']);
    monthRead.resolve([day('2024-03-01')]);
    await loading;
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, archiveIndex: { '2024-03': [day('2024-03-01')] } });
    expect(library.getSnapshot().archiveIndex['2024-01']).toBeUndefined();
  });

  it('a delayed local full view cannot overwrite fresh partial months or delay successful completion', async () => {
    const { library, client } = setup(directory('2024-03'));
    const local = deferred<LocalLibraryView | null>();
    client.getLocalLibraryView.mockReturnValueOnce(local.promise);
    await library.setView('archive');
    local.resolve({ kind: 'archive', revision: 'b'.repeat(40), snapshot: snapshot(directory('2024-01'), 'b'.repeat(40)),
      month: '2024-01', days: [], index: { '2024-01': [day('2024-01-01')] } });
    await tick();
    expect(library.getSnapshot()).toMatchObject({ indexing: false, archiveRetained: false, archiveIndex: { '2024-03': [day('2024-03-01')] } });
    expect(library.getSnapshot().archiveIndex['2024-01']).toBeUndefined();
  });

  it('can show a local archive after a failed remote check and retries from a new snapshot', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03'));
    const local = deferred<LocalLibraryView | null>();
    client.getLocalLibraryView.mockReturnValueOnce(local.promise);
    client.getArchiveSnapshot.mockRejectedValueOnce(new Error('offline'));
    const entering = library.setView('archive');
    await entering;
    expect(library.getSnapshot()).toMatchObject({ directoryLoading: false, archiveError: 'offline' });
    local.resolve({ kind: 'archive', revision: archiveSnapshot.revision, snapshot: archiveSnapshot, month: '2024-03', days: [day('2024-03-01')], index: { '2024-03': [day('2024-03-01')] } });
    await tick();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, archiveError: 'offline', archiveIndex: { '2024-03': [day('2024-03-01')] }, directoryLoading: false });
    client.getArchiveSnapshot.mockResolvedValueOnce(snapshot(archiveSnapshot.months, 'b'.repeat(40)));
    client.getMonthFromSnapshot.mockResolvedValueOnce([day('2024-03-31')]);
    const refresh = library.refreshArchive();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, archiveIndex: { '2024-03': [day('2024-03-01')] } });
    await refresh;
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, archiveError: '', archiveIndex: { '2024-03': [day('2024-03-31')] } });
  });

  it('late local responses after navigation never populate another view or its remembered state', async () => {
    const { library, client } = setup();
    const local = deferred<LocalLibraryView | null>();
    const remote = deferred<ProblemDay>();
    client.getLocalLibraryView.mockReturnValueOnce(local.promise);
    client.getDay.mockReturnValueOnce(remote.promise);
    const first = library.setView('today');
    await library.setView('archive');
    await first;
    local.resolve({ kind: 'day', revision: 'a'.repeat(40), day: day('2024-02-29') });
    remote.resolve(day('2024-03-02'));
    await tick();
    expect(library.getSnapshot()).toMatchObject({ today: null, archiveIndex: { '2024-03': [day('2024-03-01')] } });
    const next = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(next.promise);
    const returning = library.setView('today');
    expect(library.getSnapshot()).toMatchObject({ today: null, dayRetained: false });
    next.resolve(day('2024-03-03'));
    await returning;
  });
});
const directory = (...months: string[]): ArchiveMonth[] => months.map(month => ({ month, days: 0 }));
const snapshot = (months: ArchiveMonth[], revision = 'a'.repeat(40)): ArchiveSnapshot => ({ branch: 'main', revision, months });
const limitInfo = { retryAt: 1_800_000_000_000, resource: 'core', kind: 'primary' as const, authenticated: false };
const rateLimit = (message = 'GitHub 请求额度已用完') => Object.assign(new Error(message), { code: 'github_rate_limited', rateLimit: limitInfo });
function setup(months = directory('2024-03', '2024-02', '2024-01')) {
  const archiveSnapshot = snapshot(months);
  const client = {
    getDay: vi.fn<ClientAPI['getDay']>().mockResolvedValue(day('2024-03-01')),
    getArchiveMonths: vi.fn<ClientAPI['getArchiveMonths']>().mockResolvedValue(months),
    getMonth: vi.fn<ClientAPI['getMonth']>().mockImplementation(async month => [day(`${month}-01`)]),
    getArchiveSnapshot: vi.fn<ClientAPI['getArchiveSnapshot']>().mockResolvedValue(archiveSnapshot),
    getMonthFromSnapshot: vi.fn<ClientAPI['getMonthFromSnapshot']>().mockImplementation(async month => [day(`${month}-01`)]),
    getLocalLibraryView: vi.fn<ClientAPI['getLocalLibraryView']>().mockResolvedValue(null),
  };
  return { client, archiveSnapshot, library: new LibraryController(client) };
}
// Flush nested directory/read/settlement microtasks without timers or network.
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const emptyContent = { today: null, months: [], archiveIndex: {}, dayLoading: false,
  directoryLoading: false, indexing: false, archiveRefreshing: false };

describe('confirming unchanged immutable archive snapshots', () => {
  it('reparses unchanged archive content after a language switch, then reuses it in the same language', async () => {
    const { library, client } = setup(directory('2024-03'));
    client.getMonthFromSnapshot.mockImplementation(async month => {
      const value = day(`${month}-01`);
      value.problems[0].sourceWarning = getLocale() === 'en' ? 'Problem link does not match the problem ID.' : '题目链接与题号不一致。';
      return [value];
    });
    await library.setView('archive');
    const currentDays = () => library.getSnapshot().archiveIndex['2024-03'];
    expect(currentDays()[0].problems[0].sourceWarning).toBe('题目链接与题号不一致。');
    await library.setView(null);
    setLocale('en');
    const entering = library.setView('archive');
    expect(currentDays()[0].problems[0].sourceWarning).toBe('题目链接与题号不一致。');
    expect(library.getSnapshot().archiveRetained).toBe(true);
    await entering;
    expect(currentDays()[0].problems[0].sourceWarning).toBe('Problem link does not match the problem ID.');
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(2);
    await library.refreshArchive();
    expect(client.getArchiveSnapshot).toHaveBeenCalledTimes(3);
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(2);
  });

  it('never marks a response spanning a language change as a reusable view of the new locale', async () => {
    const { library, client } = setup(directory('2024-03'));
    const pending = deferred<ProblemDay[]>();
    client.getMonthFromSnapshot.mockReturnValueOnce(pending.promise);
    const entering = library.setView('archive');
    await tick();
    setLocale('en');
    const old = day('2024-03-01');
    old.problems[0].sourceWarning = '题目链接与题号不一致。';
    pending.resolve([old]);
    await entering;
    await library.refreshArchive();
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(2);
    await library.refreshArchive();
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(2);
  });

  it('does not trust a local preview completed after the request language changes for same-SHA reuse', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03'));
    const local = deferred<LocalLibraryView | null>(), remote = deferred<ArchiveSnapshot>();
    client.getLocalLibraryView.mockReturnValueOnce(local.promise);
    client.getArchiveSnapshot.mockReturnValueOnce(remote.promise);
    const entering = library.setView('archive');
    setLocale('en');
    local.resolve({ kind: 'archive', revision: archiveSnapshot.revision, snapshot: archiveSnapshot,
      month: '2024-03', days: [day('2024-03-01')], index: { '2024-03': [day('2024-03-01')] } });
    await tick();
    remote.resolve(archiveSnapshot);
    await entering;
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(1);
    await library.refreshArchive();
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(2);
  });

  it('checks upstream on every full refresh without reading any unchanged month or entering indexing', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03', '2024-02'));
    await library.setView('archive');
    const previousIndex = library.getSnapshot().archiveIndex;
    client.getMonthFromSnapshot.mockClear();
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    const indexingStates: boolean[] = [];
    const unsubscribe = library.subscribe(() => indexingStates.push(library.getSnapshot().indexing));
    const refreshing = library.refreshArchive();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, directoryLoading: true, indexing: false });
    expect(library.getSnapshot().archiveIndex).toBe(previousIndex);
    expect(library.indexArchive()).toBe(refreshing);
    pending.resolve({ ...archiveSnapshot, months: archiveSnapshot.months.map(entry => ({ ...entry })) });
    await refreshing;
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, directoryLoading: false, indexing: false,
      indexingCompleted: 2, indexingTotal: 2, archiveError: '', indexingError: '' });
    expect(library.getSnapshot().archiveIndex).toBe(previousIndex);
    await library.refreshArchive();
    expect(client.getArchiveSnapshot).toHaveBeenCalledTimes(3);
    expect(client.getMonthFromSnapshot).not.toHaveBeenCalled();
    expect(indexingStates).not.toContain(true);
    unsubscribe();
  });

  it('checks on archive return while reusing the same complete snapshot and makes repeated same-page calls idempotent', async () => {
    const { library, client } = setup(directory('2024-03', '2024-02'));
    await library.setView('archive');
    client.getMonthFromSnapshot.mockClear();
    await library.setView(null);
    await library.setView('archive');
    await library.setView('archive');
    await library.setView('archive');
    expect(client.getArchiveSnapshot).toHaveBeenCalledTimes(2);
    expect(client.getMonthFromSnapshot).not.toHaveBeenCalled();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, indexingCompleted: 2, indexingTotal: 2 });
  });

  it('checks but does not reload an unchanged month, including its previously read empty result', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03'));
    client.getMonthFromSnapshot.mockResolvedValueOnce([]);
    await library.setView('archive');
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    client.getMonthFromSnapshot.mockClear();
    const checking = library.refreshArchive();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, directoryLoading: true });
    pending.resolve(archiveSnapshot);
    await checking;
    expect(client.getMonthFromSnapshot).not.toHaveBeenCalled();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, archiveIndex: { '2024-03': [] }, months: [{ month: '2024-03', days: 0 }] });
  });

  it('reuses immutable content when only the branch name and directory order change', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03', '2024-02'));
    await library.setView('archive');
    client.getMonthFromSnapshot.mockClear();
    client.getArchiveSnapshot.mockResolvedValueOnce({ ...archiveSnapshot, branch: 'renamed-default', months: [...archiveSnapshot.months].reverse() });
    await library.refreshArchive();
    expect(client.getMonthFromSnapshot).not.toHaveBeenCalled();
    expect(library.getSnapshot().months.map(entry => entry.month)).toEqual(['2024-02', '2024-03']);
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, indexingCompleted: 2 });
  });

  it.each([
    { name: 'an added month', months: directory('2024-04', '2024-03', '2024-02') },
    { name: 'a removed month', months: directory('2024-03') },
    { name: 'changed day counts', months: [{ month: '2024-03', days: 2 }, { month: '2024-02', days: 0 }] },
  ])('does not reuse a same-SHA view with $name in its directory', async ({ months }) => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03', '2024-02'));
    await library.setView('archive');
    client.getMonthFromSnapshot.mockClear();
    const freshSnapshot = { ...archiveSnapshot, months };
    client.getArchiveSnapshot.mockResolvedValueOnce(freshSnapshot);
    await library.refreshArchive();
    expect(client.getMonthFromSnapshot.mock.calls).toEqual(months.map(entry => [entry.month, freshSnapshot]));
    expect(library.getSnapshot().months.map(entry => entry.month)).toEqual(months.map(entry => entry.month));
  });

  it('does not reuse a different-SHA view even when its directory is identical', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03', '2024-02'));
    await library.setView('archive');
    client.getMonthFromSnapshot.mockClear();
    const freshSnapshot = { ...archiveSnapshot, revision: 'b'.repeat(40) };
    client.getArchiveSnapshot.mockResolvedValueOnce(freshSnapshot);
    const firstMonth = deferred<ProblemDay[]>();
    client.getMonthFromSnapshot.mockReturnValueOnce(firstMonth.promise);
    const checking = library.refreshArchive();
    expect(library.getSnapshot().indexing).toBe(false);
    await tick();
    expect(library.getSnapshot()).toMatchObject({ indexing: true, archiveRetained: true, indexingCompleted: 0 });
    firstMonth.resolve([day('2024-03-31')]);
    await checking;
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', freshSnapshot], ['2024-02', freshSnapshot]]);
    expect(library.getSnapshot().archiveIndex['2024-03']).toEqual([day('2024-03-31')]);
  });

  it('reuses a complete same-SHA local full view that finishes before the remote check', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03', '2024-02'));
    const remote = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(remote.promise);
    const index = { '2024-03': [day('2024-03-01')], '2024-02': [day('2024-02-01')] };
    client.getLocalLibraryView.mockResolvedValueOnce({ kind: 'archive', revision: archiveSnapshot.revision, snapshot: archiveSnapshot,
      month: '2024-03', days: index['2024-03'], index });
    const entering = library.setView('archive');
    await tick();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, directoryLoading: true, indexing: false });
    expect(library.getSnapshot().archiveIndex).toBe(index);
    remote.resolve(archiveSnapshot);
    await entering;
    expect(client.getMonthFromSnapshot).not.toHaveBeenCalled();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, directoryLoading: false, indexing: false, indexingCompleted: 2 });
    expect(library.getSnapshot().archiveIndex).toBe(index);
  });

  it('does not await a slow local same-SHA full view or let it replace fresh partial results', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03', '2024-02'));
    const local = deferred<LocalLibraryView | null>();
    const secondMonth = deferred<ProblemDay[]>();
    client.getLocalLibraryView.mockReturnValueOnce(local.promise);
    client.getMonthFromSnapshot.mockResolvedValueOnce([day('2024-03-31')]).mockReturnValueOnce(secondMonth.promise);
    const entering = library.setView('archive');
    await tick();
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(2);
    expect(library.getSnapshot().archiveIndex).toEqual({ '2024-03': [day('2024-03-31')] });
    local.resolve({ kind: 'archive', revision: archiveSnapshot.revision, snapshot: archiveSnapshot,
      month: '2024-03', days: [day('2024-03-01')], index: { '2024-03': [day('2024-03-01')], '2024-02': [day('2024-02-01')] } });
    await tick();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, indexing: true, indexingCompleted: 1 });
    expect(library.getSnapshot().archiveIndex).toEqual({ '2024-03': [day('2024-03-31')] });
    secondMonth.resolve([day('2024-02-28')]);
    await entering;
    expect(library.getSnapshot().archiveIndex['2024-02']).toEqual([day('2024-02-28')]);
  });

  it.each<{ name: string; index: Record<string, ProblemDay[]> | undefined }>([
    { name: 'missing month', index: { '2024-03': [day('2024-03-01')] } },
    { name: 'extra month', index: { '2024-03': [], '2024-02': [], '2024-01': [] } },
    { name: 'missing full index', index: undefined },
  ])('ignores a local preview with $name rather than confirming it as a complete full view', async ({ index }) => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03', '2024-02'));
    const remote = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(remote.promise);
    client.getLocalLibraryView.mockResolvedValueOnce({ kind: 'archive', revision: archiveSnapshot.revision, snapshot: archiveSnapshot,
      month: '2024-03', days: [day('2024-03-01')], index });
    const entering = library.setView('archive');
    await tick();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, archiveIndex: {} });
    remote.resolve(archiveSnapshot);
    await entering;
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(2);
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: false, indexingCompleted: 2 });
  });

  it('never upgrades a failed or stopped partial full load into a complete same-SHA view', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03', '2024-02'));
    client.getMonthFromSnapshot.mockRejectedValueOnce(new Error('incomplete month'));
    await library.setView('archive');
    expect(library.getSnapshot().indexFailures).toHaveLength(1);
    const pending = deferred<ProblemDay[]>();
    client.getMonthFromSnapshot.mockClear().mockReturnValueOnce(pending.promise);
    const retry = library.indexArchive();
    await tick();
    expect(client.getMonthFromSnapshot).toHaveBeenCalledWith('2024-03', archiveSnapshot);
    library.stopIndexing();
    await retry;
    pending.resolve([day('2024-03-31')]);
    await tick();
    client.getMonthFromSnapshot.mockClear();
    await library.indexArchive();
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', archiveSnapshot], ['2024-02', archiveSnapshot]]);
  });

  it('never clears a stale warning merely because the known view is complete when the remote check fails', async () => {
    const { library, client } = setup(directory('2024-03'));
    await library.setView('archive');
    client.getMonthFromSnapshot.mockClear();
    client.getArchiveSnapshot.mockRejectedValueOnce(new Error('offline'));
    await library.refreshArchive();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, archiveError: 'offline', indexing: false });
    expect(client.getMonthFromSnapshot).not.toHaveBeenCalled();
  });

  it('a cancelled same-SHA check cannot clear the retained marker of its replacement request', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03'));
    await library.setView('archive');
    const old = deferred<ArchiveSnapshot>(), fresh = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = library.refreshArchive();
    library.stopRefresh();
    await first;
    const second = library.indexArchive();
    old.resolve(archiveSnapshot);
    await tick();
    expect(library.getSnapshot()).toMatchObject({ directoryLoading: true, archiveRetained: true, indexing: false });
    fresh.reject(new Error('new check failed'));
    await second;
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, archiveError: 'new check failed' });
  });
});

describe('fresh library reads and view lifetime', () => {
  it('enters the archive by reading every discovered month, including future and earliest dates', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2400-02', '2024-03', '0001-01'));
    await library.setView('archive');
    expect(client.getArchiveSnapshot).toHaveBeenCalledTimes(1);
    expect(client.getLocalLibraryView).toHaveBeenCalledExactlyOnceWith({ kind: 'archive', scope: 'all' });
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([
      ['2400-02', archiveSnapshot], ['2024-03', archiveSnapshot], ['0001-01', archiveSnapshot],
    ]);
    expect(Object.keys(library.getSnapshot().archiveIndex)).toEqual(['2400-02', '2024-03', '0001-01']);
    expect(library.getSnapshot()).toMatchObject({ indexing: false, directoryLoading: false, indexingCompleted: 3, indexingTotal: 3 });
    expect(client.getArchiveMonths).not.toHaveBeenCalled();
    expect(client.getMonth).not.toHaveBeenCalled();
    expect(client.getDay).not.toHaveBeenCalled();
  });

  it('keeps empty months and arbitrary daily problem counts in the unified index', async () => {
    const { library, client } = setup(directory('2400-02', '2024-03', '0001-01'));
    const many = [0, 1, 3, 4, 7].map((count, index) => {
      const value = day(`2400-02-${String(index + 1).padStart(2, '0')}`);
      value.problems = Array.from({ length: count }, (_, problemIndex) => ({ ...value.problems[0], id: `cf1000${String.fromCharCode(97 + problemIndex)}` }));
      return value;
    });
    client.getMonthFromSnapshot.mockResolvedValueOnce(many).mockResolvedValueOnce([]).mockResolvedValueOnce([day('0001-01-01')]);
    await library.setView('archive');
    expect(library.getSnapshot().archiveIndex['2400-02'].map(value => value.problems.length)).toEqual([0, 1, 3, 4, 7]);
    expect(library.getSnapshot().archiveIndex['2024-03']).toEqual([]);
    expect(library.getSnapshot().months).toEqual([{ month: '2400-02', days: 5 }, { month: '2024-03', days: 0 }, { month: '0001-01', days: 1 }]);
  });

  it('a manual refresh supersedes initial directory discovery and the late initial error cannot affect the new view', async () => {
    const { library, client } = setup(directory('2024-03'));
    const old = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot(directory('2400-02'), 'b'.repeat(40)));
    const entering = library.setView('archive');
    await library.refreshArchive();
    await entering;
    old.reject(new Error('late initial failure'));
    await tick();
    expect(library.getSnapshot()).toMatchObject({ archiveError: '', indexingError: '', months: [{ month: '2400-02', days: 1 }],
      archiveIndex: { '2400-02': [day('2400-02-01')] }, indexing: false, archiveRefreshing: false });
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(1);
  });

  it('disposal clears the complete archive session so a resumed controller cannot silently reuse it', async () => {
    const { library, client } = setup(directory('2024-03'));
    await library.setView('archive');
    library.dispose();
    await library.refreshArchive();
    expect(client.getArchiveSnapshot).toHaveBeenCalledTimes(1);
    library.resume();
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    const entering = library.setView('archive');
    expect(library.getSnapshot()).toMatchObject({ archiveIndex: {}, archiveRetained: false, directoryLoading: true });
    pending.resolve(snapshot(directory('2024-03')));
    await entering;
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(2);
  });

  it('stopIndexing and stopRefresh cancel the same archive operation while retaining the complete old view', async () => {
    const { library, client } = setup(directory('2024-03'));
    await library.setView('archive');
    for (const stop of [library.stopIndexing, library.stopRefresh]) {
      const pending = deferred<ArchiveSnapshot>();
      client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
      const refreshing = library.refreshArchive();
      stop();
      await refreshing;
      expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, indexStopped: true, directoryLoading: false,
        archiveIndex: { '2024-03': [day('2024-03-01')] }, indexing: false, archiveRefreshing: false });
      pending.resolve(snapshot(directory('2400-02'), 'b'.repeat(40)));
      await tick();
      expect(library.getSnapshot().months).toEqual([{ month: '2024-03', days: 1 }]);
    }
  });

  it('ignores a local full view whose inner and outer revisions do not match', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03'));
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    client.getLocalLibraryView.mockResolvedValueOnce({ kind: 'archive', revision: 'b'.repeat(40), snapshot: archiveSnapshot,
      month: '2024-03', days: [day('2024-03-01')], index: { '2024-03': [day('2024-03-01')] } });
    const entering = library.setView('archive');
    await tick();
    expect(library.getSnapshot()).toMatchObject({ archiveIndex: {}, archiveRetained: false });
    pending.resolve(archiveSnapshot);
    await entering;
    expect(client.getMonthFromSnapshot).toHaveBeenCalledTimes(1);
  });

  it('loads no inactive view, then reads only the latest day on today entry', async () => {
    const { library, client } = setup();
    expect(library.getSnapshot()).toMatchObject(emptyContent);
    await library.setView(null);
    expect(client.getDay).not.toHaveBeenCalled();
    await library.setView('today');
    expect(client.getDay.mock.calls).toEqual([[undefined, true]]);
    expect(client.getArchiveMonths).not.toHaveBeenCalled();
    expect(client.getMonth).not.toHaveBeenCalled();
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-01'), dayLoading: false });
  });

  it('makes repeated same-view selection idempotent while pending and after completion', async () => {
    const { library, client } = setup();
    const pending = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(pending.promise);
    const first = library.setView('today');
    const repeated = library.setView('today');
    expect(client.getDay).toHaveBeenCalledTimes(1);
    pending.resolve(day('2024-03-02'));
    await Promise.all([first, repeated]);
    await library.setView('today');
    expect(client.getDay).toHaveBeenCalledTimes(1);
  });

  it('retains previous latest content while checking and after a failed update', async () => {
    const { library, client } = setup();
    await library.setView('today');
    const pending = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(pending.promise);
    const reload = library.loadLatest(true);
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-01'), dayRetained: true, dayLoading: true, dayError: '' });
    pending.reject(new Error('最新题目读取失败'));
    await reload;
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-01'), dayRetained: true, dayLoading: false, dayError: '最新题目读取失败' });
    expect(client.getDay.mock.calls).toEqual([[undefined, true], [undefined, true]]);
  });

  it('a forced latest read supersedes a pending normal read and shares duplicate refreshes', async () => {
    const { library, client } = setup();
    await library.setView('today');
    const old = deferred<ProblemDay>(), fresh = deferred<ProblemDay>();
    client.getDay.mockClear();
    client.getDay.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const initial = library.loadLatest();
    const refresh = library.loadLatest(true);
    expect(library.loadLatest(true)).toBe(refresh);
    old.resolve(day('2020-01-01'));
    await initial;
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-01'), dayRetained: true, dayLoading: true, dayError: '' });
    fresh.resolve(day('2024-03-05'));
    await refresh;
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-05'), dayLoading: false });
    expect(client.getDay.mock.calls).toEqual([[undefined, true], [undefined, true]]);
  });

  it('leaves today immediately, ignores its pending response, and reads fresh on return', async () => {
    const { library, client } = setup();
    const old = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(old.promise);
    const entering = library.setView('today');
    await library.setView(null);
    await entering; // Cancellation settles even while the underlying read is pending.
    expect(library.getSnapshot()).toMatchObject(emptyContent);
    old.resolve(day('2020-01-01'));
    await tick();
    expect(library.getSnapshot()).toMatchObject(emptyContent);
    await library.setView('today');
    expect(client.getDay).toHaveBeenCalledTimes(2);
    expect(library.getSnapshot().today).toEqual(day('2024-03-01'));
  });

  it('disposal cancels a pending session and the resumed session ignores its late rejection', async () => {
    const { library, client } = setup();
    const old = deferred<ProblemDay>(), fresh = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = library.setView('today');
    library.dispose();
    await first;
    library.resume();
    const second = library.setView('today');
    old.reject(new Error('卸载前失败'));
    await tick();
    expect(library.getSnapshot()).toMatchObject({ today: null, dayLoading: true, dayError: '' });
    fresh.resolve(day('2024-03-06'));
    await second;
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-06'), dayLoading: false });
  });

  it('directory refresh failure keeps old data and starts no month request', async () => {
    const { library, client } = setup();
    await library.setView('archive');
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    client.getMonthFromSnapshot.mockClear();
    const refreshing = library.refreshArchive();
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, archiveIndex: { '2024-03': [day('2024-03-01')] }, directoryLoading: true });
    pending.reject(new Error('目录读取失败'));
    await refreshing;
    expect(library.getSnapshot()).toMatchObject({ archiveRetained: true, archiveIndex: { '2024-03': [day('2024-03-01')] }, archiveError: '目录读取失败', directoryLoading: false, archiveRefreshing: false });
    expect(client.getMonth).not.toHaveBeenCalled();
    expect(client.getMonthFromSnapshot).not.toHaveBeenCalled();
  });

  it('handles an empty directory without phantom data or a stuck loading state', async () => {
    const { library, client } = setup([]);
    await library.setView('archive');
    expect(library.getSnapshot()).toMatchObject({ months: [], archiveIndex: {}, directoryLoading: false, archiveRefreshing: false, archiveError: '' });
    expect(client.getMonth).not.toHaveBeenCalled();
    await library.refreshArchive();
    expect(library.getSnapshot()).toMatchObject({ indexing: false, indexingCompleted: 0, indexingTotal: 0, indexFailures: [] });
    expect(client.getMonth).not.toHaveBeenCalled();
    expect(client.getMonthFromSnapshot).not.toHaveBeenCalled();
    expect(client.getArchiveSnapshot).toHaveBeenCalledTimes(2);
  });

  it('full entry automatically reads a fresh directory and all months sequentially', async () => {
    const { library, client, archiveSnapshot } = setup();
    const march = deferred<ProblemDay[]>(), february = deferred<ProblemDay[]>(), january = deferred<ProblemDay[]>();
    client.getMonthFromSnapshot.mockReturnValueOnce(march.promise).mockReturnValueOnce(february.promise).mockReturnValueOnce(january.promise);
    const indexing = library.setView('archive');
    await tick();
    expect(client.getArchiveSnapshot.mock.calls).toEqual([[]]);
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', archiveSnapshot]]);
    expect(library.getSnapshot()).toMatchObject({ indexing: true, indexingMonth: '2024-03', indexingCompleted: 0, indexingTotal: 3 });
    march.resolve([day('2024-03-04')]);
    await tick();
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', archiveSnapshot], ['2024-02', archiveSnapshot]]);
    expect(library.getSnapshot()).toMatchObject({ indexingCompleted: 1, archiveIndex: { '2024-03': [day('2024-03-04')] } });
    february.resolve([day('2024-02-04')]);
    await tick();
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', archiveSnapshot], ['2024-02', archiveSnapshot], ['2024-01', archiveSnapshot]]);
    january.resolve([day('2024-01-04')]);
    await indexing;
    expect(library.getSnapshot()).toMatchObject({ indexing: false, indexingMonth: '', indexingCompleted: 3, indexingTotal: 3, indexFailures: [], indexStopped: false });
    for (const [, usedSnapshot] of client.getMonthFromSnapshot.mock.calls) expect(usedSnapshot).toBe(archiveSnapshot);
    expect(archiveSnapshot.months).toEqual(directory('2024-03', '2024-02', '2024-01'));
    expect(client.getArchiveMonths).not.toHaveBeenCalled();
    expect(client.getMonth).not.toHaveBeenCalled();
  });

  it('continues after individual failures and counts failed attempts without inventing results', async () => {
    const { library, client, archiveSnapshot } = setup();
    client.getMonthFromSnapshot.mockRejectedValueOnce(new Error('三月失败')).mockResolvedValueOnce([day('2024-02-02')]).mockRejectedValueOnce(new Error('一月失败'));
    await library.setView('archive');
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', archiveSnapshot], ['2024-02', archiveSnapshot], ['2024-01', archiveSnapshot]]);
    expect(library.getSnapshot()).toMatchObject({ indexing: false, indexingCompleted: 3, indexingTotal: 3, indexStopped: false, rateLimit: null,
      indexFailures: [{ month: '2024-03', error: '三月失败' }, { month: '2024-01', error: '一月失败' }], archiveIndex: { '2024-02': [day('2024-02-02')] } });
    expect(Object.keys(library.getSnapshot().archiveIndex)).toEqual(['2024-02']);
  });

  it('retry discards partial results and starts from a fresh directory and all returned months', async () => {
    const { library, client } = setup();
    client.getMonthFromSnapshot.mockRejectedValueOnce(new Error('失败月份'));
    await library.setView('archive');
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    client.getMonthFromSnapshot.mockClear();
    const retry = library.indexArchive();
    expect(library.getSnapshot()).toMatchObject({ months: [], archiveIndex: {}, indexFailures: [], indexingCompleted: 0, directoryLoading: true });
    const freshSnapshot = snapshot(directory('2024-04', '2024-03', '2024-02'), 'b'.repeat(40));
    pending.resolve(freshSnapshot);
    await retry;
    expect(client.getArchiveSnapshot.mock.calls).toEqual([[], []]);
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-04', freshSnapshot], ['2024-03', freshSnapshot], ['2024-02', freshSnapshot]]);
    expect(library.getSnapshot().archiveIndex['2024-01']).toBeUndefined();
  });

  it('full refresh reloads every month after a fully successful run', async () => {
    const { library, client } = setup(directory('2024-03', '2024-02'));
    await library.setView('archive');
    const freshSnapshot = snapshot(directory('2024-03', '2024-02'), 'b'.repeat(40));
    client.getArchiveSnapshot.mockResolvedValueOnce(freshSnapshot);
    client.getMonthFromSnapshot.mockClear();
    await library.refreshArchive();
    expect(client.getArchiveSnapshot.mock.calls).toEqual([[], []]);
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', freshSnapshot], ['2024-02', freshSnapshot]]);
    expect(library.getSnapshot()).toMatchObject({ indexingCompleted: 2, indexingTotal: 2, indexFailures: [] });
  });

  it('full archive reentry retains its complete view while discovering a snapshot with new months', async () => {
    const { library, client } = setup(directory('2024-03'));
    await library.setView('archive');
    await library.setView(null);
    expect(library.getSnapshot()).toMatchObject(emptyContent);
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    client.getMonthFromSnapshot.mockClear();
    const entering = library.setView('archive');
    expect(library.getSnapshot()).toMatchObject({ months: [{ month: '2024-03', days: 1 }], archiveIndex: { '2024-03': [day('2024-03-01')] }, archiveRetained: true, indexingCompleted: 0, directoryLoading: true });
    const freshSnapshot = snapshot(directory('2400-02', '2024-03', '0001-01'), 'b'.repeat(40));
    pending.resolve(freshSnapshot);
    await entering;
    expect(client.getArchiveSnapshot.mock.calls).toEqual([[], []]);
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([
      ['2400-02', freshSnapshot], ['2024-03', freshSnapshot], ['0001-01', freshSnapshot],
    ]);
    expect(library.getSnapshot()).toMatchObject({ indexingCompleted: 3, indexingTotal: 3, directoryLoading: false, indexing: false });
  });

  it('a rate limit stops at the failed month, retains successful results, and releases every busy state', async () => {
    const { library, client, archiveSnapshot } = setup();
    client.getMonthFromSnapshot.mockResolvedValueOnce([day('2024-03-20')]).mockRejectedValueOnce(rateLimit());
    await library.setView('archive');
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', archiveSnapshot], ['2024-02', archiveSnapshot]]);
    expect(library.getSnapshot()).toMatchObject({
      indexing: false, indexingMonth: '', directoryLoading: false, archiveRefreshing: false,
      indexStopped: true, indexingCompleted: 2, indexingTotal: 3, rateLimit: limitInfo,
      indexFailures: [{ month: '2024-02', error: 'GitHub 请求额度已用完' }],
      archiveIndex: { '2024-03': [day('2024-03-20')] },
    });
    expect(Object.keys(library.getSnapshot().archiveIndex)).toEqual(['2024-03']);
    expect(library.getSnapshot().indexingError).toContain('2024-02');
  });

  it('a rate limit while discovering the snapshot stops before any month and permits a fresh retry', async () => {
    const { library, client } = setup();
    client.getArchiveSnapshot.mockRejectedValueOnce(rateLimit());
    await library.setView('archive');
    expect(client.getMonthFromSnapshot).not.toHaveBeenCalled();
    expect(library.getSnapshot()).toMatchObject({
      archiveError: 'GitHub 请求额度已用完', months: [], archiveIndex: {},
      directoryLoading: false, indexing: false, archiveRefreshing: false,
      indexStopped: true, indexingCompleted: 0, indexingTotal: 0, indexFailures: [], rateLimit: limitInfo,
    });
    const freshSnapshot = snapshot(directory('2024-04'), 'b'.repeat(40));
    client.getArchiveSnapshot.mockResolvedValueOnce(freshSnapshot);
    await library.indexArchive();
    expect(client.getArchiveSnapshot).toHaveBeenCalledTimes(2);
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-04', freshSnapshot]]);
    expect(library.getSnapshot()).toMatchObject({
      archiveError: '', indexing: false, indexStopped: false, indexingCompleted: 1, indexingTotal: 1,
      rateLimit: null, archiveIndex: { '2024-04': [day('2024-04-01')] },
    });
  });

  it('a retry after a month rate limit starts from zero with a new snapshot', async () => {
    const { library, client } = setup();
    client.getMonthFromSnapshot.mockResolvedValueOnce([day('2024-03-20')]).mockRejectedValueOnce(rateLimit());
    await library.setView('archive');
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    client.getMonthFromSnapshot.mockClear();
    const retry = library.indexArchive();
    expect(library.getSnapshot()).toMatchObject({
      archiveIndex: {}, indexFailures: [], indexStopped: false, rateLimit: null,
      indexing: true, indexingCompleted: 0, indexingTotal: 0, directoryLoading: true,
    });
    const freshSnapshot = snapshot(directory('2024-04', '2024-03'), 'b'.repeat(40));
    pending.resolve(freshSnapshot);
    await retry;
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-04', freshSnapshot], ['2024-03', freshSnapshot]]);
    expect(library.getSnapshot()).toMatchObject({ indexing: false, indexStopped: false, indexFailures: [], rateLimit: null, indexingCompleted: 2 });
  });

  it('shares duplicate active full-run requests instead of repeating directory reads', async () => {
    const { library, client, archiveSnapshot } = setup(directory('2024-03'));
    await library.setView('archive');
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    const first = library.indexArchive();
    expect(library.indexArchive()).toBe(first);
    const sameView = library.setView('archive');
    expect(client.getArchiveSnapshot).toHaveBeenCalledTimes(2);
    pending.resolve(archiveSnapshot);
    await Promise.all([first, sameView]);
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', archiveSnapshot]]);
  });

  it('stops full loading during directory discovery immediately and ignores the late directory', async () => {
    const { library, client } = setup();
    const pending = deferred<ArchiveSnapshot>();
    client.getArchiveSnapshot.mockReturnValueOnce(pending.promise);
    const indexing = library.setView('archive');
    library.stopIndexing();
    await indexing;
    expect(library.getSnapshot()).toMatchObject({ indexing: false, directoryLoading: false, archiveRefreshing: false, indexStopped: true, archiveIndex: {}, indexingCompleted: 0 });
    pending.resolve(snapshot(directory('2024-04')));
    await tick();
    expect(client.getMonthFromSnapshot).not.toHaveBeenCalled();
    expect(library.getSnapshot().months).toEqual([]);
  });

  it('stop retains only completed current-session results and never continues the old chain', async () => {
    const { library, client, archiveSnapshot } = setup();
    const pending = deferred<ProblemDay[]>();
    client.getMonthFromSnapshot.mockResolvedValueOnce([day('2024-03-20')]).mockReturnValueOnce(pending.promise);
    const indexing = library.setView('archive');
    await tick();
    expect(library.getSnapshot().indexingCompleted).toBe(1);
    library.stopRefresh(); // Both stop controls cancel a full run.
    await indexing;
    expect(library.getSnapshot()).toMatchObject({ indexing: false, indexStopped: true, indexingCompleted: 1, archiveIndex: { '2024-03': [day('2024-03-20')] } });
    pending.resolve([day('2024-02-28')]);
    await tick();
    expect(Object.keys(library.getSnapshot().archiveIndex)).toEqual(['2024-03']);
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', archiveSnapshot], ['2024-02', archiveSnapshot]]);
  });

  it('restart ignores stopped-run errors and finally without clearing the new spinner', async () => {
    const { library, client } = setup(directory('2024-03'));
    const old = deferred<ProblemDay[]>(), fresh = deferred<ProblemDay[]>();
    client.getMonthFromSnapshot.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = library.setView('archive');
    await tick();
    library.stopIndexing();
    const second = library.indexArchive();
    await first;
    await tick();
    old.reject(new Error('已取消的旧读取'));
    await tick();
    expect(library.getSnapshot()).toMatchObject({ indexing: true, indexStopped: false, indexingCompleted: 0, indexFailures: [], archiveIndex: {}, indexingError: '' });
    fresh.resolve([day('2024-03-29')]);
    await second;
    expect(library.getSnapshot()).toMatchObject({ indexing: false, indexingCompleted: 1, indexFailures: [], archiveIndex: { '2024-03': [day('2024-03-29')] } });
  });

  it('leaving full archive clears all progress/results and old work cannot affect the next view', async () => {
    const { library, client, archiveSnapshot } = setup();
    const pending = deferred<ProblemDay[]>();
    client.getMonthFromSnapshot.mockResolvedValueOnce([day('2024-03-20')]).mockReturnValueOnce(pending.promise);
    const indexing = library.setView('archive');
    await tick();
    await library.setView('today');
    await indexing;
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-01'), months: [], archiveIndex: {}, indexing: false, indexingCompleted: 0, indexingTotal: 0, indexFailures: [], indexStopped: false });
    pending.reject(new Error('离开后失败'));
    await tick();
    expect(library.getSnapshot()).toMatchObject({ today: day('2024-03-01'), dayError: '', archiveIndex: {}, indexFailures: [] });
    expect(client.getMonthFromSnapshot.mock.calls).toEqual([['2024-03', archiveSnapshot], ['2024-02', archiveSnapshot]]);
  });
});
