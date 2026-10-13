import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryWorkerInput } from '../electron/library-worker-protocol';
import type { LibrarySyncProgress } from '../shared/types';

type TestPort = EventEmitter & { postMessage: ReturnType<typeof vi.fn> };
const fixture = vi.hoisted(() => ({
  mainThread: false,
  port: null as TestPort | null,
  data: undefined as unknown,
  repository: { marker: 'mock public repository' },
  library: {} as Record<string, ReturnType<typeof vi.fn>>,
  Repository: vi.fn(),
  Library: vi.fn(),
}));
vi.mock('node:worker_threads', () => ({
  get isMainThread() { return fixture.mainThread; },
  get parentPort() { return fixture.port; },
  get workerData() { return fixture.data; },
}));
vi.mock('../electron/git-repository', () => ({ GitRepository: fixture.Repository }));
vi.mock('../electron/git-library', () => ({ GitProblemLibrary: fixture.Library }));

const methods = ['syncLibrary', 'getLocalLibraryView', 'getDay', 'getArchiveMonths', 'getArchiveSnapshot', 'getMonthFromSnapshot', 'getMonth', 'getResources', 'getReference'] as const;
const directory = resolve('test-fixtures', 'public-library');
const turn = () => new Promise<void>(done => setImmediate(done));
const request = (id: number, method: typeof methods[number], args: unknown[] = [], locale: 'zh-CN' | 'en' = 'en'): LibraryWorkerInput => ({
  type: 'request', id, method, args, locale,
});
function emit(value: unknown) { fixture.port!.emit('message', value); }
async function start() { await import('../electron/library-worker'); }

