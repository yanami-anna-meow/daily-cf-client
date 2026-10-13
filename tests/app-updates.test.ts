import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateService } from '../electron/app-updates';
import { LATEST_RELEASE_URL, MAX_RELEASE_BYTES } from '../electron/app-update-release';
import type { AppUpdateState, AppUpdateTarget } from '../shared/app-update';

const repository = 'https://github.com/yanami-anna-meow/daily-cf-client';
const filename = 'Daily-CF-0.3.25-windows-x86_64-nsis.exe';
const target: AppUpdateTarget = { platform: 'windows', arch: 'x86_64', packageKind: 'nsis', mode: 'installer', development: false };
const payload = Buffer.from('A fake installer. This fixture is never executable or opened.');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const manifest = `${hash(payload)}  ${filename}\n`;
function metadata() {
  return {
    tag_name: 'v0.3.25', draft: false, prerelease: false,
    html_url: `${repository}/releases/tag/v0.3.25`, published_at: '2026-10-14T08:00:00Z', body: 'Example release',
    assets: [
      { id: 12, name: filename, state: 'uploaded', size: payload.length, digest: `sha256:${hash(payload)}`,
        browser_download_url: `${repository}/releases/download/v0.3.25/${filename}` },
      { id: 13, name: 'SHA256SUMS.txt', state: 'uploaded', size: Buffer.byteLength(manifest), digest: `sha256:${hash(manifest)}`,
        browser_download_url: `${repository}/releases/download/v0.3.25/SHA256SUMS.txt` },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

let temporary: string;
let temporaryParent: string;
const services: AppUpdateService[] = [];
beforeEach(async () => {
  temporaryParent = await fs.promises.realpath(os.tmpdir());
  temporary = await fs.promises.mkdtemp(path.join(temporaryParent, 'daily-cf-update-test-'));
});
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers(); vi.restoreAllMocks();
  const relative = path.relative(temporaryParent, temporary);
  if (!relative.startsWith('daily-cf-update-test-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe test fixture cleanup.');
  await fs.promises.rm(temporary, { recursive: true, force: true });
});

function fixture(options: { directory?: string; target?: AppUpdateTarget; onChange?: (state: AppUpdateState) => void } = {}) {
  const data = metadata();
  const normal = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === LATEST_RELEASE_URL) return Response.json(data);
    if (url.includes('/SHA256SUMS.txt?')) return new Response(manifest);
    if (url.includes(`/${filename}?`)) return new Response(payload);
    throw new Error(`Unexpected network call: ${url}`);
  };
  const fetch = vi.fn<typeof globalThis.fetch>(normal);
  const directory = options.directory ?? path.join(temporary, 'updates');
  const service = new AppUpdateService({ currentVersion: '0.3.24', target: options.target ?? target, directory,
    fetch, onChange: options.onChange });
  services.push(service);
  return { service, data, fetch, normal, directory };
}
async function available(test: ReturnType<typeof fixture>) {
  expect((await test.service.check()).phase).toBe('available');
}
async function ready(test: ReturnType<typeof fixture>) {
  await available(test);
  expect((await test.service.download()).phase).toBe('ready');
  return test.service.verifiedDownload();
}

