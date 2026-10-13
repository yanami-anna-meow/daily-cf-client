import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryWorkerHost } from '../electron/library-worker-host';
import { publicLibraryProgress, type LibraryWorkerRequest } from '../electron/library-worker-protocol';
import { setLocale } from '../shared/i18n';

class FakeWorker extends EventEmitter {
  postMessage = vi.fn<(value: unknown) => void>();
  terminate = vi.fn(async () => 0);
  respond(index: number, result: unknown) {
    const message = this.postMessage.mock.calls[index][0] as LibraryWorkerRequest;
    this.emit('message', { type: 'response', id: message.id, result });
  }
}
const hosts: LibraryWorkerHost[] = [];
function setup(timeoutMs?: number) {
  const workers: FakeWorker[] = [];
  const createWorker = vi.fn(() => {
    const worker = new FakeWorker(); workers.push(worker);
    return worker as unknown as Worker;
  });
  const onProgress = vi.fn();
  const host = new LibraryWorkerHost('C:/isolated-public-library/library.git', { createWorker, timeoutMs, onProgress, workerFile: 'library-worker.cjs' });
  hosts.push(host);
  return { host, workers, createWorker, onProgress };
}
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); vi.useRealTimers(); setLocale('zh-CN'); });

describe('Git library worker host', () => {
  it('starts lazily with only the public storage directory and dispatches overlapping readers immediately', async () => {
    const { host, workers, createWorker } = setup();
    expect(createWorker).not.toHaveBeenCalled();
    const day = host.getDay('2128-03-02', true);
    const archive = host.getArchiveSnapshot();
    expect(createWorker).toHaveBeenCalledExactlyOnceWith('library-worker.cjs', { workerData: { directory: 'C:/isolated-public-library/library.git' } });
    expect(workers[0].postMessage.mock.calls.map(([request]) => request)).toEqual([
      { type: 'request', id: 1, method: 'getDay', args: ['2128-03-02', true], locale: 'zh-CN' },
      { type: 'request', id: 2, method: 'getArchiveSnapshot', args: [], locale: 'zh-CN' },
    ]);
    const snapshot = { branch: 'main', revision: 'a'.repeat(40), months: [] };
    workers[0].respond(1, { ok: true, data: snapshot });
    workers[0].respond(0, { ok: true, data: { date: '2128-03-02', problems: [] } });
    await expect(archive).resolves.toEqual(snapshot);
    await expect(day).resolves.toMatchObject({ date: '2128-03-02' });
  });

  it('forwards locale changes without replacing a running repository or its pending readers', async () => {
    const { host, workers, createWorker } = setup();
    const first = host.syncLibrary();
    host.setLocale('en');
    const second = host.getReference('daily_problems/2128/03/0302/personal_submission/cf1a_alice.py');
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(workers[0].postMessage.mock.calls[1]).toEqual([{ type: 'locale', locale: 'en' }]);
    expect(workers[0].postMessage.mock.calls[2][0]).toMatchObject({ locale: 'en', method: 'getReference' });
    workers[0].respond(0, { ok: true, data: { branch: 'main', revision: 'b'.repeat(40) } });
    workers[0].respond(2, { ok: true, data: 'print(1)' });
    await expect(first).resolves.toHaveProperty('branch', 'main');
    await expect(second).resolves.toBe('print(1)');
  });

  it('returns a local view while synchronization is pending and keeps an absent local snapshot as null', async () => {
    const { host, workers, createWorker, onProgress } = setup();
    const synchronization = host.syncLibrary();
    const request = { kind: 'archive', scope: 'all' } as const;
    const retained = host.getLocalLibraryView(request);
    expect(workers[0].postMessage.mock.calls[1][0]).toMatchObject({ method: 'getLocalLibraryView', args: [request] });
    const revision = 'c'.repeat(40);
    const view = { kind: 'archive', revision, snapshot: { branch: 'main', revision, months: [] }, month: '', days: [], index: {} };
    workers[0].respond(1, { ok: true, data: view });
    await expect(retained).resolves.toEqual(view);
    const absent = host.getLocalLibraryView({ kind: 'day', date: '2128-03-02' });
    workers[0].respond(2, { ok: true, data: null });
    await expect(absent).resolves.toBeNull();
    expect(onProgress).not.toHaveBeenCalled();
    workers[0].respond(0, { ok: true, data: { branch: 'main', revision: 'd'.repeat(40) } });
    await synchronization;
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('preserves a confirmed deletion code and excludes private worker error fields', async () => {
    const { host, workers, onProgress } = setup();
    const removed = host.getResources('2128-03-02', 'cf1a');
    const result = removed.catch(error => error);
    workers[0].respond(0, { ok: false, error: 'The problem was removed', code: 'library_content_missing',
      token: 'never-exposed', response: { private: true } });
    const error = await result;
    expect(error).toMatchObject({ message: 'The problem was removed', code: 'library_content_missing' });
    expect(error).not.toHaveProperty('token');
    expect(error).not.toHaveProperty('response');
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('keeps read errors request-scoped and preserves only known public error details', async () => {
    const { host, workers, createWorker } = setup();
    const missing = host.getDay('2128-03-02');
    const rejected = expect(missing).rejects.toMatchObject({ message: 'missing day' });
    workers[0].respond(0, { ok: false, error: 'missing day', token: 'never-exposed', stack: 'private' });
    await rejected;
    const next = host.syncLibrary();
    workers[0].respond(1, { ok: true, data: { branch: 'main', revision: 'a'.repeat(40) } });
    await next;
    expect(createWorker).toHaveBeenCalledTimes(1);
    const error = await missing.catch(error => error);
    expect(error).not.toHaveProperty('token');
  });

  it('rejects every in-flight read on a crash and ignores old worker messages after recovery', async () => {
    const { host, workers, onProgress } = setup();
    const a = host.syncLibrary(); const b = host.getArchiveMonths();
    const failures = [expect(a).rejects.toThrow('题库读取中断'), expect(b).rejects.toThrow('题库读取中断')];
    workers[0].emit('error', new Error('native crash with private path'));
    await Promise.all(failures);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'error', completed: 0, unit: 'objects', message: '题库读取中断，请重试。' });
    const recovered = host.syncLibrary();
    workers[0].emit('message', { type: 'progress', progress: { phase: 'ready', unit: 'objects', completed: 0 } });
    workers[0].respond(0, { ok: true, data: { branch: 'stale', revision: 'a'.repeat(40) } });
    expect(onProgress).toHaveBeenCalledTimes(1);
    workers[1].respond(0, { ok: true, data: { branch: 'next', revision: 'b'.repeat(40) } });
    await expect(recovered).resolves.toHaveProperty('branch', 'next');
  });

  it('bounds a CPU-stalled worker independently, clears all request timers and allows retry', async () => {
    vi.useFakeTimers();
    const { host, workers, onProgress } = setup(500);
    const first = host.syncLibrary(); const second = host.getArchiveSnapshot();
    const failures = [expect(first).rejects.toThrow('题库更新超时'), expect(second).rejects.toThrow('题库更新超时')];
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(failures);
    expect(vi.getTimerCount()).toBe(0);
    expect(onProgress).toHaveBeenCalledOnce();
    const recovered = host.syncLibrary();
    workers[1].respond(0, { ok: true, data: { branch: 'main', revision: 'a'.repeat(40) } });
    await recovered;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a clean unexpected exit and handles start/post failures instead of leaving requests pending', async () => {
    const { host, workers, createWorker } = setup();
    createWorker.mockImplementationOnce(() => { throw new Error('cannot start'); });
    await expect(host.syncLibrary()).rejects.toThrow('题库读取中断');
    const active = host.getArchiveSnapshot();
    const failed = expect(active).rejects.toThrow('题库读取中断');
    workers[0].emit('exit', 0);
    await failed;
    createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker(); worker.postMessage.mockImplementation(() => { throw new Error('port closed'); });
      workers.push(worker); return worker as unknown as Worker;
    });
    await expect(host.syncLibrary()).rejects.toThrow('题库读取中断');
  });

  it('disposes without reporting a false refresh error and cannot start new work afterwards', async () => {
    const { host, workers, createWorker, onProgress } = setup();
    const pending = host.syncLibrary();
    const failure = expect(pending).rejects.toThrow();
    host.dispose();
    await failure;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(onProgress).not.toHaveBeenCalled();
    await expect(host.syncLibrary()).rejects.toThrow();
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it('relays only valid public progress and strips unexpected properties', async () => {
    const { host, workers, onProgress } = setup();
    const operation = host.syncLibrary();
    workers[0].emit('message', { type: 'progress', progress: { phase: 'ready', unit: 'objects', completed: 2, total: 2,
      revision: 'a'.repeat(40), updatedAt: '2026-10-09T00:00:00Z', token: 'not-a-public-field' } });
    workers[0].emit('message', { type: 'progress', progress: { phase: 'downloading', unit: 'bytes', completed: NaN } });
    workers[0].emit('message', { type: 'progress', progress: { phase: 'unknown', unit: 'objects', completed: 0 } });
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ phase: 'ready', unit: 'objects', completed: 2, total: 2,
      revision: 'a'.repeat(40), updatedAt: '2026-10-09T00:00:00Z' });
    workers[0].respond(0, { ok: true, data: { branch: 'main', revision: 'a'.repeat(40) } });
    await operation;
    expect(publicLibraryProgress(null)).toBeNull();
    expect(publicLibraryProgress({ phase: 'checking', unit: 'objects', completed: 0, total: -1, revision: 'invalid', updatedAt: 'bad-date' }))
      .toEqual({ phase: 'checking', unit: 'objects', completed: 0 });
    expect(publicLibraryProgress({ phase: 'repairing', unit: 'objects', completed: 0, localPath: 'private-path' }))
      .toEqual({ phase: 'repairing', unit: 'objects', completed: 0 });
  });
});
