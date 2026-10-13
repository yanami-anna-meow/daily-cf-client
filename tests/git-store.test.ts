import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitStore } from '../electron/git-store';

const marker = 'daily-cf-repository.json';
const pointer = 'daily-cf-active.json';
const snapshot = { revision: '1'.repeat(40), branch: 'main' };
let temporary: string;
let root: string;
let store: GitStore;
let temporaryRoot: string;
beforeEach(async () => {
  temporaryRoot = await fs.promises.realpath(os.tmpdir());
  temporary = await fs.promises.mkdtemp(path.join(temporaryRoot, 'daily-cf-store-'));
  root = path.join(temporary, 'library.git');
  store = new GitStore(root, 'fixture/library');
});
afterEach(async () => {
  vi.restoreAllMocks();
  const relative = path.relative(temporaryRoot, path.resolve(temporary));
  if (!relative.startsWith('daily-cf-store-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe store fixture cleanup.');
  await fs.promises.rm(temporary, { recursive: true, force: true });
});

async function windowsShortPath(directory: string): Promise<string> {
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:DAILY_CF_TEST_SHORT_PATH).ShortPath',
  ], { env: { ...process.env, DAILY_CF_TEST_SHORT_PATH: directory }, windowsHide: true, timeout: 10_000 });
  return stdout.trim();
}

