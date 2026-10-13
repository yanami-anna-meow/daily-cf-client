import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import git from 'isomorphic-git';
import lockfile from 'proper-lockfile';
import { GitRepository } from '../electron/git-repository';
import { GitStore } from '../electron/git-store';
import { GitIntegrity } from '../electron/git-integrity';
import { startGitFixture } from './helpers/git-http-fixture';
import type { LibrarySyncProgress } from '../shared/types';

const remote = 'https://github.com/fixture/library.git';
let fixture: Awaited<ReturnType<typeof startGitFixture>>;
let directory: string;
let fetcher: typeof fetch;

beforeEach(async () => {
  fixture = await startGitFixture({
    'README.md': 'Hello repository',
    'daily_problems/2128/03/0304/problems.md': 'Future problems',
    'daily_problems/2128/03/0304/personal_submission/cf1a_a.cpp': 'int main() {}',
  });
  directory = path.join(fixture.directory, 'client');
  fetcher = vi.fn(async (input, options) => {
    const url = String(input);
    expect(url.startsWith(`${remote}/`)).toBe(true);
    expect(new Headers(options?.headers).has('authorization')).toBe(false);
    expect(options?.credentials).toBe('omit');
    return fetch(`${fixture.url}${url.slice(remote.length)}`, options);
  });
});
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); });
const create = (options: ConstructorParameters<typeof GitRepository>[1] = {}) => new GitRepository(directory, { repository: 'fixture/library', fetch: fetcher, ...options });
async function activeGitdir(): Promise<string> {
  const context = await new GitStore(directory, 'fixture/library').open();
  if (!context) throw new Error('Expected a published test generation');
  return context.gitdir;
}
async function activePointer(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.promises.readFile(path.join(directory, 'daily-cf-active.json'), 'utf8'));
}
async function packFiles(gitdir: string): Promise<{ pack: string; index: string }> {
  const directory = path.join(gitdir, 'objects', 'pack');
  const filename = (await fs.promises.readdir(directory)).find(value => value.endsWith('.pack'));
  if (!filename) throw new Error('Expected a real downloaded pack');
  return { pack: path.join(directory, filename), index: path.join(directory, filename.replace(/\.pack$/, '.idx')) };
}

