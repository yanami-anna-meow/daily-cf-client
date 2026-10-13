import { describe, expect, it, vi } from 'vitest';
import { RetainedReadController } from '../src/useRetainedRead';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const missing = () => Object.assign(new Error('This problem was removed.'), { code: 'library_content_missing' });

describe('retained reads', () => {
  it('shows initial detail immediately while always starting the fresh read', async () => {
    const controller = new RetainedReadController<string>();
    const fresh = deferred<string>();
    const load = vi.fn(() => fresh.promise);
    expect(controller.view('a', 0, 'card detail')).toMatchObject({ data: 'card detail', loading: true, retained: true });
    const run = controller.start({ key: 'a', initial: 'card detail', load });
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(controller.view('a')).toMatchObject({ data: 'card detail', loading: true, retained: true });
    fresh.resolve('updated detail');
    await run;
    expect(controller.view('a')).toMatchObject({ data: 'updated detail', loading: false, retained: false, error: '' });
  });

  it('uses a local preview during synchronization', async () => {
    const controller = new RetainedReadController<string>();
    const fresh = deferred<string>();
    const run = controller.start({ key: 'a', load: () => fresh.promise, preview: async () => 'local data' });
    await flush();
    expect(controller.view('a')).toMatchObject({ data: 'local data', loading: true, retained: true });
    fresh.resolve('remote data');
    await run;
    expect(controller.view('a')).toMatchObject({ data: 'remote data', retained: false });
  });

  it('retains useful data with a visible failure when the network fails', async () => {
    const controller = new RetainedReadController<string>();
    await controller.start({ key: 'a', load: async () => 'previous' });
    await controller.start({ key: 'a', reload: 1, load: async () => { throw new Error('Offline'); } });
    expect(controller.view('a', 1)).toMatchObject({ data: 'previous', loading: false, retained: true, missing: false, error: 'Offline' });
  });

  it('allows a slow local preview after a network failure without hiding the failure', async () => {
    const controller = new RetainedReadController<string>();
    const preview = deferred<string | null>();
    await controller.start({ key: 'a', load: async () => { throw new Error('Offline'); }, preview: () => preview.promise });
    expect(controller.view('a')).toMatchObject({ data: undefined, retained: false, error: 'Offline' });
    preview.resolve('local data');
    await flush();
    expect(controller.view('a')).toMatchObject({ data: 'local data', loading: false, retained: true, error: 'Offline' });
  });

  it('does not let a late preview replace successful remote content', async () => {
    const controller = new RetainedReadController<string>();
    const preview = deferred<string | null>();
    await controller.start({ key: 'a', load: async () => 'fresh', preview: () => preview.promise });
    preview.resolve('older local data');
    await flush();
    expect(controller.view('a')).toMatchObject({ data: 'fresh', retained: false, loading: false, error: '' });
  });

  it('removes deleted content and blocks a slower preview from resurrecting it', async () => {
    const controller = new RetainedReadController<string>();
    await controller.start({ key: 'a', load: async () => 'old' });
    const preview = deferred<string | null>();
    await controller.start({ key: 'a', reload: 1, load: async () => { throw missing(); }, preview: () => preview.promise });
    preview.resolve('deleted content');
    await flush();
    expect(controller.view('a', 1, 'old card')).toMatchObject({ data: undefined, retained: false, loading: false, missing: true });
    expect(controller.view('a', 2, 'old card').data).toBeUndefined();
    await controller.start({ key: null, load: async () => 'unused' });
    expect(controller.view('a').data).toBeUndefined();
  });

  it('also clears content that was displayed by a fast preview before deletion was discovered', async () => {
    const controller = new RetainedReadController<string>();
    const fresh = deferred<string>();
    const run = controller.start({ key: 'a', load: () => fresh.promise, preview: async () => 'old' });
    await flush();
    expect(controller.view('a').data).toBe('old');
    fresh.reject(missing());
    await run;
    expect(controller.view('a')).toMatchObject({ data: undefined, loading: false, missing: true });
  });

  it('keeps known deletions across navigation and rejects both an old card and a local preview', async () => {
    const controller = new RetainedReadController<string>();
    await controller.start({ key: 'a', load: async () => { throw missing(); } });
    await controller.start({ key: null, load: async () => 'unused' });
    await controller.start({ key: 'b', load: async () => 'B' });
    expect(controller.view('a', 0, 'old card')).toMatchObject({ data: undefined, missing: true });
    const preview = vi.fn(async () => 'old local data');
    const fresh = deferred<string>();
    const run = controller.start({ key: 'a', initial: 'old card', load: () => fresh.promise, preview });
    await flush();
    expect(controller.view('a')).toMatchObject({ data: undefined, loading: true, missing: true });
    expect(preview).not.toHaveBeenCalled();
    fresh.reject(new Error('Offline'));
    await run;
    expect(controller.view('a')).toMatchObject({ data: undefined, missing: true, error: 'Offline' });
  });

  it('restores a previously deleted key only after a successful fresh read', async () => {
    const controller = new RetainedReadController<string>();
    await controller.start({ key: 'a', load: async () => { throw missing(); } });
    await controller.start({ key: 'b', load: async () => 'B' });
    await controller.start({ key: 'a', initial: 'old card', load: async () => 'restored file' });
    expect(controller.view('a')).toMatchObject({ data: 'restored file', missing: false, retained: false });
    await controller.start({ key: null, load: async () => 'unused' });
    expect(controller.view('a')).toMatchObject({ data: 'restored file', missing: false, retained: true });
  });

  it('does not replace already visible session content with a potentially older local preview', async () => {
    const controller = new RetainedReadController<string>();
    await controller.start({ key: 'a', load: async () => 'session version' });
    await controller.start({ key: 'b', load: async () => 'B' });
    const preview = vi.fn(async () => 'older local version');
    const fresh = deferred<string>();
    const run = controller.start({ key: 'a', load: () => fresh.promise, preview });
    await flush();
    expect(preview).not.toHaveBeenCalled();
    expect(controller.view('a')).toMatchObject({ data: 'session version', retained: true });
    fresh.resolve('new version');
    await run;
    expect(controller.view('a').data).toBe('new version');
  });

  it('does not conflate an empty source file with missing content', async () => {
    const controller = new RetainedReadController<string>();
    await controller.start({ key: 'code', load: async () => '' });
    expect(controller.view('code')).toMatchObject({ data: '', missing: false, retained: false });
    await controller.start({ key: null, load: async () => 'unused' });
    expect(controller.view('code')).toMatchObject({ data: '', retained: true });
  });

  it('keeps nullable results when a different initial value is offered', async () => {
    const controller = new RetainedReadController<string | null>();
    await controller.start({ key: 'a', load: async () => null });
    await controller.start({ key: null, load: async () => 'unused' });
    expect(controller.view('a', 0, 'old card').data).toBeNull();
  });

  it('never exposes another key, even before its layout effect starts', async () => {
    const controller = new RetainedReadController<string>();
    await controller.start({ key: 'a', load: async () => 'A source' });
    expect(controller.view('b')).toMatchObject({ data: undefined, loading: true, retained: false, missing: false });
    expect(controller.view('b', 0, 'B detail').data).toBe('B detail');
    expect(controller.view(null)).toMatchObject({ data: undefined, loading: false, missing: false });
  });

  it('ignores old-key fresh and preview responses after navigating', async () => {
    const controller = new RetainedReadController<string>();
    const oldLoad = deferred<string>();
    const oldPreview = deferred<string | null>();
    const oldRun = controller.start({ key: 'a', load: () => oldLoad.promise, preview: () => oldPreview.promise });
    await controller.start({ key: 'b', load: async () => 'B source' });
    oldPreview.resolve('A local');
    oldLoad.resolve('A fresh');
    await oldRun;
    await flush();
    expect(controller.view('b').data).toBe('B source');
    expect(controller.view('a').data).toBeUndefined();
  });

  it('ignores an old reload error after a newer reload succeeds', async () => {
    const controller = new RetainedReadController<string>();
    const old = deferred<string>();
    const oldRun = controller.start({ key: 'a', reload: 1, load: () => old.promise });
    await controller.start({ key: 'a', reload: 2, load: async () => 'newest' });
    old.reject(missing());
    await oldRun;
    expect(controller.view('a', 2)).toMatchObject({ data: 'newest', error: '', missing: false });
  });

  it('isolates repeated A to B to A navigation from the original A response', async () => {
    const controller = new RetainedReadController<string>();
    const old = deferred<string>();
    const oldRun = controller.start({ key: 'a', load: () => old.promise });
    await controller.start({ key: 'b', load: async () => 'B' });
    await controller.start({ key: 'a', load: async () => 'A new' });
    old.resolve('A original');
    await oldRun;
    expect(controller.view('a').data).toBe('A new');
  });

  it('returns retained values on re-entry but still performs another authoritative read', async () => {
    const controller = new RetainedReadController<string>();
    await controller.start({ key: 'a', load: async () => 'A' });
    await controller.start({ key: 'b', load: async () => 'B' });
    expect(controller.view('a')).toMatchObject({ data: 'A', loading: true, retained: true });
    const load = vi.fn(async () => 'A updated');
    await controller.start({ key: 'a', load });
    expect(load).toHaveBeenCalledTimes(1);
    expect(controller.view('a')).toMatchObject({ data: 'A updated', retained: false });
  });

  it('bounds the working set and treats re-entry as recent usage', async () => {
    const controller = new RetainedReadController<string>(2);
    await controller.start({ key: 'a', load: async () => 'A' });
    await controller.start({ key: 'b', load: async () => 'B' });
    await controller.start({ key: 'a', load: async () => { throw new Error('Offline'); } });
    await controller.start({ key: 'c', load: async () => 'C' });
    expect(controller.view('a').data).toBe('A');
    expect(controller.view('b').data).toBeUndefined();
  });

  it('ignores local preview failures and keeps the fresh result', async () => {
    const controller = new RetainedReadController<string>();
    await controller.start({ key: 'a', load: async () => 'fresh', preview: async () => { throw new Error('Bad local object'); } });
    await flush();
    expect(controller.view('a')).toMatchObject({ data: 'fresh', error: '', retained: false });
  });

  it('handles synchronous load failures as visible transport failures', async () => {
    const controller = new RetainedReadController<string>();
    await controller.start({ key: 'a', initial: 'card', load: () => { throw new Error('Disconnected IPC'); } });
    expect(controller.view('a')).toMatchObject({ data: 'card', error: 'Disconnected IPC', loading: false, retained: true });
  });

  it('never invokes readers for null keys and discards a response after cancellation', async () => {
    const controller = new RetainedReadController<string>();
    const load = vi.fn(async () => 'unused');
    const preview = vi.fn(async () => 'unused');
    await controller.start({ key: null, load, preview });
    expect(load).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    const pending = deferred<string>();
    const run = controller.start({ key: 'a', load: () => pending.promise });
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.cancel();
    pending.resolve('late');
    await run;
    expect(listener).not.toHaveBeenCalled();
  });

  it('a restarted effect still loads and its predecessor cannot update state', async () => {
    const controller = new RetainedReadController<string>();
    const cancelled = deferred<string>();
    const first = controller.start({ key: 'a', initial: 'card', load: () => cancelled.promise });
    controller.cancel();
    await controller.start({ key: 'a', initial: 'card', load: async () => 'live' });
    cancelled.resolve('cancelled');
    await first;
    expect(controller.view('a')).toMatchObject({ data: 'live', loading: false, retained: false });
  });
});
