import { describe, expect, it, vi } from 'vitest';
import { readProblemDay } from '../shared/day-service';
import { PARSER_VERSION } from '../shared/domain';
import { UPSTREAM, type ProblemDay } from '../shared/types';

const date = '2026-10-07';
function day(label = 'current', overrides: Partial<ProblemDay> = {}): ProblemDay {
  return {
    date,
    problems: [{ id: 'cf1185c2', label, url: 'https://codeforces.com/problemset/problem/1185/C2', rating: 1900, hint: 'Sort.' }],
    sourceUrl: `${UPSTREAM.url}/blob/main/daily_problems/2026/10/1007/problems.md`,
    fetchedAt: '2026-10-07T12:00:00.000Z', parserVersion: PARSER_VERSION, ...overrides,
  };
}

describe('remote problem-day reads', () => {
  it.each([date, undefined, '0001-01-01', '2128-02-29', '9999-12-31'])(
    'requests current remote data on every read for %s', async requestedDate => {
      const fetchDay = vi.fn(async () => day('first', { date: requestedDate ?? date }));
      expect((await readProblemDay(fetchDay, requestedDate)).problems[0].label).toBe('first');
      fetchDay.mockResolvedValue(day('changed', { date: requestedDate ?? date }));
      expect((await readProblemDay(fetchDay, requestedDate)).problems[0].label).toBe('changed');
      expect(fetchDay).toHaveBeenCalledTimes(2);
      expect(fetchDay).toHaveBeenNthCalledWith(1, requestedDate, false);
      expect(fetchDay).toHaveBeenNthCalledWith(2, requestedDate, false);
    },
  );

  it.each([false, true])('propagates every failure after an earlier success, refresh=%s', async refresh => {
    const fetchDay = vi.fn(async () => day());
    await readProblemDay(fetchDay, date);
    for (const error of [new Error('offline'), Object.assign(new Error('expired'), { status: 401 }), Object.assign(new Error('missing'), { status: 404 })]) {
      fetchDay.mockRejectedValueOnce(error);
      await expect(readProblemDay(fetchDay, date, refresh)).rejects.toBe(error);
      expect(fetchDay).toHaveBeenLastCalledWith(date, refresh);
    }
  });

  it('does not let a late response become a source for any later read', async () => {
    let finishOld!: (value: ProblemDay) => void;
    const oldResponse = new Promise<ProblemDay>(resolve => { finishOld = resolve; });
    const fetchDay = vi.fn<(_: string | undefined, refresh: boolean) => Promise<ProblemDay>>()
      .mockReturnValueOnce(oldResponse).mockResolvedValueOnce(day('newer')).mockResolvedValueOnce(day('latest'));
    const oldRequest = readProblemDay(fetchDay, date);
    expect(await readProblemDay(fetchDay, date, true)).toEqual(day('newer'));
    finishOld(day('older'));
    expect(await oldRequest).toEqual(day('older'));
    expect(await readProblemDay(fetchDay, date)).toEqual(day('latest'));
    expect(fetchDay).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed calendar dates before making a remote request', async () => {
    const fetchDay = vi.fn(async () => day());
    for (const invalid of ['', '2026-2-07', '2026-02-30', '0000-01-01', '../2026-10-07', null as unknown as string]) {
      await expect(readProblemDay(fetchDay, invalid)).rejects.toThrow();
    }
    expect(fetchDay).not.toHaveBeenCalled();
  });

  it('rejects mismatched dates and incomplete remote data without reusing earlier results', async () => {
    const fetchDay = vi.fn(async () => day());
    await readProblemDay(fetchDay, date);
    for (const invalid of [
      day('wrong date', { date: '2026-10-06' }), day('invalid calendar', { date: '2026-02-30' }),
      day('invalid timestamp', { fetchedAt: 'yesterday' }), day('invalid shape', { problems: [{}] as ProblemDay['problems'] }),
    ]) {
      fetchDay.mockResolvedValueOnce(invalid);
      await expect(readProblemDay(fetchDay, date)).rejects.toThrow('远程题单数据不完整或日期不匹配');
    }
  });
});
