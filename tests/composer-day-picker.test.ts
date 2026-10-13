import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientAPI, ProblemDay } from '../shared/types';
import { setLocale, t } from '../shared/i18n';
import { COMPOSER_DATE_DEBOUNCE_MS, ComposerDayPickerController, isCompleteComposerDate } from '../src/useComposerDayPicker';

vi.mock('../src/bridge', () => ({ api: {} }));

function day(date: string, count = 2): ProblemDay {
  return { date, problems: Array.from({ length: count }, (_, index) => ({ id: `cf${1000 + index}a`, label: `Problem ${index}`, url: `https://codeforces.com/problemset/problem/${1000 + index}/A`, rating: 1200, hint: '' })), sourceUrl: 'https://github.com/example/problems', fetchedAt: date };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(initialDate?: string) {
  const client = { getDay: vi.fn<ClientAPI['getDay']>().mockImplementation(async date => day(date ?? '2026-10-08')) };
  return { client, picker: new ComposerDayPickerController(client, initialDate) };
}
const tick = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
const settleInput = () => vi.advanceTimersByTimeAsync(COMPOSER_DATE_DEBOUNCE_MS);

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); setLocale('zh-CN'); });

describe('composer date selection and fresh reads', () => {
  it('does not read while the fork gate is hidden, then reads the selected date freshly', async () => {
    const { picker, client } = setup('2026-10-06');
    await settleInput();
    expect(client.getDay).not.toHaveBeenCalled();
    picker.resume();
    await tick();
    expect(client.getDay.mock.calls).toEqual([['2026-10-06', true]]);
    expect(picker.getSnapshot()).toEqual({ date: '2026-10-06', day: day('2026-10-06'), status: 'ready', error: '' });
  });

  it('starts an empty composer with the repository latest date and does not load it twice', async () => {
    const { picker, client } = setup();
    client.getDay.mockResolvedValueOnce(day('2035-04-09'));
    picker.resume();
    expect(picker.getSnapshot()).toMatchObject({ date: '', day: null, status: 'loading' });
    await tick();
    expect(picker.getSnapshot()).toMatchObject({ date: '2035-04-09', day: day('2035-04-09'), status: 'ready' });
    picker.select('2035-04-09');
    await settleInput();
    expect(client.getDay.mock.calls).toEqual([[undefined, true]]);
  });

  it('clears old candidates synchronously when the date changes and loads without a second click', async () => {
    const { picker, client } = setup('2026-10-08');
    picker.resume();
    await tick();
    picker.select('2026-10-06');
    expect(picker.getSnapshot()).toEqual({ date: '2026-10-06', day: null, status: 'waiting', error: '' });
    expect(client.getDay).toHaveBeenCalledTimes(1);
    await settleInput();
    expect(client.getDay.mock.calls).toEqual([['2026-10-08', true], ['2026-10-06', true]]);
    expect(picker.getSnapshot().day?.date).toBe('2026-10-06');
  });

  it('debounces valid intermediate years and requests only the final value', async () => {
    const { picker, client } = setup('2026-10-08');
    picker.resume();
    await tick();
    client.getDay.mockClear();
    for (const date of ['0002-10-06', '0020-10-06', '0202-10-06', '2026-10-06']) {
      picker.select(date);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(client.getDay).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COMPOSER_DATE_DEBOUNCE_MS - 100);
    expect(client.getDay.mock.calls).toEqual([['2026-10-06', true]]);
  });

  it('deduplicates input/change events for the same value without resetting the debounce', async () => {
    const { picker, client } = setup('2026-10-08');
    picker.resume();
    await tick();
    picker.select('2026-10-06');
    await vi.advanceTimersByTimeAsync(100);
    picker.select('2026-10-06');
    await vi.advanceTimersByTimeAsync(COMPOSER_DATE_DEBOUNCE_MS - 100);
    expect(client.getDay.mock.calls).toEqual([['2026-10-08', true], ['2026-10-06', true]]);
    picker.select('2026-10-06');
    expect(picker.getSnapshot().status).toBe('ready');
  });

  it('reads again when returning to a previously viewed date', async () => {
    const { picker, client } = setup('2026-10-08');
    picker.resume();
    await tick();
    picker.select('2026-10-06');
    await settleInput();
    client.getDay.mockResolvedValueOnce(day('2026-10-08', 7));
    picker.select('2026-10-08');
    await settleInput();
    expect(client.getDay.mock.calls).toEqual([['2026-10-08', true], ['2026-10-06', true], ['2026-10-08', true]]);
    expect(picker.getSnapshot().day?.problems).toHaveLength(7);
  });

  it.each([0, 1, 3, 4, 7, 17])('retains all %i returned candidates, including the empty state', async count => {
    const { picker, client } = setup('2030-02-01');
    const response = day('2030-02-01', count);
    client.getDay.mockResolvedValueOnce(response);
    picker.resume();
    await tick();
    expect(picker.getSnapshot()).toEqual({ date: response.date, day: response, status: 'ready', error: '' });
  });
});