describe('dedicated library worker entry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fixture.mainThread = false;
    fixture.data = { directory };
    fixture.port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
    fixture.library = Object.fromEntries(methods.map(method => [method, vi.fn().mockResolvedValue({ method })]));
    fixture.Repository.mockImplementation(function () { return fixture.repository; });
    fixture.Library.mockImplementation(function () { return fixture.library; });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    fixture.port?.removeAllListeners();
    vi.unstubAllGlobals();
  });

  it.each([undefined, null, {}, { directory: 7 }, { directory: '' }, { directory: 'relative/library' }, { directory: '../library' }])(
    'rejects missing, malformed or relative storage directories before creating repository objects: %j', async data => {
      fixture.data = data;
      await expect(start()).rejects.toThrow('dedicated worker');
      expect(fixture.Repository).not.toHaveBeenCalled();
      expect(fixture.Library).not.toHaveBeenCalled();
      expect(fixture.port!.listenerCount('message')).toBe(0);
    },
  );

  it.each(['main-thread', 'missing-port'])('requires an actual worker port: %s', async mode => {
    if (mode === 'main-thread') fixture.mainThread = true;
    else fixture.port = null;
    await expect(start()).rejects.toThrow('dedicated worker');
    expect(fixture.Repository).not.toHaveBeenCalled();
    expect(fixture.Library).not.toHaveBeenCalled();
  });

  it('initializes one public repository with only its directory and progress callback', async () => {
    await start();
    expect(fixture.data).toEqual({ directory });
    expect(fixture.Repository).toHaveBeenCalledExactlyOnceWith(directory, { onProgress: expect.any(Function) });
    expect(fixture.Library).toHaveBeenCalledExactlyOnceWith(fixture.repository);
    expect(fixture.port!.listenerCount('message')).toBe(1);
    expect(fixture.port!.postMessage).not.toHaveBeenCalled();
  });

  it('does not forward additional worker data to repository or library constructors', async () => {
    fixture.data = { directory, token: 'test-only-secret-field', settings: { forkRepository: 'someone/fork' } };
    await start();
    expect(fixture.Repository).toHaveBeenCalledExactlyOnceWith(directory, { onProgress: expect.any(Function) });
    expect(fixture.Library).toHaveBeenCalledExactlyOnceWith(fixture.repository);
  });

  it.each(methods)('dispatches the allowed %s method with its arguments, receiver and response id intact', async method => {
    const args = [{ revision: 'a'.repeat(40) }, '2128-01-03', true];
    const result = { nested: [1, { version: 'b'.repeat(40) }] };
    fixture.library[method].mockImplementation(function (this: unknown, ...received: unknown[]) {
      expect(this).toBe(fixture.library);
      expect(received).toEqual(args);
      return Promise.resolve(result);
    });
    await start();
    emit(request(23, method, args));
    await turn();
    expect(fixture.library[method]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(fixture.port!.postMessage.mock.calls).toEqual([[{ type: 'response', id: 23, result: { ok: true, data: result } }]]);
  });

  it('blocks arbitrary method names, malformed ids, malformed arguments and unknown message types', async () => {
    fixture.library.dangerous = vi.fn();
    await start();
    for (const method of ['constructor', 'toString', '__proto__', 'dangerous', 'setLocale', 'sync', 'submitBatch']) {
      emit({ ...request(1, 'getDay'), method });
    }
    for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined]) {
      emit({ ...request(1, 'getDay'), id });
    }
    for (const args of [null, undefined, {}, 'args']) emit({ ...request(1, 'getDay'), args });
    for (const locale of [undefined, null, 'fr', 'system', 'en-US']) emit({ ...request(1, 'getDay'), locale });
    for (const value of [null, false, 'request', {}, { ...request(1, 'getDay'), type: 'unexpected' }]) emit(value);
    await turn();
    for (const method of Object.values(fixture.library)) expect(method).not.toHaveBeenCalled();
    expect(fixture.port!.postMessage).not.toHaveBeenCalled();
  });

  it('dispatches a second request while the first waits and associates out-of-order responses with their ids', async () => {
    let finishFirst!: (value: unknown) => void;
    fixture.library.getDay.mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; }));
    fixture.library.getArchiveSnapshot.mockResolvedValueOnce({ branch: 'main', revision: 'b'.repeat(40), months: [] });
    await start();
    emit(request(1, 'getDay', ['2128-01-03']));
    emit(request(2, 'getArchiveSnapshot'));
    await turn();
    expect(fixture.library.getDay).toHaveBeenCalledExactlyOnceWith('2128-01-03');
    expect(fixture.library.getArchiveSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.port!.postMessage.mock.calls).toEqual([[{
      type: 'response', id: 2, result: { ok: true, data: { branch: 'main', revision: 'b'.repeat(40), months: [] } },
    }]]);
    finishFirst({ date: '2128-01-03', problems: [] });
    await turn();
    expect(fixture.port!.postMessage.mock.calls[1]).toEqual([{
      type: 'response', id: 1, result: { ok: true, data: { date: '2128-01-03', problems: [] } },
    }]);
  });

  it('dispatches local reads before a pending update completes and preserves the no-snapshot result', async () => {
    let finishUpdate!: (value: unknown) => void;
    fixture.library.syncLibrary.mockReturnValueOnce(new Promise(resolve => { finishUpdate = resolve; }));
    fixture.library.getLocalLibraryView.mockResolvedValueOnce(null);
    await start();
    emit(request(1, 'syncLibrary'));
    emit(request(2, 'getLocalLibraryView', [{ kind: 'day' }]));
    await turn();
    expect(fixture.library.getLocalLibraryView).toHaveBeenCalledExactlyOnceWith({ kind: 'day' });
    expect(fixture.port!.postMessage.mock.calls).toEqual([[{ type: 'response', id: 2, result: { ok: true, data: null } }]]);
    finishUpdate({ branch: 'main', revision: 'd'.repeat(40) });
    await turn();
    expect(fixture.port!.postMessage.mock.calls[1]).toEqual([{
      type: 'response', id: 1, result: { ok: true, data: { branch: 'main', revision: 'd'.repeat(40) } },
    }]);
  });

  it('whitelists progress fields and drops invalid progress before crossing the worker boundary', async () => {
    await start();
    const { onProgress } = fixture.Repository.mock.calls[0][1] as { onProgress(value: unknown): void };
    for (const value of [null, {}, { phase: 'secret', unit: 'bytes', completed: 0 }, { phase: 'checking', unit: 'files', completed: 0 },
      { phase: 'checking', unit: 'objects', completed: -1 }, { phase: 'checking', unit: 'objects', completed: Infinity }]) onProgress(value);
    expect(fixture.port!.postMessage).not.toHaveBeenCalled();
    const expected: LibrarySyncProgress = { phase: 'downloading', completed: 5, total: 10, unit: 'objects',
      message: 'Receiving objects', revision: 'c'.repeat(40), updatedAt: '2026-10-09T12:00:00.000Z' };
    onProgress({ ...expected, token: 'test-only-secret-field', internalDirectory: directory, raw: { headers: 'private' } });
    onProgress({ phase: 'ready', completed: 10, unit: 'objects', total: -1, revision: 'not-a-sha', updatedAt: 'invalid', message: 'x'.repeat(2500) });
    expect(fixture.port!.postMessage.mock.calls).toEqual([
      [{ type: 'progress', progress: expected }],
      [{ type: 'progress', progress: { phase: 'ready', completed: 10, unit: 'objects', message: 'x'.repeat(2000) } }],
    ]);
  });

  it('applies locale control updates immediately and uses each subsequent request locale', async () => {
    await start();
    const { getLocale } = await import('../shared/i18n');
    emit({ type: 'locale', locale: 'en' });
    expect(getLocale()).toBe('en');
    emit({ type: 'locale', locale: 'unsupported' });
    expect(getLocale()).toBe('en');
    expect(fixture.port!.postMessage).not.toHaveBeenCalled();
    fixture.library.getDay.mockImplementation(async () => getLocale());
    emit(request(3, 'getDay', [], 'zh-CN'));
    await turn();
    expect(getLocale()).toBe('zh-CN');
    emit({ type: 'locale', locale: 'en' });
    expect(getLocale()).toBe('en');
    emit(request(4, 'getDay', [], 'en'));
    await turn();
    expect(fixture.port!.postMessage.mock.calls).toEqual([
      [{ type: 'response', id: 3, result: { ok: true, data: 'zh-CN' } }],
      [{ type: 'response', id: 4, result: { ok: true, data: 'en' } }],
    ]);
  });

  it('serializes only public error fields and keeps dispatching after a method rejects', async () => {
    const rateLimit = { retryAt: 1_900_000_000_000, resource: 'core', kind: 'primary', authenticated: false };
    fixture.library.getDay.mockRejectedValueOnce(Object.assign(new Error('Read failed'), {
      code: 'private_reader_error', token: 'test-only-secret-field', response: { private: true },
    })).mockRejectedValueOnce(Object.assign(new Error('Preview again'), { code: 'submission_base_changed', detail: 'private' }))
      .mockRejectedValueOnce(Object.assign(new Error('Wait for reset'), {
        code: 'github_rate_limited', rateLimit: { ...rateLimit, token: 'test-only-secret-field' }, privateResponse: 'omit',
      })).mockResolvedValueOnce({ date: '2128-01-03' });
    await start();
    for (const id of [1, 2, 3, 4]) { emit(request(id, 'getDay')); await turn(); }
    expect(fixture.port!.postMessage.mock.calls).toEqual([
      [{ type: 'response', id: 1, result: { ok: false, error: 'Read failed' } }],
      [{ type: 'response', id: 2, result: { ok: false, error: 'Preview again', code: 'submission_base_changed' } }],
      [{ type: 'response', id: 3, result: { ok: false, error: 'Wait for reset', code: 'github_rate_limited', rateLimit } }],
      [{ type: 'response', id: 4, result: { ok: true, data: { date: '2128-01-03' } } }],
    ]);
  });

  it('serializes an authoritative missing-content code without disclosing the repository or source error', async () => {
    fixture.library.getResources.mockRejectedValueOnce(Object.assign(new Error('The problem was removed'), {
      code: 'library_content_missing', directory, token: 'test-only-secret-field', response: { private: true },
    }));
    await start();
    emit(request(8, 'getResources', ['2128-01-03', 'cf1a']));
    await turn();
    expect(fixture.port!.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'response', id: 8,
      result: { ok: false, error: 'The problem was removed', code: 'library_content_missing' } });
  });

  it('turns a synchronous non-Error failure into a localized public error without exposing its properties', async () => {
    fixture.library.getDay.mockImplementation(() => { throw { message: 'private payload', token: 'test-only-secret-field' }; });
    await start();
    emit(request(41, 'getDay', [], 'en'));
    await turn();
    expect(fixture.port!.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'response', id: 41, result: { ok: false, error: 'The operation failed. Please try again.' },
    });
  });
});
