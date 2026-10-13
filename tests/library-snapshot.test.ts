import { describe, expect, it, vi } from 'vitest';
import { ProblemLibrary } from '../electron/library';
import { UPSTREAM, type ArchiveSnapshot } from '../shared/types';

const base = `https://api.github.com/repos/${UPSTREAM.owner}/${UPSTREAM.repo}`;
const raw = `https://raw.githubusercontent.com/${UPSTREAM.owner}/${UPSTREAM.repo}`;
const firstSha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const dir = (name: string) => ({ type: 'dir', name });
const markdown = '| Difficulty | Problems | Hints |\n| --- | --- | --- |\n| 1000 | [CF1A](https://codeforces.com/problemset/problem/1/A) | Hint |';
const json = (value: unknown) => new Response(JSON.stringify(value));

describe('one fresh snapshot per full archive read', () => {
  it('reads 33 months in 3 years with 39 API requests and one immutable revision', async () => {
    const years = ['2024', '2025', '2026'];
    const monthsByYear = Object.fromEntries(years.map((year, index) => [year,
      Array.from({ length: index === 2 ? 9 : 12 }, (_, month) => `${month + 1}`.padStart(2, '0'))]));
    const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url === base) return json({ default_branch: 'main' });
      if (url === `${base}/git/ref/heads/main`) return json({ object: { sha: firstSha } });
      if (url === `${base}/contents/daily_problems?ref=${firstSha}`) return json(years.map(dir));
      const year = /^\/contents\/daily_problems\/(\d{4})$/.exec(new URL(url).pathname.slice(new URL(base).pathname.length));
      if (year && new URL(url).searchParams.get('ref') === firstSha) return json(monthsByYear[year[1]].map(dir));
      const month = /^\/contents\/daily_problems\/(\d{4})\/(\d{2})$/.exec(new URL(url).pathname.slice(new URL(base).pathname.length));
      if (month && new URL(url).searchParams.get('ref') === firstSha) return json([dir(`${month[2]}01`)]);
      if (url.startsWith(`${raw}/${firstSha}/daily_problems/`) && url.endsWith('/problems.md')) return new Response(markdown);
      throw new Error(`Unexpected request: ${url}`);
    });
    const library = new ProblemLibrary(undefined, { fetch: fetcher as typeof fetch });
    const snapshot = await library.getArchiveSnapshot();
    expect(snapshot).toMatchObject({ branch: 'main', revision: firstSha });
    expect(snapshot.months).toHaveLength(33);
    for (const month of snapshot.months) {
      expect((await library.getMonthFromSnapshot(month.month, snapshot)).map(day => day.date)).toEqual([`${month.month}-01`]);
    }
    const calls = fetcher.mock.calls.map(([input]) => String(input));
    expect(calls.filter(url => url.startsWith(base))).toHaveLength(39);
    expect(calls.filter(url => url === base)).toHaveLength(1);
    expect(calls.filter(url => url.includes('/git/ref/'))).toHaveLength(1);
    expect(calls.filter(url => url.startsWith(raw))).toHaveLength(33);
    for (const [input, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
      const url = new URL(String(input));
      if (url.pathname.includes('/contents/')) expect(url.searchParams.get('ref')).toBe(firstSha);
    }
  });

  it('keeps the current load consistent across upstream changes and discovers them on the next load', async () => {
    let head = firstSha;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === base) return json({ default_branch: 'main' });
      if (url === `${base}/git/ref/heads/main`) return json({ object: { sha: head } });
      const revision = new URL(url).searchParams.get('ref');
      if (url.startsWith(`${base}/contents/daily_problems?`)) return json([dir(revision === firstSha ? '0001' : '9999')]);
      if (url.startsWith(`${base}/contents/daily_problems/0001?`) || url.startsWith(`${base}/contents/daily_problems/9999?`)) return json([dir('12')]);
      if (url === `${base}/contents/daily_problems/0001/12?ref=${firstSha}` || url === `${base}/contents/daily_problems/9999/12?ref=${nextSha}`) return json([dir('1231')]);
      if (url === `${raw}/${firstSha}/daily_problems/0001/12/1231/problems.md`) return new Response(markdown);
      if (url === `${raw}/${nextSha}/daily_problems/9999/12/1231/problems.md`) return new Response(markdown.replace('Hint', 'New hint'));
      throw new Error(`Unexpected request: ${url}`);
    });
    const library = new ProblemLibrary(undefined, { fetch: fetcher as typeof fetch });
    const first = await library.getArchiveSnapshot();
    head = nextSha;
    expect(first.months).toEqual([{ month: '0001-12', days: 0 }]);
    expect((await library.getMonthFromSnapshot('0001-12', first))[0].date).toBe('0001-12-31');
    const second = await library.getArchiveSnapshot();
    expect(second.months).toEqual([{ month: '9999-12', days: 0 }]);
    expect(second.revision).toBe(nextSha);
    expect((await library.getMonthFromSnapshot('9999-12', second))[0].date).toBe('9999-12-31');
    expect(fetcher.mock.calls.filter(([url]) => String(url) === base)).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/git/ref/'))).toHaveLength(2);
  });

  it.each([
    null, {}, { branch: 'main', revision: 'main' }, { branch: 'main', revision: '../main' },
    { branch: '', revision: firstSha }, { branch: '../main', revision: firstSha },
    { branch: 'main\nheader', revision: firstSha }, { branch: 'main?ref=other', revision: firstSha },
  ])('rejects an unsafe snapshot without any requests: %j', async snapshot => {
    const fetcher = vi.fn<typeof fetch>();
    const library = new ProblemLibrary(undefined, { fetch: fetcher });
    await expect(library.getMonthFromSnapshot('2026-10', snapshot as ArchiveSnapshot)).rejects.toThrow('无法确认题库当前版本');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('supports a valid namespaced branch and 64-character immutable revisions', async () => {
    const snapshot: ArchiveSnapshot = { branch: 'release/中文', revision: 'c'.repeat(64), months: [] };
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${base}/contents/daily_problems/2400/02?ref=${snapshot.revision}`) return json([dir('0229')]);
      if (url === `${raw}/${snapshot.revision}/daily_problems/2400/02/0229/problems.md`) return new Response(markdown);
      throw new Error(`Unexpected request: ${url}`);
    });
    const library = new ProblemLibrary(undefined, { fetch: fetcher as typeof fetch });
    const days = await library.getMonthFromSnapshot('2400-02', snapshot);
    expect(days[0].date).toBe('2400-02-29');
    expect(days[0].sourceUrl).toContain(`/blob/${encodeURIComponent(snapshot.branch)}/`);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