describe('app update checks and user consent', () => {
  it('checks exact public metadata without downloading, creating files, or using credentials', async () => {
    const test = fixture();
    const state = await test.service.check();
    expect(state).toMatchObject({ phase: 'available', currentVersion: '0.3.24', release: { version: '0.3.25', asset: { name: filename } } });
    expect(test.fetch).toHaveBeenCalledOnce();
    expect(test.fetch.mock.calls[0][0]).toBe(LATEST_RELEASE_URL);
    expect(test.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    expect(new Headers(test.fetch.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    await expect(fs.promises.stat(test.directory)).rejects.toHaveProperty('code', 'ENOENT');
    await expect(test.service.verifiedDownload()).rejects.toHaveProperty('code', 'not_ready');
  });

  it('returns defensive snapshots, including to observers', async () => {
    const suppliedTarget = { ...target };
    const test = fixture({ target: suppliedTarget, onChange: state => { state.target.arch = 'unknown'; if (state.release) state.release.version = 'changed'; } });
    suppliedTarget.arch = 'arm64';
    const returned = await test.service.check();
    returned.target.arch = 'unknown'; returned.release!.asset!.name = 'changed';
    expect(test.service.getState()).toMatchObject({ target: { arch: 'x86_64' }, release: { version: '0.3.25', asset: { name: filename } } });
  });

  it.each([['v0.3.24', false], ['v0.3.23', false], ['v0.4.0-rc.1', true]])('never downloads or downgrades for %s', async (tag, prerelease) => {
    const test = fixture(); Object.assign(test.data, { tag_name: tag, prerelease });
    expect((await test.service.check()).phase).toBe('current');
    expect(test.fetch).toHaveBeenCalledOnce();
  });

  it('reports no available release on 404 and limits 403/429 without retry loops', async () => {
    const test = fixture();
    test.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await test.service.check()).phase).toBe('current');
    for (const status of [403, 429]) {
      test.fetch.mockResolvedValueOnce(new Response(null, { status }));
      expect(await test.service.check()).toMatchObject({ phase: 'error', error: expect.stringContaining('GitHub') });
    }
    expect(test.fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps an available release after a failed recheck', async () => {
    const test = fixture(); await available(test);
    test.fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await test.service.check()).toMatchObject({ phase: 'error', release: { version: '0.3.25' } });
    expect((await test.service.download()).phase).toBe('ready');
  });

  it('coalesces concurrent checks', async () => {
    const test = fixture(); const pending = deferred<Response>();
    test.fetch.mockReturnValueOnce(pending.promise);
    const first = test.service.check(); const second = test.service.check();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(test.fetch).toHaveBeenCalledOnce());
    pending.resolve(Response.json(test.data)); await first;
    expect(test.service.getState().phase).toBe('available');
  });

  it('cancels a hung check immediately and ignores its late completion after retry', async () => {
    const test = fixture(); const old = deferred<Response>();
    test.fetch.mockReturnValueOnce(old.promise);
    const first = test.service.check();
    await vi.waitFor(() => expect(test.fetch).toHaveBeenCalledOnce());
    test.service.cancel();
    expect(test.service.getState()).toMatchObject({ phase: 'idle', error: undefined });
    await test.service.check();
    old.resolve(Response.json({ ...test.data, tag_name: 'v0.3.23' }));
    await first;
    expect(test.service.getState()).toMatchObject({ phase: 'available', release: { version: '0.3.25' }, error: undefined });
  });

  it('bounds a metadata request even when a transport ignores abort', async () => {
    const test = fixture(); test.fetch.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    const running = test.service.check();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await running).toMatchObject({ phase: 'error', error: expect.stringContaining('超时') });
    expect(test.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('cancels a response body if the transport completes only after its request timeout', async () => {
    const test = fixture(); const late = deferred<Response>();
    test.fetch.mockReturnValueOnce(late.promise);
    vi.useFakeTimers();
    const running = test.service.check();
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await running).phase).toBe('error');
    const cancelBody = vi.fn();
    late.resolve(new Response(new ReadableStream({ cancel: cancelBody })));
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it.each([
    () => new Response('broken JSON'),
    () => new Response(new Uint8Array([0xff, 0xfe])),
    () => new Response('x'.repeat(MAX_RELEASE_BYTES + 1)),
    () => new Response('{}', { headers: { 'Content-Length': String(MAX_RELEASE_BYTES + 1) } }),
  ])('rejects malformed and oversized metadata', async make => {
    const test = fixture(); test.fetch.mockResolvedValueOnce(make());
    expect((await test.service.check()).phase).toBe('error');
    expect(test.fetch).toHaveBeenCalledOnce();
  });

  it('detects a release but refuses a download for a development build', async () => {
    const test = fixture({ target: { ...target, development: true } });
    expect(await test.service.check()).toMatchObject({ phase: 'available', release: { version: '0.3.25' } });
    expect(test.service.getState().release?.asset).toBeUndefined();
    expect((await test.service.download()).phase).toBe('error');
    expect(test.fetch).toHaveBeenCalledOnce();
  });

  it('does nothing after disposal', async () => {
    const test = fixture(); test.service.dispose();
    expect((await test.service.check()).phase).toBe('idle');
    expect((await test.service.download()).phase).toBe('idle');
    expect(test.fetch).not.toHaveBeenCalled();
  });
});

describe('app update download boundaries', () => {
  it('downloads only on request, verifies manifest and file, then exposes a complete final file', async () => {
    const states: AppUpdateState[] = [];
    const test = fixture({ onChange: state => states.push(state) });
    const file = await ready(test);
    expect(test.fetch).toHaveBeenCalledTimes(3);
    expect(path.basename(file)).toBe(filename);
    expect(path.basename(path.dirname(file))).toMatch(/^download-/);
    expect(await fs.promises.readFile(file)).toEqual(payload);
    expect(await fs.promises.readdir(path.dirname(file))).toEqual([filename]);
    expect(states.some(state => state.phase === 'downloading' && state.progress?.downloaded === payload.length)).toBe(true);
    expect(states.filter(state => state.phase === 'ready')).toHaveLength(1);
    expect(states.every(state => !('file' in state))).toBe(true);
    expect(await test.service.download()).toMatchObject({ phase: 'ready' });
    expect(test.fetch).toHaveBeenCalledTimes(3);
  });

  it('does not let an observer throw disrupt a download', async () => {
    const test = fixture({ onChange: () => { throw new Error('observer bug'); } });
    await ready(test);
  });

  it('supports missing API digests when the authoritative checksum manifest verifies', async () => {
    const test = fixture();
    test.data.assets.forEach(asset => Object.assign(asset, { digest: null }));
    await ready(test);
  });

  it('refuses a missing checksum before requesting any download', async () => {
    const test = fixture(); test.data.assets.pop(); await available(test);
    expect((await test.service.download()).phase).toBe('error');
    expect(test.fetch).toHaveBeenCalledOnce();
  });

  it('compares the checksum file itself with its GitHub digest', async () => {
    const test = fixture(); test.data.assets[1].digest = 'sha256:' + '0'.repeat(64); await available(test);
    expect((await test.service.download()).phase).toBe('error');
    expect(test.fetch).toHaveBeenCalledTimes(2);
  });

  it('stops before installer download if API digest and manifest disagree', async () => {
    const test = fixture(); test.data.assets[0].digest = 'sha256:' + '0'.repeat(64); await available(test);
    expect((await test.service.download()).phase).toBe('error');
    expect(test.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wrong hash', () => new Response(Buffer.alloc(payload.length))],
    ['truncated file', () => new Response(payload.subarray(0, payload.length - 1))],
    ['oversized file', () => new Response(Buffer.concat([payload, Buffer.from('x')]))],
    ['wrong content length', () => new Response(payload, { headers: { 'Content-Length': String(payload.length + 1) } })],
    ['transformed payload', () => new Response(payload, { headers: { 'Content-Encoding': 'gzip' } })],
    ['partial HTTP status', () => new Response(payload, { status: 206 })],
    ['stream read failure', () => new Response(new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 4)); controller.error(new Error('connection lost')); } }))],
  ] as const)('rejects %s without exposing a ready file, then permits retry', async (_name, make) => {
    const test = fixture(); await available(test);
    test.fetch.mockImplementation(async input => String(input).includes(`/${filename}?`) ? make() : test.normal(input));
    expect((await test.service.download()).phase).toBe('error');
    await expect(test.service.verifiedDownload()).rejects.toHaveProperty('code', 'not_ready');
    expect(await fs.promises.readdir(test.directory)).toEqual([]);
    test.fetch.mockImplementation(test.normal);
    expect((await test.service.download()).phase).toBe('ready');
  });

  it('coalesces downloads and does not let a check interrupt them', async () => {
    const test = fixture(); await available(test); const pending = deferred<Response>();
    test.fetch.mockReturnValueOnce(pending.promise);
    const first = test.service.download();
    expect(test.service.download()).toBe(first);
    expect(test.service.check()).toBe(first);
    await vi.waitFor(() => expect(test.fetch).toHaveBeenCalledTimes(2));
    pending.resolve(new Response(manifest));
    expect((await first).phase).toBe('ready');
    expect(test.fetch).toHaveBeenCalledTimes(3);
  });

  it('times out an installer response whose body never arrives, cancels it, and removes its partial file', async () => {
    const test = fixture(); await available(test);
    const cancelBody = vi.fn();
    test.fetch.mockImplementation(async input => String(input).includes(`/${filename}?`)
      ? new Response(new ReadableStream({ cancel: cancelBody })) : test.normal(input));
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      realTimeout(callback, delay === 30_000 ? 20 : delay, ...args)) as typeof setTimeout);
    expect(await test.service.download()).toMatchObject({ phase: 'error', error: expect.stringContaining('超时') });
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(test.fetch).toHaveBeenCalledTimes(3);
    expect(await fs.promises.readdir(test.directory)).toEqual([]);
  });

  it('cancels a partly written file, preserves release info, and retries without stale progress', async () => {
    const test = fixture(); await available(test);
    const cancelledBody = vi.fn();
    test.fetch.mockImplementation(async input => String(input).includes(`/${filename}?`)
      ? new Response(new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 4)); }, cancel: cancelledBody }))
      : test.normal(input));
    const old = test.service.download();
    await vi.waitFor(() => expect(test.service.getState().progress?.downloaded).toBe(4));
    test.service.cancel();
    expect(test.service.getState()).toMatchObject({ phase: 'available', release: { version: '0.3.25' }, progress: undefined, error: undefined });
    test.fetch.mockImplementation(test.normal);
    const retry = test.service.download();
    await old; expect((await retry).phase).toBe('ready');
    expect(cancelledBody).toHaveBeenCalledOnce();
    expect(await fs.promises.readdir(test.directory)).toHaveLength(1);
    await test.service.verifiedDownload();
  });

  it('retains ready files across an unchanged check, but drops them if checksum metadata changes', async () => {
    const test = fixture(); const file = await ready(test);
    expect((await test.service.check()).phase).toBe('ready');
    expect(await test.service.verifiedDownload()).toBe(file);
    test.data.assets[1].id++;
    expect((await test.service.check()).phase).toBe('available');
    await expect(test.service.verifiedDownload()).rejects.toHaveProperty('code', 'not_ready');
    expect(await fs.promises.readFile(file)).toEqual(payload);
  });

  it('makes a verified AppImage executable only for its owner', async () => {
    const test = fixture({ target: { ...target, platform: 'linux', packageKind: 'appimage', mode: 'replace-file' } });
    const name = 'Daily-CF-0.3.25-linux-x86_64.AppImage';
    const sums = `${hash(payload)}  ${name}\n`;
    Object.assign(test.data.assets[0], { name, browser_download_url: `${repository}/releases/download/v0.3.25/${name}` });
    Object.assign(test.data.assets[1], { size: Buffer.byteLength(sums), digest: `sha256:${hash(sums)}` });
    test.fetch.mockImplementation(async input => {
      if (String(input) === LATEST_RELEASE_URL) return Response.json(test.data);
      return new Response(String(input).includes('/SHA256SUMS.txt?') ? sums : payload);
    });
    const file = await ready(test);
    expect(path.basename(file)).toBe(name);
    if (process.platform !== 'win32') expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o700);
  });
});

