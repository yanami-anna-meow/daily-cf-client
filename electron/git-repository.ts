import path from 'node:path';
import git, { type HttpClient } from 'isomorphic-git';
import lockfile from 'proper-lockfile';
import { t } from '../shared/i18n';
import { UPSTREAM, type LibrarySyncProgress } from '../shared/types';
import { GitIntegrity, GitIntegrityError, type IntegrityProof, type VerifiedCommit, type VerifiedTree } from './git-integrity';
import { GitStore, type GitStoreContext } from './git-store';

const SNAPSHOT_REF = 'refs/heads/daily-cf-snapshot';
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 500_000;
const SYNC_TIMEOUT_MS = 180_000;
const MAX_CACHED_COMMITS = 128;
const MAX_CACHED_TREES = 8192;

export interface GitSnapshot { branch: string; revision: string; }
export interface GitRepositoryFile { path: string; oid: string; mode: string; }
export interface GitRepositoryOptions {
  repository?: string;
  onProgress?: (progress: LibrarySyncProgress) => void;
  /** Injection for deterministic local HTTP tests; never receives account credentials. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxDownloadBytes?: number;
}
export type GitRepositoryErrorCode = 'sync_timeout' | 'sync_network' | 'sync_busy' | 'sync_invalid_repository' | 'sync_too_large' | 'sync_invalid_path' | 'sync_local_error';
export class GitRepositoryError extends Error {
  constructor(message: string, readonly code: GitRepositoryErrorCode) {
    super(message);
    this.name = 'GitRepositoryError';
  }
}

interface SyncFlight {
  repository: string;
  owner: GitRepository;
  promise: Promise<GitSnapshot>;
  listeners: Set<(progress: LibrarySyncProgress) => void>;
  progress?: LibrarySyncProgress;
}
interface ReadContext {
  store: GitStoreContext;
  integrity: GitIntegrity;
  reader?: GitIntegrity;
  capturing?: Promise<GitIntegrity>;
  objectCache: object;
  proof?: IntegrityProof;
  commits: Map<string, Promise<VerifiedCommit>>;
  trees: Map<string, Promise<VerifiedTree>>;
}
// Share only a currently running transfer. A completed sync is never reused by
// the next read operation, even when its remote HEAD has not changed.
const flights = new Map<string, SyncFlight>();

function validOid(value: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new GitRepositoryError(t('题库版本无效，请刷新后重试。'), 'sync_invalid_path');
  }
}
function validPath(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 16_384 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new GitRepositoryError(t('题库文件路径无效。'), 'sync_invalid_path');
  }
}
function regularFile(mode: string): boolean { return mode === '100644' || mode === '100755'; }
function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}
function notify(listener: (progress: LibrarySyncProgress) => void, progress: LibrarySyncProgress): void {
  try { listener(progress); } catch { /* A renderer notification cannot fail the repository transfer. */ }
}

/** A public, read-only Git object store. Nothing from the remote is checked out. */
export class GitRepository {
  readonly directory: string;
  private readonly store: GitStore;
  private readonly repository: string;
  private readonly url: string;
  private readonly options: GitRepositoryOptions;
  // Git pack indexes and immutable objects are addressed by SHA. This is an
  // implementation detail of the local clone, never an HTTP response cache.
  private readonly contexts = new Map<string, ReadContext>();
  private readonly revisions = new Map<string, ReadContext>();

