import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PromiseFsClient } from 'isomorphic-git';

const MARKER = 'daily-cf-repository.json';
const POINTER = 'daily-cf-active.json';
const SNAPSHOT_REF = 'refs/heads/daily-cf-snapshot';
const GENERATION = /^objects-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.git$/;

export type GitStoreErrorCode = 'unsafe_root' | 'git_store_corrupt';
export class GitStoreError extends Error {
  constructor(message: string, readonly code: GitStoreErrorCode) { super(message); this.name = 'GitStoreError'; }
}
export interface GitStoreSnapshot { revision: string; branch: string; }
export interface GitStoreContext {
  id: string;
  gitdir: string;
  legacy: boolean;
  fs: PromiseFsClient;
  snapshot?: GitStoreSnapshot;
}

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}
function validSnapshot(value: unknown): value is GitStoreSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as GitStoreSnapshot;
  return typeof snapshot.revision === 'string' && /^[0-9a-f]{40}$/.test(snapshot.revision)
    && typeof snapshot.branch === 'string' && snapshot.branch.length > 0 && snapshot.branch.length <= 1024
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(snapshot.branch) && !snapshot.branch.includes('..')
    && !snapshot.branch.includes('@{') && !snapshot.branch.endsWith('/') && !snapshot.branch.startsWith('/');
}
function unsafe(message: string, code: GitStoreErrorCode): never { throw new GitStoreError(message, code); }

/** No operation follows filesystem links. Writes replace an exclusively created
 * sibling file, rather than opening an existing destination for truncation. */
class CheckedFiles {
  constructor(readonly root: string, readonly code: GitStoreErrorCode, private readonly track?: (input: string, removed?: boolean) => void) {}

  resolve(input: string): string {
    if (typeof input !== 'string' || input.includes('\0')) unsafe('Invalid local repository path.', this.code);
    const absolute = path.resolve(input);
    const relative = path.relative(this.root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) unsafe('Repository path escapes its directory.', this.code);
    // Windows alternate data streams and device aliases must not bypass checks.
    if (relative.split(path.sep).some(part => /[:\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) unsafe('Invalid local repository path.', this.code);
    return absolute;
  }

  async check(input: string, missing = false): Promise<fs.Stats | null> {
    const absolute = this.resolve(input);
    try {
      const actualRoot = await fs.promises.realpath(this.root);
      const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
      if (canonical(actualRoot) !== canonical(this.root)) unsafe('Local repository directory has a linked parent.', this.code);
    } catch (error) {
      if (errno(error) === 'ELOOP') unsafe('Local repository has a filesystem link cycle.', this.code);
      if (missing && errno(error) === 'ENOENT') return null;
      throw error;
    }
    const segments = path.relative(this.root, absolute).split(path.sep).filter(Boolean);
    let current = this.root;
    let result: fs.Stats | null = null;
    for (let index = -1; index < segments.length; index += 1) {
      if (index >= 0) current = path.join(current, segments[index]);
      try { result = await fs.promises.lstat(current); }
      catch (error) { if (missing && errno(error) === 'ENOENT') return null; throw error; }
      if (result.isSymbolicLink() || (!result.isDirectory() && (!result.isFile() || result.nlink !== 1))) unsafe('Local repository contains a filesystem link or unsupported entry.', this.code);
      if (index < segments.length - 1 && !result.isDirectory()) unsafe('Local repository parent is not a directory.', this.code);
    }
    return result;
  }

  async readFile(input: string, options?: Parameters<typeof fs.promises.readFile>[1]): Promise<Buffer | string> {
    const before = await this.check(input);
    if (!before?.isFile()) unsafe('Local repository entry is not a regular file.', this.code);
    const handle = await fs.promises.open(this.resolve(input), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.nlink !== 1 || actual.ino !== before.ino || actual.dev !== before.dev) unsafe('Local repository changed during access.', this.code);
      return await handle.readFile(options ?? {});
    } finally { await handle.close(); }
  }

  async mkdir(input: string): Promise<void> {
    const absolute = this.resolve(input);
    const segments = path.relative(this.root, absolute).split(path.sep).filter(Boolean);
    await this.check(this.root);
    let current = this.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try { await fs.promises.mkdir(current); }
      catch (error) { if (errno(error) !== 'EEXIST') throw error; }
      if (!(await this.check(current))?.isDirectory()) unsafe('Local repository parent is not a directory.', this.code);
      this.track?.(current);
    }
  }

