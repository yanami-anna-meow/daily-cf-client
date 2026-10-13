import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { GitProblemLibrary } from '../electron/git-library';
import { repositoryDatePath } from '../shared/domain';
import { setLocale } from '../shared/i18n';
import { MAX_LIBRARY_FILE_BYTES } from '../shared/library-files';
import { UPSTREAM } from '../shared/types';

const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);
const THIRD = 'c'.repeat(40);
const DATE = '2026-10-07';
const BASE = repositoryDatePath(DATE);
const DAY_PATH = `${BASE}/problems.md`;
const CODE_PATH = `${BASE}/personal_submission/cf1a_alice.cpp`;
const now = () => Date.UTC(2026, 9, 9);
const table = (count = 1) => [
  '| Difficulty | Problems | Hints |', '| --- | --- | --- |',
  ...Array.from({ length: count }, (_, index) => `| ${index % 2 ? '*' : ''}${800 + 100 * index} | [CF${index + 1}A](https://codeforces.com/contest/${index + 1}/problem/A) | Hint ${index + 1} |`),
].join('\n');
type TrackedFile = string | { body: string; mode: string };
type Files = Record<string, TrackedFile>;
function blobOid(file: TrackedFile): string {
  const body = typeof file === 'string' ? file : file.body;
  return createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex');
}
function setup(initial: Files = { [DAY_PATH]: table() }) {
  const revisions = new Map<string, Files>([[FIRST, initial]]);
  let current = { branch: 'main', revision: FIRST };
  let local: { branch: string; revision: string } | null = null;
  let error: Error | undefined;
  const repository = {
    sync: vi.fn(async () => {
      if (error) throw error;
      local = { ...current };
      return { ...current };
    }),
    getLocalSnapshot: vi.fn(async () => local ? { ...local } : null),
    listFiles: vi.fn(async (revision: string) => {
      const files = revisions.get(revision);
      if (!files) throw new Error('Unknown immutable revision');
      return Object.entries(files).map(([path, value]) => ({ path, oid: blobOid(value), mode: typeof value === 'string' ? '100644' : value.mode }));
    }),
    readFile: vi.fn(async (revision: string, path: string, maxBytes: number) => {
      const file = revisions.get(revision)?.[path];
      if (file === undefined || (typeof file !== 'string' && file.mode !== '100644' && file.mode !== '100755')) return null;
      const text = typeof file === 'string' ? file : file.body;
      if (Buffer.byteLength(text) > maxBytes) throw new Error('File size limit');
      return text;
    }),
  };
  const library = new GitProblemLibrary(repository, { now });
  return {
    library, repository, revisions,
    update(files: Files, revision = SECOND, branch = 'stable/next') {
      revisions.set(revision, files);
      current = { branch, revision };
    },
    failSync(failure = new Error('Network unavailable')) { error = failure; },
    recoverSync() { error = undefined; },
  };
}

afterEach(() => { setLocale('zh-CN'); vi.restoreAllMocks(); });

