import { describe, expect, it, vi } from 'vitest';
import { ProblemLibrary, type LibraryOptions } from '../electron/library';
import { UPSTREAM } from '../shared/types';

const base = `https://api.github.com/repos/${UPSTREAM.owner}/${UPSTREAM.repo}`;
const raw = `https://raw.githubusercontent.com/${UPSTREAM.owner}/${UPSTREAM.repo}/stable`;
const stableSha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
// Existing fixtures use readable branch labels. Resolve each workflow's ref to
// a real-shaped immutable SHA, then route pinned requests to those fixtures.
const fixtureUrl = (url: string) => url.replace(stableSha, 'stable').replace(nextSha, 'next');
const referenceRoute = (url: string) => url === `${base}/git/ref/heads/stable` ? { object: { sha: stableSha } }
  : url === `${base}/git/ref/heads/next` ? { object: { sha: nextSha } } : undefined;
const dir = (path: string, name: string) => ({ type: 'dir', name, path: `${path}/${name}` });
const file = (name: string, size = 12, path = `daily_problems/2026/10/1007/personal_submission/${name}`) => ({ type: 'file', name, path, size });
const markdown = '| Difficulty | Problems | Hints |\n| --- | --- | --- |\n| *1000 | [GYM106744G](https://codeforces.com/gym/106744/problem/G) | Greedy. |\n| 1900 | [CF1185C2](https://codeforces.com/problemset/problem/1185/C2) | Sort. |';
function setup(routes: Record<string, unknown | (() => Response)> = {}, token?: string, options: Pick<LibraryOptions, 'now'> = {}) {
  const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = fixtureUrl(String(input));
    const value = routes[url] ?? referenceRoute(String(input)) ?? (url === base ? { default_branch: 'stable' } : undefined);
    if (value === undefined) throw new Error(`Unexpected request: ${url}`);
    if (typeof value === 'function') return (value as () => Response)();
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 });
  });
  return { fetcher, library: new ProblemLibrary(token, { fetch: fetcher as typeof fetch, now: options.now ?? (() => Date.UTC(2026, 9, 7)) }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const json = (value: unknown) => new Response(JSON.stringify(value));

describe('ProblemLibrary', () => {
  it('discovers all historical years without recursively downloading their source trees', async () => {
    const { library, fetcher } = setup({
      [`${base}/contents/daily_problems?ref=stable`]: [dir('daily_problems', '2024'), dir('daily_problems', '2026'), dir('daily_problems', 'notes')],
      [`${base}/contents/daily_problems/2024?ref=stable`]: [dir('daily_problems/2024', '03'), dir('daily_problems/2024', '13')],
      [`${base}/contents/daily_problems/2026?ref=stable`]: [dir('daily_problems/2026', '09'), dir('daily_problems/2026', '10')],
    });
    expect(await library.getArchiveMonths()).toEqual([{ month: '2026-10', days: 0 }, { month: '2026-09', days: 0 }, { month: '2024-03', days: 0 }]);
    expect(fetcher).toHaveBeenCalledTimes(5);
    await library.getArchiveMonths();
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it('loads real day folders and reparses Gym and multi-character indexes on every read', async () => {
    const { library, fetcher } = setup({
      [`${base}/contents/daily_problems/2026/10?ref=stable`]: [dir('daily_problems/2026/10', '1007'), dir('daily_problems/2026/10', '1006'), dir('daily_problems/2026/10', '1032'), dir('daily_problems/2026/10', '0920')],
      [`${raw}/daily_problems/2026/10/1007/problems.md`]: markdown,
      [`${raw}/daily_problems/2026/10/1006/problems.md`]: markdown,
    });
    const days = await library.getMonth('2026-10');
    expect(days.map((day) => day.date)).toEqual(['2026-10-07', '2026-10-06']);
    expect(days[0].problems.map((problem) => problem.id)).toEqual(['cf106744g', 'cf1185c2']);
    expect(days[0].problems.map((problem) => problem.rating)).toEqual([1000, 1900]);
    expect(days[0].sourceUrl).toContain('/blob/stable/daily_problems/2026/10/1007/problems.md');
    const calls = fetcher.mock.calls.length;
    expect((await library.getMonth('2026-10'))[0]).not.toHaveProperty('cached');
    expect(fetcher).toHaveBeenCalledTimes(calls * 2);
    const unavailable = vi.fn(() => Promise.reject(new TypeError('offline')));
    const restored = new ProblemLibrary(undefined, { fetch: unavailable as typeof fetch });
    await expect(restored.getMonth('2026-10')).rejects.toThrow('无法连接 GitHub');
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it('returns every problem from days containing 0, 1, 3, 4 and 7 entries in the same month', async () => {
    const cases = [
      { count: 0, day: '1001' }, { count: 1, day: '1002' }, { count: 3, day: '1003' },
      { count: 4, day: '1004' }, { count: 7, day: '1005' },
    ];
    const problems = [
      { id: 'cf1a', url: 'https://codeforces.com/problemset/problem/1/A', rating: 800, ratingSource: 'official', kind: 'round' },
      { id: 'cf106744g', url: 'https://codeforces.com/gym/106744/problem/G', rating: 1000, ratingSource: 'estimated', kind: 'gym' },
      { id: 'cf1185c2', url: 'https://codeforces.com/contest/1185/problem/C2', rating: 1900, ratingSource: 'estimated', kind: 'round' },
      { id: 'cf103627a', url: 'https://codeforces.com/gym/103627/problem/A', rating: 2100, ratingSource: 'official', kind: 'gym' },
      { id: 'cf2b', url: 'https://codeforces.com/problemset/problem/2/B', rating: null, ratingSource: 'unknown', kind: 'round' },
      { id: 'cf1999f1', url: 'https://codeforces.com/contest/1999/problem/F1', rating: 800, ratingSource: 'official', kind: 'round' },
      { id: 'cf106247d', url: 'https://codeforces.com/gym/106247/problem/D', rating: 1600, ratingSource: 'estimated', kind: 'gym' },
    ];
    const routes: Record<string, unknown> = {
      [`${base}/contents/daily_problems/2026/10?ref=stable`]: cases.map(({ day }) => dir('daily_problems/2026/10', day)),
    };
    for (const { count, day } of cases) {
      routes[`${raw}/daily_problems/2026/10/${day}/problems.md`] = [
        '| Difficulty | Problems | Hints |', '| --- | --- | --- |',
        ...problems.slice(0, count).map((problem, index) => {
          const difficulty = problem.rating === null ? '?' : `${problem.ratingSource === 'estimated' ? '*' : ''}${problem.rating}`;
          return `| ${difficulty} | [${problem.id.toUpperCase()}](${problem.url}) | Hint ${index + 1} |`;
        }),
      ].join('\n');
    }
    const { library, fetcher } = setup(routes);
    const days = await library.getMonth('2026-10');
    expect(days.map(day => [day.date, day.problems.length])).toEqual([
      ['2026-10-05', 7], ['2026-10-04', 4], ['2026-10-03', 3], ['2026-10-02', 1], ['2026-10-01', 0],
    ]);
    for (const day of days) {
      const count = cases.find(item => item.day === day.date.replaceAll('-', '').slice(4))!.count;
      expect(day.problems).toEqual(problems.slice(0, count).map((problem, index) => ({
        ...problem, label: problem.id.toUpperCase(), hint: `Hint ${index + 1}`,
      })));
    }
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/problems.md'))).toHaveLength(5);
  });

  it('discovers sparse older years and future months directly from directories and can open pre-2020 dates', async () => {
    const { library } = setup({
      [`${base}/contents/daily_problems?ref=stable`]: ['0000', '0001', '1999', '2019', '2026', '2101'].map(year => dir('daily_problems', year)),
      [`${base}/contents/daily_problems/0001?ref=stable`]: [dir('daily_problems/0001', '01')],
      [`${base}/contents/daily_problems/1999?ref=stable`]: [dir('daily_problems/1999', '12')],
      [`${base}/contents/daily_problems/2019?ref=stable`]: [dir('daily_problems/2019', '02'), dir('daily_problems/2019', '11')],
      [`${base}/contents/daily_problems/2026?ref=stable`]: [dir('daily_problems/2026', '10')],
      [`${base}/contents/daily_problems/2101?ref=stable`]: [dir('daily_problems/2101', '01'), dir('daily_problems/2101', '12'), dir('daily_problems/2101', '13')],
      [`${base}/contents/daily_problems/1999/12?ref=stable`]: [dir('daily_problems/1999/12', '1231')],
      [`${base}/contents/daily_problems/2019/02?ref=stable`]: [dir('daily_problems/2019/02', '0228')],
      [`${raw}/daily_problems/1999/12/1231/problems.md`]: markdown,
      [`${raw}/daily_problems/2019/02/0228/problems.md`]: markdown,
    });
    expect((await library.getArchiveMonths()).map(month => month.month)).toEqual(['2101-12', '2101-01', '2026-10', '2019-11', '2019-02', '1999-12', '0001-01']);
    expect((await library.getMonth('1999-12'))[0].date).toBe('1999-12-31');
    expect((await library.getMonth('2019-02'))[0].date).toBe('2019-02-28');
  });

  it('discovers added earlier years and sparse future months immediately without a refresh flag', async () => {
    const routes: Record<string, unknown> = {
      [`${base}/contents/daily_problems?ref=stable`]: [dir('daily_problems', '2026')],
      [`${base}/contents/daily_problems/2026?ref=stable`]: [dir('daily_problems/2026', '10')],
    };
    const { library, fetcher } = setup(routes);
    expect((await library.getArchiveMonths()).map(item => item.month)).toEqual(['2026-10']);
    const originalCalls = fetcher.mock.calls.length;
    routes[`${base}/contents/daily_problems?ref=stable`] = [dir('daily_problems', '1999'), dir('daily_problems', '2026'), dir('daily_problems', '2027')];
    routes[`${base}/contents/daily_problems/1999?ref=stable`] = [dir('daily_problems/1999', '12')];
    routes[`${base}/contents/daily_problems/2026?ref=stable`] = [dir('daily_problems/2026', '03'), dir('daily_problems/2026', '10')];
    routes[`${base}/contents/daily_problems/2027?ref=stable`] = [dir('daily_problems/2027', '01')];
    const expected = ['2027-01', '2026-10', '2026-03', '1999-12'];
    expect((await library.getArchiveMonths()).map(item => item.month)).toEqual(expected);
    expect(fetcher.mock.calls.length).toBeGreaterThan(originalCalls);
    const restored = new ProblemLibrary(undefined, { fetch: fetcher as typeof fetch });
    expect((await restored.getArchiveMonths()).map(item => item.month)).toEqual(expected);
  });

  it.each([
    ['2128', '02', '29'], ['9999', '12', '31'],
  ])('reads repository dates in %s-%s-%s independently of the current year', async (year, month, day) => {
    const date = `${year}-${month}-${day}`;
    const datePath = `daily_problems/${year}/${month}/${month}${day}`;
    const codePath = `${datePath}/personal_submission/cf106744g_future_author.cpp`;
    const code = '// Reference code stored under the repository date\nint main() {}';
    const { library, fetcher } = setup({
      [`${base}/contents/daily_problems?ref=stable`]: [dir('daily_problems', year)],
      [`${base}/contents/daily_problems/${year}?ref=stable`]: [dir(`daily_problems/${year}`, month)],
      [`${base}/contents/daily_problems/${year}/${month}?ref=stable`]: [dir(`daily_problems/${year}/${month}`, `${month}${day}`)],
      [`${raw}/${datePath}/problems.md`]: markdown,
      [`${raw}/${datePath}/solution/cf106744g.md`]: '# Repository editorial',
      [`${base}/contents/${datePath}/personal_submission?ref=stable`]: [file('cf106744g_future_author.cpp', code.length, codePath)],
      [`${raw}/${codePath}`]: code,
    }, undefined, { now: () => Date.UTC(2026, 9, 7) });
    expect(await library.getArchiveMonths(true)).toEqual([{ month: `${year}-${month}`, days: 0 }]);
    const days = await library.getMonth(`${year}-${month}`, true);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ date, fetchedAt: '2026-10-07T00:00:00.000Z' });
    expect(days[0].problems.map(problem => problem.id)).toEqual(['cf106744g', 'cf1185c2']);
    const resources = await library.getResources(date, 'cf106744g', true);
    expect(resources.editorial).toBe('# Repository editorial');
    expect(resources.references.map(reference => reference.path)).toEqual([codePath]);
    expect(await library.getReference(codePath, true)).toBe(code);
    const calls = fetcher.mock.calls.length;
    const restored = new ProblemLibrary(undefined, {
      fetch: fetcher as typeof fetch, now: () => Date.UTC(2026, 9, 7),
    });
    expect((await restored.getMonth(`${year}-${month}`))[0]).toMatchObject({ date });
    expect(fetcher).toHaveBeenCalledTimes(calls + 4);
  });

  it('discovers newly added dates and redownloads previously parsed days on the next ordinary read', async () => {
    const routes: Record<string, unknown> = {
      [`${base}/contents/daily_problems/2026/10?ref=stable`]: [dir('daily_problems/2026/10', '1007')],
      [`${raw}/daily_problems/2026/10/1007/problems.md`]: markdown,
      [`${raw}/daily_problems/2026/10/1008/problems.md`]: markdown,
    };
    const { library, fetcher } = setup(routes);
    await library.getMonth('2026-10');
    routes[`${base}/contents/daily_problems/2026/10?ref=stable`] = [dir('daily_problems/2026/10', '1007'), dir('daily_problems/2026/10', '1008')];
    routes[`${raw}/daily_problems/2026/10/1007/problems.md`] = markdown.replace('Greedy.', 'Edited immediately.');
    const days = await library.getMonth('2026-10');
    expect(days.map(day => day.date)).toEqual(['2026-10-08', '2026-10-07']);
    expect(days[1].problems[0].hint).toBe('Edited immediately.');
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/1007/problems.md'))).toHaveLength(2);
  });

  it('rechecks default branch, directory and markdown for a previously loaded month without a refresh flag', async () => {
    const routes: Record<string, unknown> = {
      [`${base}/contents/daily_problems/2026/10?ref=stable`]: [dir('daily_problems/2026/10', '1007')],
      [`${raw}/daily_problems/2026/10/1007/problems.md`]: markdown,
    };
    const { library } = setup(routes);
    await library.getMonth('2026-10');
    routes[base] = { default_branch: 'next' };
    routes[`${base}/contents/daily_problems/2026/10?ref=next`] = [dir('daily_problems/2026/10', '1008')];
    routes[`${raw.replace('/stable', '/next')}/daily_problems/2026/10/1008/problems.md`] = markdown.replace('Greedy.', 'Updated.');
    const days = await library.getMonth('2026-10');
    expect(days.map(day => day.date)).toEqual(['2026-10-08']);
    expect(days[0].problems[0].hint).toBe('Updated.');
    expect(days[0].sourceUrl).toContain('/blob/next/');
  });

  it('pins month directories and sheets to one commit when the remote branch advances between reads', async () => {
    let head = stableSha;
    const directoryUrl = `${base}/contents/daily_problems/2026/10?ref=${stableSha}`;
    const sheetUrl = `${raw.replace('/stable', `/${stableSha}`)}/daily_problems/2026/10/1007/problems.md`;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === base) return json({ default_branch: 'stable' });
      if (url === `${base}/git/ref/heads/stable`) return json({ object: { sha: head } });
      if (url === directoryUrl) {
        head = nextSha;
        return json([dir('daily_problems/2026/10', '1007')]);
      }
      if (url === sheetUrl) return new Response(markdown);
      // The new head removes this sheet. Reading a mutable branch here would
      // silently turn a valid date from the old directory into an empty month.
      return new Response('Not found', { status: 404 });
    });
    const library = new ProblemLibrary(undefined, { fetch: fetcher as typeof fetch });
    const days = await library.getMonth('2026-10', true);
    expect(head).toBe(nextSha);
    expect(days.map(day => day.date)).toEqual(['2026-10-07']);
    expect(days[0].problems[0].hint).toBe('Greedy.');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      base, `${base}/git/ref/heads/stable`, directoryUrl, sheetUrl,
    ]);
  });

  it('does not hide expired credentials after an earlier successful month read', async () => {
    const routes: Record<string, unknown> = {
      [`${base}/contents/daily_problems/2026/10?ref=stable`]: [dir('daily_problems/2026/10', '1007')],
      [`${raw}/daily_problems/2026/10/1007/problems.md`]: markdown,
    };
    const { library } = setup(routes);
    await library.getMonth('2026-10');
    routes[base] = () => new Response('{}', { status: 401 });
    await expect(library.getMonth('2026-10')).rejects.toMatchObject({ status: 401 });
  });

  it('uses nonrecursive Git trees when Contents reaches its unpageable 1000-entry boundary', async () => {
    const { library, fetcher } = setup({
      [`${base}/contents/daily_problems?ref=stable`]: Array.from({ length: 1000 }, (_, index) => dir('daily_problems', `note-${index}`)),
      [`${base}/git/trees/stable`]: { tree: [{ path: 'daily_problems', type: 'tree', sha: 'days-tree' }], truncated: false },
      [`${base}/git/trees/days-tree`]: { tree: ['1999', '2027'].map(year => ({ path: year, type: 'tree', sha: `tree-${year}` })), truncated: false },
      [`${base}/contents/daily_problems/1999?ref=stable`]: [dir('daily_problems/1999', '12')],
      [`${base}/contents/daily_problems/2027?ref=stable`]: [dir('daily_problems/2027', '01')],
    });
    expect((await library.getArchiveMonths()).map(item => item.month)).toEqual(['2027-01', '1999-12']);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('recursive'))).toBe(false);
  });

  it('refuses to return an incomplete archive when the fallback Git tree is truncated', async () => {
    const { library } = setup({
      [`${base}/contents/daily_problems?ref=stable`]: Array.from({ length: 1000 }, (_, index) => dir('daily_problems', `note-${index}`)),
      [`${base}/git/trees/stable`]: { tree: [], truncated: true },
    });
    await expect(library.getArchiveMonths()).rejects.toThrow('未完整返回目录');
  });

  it('does not resurrect a day removed on the server and checks empty results again', async () => {
    const routes: Record<string, unknown> = {
      [`${base}/contents/daily_problems/2026/10?ref=stable`]: [dir('daily_problems/2026/10', '1007')],
      [`${raw}/daily_problems/2026/10/1007/problems.md`]: markdown,
    };
    const { library, fetcher } = setup(routes);
    expect(await library.getMonth('2026-10')).toHaveLength(1);
    routes[`${raw}/daily_problems/2026/10/1007/problems.md`] = () => new Response('', { status: 404 });
    expect(await library.getMonth('2026-10')).toEqual([]);
    const calls = fetcher.mock.calls.length;
    expect(await library.getMonth('2026-10')).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(calls + 4);
  });

  it('keeps concurrent discoveries independent and rereads the branch after an older request finishes late', async () => {
    const oldBranch = deferred<Response>();
    const entered = deferred<void>();
    let metadataCalls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const reference = referenceRoute(String(input));
      if (reference) return json(reference);
      const url = fixtureUrl(String(input));
      if (url === base) {
        if (++metadataCalls === 1) { entered.resolve(); return oldBranch.promise; }
        return json({ default_branch: 'next' });
      }
      if (url === `${base}/contents/daily_problems?ref=stable`) return json([dir('daily_problems', '2026')]);
      if (url === `${base}/contents/daily_problems/2026?ref=stable`) return json([dir('daily_problems/2026', '10')]);
      if (url === `${base}/contents/daily_problems?ref=next`) return json([dir('daily_problems', '1999')]);
      if (url === `${base}/contents/daily_problems/1999?ref=next`) return json([dir('daily_problems/1999', '12')]);
      throw new Error(`Unexpected request ${url}`);
    });
    const library = new ProblemLibrary(undefined, { fetch: fetcher as typeof fetch });
    const older = library.getArchiveMonths();
    await entered.promise;
    expect((await library.getArchiveMonths()).map(item => item.month)).toEqual(['1999-12']);
    oldBranch.resolve(json({ default_branch: 'stable' }));
    expect((await older).map(item => item.month)).toEqual(['2026-10']);
    expect((await library.getArchiveMonths()).map(item => item.month)).toEqual(['1999-12']);
    expect(metadataCalls).toBe(3);
  });

  it('does not reuse a late old sheet in subsequent month requests', async () => {
    const oldSheet = deferred<Response>();
    const entered = deferred<void>();
    let directoryCalls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const reference = referenceRoute(String(input));
      if (reference) return json(reference);
      const url = fixtureUrl(String(input));
      if (url === base) return json({ default_branch: 'stable' });
      if (url === `${base}/contents/daily_problems/2026/10?ref=stable`) return json([dir('daily_problems/2026/10', ++directoryCalls === 1 ? '1007' : '1008')]);
      if (url.endsWith('/1007/problems.md')) { entered.resolve(); return oldSheet.promise; }
      if (url.endsWith('/1008/problems.md')) return new Response(markdown.replace('Greedy.', 'Fresh.'));
      throw new Error(`Unexpected request ${url}`);
    });
    const library = new ProblemLibrary(undefined, { fetch: fetcher as typeof fetch });
    const older = library.getMonth('2026-10');
    await entered.promise;
    expect((await library.getMonth('2026-10')).map(day => day.date)).toEqual(['2026-10-08']);
    oldSheet.resolve(new Response(markdown));
    await older;
    const days = await library.getMonth('2026-10');
    expect(days.map(day => day.date)).toEqual(['2026-10-08']);
    expect(days[0].problems[0].hint).toBe('Fresh.');
    expect(directoryCalls).toBe(3);
  });

  it('truly refreshes editorial and reference listings and ignores an older late response', async () => {
    const oldEditorial = deferred<Response>();
    const entered = deferred<void>();
    let editorialCalls = 0;
    let directoryCalls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const reference = referenceRoute(String(input));
      if (reference) return json(reference);
      const url = fixtureUrl(String(input));
      if (url === base) return json({ default_branch: 'stable' });
      if (url.endsWith('/solution/cf106744g.md')) {
        if (++editorialCalls === 1) { entered.resolve(); return oldEditorial.promise; }
        return new Response('# Updated editorial');
      }
      if (url.includes('/personal_submission?ref=stable')) return json([file(++directoryCalls === 1 ? 'cf106744g_alice.cpp' : 'cf106744g_bob.py')]);
      throw new Error(`Unexpected request ${url}`);
    });
    const library = new ProblemLibrary(undefined, { fetch: fetcher as typeof fetch });
    const older = library.getResources('2026-10-07', 'cf106744g');
    await entered.promise;
    const newer = await library.getResources('2026-10-07', 'cf106744g');
    oldEditorial.resolve(new Response('# Old editorial'));
    await older;
    expect(newer.editorial).toBe('# Updated editorial');
    expect((await library.getResources('2026-10-07', 'cf106744g')).references.map(item => item.name)).toEqual(['cf106744g_bob.py']);
    expect((await library.getResources('2026-10-07', 'cf106744g')).editorial).toBe('# Updated editorial');
    expect(editorialCalls).toBe(4);
  });

  it('reads reference code independently for concurrent callers and never reuses a late older body', async () => {
    const oldCode = deferred<Response>();
    const freshCode = deferred<Response>();
    const enteredOld = deferred<void>();
    const enteredFresh = deferred<void>();
    const path = 'daily_problems/2026/10/1007/personal_submission/cf106744g_alice.cpp';
    let codeCalls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const reference = referenceRoute(String(input));
      if (reference) return json(reference);
      if (String(input) === base) return json({ default_branch: 'stable' });
      if (++codeCalls === 1) { enteredOld.resolve(); return oldCode.promise; }
      if (codeCalls === 2) { enteredFresh.resolve(); return freshCode.promise; }
      return new Response('// Newest code');
    });
    const library = new ProblemLibrary(undefined, { fetch: fetcher as typeof fetch });
    const older = library.getReference(path);
    await enteredOld.promise;
    const newer = library.getReference(path);
    await enteredFresh.promise;
    const concurrent = library.getReference(path);
    freshCode.resolve(new Response('// Fresh code'));
    expect(await newer).toBe('// Fresh code');
    expect(await concurrent).toBe('// Newest code');
    oldCode.resolve(new Response('// Stale code'));
    expect(await older).toBe('// Stale code');
    expect(await library.getReference(path)).toBe('// Newest code');
    expect(codeCalls).toBe(4);
  });

  it('reports a removed reference on every read after an earlier success', async () => {
    const path = 'daily_problems/2026/10/1007/personal_submission/cf106744g_alice.cpp';
    const routes: Record<string, unknown> = { [`${raw}/${path}`]: '// Original code' };
    const { library } = setup(routes);
    await library.getReference(path);
    routes[`${raw}/${path}`] = () => new Response('', { status: 404 });
    await expect(library.getReference(path)).rejects.toMatchObject({ status: 404 });
    await expect(library.getReference(path)).rejects.toMatchObject({ status: 404 });
  });

  it('reads edited reference code immediately without elapsed time or a refresh flag', async () => {
    const path = 'daily_problems/2026/10/1007/personal_submission/cf106744g_alice.cpp';
    const routes: Record<string, unknown> = { [`${raw}/${path}`]: '// Original code' };
    const { library } = setup(routes);
    expect(await library.getReference(path)).toBe('// Original code');
    routes[`${raw}/${path}`] = '// Remote edit';
    expect(await library.getReference(path)).toBe('// Remote edit');
  });

  it('filters references by exact problem prefix, legitimate paths and supported file sizes', async () => {
    const { library } = setup({
      [`${raw}/daily_problems/2026/10/1007/solution/cf106744g.md`]: '# 贪心题解',
      [`${base}/contents/daily_problems/2026/10/1007/personal_submission?ref=stable`]: [
        file('cf106744g_alice.cpp'), file('cf106744g_bob.py'), file('cf106744g_yawn_sean.cpp'), file('cf106744g1_charlie.cpp'),
        file('cf103627a_alice.cpp'), file('cf106744g_custom.mycode'), file('cf106744g_types.d.ts'), file('cf106744g_large.cpp', 1024 * 1024 + 1),
        file('cf106744g_other.cpp', 12, 'secrets/cf106744g_other.cpp'), { ...file('cf106744g_link.cpp'), type: 'symlink' },
      ],
    });
    const result = await library.getResources('2026-10-07', 'cf106744g');
    expect(result.editorial).toBe('# 贪心题解');
    expect(result.editorialUrl).toContain('/blob/stable/');
    expect(result.references.map((entry) => entry.name)).toEqual(['cf106744g_alice.cpp', 'cf106744g_bob.py', 'cf106744g_custom.mycode', 'cf106744g_types.d.ts', 'cf106744g_yawn_sean.cpp']);
    expect(result.references.map((entry) => entry.language)).toEqual(['C++', 'Python', '.mycode', 'TypeScript', 'C++']);
  });

  it.each(['ratingSource', 'kind'] as const)('reparses %s from upstream even if the caller mutated an earlier result', async (field) => {
    const { library, fetcher } = setup({
      [`${base}/contents/daily_problems/2026/10?ref=stable`]: [dir('daily_problems/2026/10', '1007'), dir('daily_problems/2026/10', '1006')],
      [`${raw}/daily_problems/2026/10/1007/problems.md`]: markdown,
      [`${raw}/daily_problems/2026/10/1006/problems.md`]: markdown,
    });
    const earlier = await library.getMonth('2026-10');
    delete earlier[0].problems[0][field];
    const days = await library.getMonth('2026-10');
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(days[0].problems[0]).toMatchObject({ kind: 'gym', ratingSource: 'estimated' });
    expect(days[1]).not.toHaveProperty('cached');
  });

  it('does not reuse results across independent library instances', async () => {
    const routes: Record<string, unknown> = {
      [`${base}/contents/daily_problems?ref=stable`]: [dir('daily_problems', '2026')],
      [`${base}/contents/daily_problems/2026?ref=stable`]: [dir('daily_problems/2026', '10')],
    };
    const { library, fetcher } = setup(routes);
    expect(await library.getArchiveMonths()).toHaveLength(1);
    routes[`${base}/contents/daily_problems/2026?ref=stable`] = [];
    const restarted = new ProblemLibrary(undefined, { fetch: fetcher as typeof fetch });
    expect(await restarted.getArchiveMonths()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it('sets no-store on metadata, refs, directories and raw bodies for every public read', async () => {
    const path = 'daily_problems/2026/10/1007/personal_submission/cf106744g_alice.cpp';
    const { library, fetcher } = setup({
      [`${base}/contents/daily_problems?ref=stable`]: [dir('daily_problems', '2026')],
      [`${base}/contents/daily_problems/2026?ref=stable`]: [dir('daily_problems/2026', '10')],
      [`${base}/contents/daily_problems/2026/10?ref=stable`]: [dir('daily_problems/2026/10', '1007')],
      [`${raw}/daily_problems/2026/10/1007/problems.md`]: markdown,
      [`${raw}/daily_problems/2026/10/1007/solution/cf106744g.md`]: '# Editorial',
      [`${base}/contents/daily_problems/2026/10/1007/personal_submission?ref=stable`]: [file('cf106744g_alice.cpp')],
      [`${raw}/${path}`]: '// Code',
    });
    for (const refresh of [undefined, false, true]) {
      await library.getArchiveMonths(refresh);
      await library.getMonth('2026-10', refresh);
      await library.getResources('2026-10-07', 'cf106744g', refresh);
      await library.getReference(path, refresh);
    }
    expect(fetcher.mock.calls.filter(([url]) => String(url) === base)).toHaveLength(12);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/git/ref/'))).toHaveLength(12);
    expect(fetcher).toHaveBeenCalledTimes(45);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
  });

  it('treats a missing official editorial and submissions folder as unavailable resources', async () => {
    const missing = () => new Response('Not found', { status: 404 });
    const { library } = setup({
      [`${raw}/daily_problems/2026/10/1007/solution/cf106744g.md`]: missing,
      [`${base}/contents/daily_problems/2026/10/1007/personal_submission?ref=stable`]: missing,
    });
    expect(await library.getResources('2026-10-07', 'cf106744g')).toEqual({ editorial: null, editorialUrl: null, references: [] });
  });

  it.each([
    '../../secret.txt', 'https://evil.test/cf106744g_a.cpp',
    'daily_problems/2026/10/1007/personal_submission/../../secrets.cpp',
    'daily_problems/2026/10/1007/personal_submission/cf106744g_%2e%2e.cpp',
    'daily_problems/2026/10/1007/personal_submission/cf106744g_a.cpp:stream',
    'daily_problems/2026/10/1107/personal_submission/cf106744g_a.cpp',
    'daily_problems/2026/02/0230/personal_submission/cf106744g_a.cpp',
    'daily_problems/2026/10/1007/personal_submission/cf106744g_a\\x.cpp',
  ])('rejects unsafe reference paths before making network requests: %s', async (path) => {
    const { library, fetcher } = setup();
    await expect(library.getReference(path)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads an unknown extension as literal text while still rejecting binary content', async () => {
    const path = 'daily_problems/2026/10/1007/personal_submission/cf106744g_alice.custom';
    const source = '// <script>alert(1)</script>\ncustom code';
    const { library } = setup({ [`${raw}/${path}`]: source });
    expect(await library.getReference(path)).toBe(source);
    const binary = setup({ [`${raw}/${path}`]: '\0binary' });
    await expect(binary.library.getReference(path)).rejects.toThrow('不是可预览的文本代码');
  });

  it('keeps credentials on GitHub API only and reads code as literal text', async () => {
    const path = 'daily_problems/2026/10/1007/personal_submission/cf106744g_alice.cpp';
    const { library, fetcher } = setup({ [`${raw}/${path}`]: '// <script>alert(1)</script>\nint main() {}' }, 'sensitive-token');
    expect(await library.getReference(path)).toBe('// <script>alert(1)</script>\nint main() {}');
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer sensitive-token' });
    const rawRequest = fetcher.mock.calls.find(([url]) => String(url).startsWith('https://raw.githubusercontent.com/'))!;
    expect(rawRequest[1]?.headers).not.toHaveProperty('Authorization');
    expect(rawRequest[1]?.redirect).toBe('error');
  });

  it('enforces the 1 MB streaming body limit even without Content-Length', async () => {
    const path = 'daily_problems/2026/10/1007/personal_submission/cf106744g_alice.cpp';
    const { library } = setup({ [`${raw}/${path}`]: () => new Response(new Uint8Array(1024 * 1024 + 1)) });
    await expect(library.getReference(path)).rejects.toThrow('1 MB');
  });

  it('provides an actionable unauthenticated rate-limit message', async () => {
    const { library } = setup({ [base]: () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) });
    await expect(library.getArchiveMonths()).rejects.toThrow('请登录 GitHub');
  });

  it.each([401, 403, 404, 429, 500])('preserves HTTP %s so the main process can invalidate expired credentials', async (status) => {
    const { library } = setup({ [base]: () => new Response('{}', { status }) }, 'expired-token');
    await expect(library.getArchiveMonths()).rejects.toMatchObject({ name: 'LibraryError', status });
  });

  it.each([0, 401, 500])('does not fall back after a prior success when the next remote read fails with %s', async status => {
    const routes: Record<string, unknown> = {
      [`${base}/contents/daily_problems/2026/10?ref=stable`]: [dir('daily_problems/2026/10', '1007')],
      [`${raw}/daily_problems/2026/10/1007/problems.md`]: markdown,
    };
    const { library } = setup(routes);
    await library.getMonth('2026-10');
    routes[base] = () => { if (status === 0) throw new TypeError('offline'); return new Response('{}', { status }); };
    await expect(library.getMonth('2026-10')).rejects.toMatchObject({ status });
  });
});