  async writeAtomic(input: string, contents: string | NodeJS.ArrayBufferView, options?: Parameters<typeof fs.promises.writeFile>[2], replacePointerLink = false): Promise<void> {
    const destination = this.resolve(input);
    if (destination === this.root) unsafe('Cannot replace the repository directory.', this.code);
    await this.check(path.dirname(destination));
    const checkDestination = async (): Promise<fs.Stats | null> => {
      if (!replacePointerLink) return this.check(destination, true);
      // This exception is used only for the fixed active-pointer entry. Rename
      // replaces a link itself; it never reads or writes the link target.
      let stat: fs.Stats;
      try { stat = await fs.promises.lstat(destination); }
      catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
      if (!stat.isFile() && !stat.isSymbolicLink()) unsafe('Repository pointer cannot replace a directory.', this.code);
      return stat;
    };
    const existing = await checkDestination();
    if (existing && !existing.isFile() && !(replacePointerLink && existing.isSymbolicLink())) unsafe('Local repository destination is not a regular file.', this.code);
    const settings = typeof options === 'string' ? { encoding: options } : options ?? {};
    if (typeof settings === 'object' && 'flag' in settings && settings.flag && settings.flag !== 'w' && settings.flag !== 'wx') unsafe('Unsupported repository write mode.', this.code);
    if (existing && typeof settings === 'object' && 'flag' in settings && settings.flag === 'wx') throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
    const temporary = path.join(path.dirname(destination), `.daily-cf-write-${randomUUID()}`);
    let created = false;
    try {
      const handle = await fs.promises.open(temporary, 'wx', 0o600);
      created = true;
      try { await handle.writeFile(contents, settings as Parameters<typeof handle.writeFile>[1]); await handle.sync(); }
      finally { await handle.close(); }
      await this.check(path.dirname(destination));
      await this.check(temporary);
      await checkDestination();
      if (typeof settings === 'object' && 'flag' in settings && settings.flag === 'wx') {
        // Linking a complete fresh file provides exclusive final publication;
        // rename would overwrite a concurrently created ownership marker.
        await fs.promises.link(temporary, destination);
        await fs.promises.unlink(temporary);
      } else {
        await fs.promises.rename(temporary, destination);
      }
      created = false;
      this.track?.(destination);
    } finally {
      if (created) {
        // Only our fresh temporary file is eligible for cleanup; never recurse.
        try { await this.check(temporary); await fs.promises.unlink(temporary); }
        catch (error) { if (errno(error) !== 'ENOENT') throw error; }
      }
    }
  }

  async entries(input: string): Promise<string[]> {
    if (!(await this.check(input))?.isDirectory()) unsafe('Local repository entry is not a directory.', this.code);
    return fs.promises.readdir(this.resolve(input));
  }

  async scan(input = this.root): Promise<void> {
    const pending = [input];
    let entries = 0;
    while (pending.length) {
      const next = pending.pop()!;
      const stat = await this.check(next);
      if (++entries > 1_000_000) unsafe('Local repository has too many filesystem entries.', this.code);
      if (stat?.isDirectory()) for (const entry of await this.entries(next)) pending.push(path.join(next, entry));
    }
  }

  client(readonly: boolean): PromiseFsClient {
    const writable = (input: string): string => {
      const absolute = this.resolve(input);
      const relative = path.relative(this.root, absolute).split(path.sep).join('/');
      if (readonly || !(relative === 'objects' || relative.startsWith('objects/') || relative === 'refs' || relative === 'refs/remotes' || relative === 'refs/remotes/origin' || relative.startsWith('refs/remotes/origin/') || ['FETCH_HEAD', 'shallow', 'shallow.lock'].includes(relative))) unsafe('Repository write is outside the fetch storage area.', this.code);
      return absolute;
    };
    return { promises: {
      readFile: this.readFile.bind(this),
      writeFile: async (input: string, contents: string | NodeJS.ArrayBufferView, options?: Parameters<typeof fs.promises.writeFile>[2]) => this.writeAtomic(writable(input), contents, options),
      stat: async (input: string) => this.check(input),
      lstat: async (input: string) => this.check(input),
      readdir: this.entries.bind(this),
      mkdir: async (input: string) => { if (this.resolve(input) === this.root) { await this.check(input); return; } await this.mkdir(writable(input)); },
      unlink: async (input: string) => { const absolute = writable(input); if (!(await this.check(absolute))?.isFile()) unsafe('Cannot unlink repository directory.', this.code); await fs.promises.unlink(absolute); this.track?.(absolute, true); },
      rmdir: async (input: string, options?: { recursive?: boolean }) => { const absolute = writable(input); if (options?.recursive) unsafe('Recursive deletion is not allowed.', this.code); await this.check(absolute); await fs.promises.rmdir(absolute); this.track?.(absolute, true); },
      readlink: async () => unsafe('Filesystem links are not allowed in the repository.', this.code),
      symlink: async () => unsafe('Filesystem links are not allowed in the repository.', this.code),
    } };
  }
}