  constructor(directory: string, options: GitRepositoryOptions = {}) {
    this.directory = path.resolve(directory);
    this.repository = options.repository ?? `${UPSTREAM.owner}/${UPSTREAM.repo}`;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repository)
      || this.repository.split('/').some(part => part === '.' || part === '..')) {
      throw new GitRepositoryError(t('题库仓库地址无效。'), 'sync_invalid_repository');
    }
    this.url = `https://github.com/${this.repository}.git`;
    this.options = options;
    this.store = new GitStore(this.directory, this.repository);
  }

  sync(): Promise<GitSnapshot> {
    // Windows paths are case insensitive. Resolve aliases through realpath in
    // the OS lock as well; the map is just the inexpensive common-case join.
    const key = process.platform === 'win32' ? this.directory.toLowerCase() : this.directory;
    const existing = flights.get(key);
    if (existing) {
      if (existing.repository !== this.repository) return Promise.reject(new GitRepositoryError(t('题库目录已属于另一个仓库。'), 'sync_invalid_repository'));
      if (this.options.onProgress) {
        existing.listeners.add(this.options.onProgress);
        if (existing.progress) notify(this.options.onProgress, existing.progress);
      }
      return existing.promise.then(snapshot => {
        const context = existing.owner.revisions.get(snapshot.revision);
        if (context) this.remember(snapshot.revision, context);
        return snapshot;
      });
    }
    const listeners = new Set<(progress: LibrarySyncProgress) => void>();
    if (this.options.onProgress) listeners.add(this.options.onProgress);
    const flight: SyncFlight = { repository: this.repository, owner: this, listeners, promise: undefined! };
    flights.set(key, flight);
    flight.promise = this.performSync(progress => {
      flight.progress = progress;
      for (const listener of flight.listeners) notify(listener, progress);
    }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
    return flight.promise;
  }

  /** Read the last fully published commit without creating files or contacting
   * the remote. The active pointer changes only after the complete snapshot
   * has verified; readers capture one generation even during a repair.
   */
  async getLocalSnapshot(): Promise<GitSnapshot | null> {
    try {
      const selected = await this.store.open();
      if (!selected?.snapshot) return null;
      const { revision, branch } = selected.snapshot;
      const context = this.context(selected);
      const { reader, cache } = await this.readView(context);
      const { commit } = await this.readCommit(context, revision, cache, reader);
      await this.readTree(context, commit.tree, cache, reader);
      // A delayed preview may belong to a generation repaired while its disk
      // reads were in flight. Only a completed sync may replace that mapping.
      if (!this.revisions.has(revision)) this.remember(revision, context);
      return { branch, revision };
    } catch (error) { throw this.readError(error); }
  }

  private context(selected: GitStoreContext): ReadContext {
    let context = this.contexts.get(selected.id);
    if (!context || context.store.gitdir !== selected.gitdir) {
      context = { store: selected, integrity: new GitIntegrity(selected.gitdir, selected.fs), objectCache: {}, commits: new Map(), trees: new Map() };
      this.contexts.set(selected.id, context);
      while (this.contexts.size > 8) this.contexts.delete(this.contexts.keys().next().value!);
    }
    return context;
  }

  private remember(revision: string, context: ReadContext): void {
    this.contexts.delete(context.store.id);
    this.contexts.set(context.store.id, context);
    this.revisions.delete(revision);
    this.revisions.set(revision, context);
    while (this.revisions.size > 128) this.revisions.delete(this.revisions.keys().next().value!);
    // Retain only a few generations of immutable pack bytes. Already-running
    // readers keep their own context; eviction never redirects a pinned read.
    while (this.contexts.size > 4) {
      const oldest = this.contexts.keys().next().value!;
      const discarded = this.contexts.get(oldest)!;
      this.contexts.delete(oldest);
      for (const [sha, held] of this.revisions) if (held === discarded) this.revisions.delete(sha);
    }
  }

  private async reader(context: ReadContext): Promise<GitIntegrity> {
    if (context.reader) return context.reader;
    if (!context.capturing) {
      const pending = context.integrity.capture().then(reader => {
        // A completed sync may already have published a newer capture.
        if (!context.reader) context.reader = reader;
        return reader;
      }).finally(() => { if (context.capturing === pending) context.capturing = undefined; });
      context.capturing = pending;
    }
    return context.capturing;
  }

  private async readView(context: ReadContext): Promise<{ reader: GitIntegrity; cache: object }> {
    const reader = await this.reader(context);
    // Keep a reader and its pack cache paired for this entire operation, even
    // if sync publishes a newer immutable capture between two tree reads.
    return { reader, cache: context.reader === reader ? context.objectCache : {} };
  }

  private async contextFor(revision: string): Promise<ReadContext> {
    const remembered = this.revisions.get(revision);
    if (remembered) return remembered;
    const selected = await this.store.open();
    const published = this.revisions.get(revision);
    if (published) return published;
    if (!selected) throw new GitRepositoryError(t('本地题库版本缺失，请同步后重试。'), 'sync_local_error');
    const context = this.context(selected);
    this.remember(revision, context);
    return context;
  }

  private isCorrupt(error: unknown): boolean {
    return errorCode(error) === 'git_local_corrupt' || errorCode(error) === 'git_store_corrupt';
  }

  private readError(error: unknown): unknown {
    if (errorCode(error) === 'git_integrity_too_large') {
      const failure = new GitRepositoryError(t('本地题库超过当前支持的大小，请联系开发者。'), 'sync_too_large');
      failure.cause = error;
      return failure;
    }
    if (this.isCorrupt(error) || errorCode(error) === 'unsafe_root') {
      const failure = new GitRepositoryError(errorCode(error) === 'unsafe_root'
        ? t('本地题库目录不安全，已停止同步；请检查目录中的链接和仓库标识。')
        : t('本地题库已被修改，无法读取该版本，请刷新后重试。'), errorCode(error) === 'unsafe_root' ? 'sync_invalid_repository' : 'sync_local_error');
      failure.cause = error;
      return failure;
    }
    return error;
  }

  private async performSync(emit: (progress: LibrarySyncProgress) => void): Promise<GitSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? SYNC_TIMEOUT_MS);
    let release: (() => Promise<void>) | undefined;
    let compromised = false;
    let transferFailure: GitRepositoryError | undefined;
    let repairing = false;
    const candidates: GitStoreContext[] = [];
    let lastProgress = 0;
    let lastPhase = '';
    const progress = (event: LibrarySyncProgress): void => {
      if (event.phase !== lastPhase || Date.now() - lastProgress >= 100 || event.phase === 'ready' || event.phase === 'error') {
        lastProgress = Date.now(); lastPhase = event.phase; emit(event);
      }
    };
    progress({ phase: 'checking', completed: 0, unit: 'objects' });
    try {
      // Validate every ancestor before creating the managed directory or its
      // lock, so a parent junction cannot redirect even this initial write.
      await this.store.ensureRoot();
      try {
        release = await lockfile.lock(this.directory, {
          // Longer than the worker host's hard deadline: a CPU-heavy pack
          // indexing step must never make another process steal a live lock.
          realpath: true, retries: 0, stale: 240_000, update: 5_000,
          onCompromised: () => { compromised = true; controller.abort(); },
        });
      } catch (error) {
        if (errorCode(error) === 'ELOCKED') throw new GitRepositoryError(t('题库正在被其他同步任务使用。如果上次同步异常退出，请稍后重试。'), 'sync_busy');
        throw error;
      }
      await this.store.ensureRoot();
      try {
        return await this.syncStore(await this.store.open(), controller, progress,
          error => { transferFailure = error; }, () => compromised, candidates);
      } catch (error) {
        if (!this.isCorrupt(error) || controller.signal.aborted || compromised) throw error;
        // The failed generation is retained. A fresh public clone is published
        // only after its full reachable snapshot has independently verified.
        repairing = true;
        transferFailure = undefined;
        progress({ phase: 'repairing', completed: 0, unit: 'objects' });
        const replacement = await this.store.create();
        candidates.push(replacement);
        return await this.syncStore(replacement, controller, progress,
          error => { transferFailure = error; }, () => compromised, candidates);
      }
    } catch (error) {
      const failure = compromised ? new GitRepositoryError(t('题库同步锁已失效，请稍后重试。'), 'sync_busy')
        : controller.signal.aborted ? new GitRepositoryError(t('题库同步超时，请检查网络后重试。'), 'sync_timeout')
        : transferFailure ?? (error instanceof GitRepositoryError ? error
        : errorCode(error) === 'unsafe_root'
          ? new GitRepositoryError(t('本地题库目录不安全，已停止同步；请检查目录中的链接和仓库标识。'), 'sync_invalid_repository')
        : errorCode(error) === 'git_integrity_too_large'
          ? new GitRepositoryError(t('本地题库超过当前支持的大小，请联系开发者。'), 'sync_too_large')
        : this.isCorrupt(error)
          ? new GitRepositoryError(repairing ? t('本地题库已损坏，自动修复未能完成，请重试。') : t('本地题库已被修改，无法读取该版本，请刷新后重试。'), 'sync_local_error')
        : ['EACCES', 'EPERM', 'ENOSPC', 'EIO'].includes(errorCode(error) ?? '')
          ? new GitRepositoryError(t('无法写入本地题库，请检查磁盘空间和目录权限后重试。'), 'sync_local_error')
          : new GitRepositoryError(t('无法同步 GitHub 题库，请检查网络后重试。'), 'sync_network'));
      if (failure !== error) failure.cause = error;
      progress({ phase: 'error', completed: 0, unit: 'objects', message: failure.message });
      throw failure;
    } finally {
      clearTimeout(timeout);
      controller.abort();
      // Only candidates created by this attempt are eligible. The store never
      // disposes a published generation or follows an unexpected entry.
      for (const candidate of candidates) {
        try { await this.store.dispose(candidate); }
        catch { /* Cleanup cannot replace the original sync result or error. */ }
      }
      if (release) {
        try { await release(); } catch { /* A compromised lock has already been reported. */ }
      }
    }
  }

  private async syncStore(
    selected: GitStoreContext | null, controller: AbortController,
    progress: (event: LibrarySyncProgress) => void,
    transferFailed: (error: GitRepositoryError) => void,
    compromised: () => boolean,
    candidates: GitStoreContext[],
  ): Promise<GitSnapshot> {
    const checkActive = (): void => {
      if (compromised()) throw new GitRepositoryError(t('题库同步锁已失效，请稍后重试。'), 'sync_busy');
      if (controller.signal.aborted) throw new GitRepositoryError(t('题库同步超时，请检查网络后重试。'), 'sync_timeout');
    };
    checkActive();
    if (selected?.snapshot) {
      const original = this.context(selected);
      // inspect rereads actual object-store bytes even when the SHA, timestamps
      // and in-memory preview are unchanged. Only byte-identical proofs reuse
      // the previously verified full object closure.
      original.proof = await original.integrity.inspect(selected.snapshot.revision, original.proof);
      if (selected.legacy) {
        selected = await this.store.stageFrom(selected, selected.snapshot);
        candidates.push(selected);
      }
    } else if (selected?.legacy) {
      throw new GitIntegrityError('The legacy object store has no published snapshot.');
    }
    const target = selected ?? await this.store.create();
    if (!selected) candidates.push(target);
    await this.store.prepare(target);
    checkActive();
    const context = this.context(target);
    // Negotiation has a separate disposable cache. It is never handed to the
    // authenticated immutable reader used by the application.
    const cache = {};
    if (target.snapshot && context.proof?.revision !== target.snapshot.revision) {
      // A copied legacy generation has a new path and therefore needs its own
      // proof before Git uses it for negotiation. Ordinary sync already did this.
      context.proof = await context.integrity.inspect(target.snapshot.revision, context.proof);
    }
    let result: Awaited<ReturnType<typeof git.fetch>>;
    try {
      result = await git.fetch({
        fs: target.fs, http: this.http(controller, progress, transferFailed), gitdir: target.gitdir,
        url: this.url, remote: 'origin', corsProxy: '', ref: SNAPSHOT_REF, remoteRef: 'HEAD', singleBranch: true,
        depth: target.snapshot ? undefined : 1, relative: false, tags: false, cache,
        onProgress: event => {
          if (!controller.signal.aborted) progress({ phase: /Resolving|Analyzing|Indexing/i.test(event.phase) ? 'indexing' : 'downloading', completed: event.loaded, total: event.total > 0 ? event.total : undefined, unit: 'objects' });
        },
      });
    } catch (error) {
      // A transport or permission failure does not itself justify rebuilding.
      // If Git failed because its local files changed during fetch, establish
      // that fact through the independent verifier before retrying a fresh clone.
      if (target.snapshot && !controller.signal.aborted && !/^E[A-Z]+$/.test(errorCode(error) ?? '')) {
        await context.integrity.inspect(target.snapshot.revision, context.proof);
      }
      throw error;
    }
    checkActive();
    if (!result.fetchHead || !result.defaultBranch?.startsWith('refs/heads/')) {
      throw new GitRepositoryError(t('远端仓库没有可读取的默认分支。'), 'sync_invalid_repository');
    }
    validOid(result.fetchHead);
    progress({ phase: 'indexing', completed: 0, unit: 'objects' });
    const proof = await context.integrity.inspect(result.fetchHead, context.proof);
    checkActive();
    const snapshot = { branch: result.defaultBranch.slice('refs/heads/'.length), revision: result.fetchHead };
    await this.store.publish(target, snapshot);
    checkActive();
    const reader = context.integrity.reader(proof);
    if (context.reader !== reader) context.objectCache = {};
    context.reader = reader;
    context.proof = proof;
    this.remember(snapshot.revision, context);
    progress({ phase: 'ready', completed: 1, total: 1, unit: 'objects', revision: snapshot.revision, updatedAt: new Date().toISOString() });
    return snapshot;
  }

  private memoized<T>(values: Map<string, Promise<T>>, oid: string, limit: number, read: () => Promise<T>): Promise<T> {
    validOid(oid);
    const existing = values.get(oid);
    if (existing) {
      values.delete(oid);
      values.set(oid, existing);
      return existing;
    }
    const pending = Promise.resolve().then(read).catch(error => {
      if (values.get(oid) === pending) values.delete(oid);
      throw error;
    });
    values.set(oid, pending);
    while (values.size > limit) values.delete(values.keys().next().value!);
    return pending;
  }

  private async readWithCache<T>(context: ReadContext, cache: object, read: () => Promise<T>): Promise<T> {
    try { return await read(); }
    catch (error) {
      // isomorphic-git also memoizes rejected pack-index promises. A failed
      // disk read must be retryable without throwing away a newer sync's cache.
      if (context.objectCache === cache) {
        context.objectCache = {};
      }
      throw error;
    }
  }

  private readCommit(context: ReadContext, oid: string, cache: object, reader: GitIntegrity): Promise<VerifiedCommit> {
    return this.memoized(context.commits, oid, MAX_CACHED_COMMITS, () => this.readWithCache(context, cache,
      () => reader.readCommit(oid, cache)));
  }

  private readTree(context: ReadContext, oid: string, cache: object, reader: GitIntegrity): Promise<VerifiedTree> {
    return this.memoized(context.trees, oid, MAX_CACHED_TREES, () => this.readWithCache(context, cache,
      () => reader.readTree(oid, cache)));
  }

  private http(controller: AbortController, progress: (event: LibrarySyncProgress) => void, recordFailure: (error: GitRepositoryError) => void): HttpClient {
    const fetcher = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    const maxBytes = this.options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
    let downloaded = 0;
    return { request: async request => {
      const url = new URL(request.url);
      const expected = new URL(this.url);
      if (url.origin !== expected.origin || url.username || url.password || url.hash
        || ![`${expected.pathname}/info/refs`, `${expected.pathname}/git-upload-pack`].includes(url.pathname)
        || !['GET', 'POST'].includes(request.method ?? 'GET')) {
        throw new GitRepositoryError(t('Git 同步请求地址无效。'), 'sync_invalid_repository');
      }
      const headers = new Headers(request.headers);
      headers.delete('authorization'); headers.delete('cookie'); headers.delete('proxy-authorization');
      headers.set('User-Agent', 'Daily-CF-Client');
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (request.body) {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of request.body) {
          length += chunk.byteLength;
          if (length > 4 * 1024 * 1024) throw new GitRepositoryError(t('Git 同步请求过大。'), 'sync_too_large');
          chunks.push(chunk);
        }
        body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      }
      const response = await fetcher(url, {
        method: request.method ?? 'GET', headers, body, signal: controller.signal,
        redirect: 'error', cache: 'no-store', credentials: 'omit',
      });
      if (Number(response.headers.get('content-length')) + downloaded > maxBytes) {
        await response.body?.cancel();
        throw new GitRepositoryError(t('题库下载超过当前支持的大小，请联系开发者。'), 'sync_too_large');
      }
      return {
        url: request.url, method: request.method, statusCode: response.status, statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: (async function* () {
          if (!response.body) return;
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              downloaded += value.byteLength;
              if (downloaded > maxBytes) throw new GitRepositoryError(t('题库下载超过当前支持的大小，请联系开发者。'), 'sync_too_large');
              if (url.pathname.endsWith('/git-upload-pack')) progress({ phase: 'downloading', completed: downloaded, unit: 'bytes' });
              yield value;
            }
          } catch (error) {
            if (error instanceof GitRepositoryError) recordFailure(error);
            throw error;
          } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
        })(),
      };
    } };
  }

  async listFiles(revision: string): Promise<GitRepositoryFile[]> {
    validOid(revision);
    try {
      const context = await this.contextFor(revision);
      const { reader, cache } = await this.readView(context);
      const { commit } = await this.readCommit(context, revision, cache, reader);
      const pending = [{ prefix: '', oid: commit.tree, depth: 0 }];
      const files: GitRepositoryFile[] = [];
      let entries = 0;
      while (pending.length) {
        const item = pending.pop()!;
        if (item.depth > 128) throw new GitRepositoryError(t('题库目录层级过深，无法读取。'), 'sync_too_large');
        const { tree } = await this.readTree(context, item.oid, cache, reader);
        for (const entry of tree) {
          if (++entries > MAX_ENTRIES) throw new GitRepositoryError(t('题库文件数量超过当前支持的范围。'), 'sync_too_large');
          if (entry.path.includes('/')) throw new GitRepositoryError(t('题库文件路径无效。'), 'sync_invalid_path');
          const filename = `${item.prefix}${entry.path}`;
          validPath(filename); validOid(entry.oid);
          if (entry.type === 'tree' && entry.mode === '040000') pending.push({ prefix: `${filename}/`, oid: entry.oid, depth: item.depth + 1 });
          else if (entry.type === 'blob' && regularFile(entry.mode)) files.push({ path: filename, oid: entry.oid, mode: entry.mode });
        }
      }
      return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    } catch (error) { throw this.readError(error); }
  }

  async readFile(revision: string, filename: string, maxBytes: number): Promise<string | null> {
    validOid(revision); validPath(filename);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new GitRepositoryError(t('题库文件大小限制无效。'), 'sync_invalid_path');
    try {
      const context = await this.contextFor(revision);
      const { reader, cache } = await this.readView(context);
      const { commit } = await this.readCommit(context, revision, cache, reader);
      const parts = filename.split('/');
      let oid = commit.tree;
      for (let index = 0; index < parts.length; index++) {
        const { tree } = await this.readTree(context, oid, cache, reader);
        const entry = tree.find(value => value.path === parts[index]);
        if (!entry) return null;
        validOid(entry.oid);
        if (index < parts.length - 1) {
          if (entry.type !== 'tree' || entry.mode !== '040000') return null;
          oid = entry.oid;
        } else {
          if (entry.type !== 'blob' || !regularFile(entry.mode)) return null;
          const { blob } = await this.readWithCache(context, cache, () => reader.readBlob(entry.oid, cache));
          if (blob.byteLength > maxBytes) throw new GitRepositoryError(t('文件过大，无法在客户端中读取。'), 'sync_too_large');
          return Buffer.from(blob).toString('utf8');
        }
      }
      return null;
    } catch (error) { throw this.readError(error); }
  }
}