describe('app update HTTPS redirect boundary', () => {
  it('follows a bounded redirect to the documented GitHub release-asset host', async () => {
    const test = fixture(); await available(test);
    test.fetch.mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.hostname === 'github.com') return new Response(null, { status: 302, headers: { Location: `https://release-assets.githubusercontent.com/github-production-release-asset-2e65be/123/${path.basename(url.pathname)}?signature=fixture` } });
      return new Response(url.pathname.endsWith('SHA256SUMS.txt') ? manifest : payload);
    });
    expect((await test.service.download()).phase).toBe('ready');
    expect(test.fetch).toHaveBeenCalledTimes(5);
    for (const [, init] of test.fetch.mock.calls) expect(init?.credentials).toBe('omit');
  });

  it.each([
    'http://release-assets.githubusercontent.com/file', 'https://evil.example/file',
    'https://release-assets.githubusercontent.com.evil.example/file', 'https://127.0.0.1/file',
    'https://release-assets.githubusercontent.com:8443/file', 'https://user:secret@release-assets.githubusercontent.com/file',
    'https://release-assets.githubusercontent.com/file#fragment', 'https://raw.githubusercontent.com/file',
    `${repository}/releases/download/v0.3.25/other.exe`,
  ])('rejects an unsafe redirect to %s before following it', async location => {
    const test = fixture(); await available(test);
    test.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: location } }));
    expect((await test.service.download()).phase).toBe('error');
    expect(test.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects metadata redirects and redirect loops', async () => {
    const test = fixture(); test.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: LATEST_RELEASE_URL } }));
    expect((await test.service.check()).phase).toBe('error');
    expect(test.fetch).toHaveBeenCalledOnce();
    await available(test);
    test.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/loop' } }));
    expect((await test.service.download()).phase).toBe('error');
    expect(test.fetch).toHaveBeenCalledTimes(8);
  });

  it('rejects a transport that silently followed a redirect', async () => {
    const test = fixture(); await available(test);
    const response = new Response(manifest); Object.defineProperty(response, 'redirected', { value: true });
    test.fetch.mockResolvedValueOnce(response);
    expect((await test.service.download()).phase).toBe('error');
  });
});