/** Generation names and the root marker establish ownership. Old generations
 * and unrecognised files are never removed by this store. */
export class GitStore {
  readonly root: string;
  private readonly rootFiles: CheckedFiles;
  private readonly created = new Map<string, { paths: Set<string>; published: boolean }>();
  constructor(root: string, readonly repository: string) {
    this.root = path.resolve(root);
    this.rootFiles = new CheckedFiles(this.root, 'unsafe_root');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) unsafe('Invalid repository identity.', 'unsafe_root');
  }

  private async checkAncestors(): Promise<void> {
    const parsed = path.parse(this.root);
    let current = parsed.root;
    for (const segment of this.root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) unsafe('Repository root must have real directory parents.', 'unsafe_root');
      } catch (error) { if (errno(error) === 'ENOENT') return; throw error; }
    }
  }

  private async identity(): Promise<boolean> {
    await this.checkAncestors();
    if (!(await this.rootFiles.check(this.root, true))) return false;
    const marker = path.join(this.root, MARKER);
    const markerStat = await this.rootFiles.check(marker, true);
    if (!markerStat) {
      if ((await this.rootFiles.entries(this.root)).length) unsafe('Repository directory contains unowned files.', 'unsafe_root');
      return false;
    }
    if (markerStat.size > 16_384) unsafe('Repository ownership marker is too large.', 'unsafe_root');
    let value: unknown;
    try { value = JSON.parse(String(await this.rootFiles.readFile(marker, 'utf8'))); }
    catch (error) { if (error instanceof SyntaxError) unsafe('Repository ownership marker is invalid.', 'unsafe_root'); throw error; }
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('repository' in value) || value.repository !== this.repository) unsafe('Repository directory belongs to a different repository.', 'unsafe_root');
    return true;
  }

  async ensureRoot(): Promise<void> {
    if (await this.identity()) return;
    await fs.promises.mkdir(this.root, { recursive: true });
    await this.checkAncestors();
    if ((await this.rootFiles.entries(this.root)).length) {
      if (await this.identity()) return;
      unsafe('Repository directory contains unowned files.', 'unsafe_root');
    }
    await this.rootFiles.writeAtomic(path.join(this.root, MARKER), JSON.stringify({ version: 1, repository: this.repository }), { flag: 'wx' });
  }

  private context(id: string, snapshot?: GitStoreSnapshot): GitStoreContext {
    if (id !== 'objects.git' && !GENERATION.test(id)) unsafe('Invalid repository generation.', 'git_store_corrupt');
    const gitdir = path.join(this.root, id);
    return { id, gitdir, legacy: id === 'objects.git', fs: this.files(id).client(id === 'objects.git'), snapshot };
  }

  private files(id: string): CheckedFiles {
    const gitdir = path.join(this.root, id);
    return new CheckedFiles(gitdir, 'git_store_corrupt', (input, removed) => {
      const owned = this.created.get(id);
      if (!owned || owned.published) return;
      const relative = path.relative(gitdir, input);
      if (removed) owned.paths.delete(relative); else owned.paths.add(relative);
    });
  }

  private validateContext(context: GitStoreContext): CheckedFiles {
    if ((context.id !== 'objects.git' && !GENERATION.test(context.id)) || context.gitdir !== path.join(this.root, context.id) || context.legacy !== (context.id === 'objects.git')) unsafe('Repository context belongs to another store.', 'git_store_corrupt');
    return this.files(context.id);
  }

  async open(): Promise<GitStoreContext | null> {
    if (!(await this.identity())) return null;
    const metadata = new CheckedFiles(this.root, 'git_store_corrupt');
    const pointer = path.join(this.root, POINTER);
    if (await metadata.check(pointer, true)) {
      let value: unknown;
      try {
        if ((await metadata.check(pointer))!.size > 16_384) unsafe('Repository pointer is too large.', 'git_store_corrupt');
        value = JSON.parse(String(await metadata.readFile(pointer, 'utf8')));
      } catch (error) { if (error instanceof SyntaxError) unsafe('Repository pointer is invalid.', 'git_store_corrupt'); throw error; }
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('repository' in value) || value.repository !== this.repository || !('generation' in value) || typeof value.generation !== 'string' || !GENERATION.test(value.generation) || !validSnapshot(value)) unsafe('Repository pointer is invalid.', 'git_store_corrupt');
      const context = this.context(value.generation, { revision: value.revision, branch: value.branch });
      if (!(await metadata.check(context.gitdir, true))?.isDirectory()) unsafe('Repository generation is missing.', 'git_store_corrupt');
      return context;
    }
    const legacy = this.context('objects.git');
    if (!(await metadata.check(legacy.gitdir, true))) return null;
    const files = this.validateContext(legacy);
    const snapshotFile = path.join(legacy.gitdir, SNAPSHOT_REF);
    const snapshotStat = await files.check(snapshotFile, true);
    if (snapshotStat) {
      if (snapshotStat.size > 128) unsafe('Legacy repository snapshot is invalid.', 'git_store_corrupt');
      const revision = String(await files.readFile(snapshotFile, 'utf8')).trim();
      if (!validSnapshot({ revision, branch: 'daily-cf-snapshot' })) unsafe('Legacy repository snapshot is invalid.', 'git_store_corrupt');
      legacy.snapshot = { revision, branch: 'daily-cf-snapshot' };
    }
    return legacy;
  }

  async create(): Promise<GitStoreContext> {
    await this.ensureRoot();
    const context = this.context(`objects-${randomUUID()}.git`);
    await fs.promises.mkdir(context.gitdir);
    this.created.set(context.id, { paths: new Set(['']), published: false });
    try {
      const files = this.validateContext(context);
      for (const directory of ['objects/pack', 'objects/info', 'refs/heads', 'refs/remotes/origin']) await files.mkdir(path.join(context.gitdir, directory));
      await this.prepare(context);
      return context;
    } catch (error) { await this.dispose(context).catch(() => false); throw error; }
  }

  async prepare(context: GitStoreContext): Promise<void> {
    if (!(await this.identity())) unsafe('Missing repository ownership marker.', 'unsafe_root');
    if (context.legacy) unsafe('Legacy repository storage is read-only.', 'git_store_corrupt');
    const files = this.validateContext(context);
    await files.scan();
    await files.writeAtomic(path.join(context.gitdir, 'config'), `[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n[remote "origin"]\n\turl = https://github.com/${this.repository}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    await files.writeAtomic(path.join(context.gitdir, 'HEAD'), `ref: ${SNAPSHOT_REF}\n`);
    await files.writeAtomic(path.join(context.gitdir, 'packed-refs'), '');
    const shallow = path.join(context.gitdir, 'shallow');
    const shallowStat = await files.check(shallow, true);
    if (shallowStat) {
      if (shallowStat.size > 4 * 1024 * 1024) unsafe('Repository shallow boundary is too large.', 'git_store_corrupt');
      const content = String(await files.readFile(shallow, 'utf8'));
      if (!content.trim() || content.trim().split(/\r?\n/).some(line => !/^[0-9a-f]{40}$/.test(line))) unsafe('Repository shallow boundary is invalid.', 'git_store_corrupt');
    }
    await this.clearRemoteRefs(context, files);
    if (context.snapshot) await this.writeSnapshot(context, context.snapshot);
  }

  private async clearRemoteRefs(context: GitStoreContext, files: CheckedFiles): Promise<void> {
    const origin = path.join(context.gitdir, 'refs/remotes/origin');
    if (!(await files.check(origin, true))) return;
    const pending = [origin];
    const entries: { filename: string; directory: boolean }[] = [];
    while (pending.length) {
      const filename = pending.pop()!;
      const stat = (await files.check(filename))!;
      entries.push({ filename, directory: stat.isDirectory() });
      if (stat.isDirectory()) for (const name of await files.entries(filename)) pending.push(path.join(filename, name));
      else {
        if (stat.size > 2048) unsafe('Remote reference is invalid.', 'git_store_corrupt');
        const value = String(await files.readFile(filename, 'utf8')).trim();
        const prefix = 'ref: refs/remotes/origin/';
        const symbolic = value.startsWith(prefix) && validSnapshot({ revision: '0'.repeat(40), branch: value.slice(prefix.length) });
        if (!/^[0-9a-f]{40}$/.test(value) && !symbolic) unsafe('Remote reference is invalid.', 'git_store_corrupt');
      }
    }
    // Remove only validated, replaceable origin refs. Immutable objects and the
    // private snapshot ref are untouched, including across branch-name changes.
    for (const { filename, directory } of entries.reverse()) {
      await files.check(filename);
      if (directory) await fs.promises.rmdir(filename); else await fs.promises.unlink(filename);
      this.created.get(context.id)?.paths.delete(path.relative(context.gitdir, filename));
    }
    await files.mkdir(origin);
  }

  async stageFrom(source: GitStoreContext, snapshot = source.snapshot): Promise<GitStoreContext> {
    if (!(await this.identity())) unsafe('Missing repository ownership marker.', 'unsafe_root');
    const sourceFiles = this.validateContext(source);
    await sourceFiles.scan();
    const destination = await this.create();
    try {
      const targetFiles = this.validateContext(destination);
      const pending = ['objects'];
      while (pending.length) {
        const relative = pending.pop()!;
        const input = path.join(source.gitdir, relative);
        const stat = await sourceFiles.check(input, true);
        if (!stat) continue;
        const output = path.join(destination.gitdir, relative);
        if (stat.isDirectory()) {
          await targetFiles.mkdir(output);
          for (const entry of await sourceFiles.entries(input)) pending.push(path.join(relative, entry));
        } else {
          await targetFiles.writeAtomic(output, await sourceFiles.readFile(input));
        }
      }
      const shallow = path.join(source.gitdir, 'shallow');
      const shallowStat = await sourceFiles.check(shallow, true);
      if (shallowStat) {
        if (shallowStat.size > 4 * 1024 * 1024) unsafe('Legacy shallow boundary is too large.', 'git_store_corrupt');
        const content = String(await sourceFiles.readFile(shallow, 'utf8'));
        if (!content.trim() || content.trim().split(/\r?\n/).some(line => !/^[0-9a-f]{40}$/.test(line))) unsafe('Legacy shallow boundary is invalid.', 'git_store_corrupt');
        await targetFiles.writeAtomic(path.join(destination.gitdir, 'shallow'), content);
      }
      if (snapshot) { await this.writeSnapshot(destination, snapshot); destination.snapshot = { ...snapshot }; }
      return destination;
    } catch (error) { await this.dispose(destination).catch(() => false); throw error; }
  }

  private async writeSnapshot(context: GitStoreContext, snapshot: GitStoreSnapshot): Promise<void> {
    if (context.legacy || !validSnapshot(snapshot)) unsafe('Invalid repository snapshot.', 'git_store_corrupt');
    const files = this.validateContext(context);
    await files.mkdir(path.join(context.gitdir, 'refs/heads'));
    await files.writeAtomic(path.join(context.gitdir, SNAPSHOT_REF), `${snapshot.revision}\n`);
  }

  async publish(context: GitStoreContext, snapshot: GitStoreSnapshot): Promise<void> {
    if (!(await this.identity())) unsafe('Missing repository ownership marker.', 'unsafe_root');
    await this.writeSnapshot(context, snapshot);
    const metadata = new CheckedFiles(this.root, 'git_store_corrupt');
    await metadata.writeAtomic(path.join(this.root, POINTER), JSON.stringify({ version: 1, repository: this.repository, generation: context.id, ...snapshot }), undefined, true);
    const created = this.created.get(context.id);
    if (created) { created.published = true; created.paths.clear(); }
    context.snapshot = { ...snapshot };
  }

  /** Best-effort disposal is restricted to generations created by this instance
   * and never published. Any unknown file or unsafe pointer leaves it intact. */
  async dispose(context: GitStoreContext): Promise<boolean> {
    const owned = this.created.get(context.id);
    if (!owned || owned.published || context.legacy) return false;
    if (!(await this.identity())) return false;
    const files = this.validateContext(context);
    const pointer = path.join(this.root, POINTER);
    const metadata = new CheckedFiles(this.root, 'git_store_corrupt');
    try {
      const stat = await metadata.check(pointer, true);
      if (stat) {
        if (!stat.isFile() || stat.size > 16_384) return false;
        let value: unknown;
        try { value = JSON.parse(String(await metadata.readFile(pointer, 'utf8'))); }
        catch (error) { if (error instanceof SyntaxError) return false; throw error; }
        if (!value || typeof value !== 'object' || !('generation' in value) || value.generation === context.id) return false;
      }
      const pending = [context.gitdir];
      const entries: { filename: string; directory: boolean }[] = [];
      while (pending.length) {
        const filename = pending.pop()!;
        if (!owned.paths.has(path.relative(context.gitdir, filename))) return false;
        const stat = await files.check(filename, true);
        if (!stat) continue;
        entries.push({ filename, directory: stat.isDirectory() });
        if (stat.isDirectory()) for (const name of await files.entries(filename)) pending.push(path.join(filename, name));
      }
      for (const { filename, directory } of entries.reverse()) {
        await files.check(filename);
        if (directory) await fs.promises.rmdir(filename); else await fs.promises.unlink(filename);
      }
      this.created.delete(context.id);
      return true;
    } catch (error) { if (error instanceof GitStoreError) return false; throw error; }
  }
}