describe('retained Git views', () => {
  it('returns null before the first successful snapshot without syncing or reading files', async () => {
    const { library, repository } = setup();
    expect(await library.getLocalLibraryView({ kind: 'day' })).toBeNull();
    expect(repository.sync).not.toHaveBeenCalled();
    expect(repository.listFiles).not.toHaveBeenCalled();
    expect(repository.readFile).not.toHaveBeenCalled();
  });

  it('returns old days, month directories, full archives and resources using only the published commit', async () => {
    const editorial = `${BASE}/solution/cf1a.md`;
    const oldDate = '0001-01-01';
    const { library, repository, update } = setup({
      [DAY_PATH]: table(), [CODE_PATH]: 'old code', [editorial]: 'old editorial',
      [`${repositoryDatePath(oldDate)}/problems.md`]: table(3),
    });
    await library.syncLibrary();
    update({ 'daily_problems/9999/12/1231/problems.md': table(4) });
    const local = await library.getLocalLibraryView({ kind: 'day' });
    expect(local).toMatchObject({ kind: 'day', revision: FIRST, day: { date: DATE, problems: [{ id: 'cf1a' }] } });
    const archive = await library.getLocalLibraryView({ kind: 'archive', scope: 'all' });
    expect(archive).toMatchObject({ kind: 'archive', revision: FIRST, month: '2026-10', snapshot: { revision: FIRST } });
    if (archive?.kind !== 'archive') throw new Error('Missing archive');
    expect(Object.keys(archive.index!)).toEqual(['2026-10', '0001-01']);
    expect(archive.index!['0001-01'][0].problems).toHaveLength(3);
    expect(await library.getLocalLibraryView({ kind: 'archive', scope: 'month', month: '2128-01' })).toMatchObject({ month: '2128-01', days: [] });
    expect(await library.getLocalLibraryView({ kind: 'resources', date: DATE, problemId: 'cf1a' })).toMatchObject({
      kind: 'resources', revision: FIRST, resources: { editorial: 'old editorial', references: [{ path: CODE_PATH }] },
    });
    expect(await library.getLocalLibraryView({ kind: 'reference', path: CODE_PATH })).toEqual({ kind: 'reference', revision: FIRST, code: 'old code' });
    expect(repository.sync).toHaveBeenCalledTimes(1);
    expect(repository.readFile.mock.calls.every(([revision]) => revision === FIRST)).toBe(true);
    expect((await library.getDay()).date).toBe('9999-12-31');
  });

  it('pins a complete local archive while another synchronization publishes a newer revision', async () => {
    const fixture = setup({ [DAY_PATH]: table(), 'daily_problems/0001/01/0101/problems.md': table(3) });
    await fixture.library.syncLibrary();
    const read = fixture.repository.readFile.getMockImplementation()!;
    fixture.repository.readFile.mockImplementationOnce(async (...args) => {
      fixture.update({ [DAY_PATH]: table(7) });
      await fixture.library.syncLibrary();
      return read(...args);
    });
    const view = await fixture.library.getLocalLibraryView({ kind: 'archive', scope: 'all' });
    expect(view).toMatchObject({ revision: FIRST });
    if (view?.kind !== 'archive') throw new Error('Missing archive');
    expect(view.days[0].problems).toHaveLength(1);
    expect(view.index!['0001-01'][0].problems).toHaveLength(3);
    expect((await fixture.library.getLocalLibraryView({ kind: 'day' }))?.revision).toBe(SECOND);
  });

  it('keeps failed-sync previews available and reports authoritative deletions distinctly', async () => {
    const fixture = setup({ [DAY_PATH]: table(), [CODE_PATH]: 'old code' });
    await fixture.library.syncLibrary();
    fixture.failSync();
    expect(await fixture.library.getLocalLibraryView({ kind: 'day', date: DATE })).toMatchObject({ revision: FIRST });
    await expect(fixture.library.getDay()).rejects.toThrow('Network unavailable');
    fixture.recoverSync(); fixture.update({});
    await expect(fixture.library.getDay(DATE)).rejects.toMatchObject({ code: 'library_content_missing' });
    await expect(fixture.library.getDay()).rejects.toMatchObject({ code: 'library_content_missing' });
    await expect(fixture.library.getReference(CODE_PATH)).rejects.toMatchObject({ code: 'library_content_missing' });
    expect(await fixture.library.getLocalLibraryView({ kind: 'day' })).toBeNull();
    expect(await fixture.library.getLocalLibraryView({ kind: 'reference', path: CODE_PATH })).toBeNull();
    expect(await fixture.library.getLocalLibraryView({ kind: 'archive', scope: 'all' })).toMatchObject({
      revision: SECOND, snapshot: { months: [] }, month: '', days: [], index: {},
    });
  });

  it('does not share mutable preview data with later reads', async () => {
    const { library } = setup();
    await library.syncLibrary();
    const first = await library.getLocalLibraryView({ kind: 'archive', scope: 'all' });
    if (first?.kind !== 'archive') throw new Error('Missing archive');
    first.snapshot.months.length = 0;
    first.days[0].problems[0].hint = 'Changed by caller';
    const second = await library.getLocalLibraryView({ kind: 'archive', scope: 'all' });
    if (second?.kind !== 'archive') throw new Error('Missing archive');
    expect(second.snapshot.months).toHaveLength(1);
    expect(second.days[0].problems[0].hint).toBe('Hint 1');
  });

  it.each([null, {}, { kind: 'syncLibrary' }, { kind: 'archive', scope: 'invalid' }, { kind: 'archive', scope: 'all', month: '0000-01' },
    { kind: 'day', date: '2128-02-30' }, { kind: 'resources', date: DATE, problemId: '../secret' },
    { kind: 'reference', path: '../secret' }, { kind: 'reference', path: `${BASE}/solution/cf1a.md` },
  ])('rejects invalid local request %j before touching repository state', async value => {
    const { library, repository } = setup();
    await expect(library.getLocalLibraryView(value as never)).rejects.toThrow();
    expect(repository.getLocalSnapshot).not.toHaveBeenCalled();
    expect(repository.sync).not.toHaveBeenCalled();
  });
});