describe('complete Gregorian dates without a current-date cutoff', () => {
  it.each(['0001-01-01', '0099-12-31', '1600-02-29', '2000-02-29', '2032-02-29', '9999-12-31'])('loads valid %s', async date => {
    const { picker, client } = setup(date);
    expect(isCompleteComposerDate(date)).toBe(true);
    picker.resume();
    await tick();
    expect(client.getDay.mock.calls).toEqual([[date, true]]);
    expect(picker.getSnapshot().status).toBe('ready');
  });

  it.each(['', '2026-', '2026-10', '2026-10-0', '0000-01-01', '10000-01-01', '1900-02-29', '2026-02-30', '2026-13-01', '2026-10-00'])('does not request incomplete/invalid %j, or treat it as latest', async date => {
    const { picker, client } = setup('2026-10-08');
    picker.resume();
    await tick();
    client.getDay.mockClear();
    picker.select(date);
    await settleInput();
    picker.refresh();
    expect(isCompleteComposerDate(date)).toBe(false);
    expect(picker.getSnapshot()).toEqual({ date, day: null, status: 'idle', error: '' });
    expect(client.getDay).not.toHaveBeenCalled();
  });
});

describe('stale requests, retries and lifetime', () => {
  it.each(['resolve', 'reject'] as const)('ignores late initial latest %s after a date was selected', async outcome => {
    const { picker, client } = setup();
    const latest = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(latest.promise);
    picker.resume();
    picker.select('2026-10-06');
    if (outcome === 'resolve') latest.resolve(day('2026-10-08'));
    else latest.reject(new Error('Old latest failure'));
    await tick();
    expect(picker.getSnapshot()).toEqual({ date: '2026-10-06', day: null, status: 'waiting', error: '' });
    await settleInput();
    expect(picker.getSnapshot().day?.date).toBe('2026-10-06');
  });

  it.each(['resolve', 'reject'] as const)('ignores a superseded %s after the new selection completes', async outcome => {
    const { picker, client } = setup('2026-10-08');
    const old = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(old.promise);
    picker.resume();
    picker.select('2026-10-06');
    await settleInput();
    const current = picker.getSnapshot();
    if (outcome === 'resolve') old.resolve(day('2026-10-08'));
    else old.reject(new Error('Old date failure'));
    await tick();
    expect(picker.getSnapshot()).toBe(current);
  });

  it('clearing the date cancels pending debounce and invalidates an in-flight read', async () => {
    const { picker, client } = setup('2026-10-08');
    const old = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(old.promise);
    picker.resume();
    picker.select('2026-10-06');
    picker.select('');
    await settleInput();
    old.resolve(day('2026-10-08'));
    await tick();
    expect(client.getDay).toHaveBeenCalledTimes(1);
    expect(picker.getSnapshot()).toEqual({ date: '', day: null, status: 'idle', error: '' });
  });

  it('retries a failed selection and refreshes a successful one with no stale fallback', async () => {
    const { picker, client } = setup('2026-10-06');
    client.getDay.mockRejectedValueOnce(new Error('Network unavailable'));
    picker.resume();
    await tick();
    expect(picker.getSnapshot()).toEqual({ date: '2026-10-06', day: null, status: 'error', error: 'Network unavailable' });
    picker.refresh();
    expect(picker.getSnapshot()).toMatchObject({ day: null, status: 'loading', error: '' });
    picker.refresh();
    await tick();
    expect(client.getDay).toHaveBeenCalledTimes(2);
    client.getDay.mockRejectedValueOnce(new Error('Refresh failed'));
    picker.refresh();
    expect(picker.getSnapshot().day).toBeNull();
    await tick();
    expect(picker.getSnapshot()).toMatchObject({ day: null, status: 'error', error: 'Refresh failed' });
    expect(client.getDay.mock.calls).toEqual(Array.from({ length: 3 }, () => ['2026-10-06', true]));
  });

  it('retries a failed initial latest request without substituting an empty date', async () => {
    const { picker, client } = setup();
    client.getDay.mockRejectedValueOnce(new Error('Latest unavailable'));
    picker.resume();
    await tick();
    picker.refresh();
    await tick();
    expect(client.getDay.mock.calls).toEqual([[undefined, true], [undefined, true]]);
    expect(picker.getSnapshot().date).toBe('2026-10-08');
  });

  it.each([
    ['2026-10-08', '返回的题目日期与所选日期不一致，请重试。', 'The returned problem date does not match your selection. Please retry.'],
    ['invalid', '读取到的题目日期无效，请重试。', 'The returned problem date is invalid. Please retry.'],
  ])('rejects response date %s and translates its retained error on render', async (returnedDate, chinese, english) => {
    setLocale('en');
    const { picker, client } = setup('2026-10-06');
    client.getDay.mockResolvedValueOnce(day(returnedDate));
    picker.resume();
    await tick();
    expect(picker.getSnapshot()).toMatchObject({ date: '2026-10-06', day: null, status: 'error' });
    const error = picker.getSnapshot().error;
    expect(error).toBe(chinese);
    // BatchComposer renders t(dayError), so an existing notice follows locale changes.
    expect(t(error)).toBe(english);
    setLocale('zh-CN');
    expect(t(error)).toBe(chinese);
  });

  it('cancels timers and in-flight publication on close or when opening the fork gate', async () => {
    const { picker, client } = setup('2026-10-08');
    const old = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(old.promise);
    picker.resume();
    picker.select('2026-10-06');
    picker.suspend();
    await settleInput();
    old.resolve(day('2026-10-08'));
    await tick();
    expect(client.getDay).toHaveBeenCalledTimes(1);
    expect(picker.getSnapshot()).toEqual({ date: '2026-10-06', day: null, status: 'idle', error: '' });
    picker.resume();
    await tick();
    expect(client.getDay.mock.calls).toEqual([['2026-10-08', true], ['2026-10-06', true]]);
  });

  it('survives StrictMode setup/cleanup/setup and ignores the abandoned first read', async () => {
    const { picker, client } = setup('2026-10-06');
    const old = deferred<ProblemDay>(), fresh = deferred<ProblemDay>();
    client.getDay.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    picker.resume();
    picker.suspend();
    picker.resume();
    old.reject(new Error('Old effect failure'));
    await tick();
    expect(picker.getSnapshot()).toMatchObject({ status: 'loading', error: '', day: null });
    fresh.resolve(day('2026-10-06', 4));
    await tick();
    expect(picker.getSnapshot().day?.problems).toHaveLength(4);
  });

  it('starts a reopened composer independently and unsubscribes observers', async () => {
    const { picker, client } = setup('2026-10-06');
    const listener = vi.fn();
    const unsubscribe = picker.subscribe(listener);
    picker.resume();
    await tick();
    unsubscribe();
    listener.mockClear();
    picker.suspend();
    expect(listener).not.toHaveBeenCalled();
    const reopened = new ComposerDayPickerController(client, '2026-10-06');
    reopened.resume();
    await tick();
    expect(client.getDay).toHaveBeenCalledTimes(2);
    expect(reopened.getSnapshot().status).toBe('ready');
  });
});