describe('GitStore ownership and atomic generation publication', () => {
  // Allow for PowerShell cold startup on shared Windows runners; keep the subprocess bounded too.
  it.skipIf(process.platform !== 'win32')('accepts a real Windows short parent path and still rejects a later root junction', async context => {
    const shortParent = await windowsShortPath(temporary);
    if (shortParent.toLowerCase() === temporary.toLowerCase()) {
      context.skip('8.3 short names are disabled on this test volume');
      return;
    }
    const aliasRoot = path.join(shortParent, 'library.git');
    const aliasStore = new GitStore(aliasRoot, 'fixture/library');
    const generation = await aliasStore.create();
    await aliasStore.publish(generation, snapshot);
    await generation.fs.promises.writeFile(path.join(generation.gitdir, 'objects/sentinel'), 'original');
    expect((await new GitStore(aliasRoot, 'fixture/library').open())?.snapshot).toEqual(snapshot);
    expect(await generation.fs.promises.readFile(path.join(generation.gitdir, 'objects/sentinel'), 'utf8')).toBe('original');

    const outside = path.join(temporary, 'outside-root');
    const outsideGit = path.join(outside, generation.id);
    await fs.promises.mkdir(path.join(outsideGit, 'objects'), { recursive: true });
    await fs.promises.writeFile(path.join(outsideGit, 'objects/sentinel'), 'unchanged');
    await fs.promises.rename(root, path.join(temporary, 'original-root'));
    await fs.promises.symlink(outside, root, 'junction');
    await expect(generation.fs.promises.readFile(path.join(generation.gitdir, 'objects/sentinel'))).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(generation.fs.promises.writeFile(path.join(generation.gitdir, 'objects/sentinel'), 'changed')).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(aliasStore.open()).rejects.toMatchObject({ code: 'unsafe_root' });
    expect(await fs.promises.readFile(path.join(outsideGit, 'objects/sentinel'), 'utf8')).toBe('unchanged');
  }, 15_000);

  it('opens a missing or empty directory without creating local files', async () => {
    expect(await store.open()).toBeNull();
    await expect(fs.promises.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.promises.mkdir(root);
    expect(await store.open()).toBeNull();
    expect(await fs.promises.readdir(root)).toEqual([]);
  });

  it('publishes one generation atomically and keeps captured contexts and all previous generations', async () => {
    const first = await store.create();
    expect(await store.open()).toBeNull();
    await store.publish(first, snapshot);
    const captured = await store.open();
    expect(captured).toMatchObject({ id: first.id, gitdir: first.gitdir, legacy: false, snapshot });
    const second = await store.create();
    const next = { revision: '2'.repeat(40), branch: 'next' };
    const rename = fs.promises.rename.bind(fs.promises);
    const observations: unknown[] = [];
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(root, pointer)) observations.push((await store.open())?.snapshot);
      return rename(from, to);
    });
    await store.publish(second, next);
    expect(observations).toEqual([snapshot]);
    expect((await store.open())?.snapshot).toEqual(next);
    expect(captured?.gitdir).toBe(first.gitdir);
    expect(await fs.promises.readFile(path.join(first.gitdir, 'refs/heads/daily-cf-snapshot'), 'utf8')).toBe(`${snapshot.revision}\n`);
    expect((await fs.promises.readdir(root)).filter(name => name.startsWith('objects-'))).toHaveLength(2);
  });

  it('does not claim unknown files, mismatched identities, malformed ownership, or linked markers', async () => {
    await fs.promises.mkdir(root);
    const unknown = path.join(root, 'my-file.txt');
    await fs.promises.writeFile(unknown, 'user data');
    await expect(store.ensureRoot()).rejects.toMatchObject({ code: 'unsafe_root' });
    expect(await fs.promises.readFile(unknown, 'utf8')).toBe('user data');
    await fs.promises.writeFile(path.join(root, marker), JSON.stringify({ version: 1, repository: 'another/library' }));
    await expect(store.open()).rejects.toMatchObject({ code: 'unsafe_root' });
    await fs.promises.writeFile(path.join(root, marker), '{broken');
    await expect(store.create()).rejects.toMatchObject({ code: 'unsafe_root' });
    await fs.promises.unlink(path.join(root, marker));
    await fs.promises.link(unknown, path.join(root, marker));
    await expect(store.ensureRoot()).rejects.toMatchObject({ code: 'unsafe_root' });
    expect(await fs.promises.readFile(unknown, 'utf8')).toBe('user data');
  });

  it('rejects root and parent junctions without writing through them', async () => {
    const outside = path.join(temporary, 'outside');
    await fs.promises.mkdir(outside);
    await fs.promises.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(store.create()).rejects.toMatchObject({ code: 'unsafe_root' });
    await expect(new GitStore(path.join(root, 'nested'), 'fixture/library').create()).rejects.toMatchObject({ code: 'unsafe_root' });
    expect(await fs.promises.readdir(outside)).toEqual([]);
  });

  it('does not overwrite a different ownership marker created during first publication', async () => {
    const link = fs.promises.link.bind(fs.promises);
    const other = JSON.stringify({ version: 1, repository: 'other/repository' });
    vi.spyOn(fs.promises, 'link').mockImplementation(async (from, to) => {
      if (String(to) === path.join(root, marker)) await fs.promises.writeFile(to, other, { flag: 'wx' });
      return link(from, to);
    });
    await expect(store.ensureRoot()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.promises.readFile(path.join(root, marker), 'utf8')).toBe(other);
    expect((await fs.promises.readdir(root)).filter(name => name.startsWith('.daily-cf-write-'))).toEqual([]);
    await expect(store.open()).rejects.toMatchObject({ code: 'unsafe_root' });
  });

  it('allows malformed or missing-generation pointers to be replaced by a fresh generation without deleting anything', async () => {
    const old = await store.create();
    await store.publish(old, snapshot);
    await fs.promises.writeFile(path.join(root, pointer), '{interrupted');
    await expect(store.open()).rejects.toMatchObject({ code: 'git_store_corrupt' });
    const fresh = await store.create();
    await store.publish(fresh, snapshot);
    expect((await store.open())?.id).toBe(fresh.id);
    expect((await fs.promises.stat(old.gitdir)).isDirectory()).toBe(true);
    const value = JSON.parse(await fs.promises.readFile(path.join(root, pointer), 'utf8'));
    await fs.promises.writeFile(path.join(root, pointer), JSON.stringify({ ...value, generation: 'objects-00000000-0000-0000-0000-000000000000.git' }));
    await expect(store.open()).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await store.publish(fresh, snapshot);
    expect((await store.open())?.id).toBe(fresh.id);
  });

  it('replaces a hardlinked active pointer entry without modifying its outside target', async () => {
    const context = await store.create();
    const outside = path.join(temporary, 'outside-pointer.json');
    await fs.promises.writeFile(outside, 'outside sentinel');
    await fs.promises.link(outside, path.join(root, pointer));
    await expect(store.open()).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await store.publish(context, snapshot);
    expect((await store.open())?.id).toBe(context.id);
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('outside sentinel');
    expect((await fs.promises.stat(outside)).nlink).toBe(1);
  });

  it('replaces a symbolic active pointer entry without following it', async context => {
    const generation = await store.create();
    const outside = path.join(temporary, 'outside-symlink.json');
    await fs.promises.writeFile(outside, 'outside sentinel');
    try { await fs.promises.symlink(outside, path.join(root, pointer), 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw error; }
    await expect(store.open()).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await store.publish(generation, snapshot);
    expect((await store.open())?.id).toBe(generation.id);
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('outside sentinel');
  });

  it('never removes a directory occupying the active-pointer location', async () => {
    const context = await store.create();
    await fs.promises.mkdir(path.join(root, pointer));
    await fs.promises.writeFile(path.join(root, pointer, 'mine.txt'), 'keep');
    await expect(store.publish(context, snapshot)).rejects.toMatchObject({ code: 'git_store_corrupt' });
    expect(await fs.promises.readFile(path.join(root, pointer, 'mine.txt'), 'utf8')).toBe('keep');
  });

  it('resets config, HEAD, packed refs and private ref from the authoritative snapshot', async () => {
    const context = await store.create();
    await store.publish(context, snapshot);
    await fs.promises.writeFile(path.join(context.gitdir, 'config'), '[remote "origin"]\nfetch = +refs/heads/*:refs/heads/*\n');
    await fs.promises.writeFile(path.join(context.gitdir, 'HEAD'), '../../outside');
    await fs.promises.writeFile(path.join(context.gitdir, 'packed-refs'), `${'f'.repeat(40)} refs/heads/daily-cf-snapshot\n`);
    await fs.promises.writeFile(path.join(context.gitdir, 'refs/heads/daily-cf-snapshot'), `${'f'.repeat(40)}\n`);
    await store.prepare(context);
    expect(await git.getConfig({ fs: context.fs, gitdir: context.gitdir, path: 'remote.origin.fetch' })).toBe('+refs/heads/*:refs/remotes/origin/*');
    expect(await git.getConfig({ fs: context.fs, gitdir: context.gitdir, path: 'remote.origin.url' })).toBe('https://github.com/fixture/library.git');
    expect(await git.resolveRef({ fs: context.fs, gitdir: context.gitdir, ref: 'HEAD' })).toBe(snapshot.revision);
    expect(await fs.promises.readFile(path.join(context.gitdir, 'packed-refs'), 'utf8')).toBe('');
    await fs.promises.writeFile(path.join(context.gitdir, 'shallow'), 'invalid');
    await expect(store.prepare(context)).rejects.toMatchObject({ code: 'git_store_corrupt' });
  });

  it('clears only replaceable origin refs so default-branch prefix changes do not conflict', async () => {
    const context = await store.create();
    await store.publish(context, snapshot);
    await context.fs.promises.writeFile(path.join(context.gitdir, 'refs/remotes/origin/main'), `${snapshot.revision}\n`);
    await store.prepare(context);
    expect(await fs.promises.readdir(path.join(context.gitdir, 'refs/remotes/origin'))).toEqual([]);
    await context.fs.promises.mkdir(path.join(context.gitdir, 'refs/remotes/origin/main'));
    await context.fs.promises.writeFile(path.join(context.gitdir, 'refs/remotes/origin/main/topic'), `${snapshot.revision}\n`);
    await store.prepare(context);
    expect(await fs.promises.readdir(path.join(context.gitdir, 'refs/remotes/origin'))).toEqual([]);
    expect(await git.resolveRef({ fs: context.fs, gitdir: context.gitdir, ref: 'HEAD' })).toBe(snapshot.revision);
    await fs.promises.writeFile(path.join(context.gitdir, 'refs/remotes/origin/user-file'), 'unknown data');
    await expect(store.prepare(context)).rejects.toMatchObject({ code: 'git_store_corrupt' });
    expect(await fs.promises.readFile(path.join(context.gitdir, 'refs/remotes/origin/user-file'), 'utf8')).toBe('unknown data');
  });

  it('accepts Unicode default-branch symbolic refs when refreshing origin references', async () => {
    const context = await store.create();
    const unicodeSnapshot = { ...snapshot, branch: '题库/最新题目' };
    await store.publish(context, unicodeSnapshot);
    await context.fs.promises.mkdir(path.join(context.gitdir, 'refs/remotes/origin/题库'));
    await context.fs.promises.writeFile(path.join(context.gitdir, 'refs/remotes/origin/题库/最新题目'), `${snapshot.revision}\n`);
    await context.fs.promises.writeFile(path.join(context.gitdir, 'refs/remotes/origin/HEAD'), 'ref: refs/remotes/origin/题库/最新题目\n');
    await store.prepare(context);
    expect(await fs.promises.readdir(path.join(context.gitdir, 'refs/remotes/origin'))).toEqual([]);
    expect((await store.open())?.snapshot).toEqual(unicodeSnapshot);
    expect(await git.resolveRef({ fs: context.fs, gitdir: context.gitdir, ref: 'HEAD' })).toBe(snapshot.revision);
  });

  it('opens legacy storage read-only and copies only objects and validated shallow boundaries into a generation', async () => {
    await store.ensureRoot();
    const legacyDir = path.join(root, 'objects.git');
    await git.init({ fs, gitdir: legacyDir, bare: true });
    await fs.promises.mkdir(path.join(legacyDir, 'refs/heads'), { recursive: true });
    await fs.promises.writeFile(path.join(legacyDir, 'refs/heads/daily-cf-snapshot'), `${snapshot.revision}\n`);
    const blob = await git.writeBlob({ fs, gitdir: legacyDir, blob: Buffer.from('legacy code') });
    await fs.promises.writeFile(path.join(legacyDir, 'config'), 'invalid config kept intact');
    await fs.promises.writeFile(path.join(legacyDir, 'shallow'), `${snapshot.revision}\n`);
    const legacy = (await store.open())!;
    expect(legacy).toMatchObject({ id: 'objects.git', legacy: true, snapshot: { revision: snapshot.revision } });
    await expect(store.prepare(legacy)).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(legacy.fs.promises.writeFile(path.join(legacyDir, 'objects/new'), 'x')).rejects.toMatchObject({ code: 'git_store_corrupt' });
    const migrated = await store.stageFrom(legacy);
    expect((await store.open())?.legacy).toBe(true);
    expect(Buffer.from((await git.readBlob({ fs: migrated.fs, gitdir: migrated.gitdir, oid: blob })).blob).toString()).toBe('legacy code');
    expect(await fs.promises.readFile(path.join(migrated.gitdir, 'shallow'), 'utf8')).toBe(`${snapshot.revision}\n`);
    expect(await fs.promises.readFile(path.join(legacyDir, 'config'), 'utf8')).toBe('invalid config kept intact');
    await store.publish(migrated, snapshot);
    expect((await store.open())?.legacy).toBe(false);
    expect((await fs.promises.stat(legacyDir)).isDirectory()).toBe(true);
  });

  it('rejects linked descendants and preserves the outside sentinel for all write paths', async () => {
    const context = await store.create();
    const outside = path.join(temporary, 'sentinel.txt');
    await fs.promises.writeFile(outside, 'do not modify');
    await fs.promises.unlink(path.join(context.gitdir, 'config'));
    await fs.promises.link(outside, path.join(context.gitdir, 'config'));
    await expect(store.prepare(context)).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(store.stageFrom(context)).rejects.toMatchObject({ code: 'git_store_corrupt' });
    const linkedObject = path.join(context.gitdir, 'objects', 'linked');
    await fs.promises.link(outside, linkedObject);
    await expect(context.fs.promises.writeFile(linkedObject, 'overwrite')).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(context.fs.promises.unlink(linkedObject)).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(context.fs.promises.readFile(linkedObject)).rejects.toMatchObject({ code: 'git_store_corrupt' });
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('do not modify');
    const fresh = await store.create();
    await store.publish(fresh, snapshot);
    expect((await store.open())?.id).toBe(fresh.id);
  });

  it('rejects a pack directory junction introduced after opening a context', async () => {
    const context = await store.create();
    const outside = path.join(temporary, 'outside-pack');
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, 'sentinel'), 'unchanged');
    await fs.promises.rmdir(path.join(context.gitdir, 'objects/pack'));
    await fs.promises.symlink(outside, path.join(context.gitdir, 'objects/pack'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(store.prepare(context)).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(context.fs.promises.writeFile(path.join(context.gitdir, 'objects/pack/new.pack'), 'x')).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(context.fs.promises.readFile(path.join(context.gitdir, 'objects/pack/sentinel'))).rejects.toMatchObject({ code: 'git_store_corrupt' });
    expect(await fs.promises.readdir(outside)).toEqual(['sentinel']);
  });

  it('rejects a store-root junction introduced after a context was captured', async () => {
    const context = await store.create();
    const outside = path.join(temporary, 'outside-root');
    const outsideGit = path.join(outside, context.id);
    await fs.promises.mkdir(path.join(outsideGit, 'objects'), { recursive: true });
    await fs.promises.writeFile(path.join(outsideGit, 'objects/sentinel'), 'unchanged');
    await fs.promises.rename(root, path.join(temporary, 'original-root'));
    await fs.promises.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(context.fs.promises.readFile(path.join(context.gitdir, 'objects/sentinel'))).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(context.fs.promises.writeFile(path.join(context.gitdir, 'objects/sentinel'), 'changed')).rejects.toMatchObject({ code: 'git_store_corrupt' });
    expect(await fs.promises.readFile(path.join(outsideGit, 'objects/sentinel'), 'utf8')).toBe('unchanged');
  });

  it('confines the fs adapter and forbids private-ref/config mutation by git fetch', async () => {
    const context = await store.create();
    for (const relative of ['../outside', 'config', 'HEAD', 'refs/heads/daily-cf-snapshot', 'objects/name:stream', 'objects/CON', 'objects/trailing.']) {
      await expect(context.fs.promises.writeFile(path.join(context.gitdir, relative), 'no')).rejects.toMatchObject({ code: 'git_store_corrupt' });
    }
    await expect(context.fs.promises.rmdir(path.join(context.gitdir, 'objects'), { recursive: true })).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(store.publish({ ...context, gitdir: temporary }, snapshot)).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await expect(store.publish(context, { ...snapshot, revision: '../outside' })).rejects.toMatchObject({ code: 'git_store_corrupt' });
    await context.fs.promises.writeFile(path.join(context.gitdir, 'FETCH_HEAD'), 'fetch state');
    expect(await context.fs.promises.readFile(path.join(context.gitdir, 'FETCH_HEAD'), 'utf8')).toBe('fetch state');
    expect((await fs.promises.readdir(context.gitdir)).some(name => name.startsWith('.daily-cf-write-'))).toBe(false);
  });

  it('propagates native IO failures and leaves the last pointer readable after interrupted publication', async () => {
    const first = await store.create();
    await store.publish(first, snapshot);
    const second = await store.create();
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(root, pointer)) throw Object.assign(new Error('IO failure'), { code: 'EIO' });
      return rename(from, to);
    });
    await expect(store.publish(second, { ...snapshot, revision: '2'.repeat(40) })).rejects.toMatchObject({ code: 'EIO' });
    expect((await store.open())?.id).toBe(first.id);
    expect((await fs.promises.readdir(root)).some(name => name.startsWith('.daily-cf-write-'))).toBe(false);
  });

  it('disposes only this instance’s never-published generations and only tracked files', async () => {
    const active = await store.create();
    await store.publish(active, snapshot);
    const failed = await store.create();
    await failed.fs.promises.mkdir(path.join(failed.gitdir, 'objects/aa'));
    await failed.fs.promises.writeFile(path.join(failed.gitdir, 'objects/aa/object'), 'downloaded bytes');
    expect(await new GitStore(root, 'fixture/library').dispose(failed)).toBe(false);
    expect(await store.dispose(failed)).toBe(true);
    await expect(fs.promises.stat(failed.gitdir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.dispose(active)).toBe(false);
    expect((await store.open())?.id).toBe(active.id);
    const unknown = await store.create();
    await fs.promises.writeFile(path.join(unknown.gitdir, 'my-data.txt'), 'keep');
    expect(await store.dispose(unknown)).toBe(false);
    expect(await fs.promises.readFile(path.join(unknown.gitdir, 'my-data.txt'), 'utf8')).toBe('keep');
    expect((await fs.promises.stat(path.join(unknown.gitdir, 'objects'))).isDirectory()).toBe(true);
  });

  it('preserves all files when disposal finds links or an active-pointer reference to the candidate', async () => {
    const candidate = await store.create();
    const sentinel = path.join(temporary, 'sentinel-dispose');
    await fs.promises.writeFile(sentinel, 'keep');
    await candidate.fs.promises.writeFile(path.join(candidate.gitdir, 'objects/file'), 'temporary');
    await fs.promises.unlink(path.join(candidate.gitdir, 'objects/file'));
    await fs.promises.link(sentinel, path.join(candidate.gitdir, 'objects/file'));
    expect(await store.dispose(candidate)).toBe(false);
    expect(await fs.promises.readFile(sentinel, 'utf8')).toBe('keep');
    expect((await fs.promises.stat(path.join(candidate.gitdir, 'HEAD'))).isFile()).toBe(true);
    const referenced = await store.create();
    await fs.promises.writeFile(path.join(root, pointer), JSON.stringify({ version: 1, repository: 'fixture/library', generation: referenced.id, ...snapshot }));
    expect(await store.dispose(referenced)).toBe(false);
    expect((await fs.promises.stat(referenced.gitdir)).isDirectory()).toBe(true);
  });
});