describe('GitProblemLibrary repository discovery', () => {
  it('finds historical and future problem files in the current tree without requiring commit history', async () => {
    const dates = ['0001-01-01', '1999-12-31', '2026-10-07', '2128-02-29', '9999-12-31'];
    const files: Files = Object.fromEntries(dates.map(date => [`${repositoryDatePath(date)}/problems.md`, table()]));
    files['daily_problems/2019/11/README.md'] = 'A month with no daily problem list';
    files['daily_problems/0000/01/0101/problems.md'] = table();
    files['daily_problems/2128/13/1301/problems.md'] = table();
    files['daily_problems/2128/02/0230/problems.md'] = table();
    files['daily_problems/2128/02/0301/problems.md'] = table();
    files['daily_problems/notes/02/0201/problems.md'] = table();
    files['README.md'] = 'Latest advertised date 2026-10-07';
    const { library, repository } = setup(files);
    const snapshot = await library.getArchiveSnapshot();
    expect(snapshot).toEqual({ branch: 'main', revision: FIRST, months: [
      { month: '9999-12', days: 1 }, { month: '2128-02', days: 1 }, { month: '2026-10', days: 1 },
      { month: '2019-11', days: 0 }, { month: '1999-12', days: 1 }, { month: '0001-01', days: 1 },
    ] });
    expect((await library.getDay()).date).toBe('9999-12-31');
    expect((await library.getMonthFromSnapshot('0001-01', snapshot))[0].date).toBe('0001-01-01');
    expect((await library.getMonthFromSnapshot('2128-02', snapshot))[0].date).toBe('2128-02-29');
    expect(await library.getMonthFromSnapshot('2019-11', snapshot)).toEqual([]);
    expect(repository.sync).toHaveBeenCalledTimes(2);
    expect(repository.listFiles).toHaveBeenCalledTimes(1);
    expect(repository.readFile.mock.calls.every(([revision]) => revision === FIRST)).toBe(true);
  });

  it('preserves days with zero, one, three, four and seven problems independently of wall-clock date', async () => {
    const counts = [0, 1, 3, 4, 7];
    const files = Object.fromEntries(counts.map((count, index) => [`daily_problems/2128/03/030${index + 1}/problems.md`, table(count)]));
    const { library } = setup(files);
    const days = await library.getMonth('2128-03');
    expect(days.map(day => day.problems.length)).toEqual([...counts].reverse());
    expect(days[0].date).toBe('2128-03-05');
    expect(days[0].problems.map(problem => problem.id)).toEqual(['cf1a', 'cf2a', 'cf3a', 'cf4a', 'cf5a', 'cf6a', 'cf7a']);
    expect(days[0].fetchedAt).toBe('2026-10-09T00:00:00.000Z');
    expect((await library.getDay('2128-03-01')).problems).toEqual([]);
  });

  it('keeps Gym/Round and estimated/official rating as independent fields', async () => {
    const { library } = setup({ [DAY_PATH]: [
      '| Difficulty | Problems | Hints |', '| --- | --- | --- |',
      '| *1000 | [CF1A](https://codeforces.com/contest/1/problem/A) | A |',
      '| 1200 | [CF2A](https://codeforces.com/contest/2/problem/A) | B |',
      '| *1600 | [GYM103627A](https://codeforces.com/gym/103627/problem/A) | C |',
      '| 2000 | [GYM106744G](https://codeforces.com/gym/106744/problem/G) | D |',
    ].join('\n') });
    expect((await library.getDay()).problems.map(({ kind, ratingSource }) => [kind, ratingSource])).toEqual([
      ['round', 'estimated'], ['round', 'official'], ['gym', 'estimated'], ['gym', 'official'],
    ]);
  });

  it('uses the newest actual problem file even if it has zero problems, and reports a repository without any problem files', async () => {
    const { library } = setup({ [DAY_PATH]: table(), 'daily_problems/2128/02/0229/problems.md': '# Coming next' });
    expect(await library.getDay()).toMatchObject({ date: '2128-02-29', problems: [] });
    const empty = setup({ 'daily_problems/2026/10/README.md': 'No daily files' });
    await expect(empty.library.getDay()).rejects.toThrow('仓库中暂未找到每日题单');
    expect(await empty.library.getMonth('2026-10')).toEqual([]);
  });

  it('reflects additions, deletions, rewrites and a changed default branch on the next independent read', async () => {
    const fixture = setup();
    expect((await fixture.library.getDay()).problems).toHaveLength(1);
    const moved = 'daily_problems/1999/12/1231/problems.md';
    fixture.update({ [moved]: table(3) });
    expect((await fixture.library.getArchiveSnapshot()).branch).toBe('stable/next');
    expect(await fixture.library.getArchiveMonths()).toEqual([{ month: '1999-12', days: 1 }]);
    expect((await fixture.library.getDay()).date).toBe('1999-12-31');
    await expect(fixture.library.getDay(DATE)).rejects.toThrow(`仓库中没有 ${DATE} 的题单`);
    fixture.update({ [moved]: table(7), [DAY_PATH]: table(4) }, THIRD, 'renamed');
    const newest = await fixture.library.getDay(DATE);
    expect(newest.problems).toHaveLength(4);
    expect(newest.sourceUrl).toBe(`${UPSTREAM.url}/blob/${THIRD}/${DAY_PATH}`);
    expect((await fixture.library.getMonth('1999-12'))[0].problems).toHaveLength(7);
  });

  it('never contacts REST or raw.githubusercontent.com for repository contents', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network through Git only'));
    const { library } = setup({ [DAY_PATH]: table(), [CODE_PATH]: 'int main() {}' });
    await library.syncLibrary();
    await library.getDay();
    await library.getArchiveMonths();
    await library.getMonth('2026-10');
    await library.getResources(DATE, 'cf1a');
    await library.getReference(CODE_PATH);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('GitProblemLibrary synchronization boundaries', () => {
  it('reuses unchanged problem blobs across revisions while returning fresh metadata and rebuilding the directory', async () => {
    const fixture = setup({ [DAY_PATH]: table(3), [CODE_PATH]: 'old reference' });
    let time = now();
    const library = new GitProblemLibrary(fixture.repository, { now: () => time });
    const first = await library.getDay(DATE);
    time += 60_000;
    fixture.update({ [DAY_PATH]: table(3), [CODE_PATH]: 'changed reference', 'daily_problems/2128/02/README.md': 'New empty month' });
    const snapshot = await library.getArchiveSnapshot();
    const changed = await library.getDay(DATE);
    expect(snapshot.months).toEqual([{ month: '2128-02', days: 0 }, { month: '2026-10', days: 1 }]);
    expect(changed.problems).toEqual(first.problems);
    expect(changed.problems).not.toBe(first.problems);
    expect(changed.problems[0]).not.toBe(first.problems[0]);
    expect(changed.sourceUrl).toContain(`/blob/${SECOND}/`);
    expect(changed.fetchedAt).not.toBe(first.fetchedAt);
    expect(fixture.repository.sync).toHaveBeenCalledTimes(3);
    expect(fixture.repository.listFiles).toHaveBeenCalledTimes(2);
    expect(fixture.repository.readFile.mock.calls.filter(([, path]) => path === DAY_PATH)).toHaveLength(1);
    expect(await library.getReference(CODE_PATH)).toBe('changed reference');
  });

  it('reads only added or changed problem blobs and excludes deleted dates on the next snapshot', async () => {
    const changedPath = 'daily_problems/2026/10/1008/problems.md';
    const deletedPath = 'daily_problems/2026/09/0901/problems.md';
    const addedPath = 'daily_problems/0001/01/0101/problems.md';
    const fixture = setup({ [DAY_PATH]: table(1), [changedPath]: table(3), [deletedPath]: table(4) });
    const original = await fixture.library.getArchiveSnapshot();
    for (const { month } of original.months) await fixture.library.getMonthFromSnapshot(month, original);
    fixture.repository.readFile.mockClear();
    fixture.update({ [DAY_PATH]: table(1), [changedPath]: table(7), [addedPath]: table(4) });
    const fresh = await fixture.library.getArchiveSnapshot();
    const days = (await Promise.all(fresh.months.map(({ month }) => fixture.library.getMonthFromSnapshot(month, fresh)))).flat();
    expect(days.map(day => [day.date, day.problems.length])).toEqual([['2026-10-08', 7], [DATE, 1], ['0001-01-01', 4]]);
    expect(fixture.repository.readFile.mock.calls.map(([, path]) => path).sort()).toEqual([addedPath, changedPath].sort());
    await expect(fixture.library.getDay('2026-09-01')).rejects.toThrow('没有 2026-09-01');
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(2);
    expect((await fixture.library.getMonthFromSnapshot('2026-09', original))[0].date).toBe('2026-09-01');
    expect(fixture.repository.listFiles).toHaveBeenCalledTimes(2);
  });

  it('does not return a retained problem when its new path is a symbolic link', async () => {
    const fixture = setup();
    await fixture.library.getDay(DATE);
    fixture.update({ [DAY_PATH]: { body: table(), mode: '120000' } });
    await expect(fixture.library.getDay(DATE)).rejects.toThrow('没有 2026-10-07');
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight problem read between concurrent local preview and synchronized reads', async () => {
    const fixture = setup();
    await fixture.library.syncLibrary();
    let release!: (value: string) => void;
    const pending = new Promise<string>(resolve => { release = resolve; });
    fixture.repository.readFile.mockReturnValueOnce(pending);
    const local = fixture.library.getLocalLibraryView({ kind: 'archive', scope: 'all' });
    const fresh = fixture.library.getMonth('2026-10');
    await vi.waitFor(() => expect(fixture.repository.readFile).toHaveBeenCalledTimes(1));
    release(table(3));
    const [preview, updated] = await Promise.all([local, fresh]);
    expect(preview).toMatchObject({ kind: 'archive', index: { '2026-10': [{ problems: [{ id: 'cf1a' }, { id: 'cf2a' }, { id: 'cf3a' }] }] } });
    expect(updated[0].problems).toHaveLength(3);
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(1);
    expect(fixture.repository.listFiles).toHaveBeenCalledTimes(1);
    expect(fixture.repository.sync).toHaveBeenCalledTimes(2);
  });

  it('keeps date-relative editorial links separate even for identical Git blobs', async () => {
    const markdown = '| *1000 | [CF1A](https://codeforces.com/contest/1/problem/A) | Hint | [Solution](solution/cf1a.md) |';
    const fixture = setup({ [DAY_PATH]: markdown, 'daily_problems/2128/02/0229/problems.md': markdown });
    const old = await fixture.library.getDay(DATE);
    const future = await fixture.library.getDay('2128-02-29');
    expect(old.problems[0].editorialUrl).toContain('/2026/10/1007/solution/');
    expect(future.problems[0].editorialUrl).toContain('/2128/02/0229/solution/');
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(2);
  });

  it('separates localized parser warnings and does not reuse English output after switching back to Chinese', async () => {
    const fixture = setup({ [DAY_PATH]: '| 1000 | [CF2A](https://codeforces.com/contest/1/problem/A) | Hint |' });
    const chinese = await fixture.library.getDay(DATE);
    expect(chinese.problems[0].sourceWarning).toContain('原仓库题号');
    setLocale('en');
    const english = await fixture.library.getDay(DATE);
    expect(english.problems[0].sourceWarning).not.toBe(chinese.problems[0].sourceWarning);
    setLocale('zh-CN');
    expect((await fixture.library.getDay(DATE)).problems[0].sourceWarning).toBe(chinese.problems[0].sourceWarning);
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(2);
    expect(fixture.repository.sync).toHaveBeenCalledTimes(3);
  });

  it('does not retain a parser result under the wrong language when the locale changes during disk I/O', async () => {
    const markdown = '| 1000 | [CF2A](https://codeforces.com/contest/1/problem/A) | Hint |';
    const fixture = setup({ [DAY_PATH]: markdown });
    let release!: (value: string) => void;
    fixture.repository.readFile.mockReturnValueOnce(new Promise<string>(resolve => { release = resolve; }));
    const pending = fixture.library.getDay(DATE);
    await vi.waitFor(() => expect(fixture.repository.readFile).toHaveBeenCalledTimes(1));
    setLocale('en');
    release(markdown);
    await pending;
    setLocale('zh-CN');
    expect((await fixture.library.getDay(DATE)).problems[0].sourceWarning).toContain('原仓库题号');
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(2);
  });

  it('retries a failed or missing blob read instead of retaining a rejected promise', async () => {
    const fixture = setup();
    fixture.repository.readFile.mockRejectedValueOnce(new Error('Disk read interrupted'));
    await expect(fixture.library.getDay(DATE)).rejects.toThrow('Disk read interrupted');
    fixture.repository.readFile.mockResolvedValueOnce(null);
    await expect(fixture.library.getDay(DATE)).rejects.toThrow('没有 2026-10-07');
    expect((await fixture.library.getDay(DATE)).problems).toHaveLength(1);
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(3);
  });

  it('evicts older parsed payloads when their combined serialized size exceeds the memory budget', async () => {
    const hint = 'x'.repeat(950_000);
    const markdown = `| 1000 | [CF1A](https://codeforces.com/contest/1/problem/A) | ${hint} |`;
    const files: Files = {};
    for (let index = 1; index <= 40; index++) files[`daily_problems/${2000 + index}/01/0101/problems.md`] = markdown;
    const fixture = setup(files);
    for (let index = 1; index <= 40; index++) await fixture.library.getDay(`${2000 + index}-01-01`);
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(40);
    expect((await fixture.library.getDay('2001-01-01')).problems[0].hint).toHaveLength(hint.length);
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(41);
  });

  it('bounds the number of small parsed entries and retains recent ones after eviction', async () => {
    const files: Files = {};
    const dates = Array.from({ length: 8_193 }, (_, index) => `${String(index + 1).padStart(4, '0')}-01-01`);
    for (const date of dates) files[`${repositoryDatePath(date)}/problems.md`] = table();
    const fixture = setup(files);
    for (const date of dates) await fixture.library.getDay(date);
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(dates.length);
    await fixture.library.getDay(dates[dates.length - 1]);
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(dates.length);
    await fixture.library.getDay(dates[0]);
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(dates.length + 1);
  });

  it('keeps two active revision indexes and rebuilds a third evicted index without mixing revisions', async () => {
    const fixture = setup({ [DAY_PATH]: table(1) });
    const first = await fixture.library.getArchiveSnapshot();
    fixture.update({ [DAY_PATH]: table(3) }, SECOND);
    const second = await fixture.library.getArchiveSnapshot();
    expect((await fixture.library.getMonthFromSnapshot('2026-10', first))[0].problems).toHaveLength(1);
    fixture.update({ [DAY_PATH]: table(7) }, THIRD);
    const third = await fixture.library.getArchiveSnapshot();
    expect(fixture.repository.listFiles).toHaveBeenCalledTimes(3);
    expect((await fixture.library.getMonthFromSnapshot('2026-10', third))[0].problems).toHaveLength(7);
    expect((await fixture.library.getMonthFromSnapshot('2026-10', second))[0].problems).toHaveLength(3);
    expect(fixture.repository.listFiles).toHaveBeenCalledTimes(4);
  });

  it('synchronizes every independent read even when refresh is omitted or false and the revision stays unchanged', async () => {
    const { library, repository } = setup({ [DAY_PATH]: table(), [CODE_PATH]: 'int main() {}' });
    await library.syncLibrary();
    await library.getDay();
    await library.getDay(DATE, false);
    await library.getArchiveMonths();
    await library.getArchiveMonths(false);
    await library.getArchiveSnapshot();
    await library.getMonth('2026-10');
    await library.getMonth('2026-10', false);
    await library.getResources(DATE, 'cf1a', false);
    await library.getReference(CODE_PATH, false);
    expect(repository.sync).toHaveBeenCalledTimes(10);
    expect(repository.listFiles).toHaveBeenCalledTimes(1);
    expect(repository.readFile.mock.calls.filter(([, path]) => path === DAY_PATH)).toHaveLength(1);
  });

  it('loads all months from one immutable snapshot without additional sync calls or repeated tree enumeration', async () => {
    const fixture = setup({ [DAY_PATH]: table(1), 'daily_problems/1999/12/1231/problems.md': table(3) });
    const snapshot = await fixture.library.getArchiveSnapshot();
    fixture.update({ [DAY_PATH]: table(7), 'daily_problems/2128/02/0229/problems.md': table(4) });
    const days = (await Promise.all(snapshot.months.map(({ month }) => fixture.library.getMonthFromSnapshot(month, snapshot)))).flat();
    expect(days.map(day => [day.date, day.problems.length])).toEqual([[DATE, 1], ['1999-12-31', 3]]);
    expect(fixture.repository.sync).toHaveBeenCalledTimes(1);
    expect(fixture.repository.listFiles).toHaveBeenCalledTimes(1);
    expect(fixture.repository.readFile.mock.calls.every(([revision]) => revision === FIRST)).toBe(true);
    expect((await fixture.library.getDay()).date).toBe('2128-02-29');
  });

  it('pins editorial and reference listing to the synchronized revision while the remote moves', async () => {
    const original: Files = { [DAY_PATH]: table(), [CODE_PATH]: 'original', [`${BASE}/solution/cf1a.md`]: 'Original editorial' };
    const fixture = setup(original);
    fixture.repository.listFiles.mockImplementationOnce(async revision => {
      fixture.update({ [DAY_PATH]: table(), [`${BASE}/personal_submission/cf1a_bob.py`]: 'replacement' });
      return Object.keys(original).map(path => ({ path, oid: blobOid(original[path]), mode: '100644' }));
    });
    const resources = await fixture.library.getResources(DATE, 'cf1a');
    expect(resources.editorial).toBe('Original editorial');
    expect(resources.references.map(file => file.name)).toEqual(['cf1a_alice.cpp']);
    expect(resources.editorialUrl).toContain(`/blob/${FIRST}/`);
    expect(resources.references[0].url).toContain(`/blob/${FIRST}/`);
    expect(fixture.repository.readFile.mock.calls[0][0]).toBe(FIRST);
    await expect(fixture.library.getReference(CODE_PATH)).rejects.toThrow('参考代码不存在');
  });

  it('surfaces a failed sync instead of returning old content; explicit already-acquired snapshots remain readable', async () => {
    const fixture = setup({ [DAY_PATH]: table(), [CODE_PATH]: 'old' });
    const snapshot = await fixture.library.getArchiveSnapshot();
    await fixture.library.getDay();
    fixture.failSync();
    const operations = [
      () => fixture.library.syncLibrary(), () => fixture.library.getDay(), () => fixture.library.getArchiveMonths(),
      () => fixture.library.getArchiveSnapshot(), () => fixture.library.getMonth('2026-10'),
      () => fixture.library.getResources(DATE, 'cf1a'), () => fixture.library.getReference(CODE_PATH),
    ];
    const readsBeforeFailure = fixture.repository.readFile.mock.calls.length;
    for (const operation of operations) await expect(operation()).rejects.toThrow('Network unavailable');
    expect(fixture.repository.readFile).toHaveBeenCalledTimes(readsBeforeFailure);
    expect((await fixture.library.getMonthFromSnapshot('2026-10', snapshot))[0].date).toBe(DATE);
    fixture.recoverSync();
    fixture.update({ [DAY_PATH]: table(4) });
    expect((await fixture.library.getDay()).problems).toHaveLength(4);
  });

  it('retries a failed tree read rather than keeping a rejected index promise', async () => {
    const { library, repository } = setup();
    repository.listFiles.mockRejectedValueOnce(new Error('Unreadable Git tree'));
    await expect(library.getArchiveSnapshot()).rejects.toThrow('Unreadable Git tree');
    expect((await library.getArchiveSnapshot()).months).toEqual([{ month: '2026-10', days: 1 }]);
    expect(repository.listFiles).toHaveBeenCalledTimes(2);
  });

  it('does not expose mutable internal directory objects or shared parsed results', async () => {
    const { library, repository } = setup();
    const months = await library.getArchiveMonths();
    months[0].month = '9999-12';
    months.push({ month: '0001-01', days: 99 });
    expect(await library.getArchiveMonths()).toEqual([{ month: '2026-10', days: 1 }]);
    const first = await library.getDay();
    first.problems[0].hint = 'Local mutation';
    expect((await library.getDay()).problems[0].hint).toBe('Hint 1');
    expect(repository.listFiles).toHaveBeenCalledTimes(1);
  });

  it('reports bounded local month parsing progress', async () => {
    const fixture = setup({ [DAY_PATH]: table(), 'daily_problems/2026/10/1008/problems.md': table() });
    const onProgress = vi.fn();
    const library = new GitProblemLibrary(fixture.repository, { now, onProgress });
    await library.getMonth('2026-10');
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { month: '2026-10', completed: 1, total: 2 }, { month: '2026-10', completed: 2, total: 2 },
    ]);
  });
});

describe('GitProblemLibrary code and input boundaries', () => {
  it('lists known and custom code formats, including executable-mode text files and filenames requiring URL encoding', async () => {
    const extensions = ['cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'py', 'py3', 'java', 'rs', 'go', 'cs', 'js', 'ts', 'kt', 'kts', 'rb', 'swift', 'scala', 'php', 'pas', 'd', 'hs', 'ml', 'fs', 'fsharp', 'pl', 'r', 'txt', 'C', 'c++', 'd.ts'];
    const files: Files = { [DAY_PATH]: table() };
    for (const [index, extension] of extensions.entries()) files[`${BASE}/personal_submission/cf1a_author${index}.${extension}`] = 'code';
    files[`${BASE}/personal_submission/cf1a_A Name#.CPP`] = { body: 'cpp', mode: '100755' };
    files[`${BASE}/personal_submission/cf2a_other.cpp`] = 'different problem';
    files[`${BASE}/personal_submission/cf1a_custom.mycode`] = 'custom code';
    files[`${BASE}/personal_submission/cf1a_map.constructor`] = 'text with an inherited map property as its extension';
    files[`${BASE}/personal_submission/nested/cf1a_nested.cpp`] = 'nested';
    files[`${BASE}/personal_submission/cf1a_link.cpp`] = { body: '../../secret', mode: '120000' };
    files[`${BASE}/personal_submission/cf1a_submodule.cpp`] = { body: 'gitlink', mode: '160000' };
    const { library } = setup(files);
    const resources = await library.getResources(DATE, 'cf1a');
    expect(resources.references).toHaveLength(extensions.length + 3);
    expect(resources.references.map(file => file.language)).toContain('Haskell');
    expect(resources.references.map(file => file.language)).toContain('文本');
    expect(resources.references.map(file => file.language)).toContain('TypeScript');
    expect(resources.references.map(file => file.language)).toContain('.mycode');
    expect(resources.references.map(file => file.language)).toContain('.constructor');
    expect(await library.getReference(`${BASE}/personal_submission/cf1a_custom.mycode`)).toBe('custom code');
    const encoded = resources.references.find(file => file.name.includes('A Name#'))!;
    expect(encoded.url).toContain('cf1a_A%20Name%23.CPP');
    expect(await library.getReference(encoded.path)).toBe('cpp');
    setLocale('en');
    expect((await library.getResources(DATE, 'cf1a')).references.find(file => file.path.endsWith('.txt'))?.language).toBe('Text');
  });

  it('does not choose a linked problems.md as the latest day', async () => {
    const { library } = setup({ [DAY_PATH]: table(), 'daily_problems/9999/12/1231/problems.md': { body: '../../secret', mode: '120000' } });
    expect((await library.getDay()).date).toBe(DATE);
    expect((await library.getArchiveMonths()).map(month => month.month)).toEqual(['2026-10']);
  });

  it('bounds all file reads in bytes and rejects binary reference previews', async () => {
    const { library, repository } = setup({ [DAY_PATH]: table(), [CODE_PATH]: '\0binary' });
    await expect(library.getReference(CODE_PATH)).rejects.toThrow('不是可预览的文本代码');
    await library.getDay();
    await library.getResources(DATE, 'cf1a');
    expect(repository.readFile.mock.calls.every(([, , maxBytes]) => maxBytes === MAX_LIBRARY_FILE_BYTES)).toBe(true);
    const large = setup({ [DAY_PATH]: table(), [CODE_PATH]: '文'.repeat(Math.floor(MAX_LIBRARY_FILE_BYTES / 3) + 1) });
    await expect(large.library.getReference(CODE_PATH)).rejects.toThrow('File size limit');
  });

  it('keeps the reference listing usable for oversized files and reports the limit only when opened', async () => {
    const { library, repository } = setup({ [DAY_PATH]: table(), [CODE_PATH]: 'x'.repeat(MAX_LIBRARY_FILE_BYTES + 1) });
    expect((await library.getResources(DATE, 'cf1a')).references.map(file => file.path)).toEqual([CODE_PATH]);
    expect(repository.readFile.mock.calls.some(([, path]) => path === CODE_PATH)).toBe(false);
    await expect(library.getReference(CODE_PATH)).rejects.toThrow('File size limit');
  });

  it.each(['../../secret', `${BASE}/personal_submission/cf1a_%2e.cpp`, `${BASE}/personal_submission/nested/cf1a_a.cpp`, `${BASE}/personal_submission/cf1a_a.cpp:stream`, 'daily_problems/2026/02/0230/personal_submission/cf1a_a.cpp'])
    ('rejects invalid reference path %s before synchronization', async path => {
      const { library, repository } = setup();
      await expect(library.getReference(path)).rejects.toThrow();
      expect(repository.sync).not.toHaveBeenCalled();
      expect(repository.readFile).not.toHaveBeenCalled();
    });

  it.each(['2026-00', '0000-01', '2026-13', '../2026/10', '2026-1', '2026-10-01'])('rejects invalid month %s before synchronization', async value => {
    const { library, repository } = setup();
    await expect(library.getMonth(value)).rejects.toThrow();
    expect(repository.sync).not.toHaveBeenCalled();
  });

  it.each([
    { branch: 'main', revision: 'main' }, { branch: 'main', revision: '../' }, { branch: '../main', revision: FIRST },
    { branch: 'bad branch', revision: FIRST }, { branch: '.private', revision: FIRST }, { branch: 'main.lock', revision: FIRST },
  ])('rejects invalid pinned revision or branch %j before accessing Git objects', async version => {
    const { library, repository } = setup();
    await expect(library.getMonthFromSnapshot('2026-10', { ...version, months: [] })).rejects.toThrow('无法确认题库当前版本');
    expect(repository.sync).not.toHaveBeenCalled();
    expect(repository.listFiles).not.toHaveBeenCalled();
    expect(repository.readFile).not.toHaveBeenCalled();
  });
});