describe('app update local file ownership and revalidation', () => {
  it('never overwrites a final filename created by another writer', async () => {
    const test = fixture(); await available(test);
    const link = fs.promises.link.bind(fs.promises);
    let destination: string | undefined;
    vi.spyOn(fs.promises, 'link').mockImplementationOnce(async (source, final) => {
      destination = String(final);
      await fs.promises.writeFile(final, 'another writer');
      return link(source, final);
    });
    expect((await test.service.download()).phase).toBe('error');
    expect(await fs.promises.readFile(destination!, 'utf8')).toBe('another writer');
    expect(await fs.promises.readdir(path.dirname(destination!))).toEqual([filename]);
  });

  it('rechecks bytes on disk after network verification and before marking a file ready', async () => {
    const test = fixture(); await available(test);
    const link = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementationOnce(async (source, final) => {
      await fs.promises.writeFile(source, Buffer.alloc(payload.length));
      return link(source, final);
    });
    expect((await test.service.download()).phase).toBe('error');
    await expect(test.service.verifiedDownload()).rejects.toHaveProperty('code', 'not_ready');
    expect(await fs.promises.readdir(test.directory)).toEqual([]);
  });

  it.each(['changed', 'truncated', 'missing', 'replaced', 'hardlink'] as const)('rejects a %s file immediately before opening it', async kind => {
    const test = fixture(); const file = await ready(test);
    if (kind === 'changed') await fs.promises.writeFile(file, Buffer.alloc(payload.length));
    if (kind === 'truncated') await fs.promises.truncate(file, 5);
    if (kind === 'missing') await fs.promises.unlink(file);
    if (kind === 'replaced') { await fs.promises.rename(file, file + '.old'); await fs.promises.writeFile(file, payload); }
    if (kind === 'hardlink') await fs.promises.link(file, path.join(temporary, 'linked-installer'));
    await expect(test.service.verifiedDownload()).rejects.toThrow();
    expect(test.service.getState().phase).toBe('error');
    expect((await test.service.download()).phase).toBe('ready');
  });

  it('rejects a download root junction before writing through it', async () => {
    const outside = path.join(temporary, 'outside'); await fs.promises.mkdir(outside);
    const root = path.join(temporary, 'updates'); await fs.promises.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    const test = fixture({ directory: root }); await available(test);
    expect((await test.service.download()).phase).toBe('error');
    expect(await fs.promises.readdir(outside)).toEqual([]);
  });

  it('rejects a junction in a parent directory', async () => {
    const outside = path.join(temporary, 'outside'); await fs.promises.mkdir(outside);
    const parent = path.join(temporary, 'parent'); await fs.promises.symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    const test = fixture({ directory: path.join(parent, 'updates') }); await available(test);
    expect((await test.service.download()).phase).toBe('error');
    expect(await fs.promises.readdir(outside)).toEqual([]);
  });

  it.each(['root', 'download'] as const)('rejects a replaced %s directory even with identical installer bytes', async which => {
    const test = fixture(); const file = await ready(test);
    const directory = which === 'root' ? test.directory : path.dirname(file);
    const backup = `${directory}-old`;
    await fs.promises.rename(directory, backup);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, payload);
    await expect(test.service.verifiedDownload()).rejects.toHaveProperty('code', 'unsafe_file');
    expect(await fs.promises.readFile(file)).toEqual(payload);
  });

  it('rejects a root junction swapped after download without deleting its target', async () => {
    const test = fixture(); const file = await ready(test);
    const original = `${test.directory}-original`; await fs.promises.rename(test.directory, original);
    const outside = path.join(temporary, 'outside'); await fs.promises.mkdir(path.join(outside, path.basename(path.dirname(file))), { recursive: true });
    const outsideFile = path.join(outside, path.basename(path.dirname(file)), filename);
    await fs.promises.writeFile(outsideFile, payload);
    await fs.promises.symlink(outside, test.directory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(test.service.verifiedDownload()).rejects.toHaveProperty('code', 'unsafe_file');
    expect((await test.service.download()).phase).toBe('error');
    expect(await fs.promises.readFile(outsideFile)).toEqual(payload);
  });

  it('does not recursively clean an unrelated file added during a cancelled download', async () => {
    const test = fixture(); await available(test);
    test.fetch.mockImplementation(async input => String(input).includes(`/${filename}?`)
      ? new Response(new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 4)); } })) : test.normal(input));
    const running = test.service.download();
    await vi.waitFor(() => expect(test.service.getState().progress?.downloaded).toBe(4));
    const [folder] = await fs.promises.readdir(test.directory);
    const unrelated = path.join(test.directory, folder, 'leave-me.txt'); await fs.promises.writeFile(unrelated, 'user data');
    test.service.cancel(); await running;
    expect(await fs.promises.readFile(unrelated, 'utf8')).toBe('user data');
    expect(await fs.promises.readdir(path.dirname(unrelated))).toEqual(['leave-me.txt']);
  });

  it('does not delete a partial filename that was replaced by another writer', async () => {
    const test = fixture(); await available(test);
    test.fetch.mockImplementation(async input => String(input).includes(`/${filename}?`)
      ? new Response(new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 4)); } })) : test.normal(input));
    const running = test.service.download();
    await vi.waitFor(() => expect(test.service.getState().progress?.downloaded).toBe(4));
    const [folder] = await fs.promises.readdir(test.directory);
    const partial = path.join(test.directory, folder, '.download.part');
    await fs.promises.rename(partial, `${partial}.old`);
    await fs.promises.writeFile(partial, 'another writer');
    test.service.cancel(); await running;
    expect(await fs.promises.readFile(partial, 'utf8')).toBe('another writer');
  });
});