describe('GitRepository over the real smart HTTP protocol', () => {
  it('has no local preview until a complete snapshot exists and does not create any storage during local reads', async () => {
    expect(await create().getLocalSnapshot()).toBeNull();
    await expect(fs.promises.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(create({ maxDownloadBytes: 1 }).sync()).rejects.toMatchObject({ code: 'sync_too_large' });
    const requests = fixture.requests.length;
    expect(await create().getLocalSnapshot()).toBeNull();
    expect(fixture.requests).toHaveLength(requests);
  }, 20_000);

  it('opens the previous snapshot after restart without network and retains it through a failed update', async () => {
    const first = await create().sync();
    const offlineFetch = vi.fn(async () => { throw new TypeError('Offline'); });
    const restarted = create({ fetch: offlineFetch });
    expect(await restarted.getLocalSnapshot()).toEqual(first);
    expect(await restarted.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect(offlineFetch).not.toHaveBeenCalled();
    await expect(restarted.sync()).rejects.toMatchObject({ code: 'sync_network' });
    expect(await restarted.getLocalSnapshot()).toMatchObject({ revision: first.revision });
    expect(offlineFetch).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('publishes changed snapshots atomically while local readers keep their immutable revision', async () => {
    const repo = create();
    const first = await repo.sync();
    const next = await fixture.publishFiles({ 'README.md': null, 'next.txt': 'Next snapshot' });
    const rename = fs.promises.rename.bind(fs.promises);
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('daily-cf-active.json')) { reached(); await resume; }
      return rename(from, to);
    });
    const updating = repo.sync();
    await paused;
    try {
      expect(await repo.getLocalSnapshot()).toMatchObject({ revision: first.revision });
      expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    } finally { release(); }
    expect((await updating).revision).toBe(next);
    spy.mockRestore();
    expect(await create().getLocalSnapshot()).toMatchObject({ revision: next });
    expect(await repo.readFile(next, 'README.md', 1024)).toBeNull();
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect((await fs.promises.readdir(directory)).filter(name => name.includes('pending'))).toEqual([]);
  }, 20_000);

  it('refuses local previews of wrong identities and corrupt active pointers without contacting the remote', async () => {
    await create().sync();
    vi.mocked(fetcher).mockClear();
    await expect(create({ repository: 'someone/else' }).getLocalSnapshot()).rejects.toMatchObject({ code: 'sync_invalid_repository' });
    const pointerPath = path.join(directory, 'daily-cf-active.json');
    const pointer = await activePointer();
    await fs.promises.writeFile(pointerPath, JSON.stringify({ ...pointer, revision: 'not-an-object' }));
    await expect(create().getLocalSnapshot()).rejects.toThrow();
    await fs.promises.writeFile(pointerPath, JSON.stringify({ ...pointer, revision: 'f'.repeat(40) }));
    await expect(create().getLocalSnapshot()).rejects.toThrow();
    await fs.promises.writeFile(path.join(directory, 'daily-cf-repository.json'), '{bad json');
    await expect(create().getLocalSnapshot()).rejects.toMatchObject({ code: 'sync_invalid_repository' });
    expect(fetcher).not.toHaveBeenCalled();
  }, 20_000);

  it('downloads one shallow snapshot with no worktree, API calls, tags or history', async () => {
    const events: LibrarySyncProgress[] = [];
    const repo = create({ onProgress: event => events.push(event) });
    await fixture.runGit(['tag', 'fixture-tag']);
    await fixture.runGit(['push', 'origin', '--tags']);
    const snapshot = await repo.sync();
    expect(snapshot.branch).toBe('main');
    expect(snapshot.revision).toMatch(/^[a-f0-9]{40}$/);
    expect((await repo.listFiles(snapshot.revision)).map(file => file.path)).toEqual([
      'README.md', 'daily_problems/2128/03/0304/personal_submission/cf1a_a.cpp', 'daily_problems/2128/03/0304/problems.md',
    ]);
    expect(await repo.readFile(snapshot.revision, 'README.md', 1024)).toBe('Hello repository');
    const gitdir = await activeGitdir();
    expect((await fs.promises.readdir(directory)).sort()).toEqual(['daily-cf-active.json', 'daily-cf-repository.json', path.basename(gitdir)].sort());
    expect(await git.listTags({ fs, gitdir })).toEqual([]);
    expect((await git.log({ fs, gitdir, ref: snapshot.revision })).length).toBe(1);
    expect(events.at(-1)).toMatchObject({ phase: 'ready', revision: snapshot.revision });
    expect(fixture.requests.every(request => /\/(info\/refs|git-upload-pack)/.test(request.url))).toBe(true);
  }, 20_000);

  it('checks remote HEAD again on every sequential sync and downloads only new objects', async () => {
    const bulky = Array.from({ length: 20_000 }, (_, index) => `${index.toString(16)}-${Math.imul(index, 15485863).toString(16)}`).join('\n');
    await fixture.publishFiles({ 'large.txt': bulky });
    const repo = create();
    const first = await repo.sync();
    const firstBytes = fixture.requests.reduce((sum, request) => sum + request.responseBodyBytes, 0);
    fixture.requests.length = 0;
    const same = await repo.sync();
    expect(same).toEqual(first);
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(fixture.requests.reduce((sum, request) => sum + request.responseBodyBytes, 0)).toBeLessThan(firstBytes / 2);
    fixture.requests.length = 0;
    const next = await fixture.publishFiles({
      'new.txt': 'New small file', 'README.md': null,
      'daily_problems/2128/03/0304/problems.md': null,
      'daily_problems/2128/03/0304/personal_submission/cf1a_a.cpp': null,
    });
    expect((await repo.sync()).revision).toBe(next);
    expect(fixture.requests.reduce((sum, request) => sum + request.responseBodyBytes, 0)).toBeLessThan(firstBytes / 2);
    expect(await repo.readFile(next, 'README.md', 1024)).toBeNull();
    expect(await repo.readFile(next, 'new.txt', 1024)).toBe('New small file');
    // Previously handed-out versions stay immutable for a whole-page read.
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect((await repo.listFiles(next)).some(file => file.path === 'README.md')).toBe(false);
    expect((await repo.listFiles(next)).some(file => file.path.startsWith('daily_problems/2128/03/'))).toBe(false);
    expect(await repo.readFile(first.revision, 'daily_problems/2128/03/0304/problems.md', 100)).toBe('Future problems');
  }, 20_000);

  it('discovers a changed default branch, accepts rewritten history, and survives restart', async () => {
    const repo = create();
    await repo.sync();
    const changed = await fixture.publishFiles({ 'README.md': 'Next default' }, 'next-default');
    await fixture.defaultBranch('next-default');
    expect(await repo.sync()).toEqual({ branch: 'next-default', revision: changed });
    await fixture.runGit(['checkout', '--orphan', 'rewritten']);
    await fixture.runGit(['rm', '-rf', '.']);
    const rewritten = await fixture.publishFiles({ 'only.txt': 'Rewritten root' }, 'rewritten');
    await fixture.defaultBranch('rewritten');
    const restarted = create();
    expect(await restarted.sync()).toEqual({ branch: 'rewritten', revision: rewritten });
    expect((await restarted.listFiles(rewritten)).map(file => file.path)).toEqual(['only.txt']);
  }, 20_000);

  it('handles default-branch file/directory name transitions without rebuilding a healthy generation', async () => {
    const events: LibrarySyncProgress[] = [];
    const repo = create({ onProgress: event => events.push(event) });
    await repo.sync();
    const gitdir = await activeGitdir();
    let previousBranch = 'main';
    for (const branch of ['main/topic', 'main']) {
      await fixture.runGit(['checkout', '--detach']);
      await fixture.runGit(['branch', '-D', previousBranch]);
      await fixture.runGit(['update-ref', '-d', `refs/remotes/origin/${previousBranch}`]);
      await fixture.runGit(['update-ref', '-d', `refs/heads/${previousBranch}`], fixture.remoteGitDir);
      await fixture.runGit(['checkout', '-b', branch]);
      const revision = await fixture.publishFiles({
        'daily_problems/2128/03/0304/problems.md': `Problems on ${branch}`,
      }, branch);
      await fixture.defaultBranch(branch);
      events.length = 0;
      expect(await repo.sync()).toEqual({ branch, revision });
      expect(await repo.readFile(revision, 'daily_problems/2128/03/0304/problems.md', 1024)).toBe(`Problems on ${branch}`);
      expect(await activeGitdir()).toBe(gitdir);
      expect(events.some(event => event.phase === 'repairing')).toBe(false);
      previousBranch = branch;
    }
  }, 30_000);

  it.each(['missing object', 'unrelated local commit'] as const)(
    'updates remote additions and deletions after shallow metadata names a %s', async boundary => {
    await fixture.publishFiles({ 'README.md': 'Upstream history before the shallow snapshot' });
    const repo = create();
    const first = await repo.sync();
    const gitdir = await activeGitdir();
    expect((await git.log({ fs, gitdir, ref: first.revision })).length).toBe(1);
    let oid = 'f'.repeat(40);
    if (boundary === 'unrelated local commit') {
      const tree = await git.writeTree({ fs, gitdir, tree: [] });
      oid = await git.writeCommit({ fs, gitdir, commit: {
        tree, parent: [], message: 'Unrelated local shallow boundary\n',
        author: { name: 'Fixture', email: 'fixture@example.invalid', timestamp: 1, timezoneOffset: 0 },
        committer: { name: 'Fixture', email: 'fixture@example.invalid', timestamp: 1, timezoneOffset: 0 },
      } });
      expect((await git.readCommit({ fs, gitdir, oid })).commit.parent).toEqual([]);
    }
    await fs.promises.writeFile(path.join(gitdir, 'shallow'), `${oid}\n`);
    const removed = 'daily_problems/2128/03/0304/problems.md';
    const added = 'daily_problems/2128/03/0305/problems.md';
    const revision = await fixture.publishFiles({ [removed]: null, [added]: `Latest problem after ${boundary}` });
    fixture.requests.length = 0;
    expect(await repo.sync()).toEqual({ branch: 'main', revision });
    expect(await repo.readFile(revision, removed, 1024)).toBeNull();
    expect(await repo.readFile(revision, added, 1024)).toBe(`Latest problem after ${boundary}`);
    expect((await repo.listFiles(revision)).some(file => file.path === removed)).toBe(false);
    expect(fixture.requests.length).toBeGreaterThan(0);
    // A normal fetch or one bounded repair is sufficient; no retry loop.
    expect(fixture.requests.length).toBeLessThanOrEqual(4);
  }, 30_000);

  it('coalesces only concurrent operations, including separate instances for the same directory', async () => {
    const repo = create();
    const other = create();
    const [one, two, three] = await Promise.all([repo.sync(), repo.sync(), other.sync()]);
    expect(one).toEqual(two); expect(one).toEqual(three);
    const requestCount = fixture.requests.length;
    await repo.sync();
    expect(fixture.requests.length).toBe(requestCount * 2);
  }, 20_000);

  it('keeps warmed pack reads after unchanged synchronization and concurrent joiners', async () => {
    const repo = create();
    const first = await repo.sync();
    const blobReads = vi.spyOn(GitIntegrity.prototype, 'readBlob');
    await repo.readFile(first.revision, 'README.md', 1024);
    const warmCache = blobReads.mock.calls.at(-1)![1];
    const inspections = vi.spyOn(GitIntegrity.prototype, 'inspect');
    const gitFetches = vi.spyOn(git, 'fetch');
    // CheckedFiles reads through FileHandle, rather than fs.readFile.
    const fileOpens = vi.spyOn(fs.promises, 'open');
    const requestCount = fixture.requests.length;
    const other = create();
    await Promise.all([repo.sync(), repo.sync(), other.sync()]);
    // Unchanged content may reuse its proof after fresh disk-byte checks; it
    // does not require re-parsing the commit. Negotiation has a separate cache.
    expect(inspections).toHaveBeenCalled();
    expect(fileOpens.mock.calls.some(([filename]) => String(filename).endsWith('.pack'))).toBe(true);
    expect(fileOpens.mock.calls.some(([filename]) => String(filename).endsWith('.idx'))).toBe(true);
    expect(fixture.requests.length).toBeGreaterThan(requestCount);
    expect(gitFetches).toHaveBeenCalledTimes(1);
    expect(gitFetches.mock.calls[0][0].cache).not.toBe(warmCache);
    fileOpens.mockClear();
    await repo.readFile(first.revision, 'README.md', 1024);
    expect(blobReads.mock.calls.at(-1)![1]).toBe(warmCache);
    await other.readFile(first.revision, 'README.md', 1024);
    expect(blobReads.mock.calls.at(-1)![1]).toBe(warmCache);
    expect(fileOpens).not.toHaveBeenCalled();
    const changed = await fixture.publishFiles({ 'README.md': 'Changed' });
    await repo.sync();
    expect(await repo.readFile(changed, 'README.md', 1024)).toBe('Changed');
    expect(blobReads.mock.calls.at(-1)![1]).not.toBe(warmCache);
  }, 20_000);

  it('shares commit and tree reads by immutable SHA while retaining path and size checks', async () => {
    const repo = create();
    const first = await repo.sync();
    const commits = vi.spyOn(GitIntegrity.prototype, 'readCommit');
    const trees = vi.spyOn(GitIntegrity.prototype, 'readTree');
    const filename = 'daily_problems/2128/03/0304/problems.md';
    expect(await Promise.all([
      repo.readFile(first.revision, filename, 1024),
      repo.readFile(first.revision, filename, 1024),
      repo.readFile(first.revision, filename, 1024),
    ])).toEqual(['Future problems', 'Future problems', 'Future problems']);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(trees).toHaveBeenCalledTimes(5);
    expect(new Set(trees.mock.calls.map(([oid]) => oid)).size).toBe(5);
    commits.mockClear(); trees.mockClear();
    expect(await repo.readFile(first.revision, filename, 1024)).toBe('Future problems');
    expect(commits).not.toHaveBeenCalled(); expect(trees).not.toHaveBeenCalled();
    await expect(repo.readFile(first.revision, filename, 1)).rejects.toMatchObject({ code: 'sync_too_large' });
    await expect(repo.readFile(first.revision, '../README.md', 1024)).rejects.toMatchObject({ code: 'sync_invalid_path' });
    const changed = await fixture.publishFiles({ [filename]: 'Updated problem list' });
    await repo.sync();
    expect(await repo.readFile(changed, filename, 1024)).toBe('Updated problem list');
    commits.mockClear(); trees.mockClear();
    expect(await repo.readFile(first.revision, filename, 1024)).toBe('Future problems');
    expect(commits).not.toHaveBeenCalled(); expect(trees).not.toHaveBeenCalled();
  }, 20_000);

  it('removes rejected metadata promises and retries disk reads with a fresh pack cache', async () => {
    const first = await create().sync();
    const repo = create();
    const commits = vi.spyOn(GitIntegrity.prototype, 'readCommit').mockRejectedValueOnce(new Error('temporary commit read failure'));
    await expect(repo.readFile(first.revision, 'README.md', 1024)).rejects.toThrow('temporary commit');
    const failedCommitCache = commits.mock.calls[0][1];
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect(commits.mock.calls[1][1]).not.toBe(failedCommitCache);
    commits.mockRestore();
    const second = create();
    const trees = vi.spyOn(GitIntegrity.prototype, 'readTree').mockRejectedValueOnce(new Error('temporary tree read failure'));
    await expect(second.readFile(first.revision, 'README.md', 1024)).rejects.toThrow('temporary tree');
    const failedTreeCache = trees.mock.calls[0][1];
    expect(await second.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect(trees.mock.calls[1][1]).not.toBe(failedTreeCache);
    const blobs = vi.spyOn(GitIntegrity.prototype, 'readBlob').mockRejectedValueOnce(new Error('temporary blob index failure'));
    await expect(second.readFile(first.revision, 'README.md', 1024)).rejects.toThrow('temporary blob');
    const failedBlobCache = blobs.mock.calls[0][1];
    expect(await second.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect(blobs.mock.calls[1][1]).not.toBe(failedBlobCache);
  }, 20_000);

  it.each(['truncated pack', 'missing pack', 'missing index', 'swapped index offsets', 'loose shadow'] as const)(
    'rebuilds a managed generation after %s without manually restoring damaged bytes', async damage => {
    const repo = create();
    const first = await repo.sync();
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    const previousGitdir = await activeGitdir();
    const files = await packFiles(previousGitdir);
    if (damage === 'truncated pack') {
      const original = await fs.promises.readFile(files.pack);
      await fs.promises.writeFile(files.pack, original.subarray(0, Math.floor(original.length / 2)));
    } else if (damage === 'missing pack') await fs.promises.unlink(files.pack);
    else if (damage === 'missing index') await fs.promises.unlink(files.index);
    else if (damage === 'swapped index offsets') {
      const index = await fs.promises.readFile(files.index);
      const count = index.readUInt32BE(8 + 255 * 4);
      expect(count).toBeGreaterThan(1);
      const offsets = 8 + 256 * 4 + count * 24;
      const firstOffset = index.readUInt32BE(offsets);
      index.writeUInt32BE(index.readUInt32BE(offsets + 4), offsets);
      index.writeUInt32BE(firstOffset, offsets + 4);
      // A matching index checksum must not make wrong OID/offset associations valid.
      createHash('sha1').update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
      await fs.promises.writeFile(files.index, index);
    } else {
      const oid = (await repo.listFiles(first.revision)).find(file => file.path === 'README.md')!.oid;
      const loose = path.join(previousGitdir, 'objects', oid.slice(0, 2), oid.slice(2));
      await fs.promises.mkdir(path.dirname(loose), { recursive: true });
      await fs.promises.writeFile(loose, deflateSync(Buffer.from('blob 6\0forged')));
    }
    expect(await repo.sync()).toEqual(first);
    expect(await activeGitdir()).not.toBe(previousGitdir);
    expect((await fs.promises.lstat(previousGitdir)).isDirectory()).toBe(true);
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect(await create().getLocalSnapshot()).toEqual(first);
  }, 30_000);

  it('bounds parsed commit retention while keeping evicted immutable versions readable', async () => {
    const first = await create().sync();
    const gitdir = await activeGitdir();
    const { commit } = await git.readCommit({ fs, gitdir, oid: first.revision });
    // Real immutable commits with the same tree exercise eviction without a
    // large network fixture or test-only changes to production cache limits.
    // Write all fixture objects before the reader captures its immutable store.
    const versions: string[] = [];
    for (let index = 0; index < 140; index++) {
      versions.push(await git.writeCommit({ fs, gitdir, commit: { ...commit, parent: [], message: `Local cache fixture ${index}\n` } }));
    }
    const repo = create();
    await repo.readFile(first.revision, 'README.md', 1024);
    for (const oid of versions) {
      expect(await repo.readFile(oid, 'README.md', 1024)).toBe('Hello repository');
    }
    const reads = vi.spyOn(GitIntegrity.prototype, 'readCommit');
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect(reads).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('does not clear a newly published cache when an older concurrent read fails', async () => {
    const repo = create();
    const first = await repo.sync();
    await repo.readFile(first.revision, 'README.md', 1024);
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blobs = vi.spyOn(GitIntegrity.prototype, 'readBlob').mockImplementationOnce(async () => {
      reached(); await resume;
      throw new Error('older read failed');
    });
    const failed = expect(repo.readFile(first.revision, 'README.md', 1024)).rejects.toThrow('older read failed');
    await paused;
    let latest: string;
    let publishedCache: object | undefined;
    try {
      latest = await fixture.publishFiles({ 'README.md': 'New version during old read' });
      await repo.sync();
      expect(await repo.readFile(latest, 'README.md', 1024)).toBe('New version during old read');
      publishedCache = blobs.mock.calls.at(-1)![1];
    } finally { release(); }
    await failed;
    expect(await repo.readFile(latest!, 'README.md', 1024)).toBe('New version during old read');
    expect(blobs.mock.calls.at(-1)![1]).toBe(publishedCache);
  }, 20_000);

  it('does not let a delayed local preview replace a repaired generation for the same SHA', async () => {
    const first = await create().sync();
    const previousGitdir = await activeGitdir();
    const repo = create();
    let release!: () => void;
    let reached!: () => void;
    let oldReader: GitIntegrity | undefined;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const readTree = GitIntegrity.prototype.readTree;
    vi.spyOn(GitIntegrity.prototype, 'readTree').mockImplementationOnce(async function (this: GitIntegrity, oid, cache) {
      // Only commit/tree bytes have been verified for the delayed preview; its
      // blob reader has never been called and must not become authoritative again.
      const tree = await readTree.call(this, oid, cache);
      oldReader = this;
      reached();
      await resume;
      return tree;
    });
    const blobs = vi.spyOn(GitIntegrity.prototype, 'readBlob');
    const preview = repo.getLocalSnapshot();
    await paused;
    try {
      expect(blobs.mock.contexts.some(reader => reader === oldReader)).toBe(false);
      const { pack } = await packFiles(previousGitdir);
      await fs.promises.writeFile(pack, Buffer.from('damaged during the local preview'));
      expect(await repo.sync()).toEqual(first);
      expect(await activeGitdir()).not.toBe(previousGitdir);
    } finally { release(); }
    expect(await preview).toEqual(first);
    blobs.mockClear();
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect(blobs).toHaveBeenCalledTimes(1);
    // Same-SHA content alone cannot expose the race: an old reader may still
    // hold previously verified pack bytes. Verify the actual generation reader.
    expect(blobs.mock.contexts[0] === oldReader).toBe(false);
  }, 30_000);

  it('never substitutes old data after network failure and allows the next request to retry', async () => {
    const repo = create();
    await repo.sync();
    const offline = create({ fetch: vi.fn(async () => { throw new TypeError('offline'); }) });
    await expect(offline.sync()).rejects.toMatchObject({ code: 'sync_network' });
    const next = await fixture.publishFiles({ 'README.md': 'Fresh after failure' });
    expect((await repo.sync()).revision).toBe(next);
  }, 20_000);

  it('aborts a stalled response and retries an interrupted initial download without deleting user files', async () => {
    const hanging = create({ timeoutMs: 40, fetch: async (_input, options) => new Promise((_resolve, reject) => {
      if (options?.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }) });
    await expect(hanging.sync()).rejects.toMatchObject({ code: 'sync_timeout' });
    await expect(create().sync()).resolves.toMatchObject({ branch: 'main' });
  }, 20_000);

  it('bounds streamed downloads and releases its lock on errors', async () => {
    await expect(create({ maxDownloadBytes: 1 }).sync()).rejects.toMatchObject({ code: 'sync_too_large' });
    await expect(create().sync()).resolves.toMatchObject({ branch: 'main' });
  }, 20_000);

  it('retries a broken initial pack stream without publishing the incomplete snapshot', async () => {
    const interrupted = create({ fetch: async (input, options) => {
      const response = await fetcher(input, options);
      if (!String(input).endsWith('/git-upload-pack')) return response;
      const body = new Uint8Array(await response.arrayBuffer());
      let started = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!started) { started = true; controller.enqueue(body.subarray(0, Math.ceil(body.length / 2))); }
          else controller.error(new TypeError('connection dropped halfway through pack'));
        },
      }), { headers: response.headers, status: response.status });
    } });
    await expect(interrupted.sync()).rejects.toMatchObject({ code: 'sync_network' });
    expect(await create().getLocalSnapshot()).toBeNull();
    await expect(fs.promises.stat(path.join(directory, 'daily-cf-active.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = create();
    const snapshot = await recovered.sync();
    expect(await recovered.readFile(snapshot.revision, 'README.md', 1024)).toBe('Hello repository');
  }, 20_000);

  it('refuses a live cross-process lock but recovers a stale crashed-process lock', async () => {
    await fs.promises.mkdir(directory);
    const release = await lockfile.lock(directory, { stale: 240_000, update: 5_000 });
    try { await expect(create().sync()).rejects.toMatchObject({ code: 'sync_busy' }); }
    finally { await release(); }
    await fs.promises.mkdir(`${directory}.lock`);
    const old = new Date(Date.now() - 300_000);
    await fs.promises.utimes(`${directory}.lock`, old, old);
    await expect(create().sync()).resolves.toMatchObject({ branch: 'main' });
  }, 20_000);

  it('preserves unrelated directories and refuses a repository identity mismatch', async () => {
    await fs.promises.mkdir(directory);
    await fs.promises.writeFile(path.join(directory, 'important.txt'), 'Keep me');
    await expect(create().sync()).rejects.toMatchObject({ code: 'sync_invalid_repository' });
    expect(await fs.promises.readFile(path.join(directory, 'important.txt'), 'utf8')).toBe('Keep me');
    directory = path.join(fixture.directory, 'other-client');
    await create().sync();
    await expect(create({ repository: 'other/repository' }).sync()).rejects.toMatchObject({ code: 'sync_invalid_repository' });
  }, 20_000);

  it('uses the active pointer after private-ref tampering and restores managed HEAD/config safely', async () => {
    const repo = create();
    const first = await repo.sync();
    let gitdir = await activeGitdir();
    const privateRef = path.join(gitdir, 'refs', 'heads', 'daily-cf-snapshot');
    await fs.promises.unlink(privateRef);
    expect(await create().getLocalSnapshot()).toEqual(first);
    await fs.promises.writeFile(privateRef, 'ref: ../../outside.txt\n');
    expect(await create().getLocalSnapshot()).toEqual(first);
    const outside = path.join(directory, 'outside.txt');
    await fs.promises.writeFile(outside, 'Keep this unrelated file');
    await fs.promises.writeFile(path.join(gitdir, 'HEAD'), 'ref: ../../outside.txt\n');
    await fs.promises.writeFile(path.join(gitdir, 'config'), [
      '[core]', '\tbare = true', '[remote "origin"]',
      '\tfetch = +refs/heads/*:refs/heads/daily-cf-snapshot',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[http]', '\tcorsProxy = https://attacker.invalid',
    ].join('\n'));
    expect(await repo.sync()).toEqual(first);
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('Keep this unrelated file');
    gitdir = await activeGitdir();
    expect(await fs.promises.readFile(path.join(gitdir, 'HEAD'), 'utf8')).toBe('ref: refs/heads/daily-cf-snapshot\n');
    expect(await git.getConfig({ fs, gitdir, path: 'remote.origin.url' })).toBe(remote);
    expect(await git.getConfig({ fs, gitdir, path: 'http.corsProxy' })).toBeUndefined();
    expect(await git.getConfigAll({ fs, gitdir, path: 'remote.origin.fetch' })).toEqual(['+refs/heads/*:refs/remotes/origin/*']);
    await fs.promises.writeFile(path.join(gitdir, 'config'), '');
    await fs.promises.writeFile(path.join(gitdir, 'HEAD'), '');
    expect(await repo.sync()).toEqual(first);
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
  }, 30_000);

  it('replaces a corrupt active pointer without deleting older generations or mixing pinned revisions', async () => {
    const repo = create();
    const first = await repo.sync();
    const previousGitdir = await activeGitdir();
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    const latest = await fixture.publishFiles({ 'README.md': null, 'new.txt': 'Fresh generation' });
    await fs.promises.writeFile(path.join(directory, 'daily-cf-active.json'), '{broken pointer');
    expect((await repo.sync()).revision).toBe(latest);
    expect(await activeGitdir()).not.toBe(previousGitdir);
    expect((await fs.promises.lstat(previousGitdir)).isDirectory()).toBe(true);
    expect(await repo.readFile(latest, 'README.md', 1024)).toBeNull();
    expect(await repo.readFile(latest, 'new.txt', 1024)).toBe('Fresh generation');
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect(await create().getLocalSnapshot()).toMatchObject({ revision: latest });
  }, 30_000);

  it('does not publish a failed repair or retry its network request indefinitely', async () => {
    const first = await create().sync();
    const previousGitdir = await activeGitdir();
    const pointerPath = path.join(directory, 'daily-cf-active.json');
    const previousPointer = await fs.promises.readFile(pointerPath, 'utf8');
    const previousGenerations = (await fs.promises.readdir(directory)).filter(name => /^objects-.*\.git$/.test(name)).sort();
    const { pack } = await packFiles(previousGitdir);
    await fs.promises.writeFile(pack, Buffer.from('damaged pack'));
    const offlineFetch = vi.fn(async () => { throw new TypeError('offline during repair'); });
    await expect(create({ fetch: offlineFetch }).sync()).rejects.toMatchObject({ code: 'sync_network' });
    expect(offlineFetch).toHaveBeenCalledTimes(1);
    expect(await fs.promises.readFile(pointerPath, 'utf8')).toBe(previousPointer);
    expect((await fs.promises.readdir(directory)).filter(name => /^objects-.*\.git$/.test(name)).sort()).toEqual(previousGenerations);
    expect(await fs.promises.readFile(pack, 'utf8')).toBe('damaged pack');
    expect(await create().sync()).toEqual(first);
    expect(await activeGitdir()).not.toBe(previousGitdir);
  }, 30_000);

  it('isolates an internal pack-directory junction without changing its external target', async () => {
    const repo = create();
    const first = await repo.sync();
    const previousGitdir = await activeGitdir();
    const { pack, index } = await packFiles(previousGitdir);
    const packdir = path.dirname(pack);
    await fs.promises.unlink(pack);
    await fs.promises.unlink(index);
    await fs.promises.rmdir(packdir);
    const outside = path.join(fixture.directory, 'outside-pack-target');
    await fs.promises.mkdir(outside);
    const sentinel = path.join(outside, 'sentinel.txt');
    await fs.promises.writeFile(sentinel, 'Do not change external files');
    await fs.promises.symlink(outside, packdir, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await repo.sync()).toEqual(first);
    expect(await activeGitdir()).not.toBe(previousGitdir);
    expect(await fs.promises.readdir(outside)).toEqual(['sentinel.txt']);
    expect(await fs.promises.readFile(sentinel, 'utf8')).toBe('Do not change external files');
    expect((await fs.promises.lstat(packdir)).isSymbolicLink()).toBe(true);
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
  }, 30_000);

  it('rejects a managed-root junction before reading or changing its target', async () => {
    const outside = path.join(fixture.directory, 'outside-root-target');
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, 'sentinel.txt'), 'Do not touch');
    await fs.promises.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(create().sync()).rejects.toMatchObject({ code: 'sync_invalid_repository' });
    await expect(create().getLocalSnapshot()).rejects.toMatchObject({ code: 'sync_invalid_repository' });
    expect(await fs.promises.readdir(outside)).toEqual(['sentinel.txt']);
    expect(await fs.promises.readFile(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('Do not touch');
    expect(fetcher).not.toHaveBeenCalled();
  }, 20_000);

  it('reads an existing legacy objects.git and migrates by creating a separate generation', async () => {
    const first = await create().sync();
    const previousGitdir = await activeGitdir();
    const legacyGitdir = path.join(directory, 'objects.git');
    // Both rename targets are immediate children of this fixture's managed root.
    expect(path.dirname(previousGitdir)).toBe(path.resolve(directory));
    expect(path.dirname(legacyGitdir)).toBe(path.resolve(directory));
    await fs.promises.rename(previousGitdir, legacyGitdir);
    await fs.promises.unlink(path.join(directory, 'daily-cf-active.json'));
    const config = await fs.promises.readFile(path.join(legacyGitdir, 'config'));
    const head = await fs.promises.readFile(path.join(legacyGitdir, 'HEAD'));
    const { pack } = await packFiles(legacyGitdir);
    const packBytes = await fs.promises.readFile(pack);
    vi.mocked(fetcher).mockClear();
    const repo = create();
    expect(await repo.getLocalSnapshot()).toMatchObject({ revision: first.revision });
    expect(await repo.readFile(first.revision, 'README.md', 1024)).toBe('Hello repository');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repo.sync()).toEqual(first);
    expect(await activeGitdir()).not.toBe(legacyGitdir);
    expect(await fs.promises.readFile(path.join(legacyGitdir, 'config'))).toEqual(config);
    expect(await fs.promises.readFile(path.join(legacyGitdir, 'HEAD'))).toEqual(head);
    expect(await fs.promises.readFile(pack)).toEqual(packBytes);
  }, 30_000);

  it('reads only regular blobs, never symlinks, gitlinks, paths outside the tree, or oversized content', async () => {
    // Construct Git entries directly; Windows does not require symlink privileges.
    const gitdir = fixture.remoteGitDir;
    const target = await git.writeBlob({ fs, gitdir, blob: Buffer.from('../../../../secret.txt') });
    const blob = await git.writeBlob({ fs, gitdir, blob: Buffer.from('12345') });
    const previous = await fixture.runGit(['rev-parse', 'HEAD']);
    const tree = await git.writeTree({ fs, gitdir, tree: [
      { mode: '120000', type: 'blob', path: 'link', oid: target },
      { mode: '160000', type: 'commit', path: 'module', oid: previous },
      { mode: '100755', type: 'blob', path: 'script', oid: blob },
    ] });
    const revision = await git.writeCommit({ fs, gitdir, commit: { tree, parent: [previous], message: 'unusual modes\n', author: { name: 'Fixture', email: 'fixture@example.invalid', timestamp: 1, timezoneOffset: 0 }, committer: { name: 'Fixture', email: 'fixture@example.invalid', timestamp: 1, timezoneOffset: 0 } } });
    await git.writeRef({ fs, gitdir, ref: 'refs/heads/main', value: revision, force: true });
    const repo = create();
    await repo.sync();
    expect(await repo.listFiles(revision)).toEqual([{ path: 'script', mode: '100755', oid: blob }]);
    expect(await repo.readFile(revision, 'link', 100)).toBeNull();
    expect(await repo.readFile(revision, 'link/secret.txt', 100)).toBeNull();
    expect(await repo.readFile(revision, 'module', 100)).toBeNull();
    await expect(repo.readFile(revision, 'script', 4)).rejects.toMatchObject({ code: 'sync_too_large' });
    expect(await repo.readFile(revision, 'script', 5)).toBe('12345');
    for (const invalid of ['../secret', '/secret', 'a//b', 'a/./b', 'a\\b', 'a\u0000b']) {
      await expect(repo.readFile(revision, invalid, 100)).rejects.toMatchObject({ code: 'sync_invalid_path' });
    }
    await expect(repo.listFiles('main')).rejects.toMatchObject({ code: 'sync_invalid_path' });
    await expect(repo.readFile(revision, 'script', -1)).rejects.toMatchObject({ code: 'sync_invalid_path' });
  }, 20_000);
});
