import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppUpdateState, AppUpdateTarget } from '../shared/app-update';
import { t } from '../shared/i18n';
import {
  AppUpdateError, checksumForAsset, LATEST_RELEASE_URL, MAX_CHECKSUM_BYTES, MAX_RELEASE_BYTES, resolveAppUpdate,
  type AppUpdateAsset, type ResolvedAppUpdate,
} from './app-update-release';

const REQUEST_TIMEOUT = 30_000;
const CHECK_TIMEOUT = 60_000;
const DOWNLOAD_TIMEOUT = 30 * 60_000;
const REDIRECT_LIMIT = 5;
// GitHub documents these release-download endpoints; do not allow arbitrary subdomains.
// https://docs.github.com/en/actions/reference/runners/self-hosted-runners
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);

interface Operation {
  controller: AbortController;
  kind: 'checking' | 'downloading';
  prior: AppUpdateState;
  promise: Promise<AppUpdateState>;
}
interface DirectoryIdentity { canonical: string; dev: number; ino: number; }
interface DownloadFile {
  directory: string;
  identity: DirectoryIdentity;
  file: string;
  stat: fs.Stats;
  asset: AppUpdateAsset;
  digest: string;
}
export interface AppUpdateOptions {
  currentVersion: string;
  target: AppUpdateTarget;
  directory: string;
  onChange?: (state: AppUpdateState) => void;
  fetch?: typeof fetch;
}

function code(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}
function cancelled(): DOMException { return new DOMException('Cancelled', 'AbortError'); }
function timeout(): AppUpdateError { return new AppUpdateError('timeout', t('连接超时，请重试。')); }
function unsafeFile(): never {
  throw new AppUpdateError('unsafe_file', t('下载文件或所在目录已被修改，请重新下载。'));
}
function wrongContent(): never {
  throw new AppUpdateError('integrity', t('下载文件不完整或校验失败，请重新下载。'));
}
function canonical(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }
function sameFile(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function regularFile(stat: fs.Stats): boolean { return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1; }

/** Enforce cancellation even for a failed transport that does not settle on abort. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal, duration = REQUEST_TIMEOUT): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); callback(); };
    const onAbort = () => finish(() => reject(signal.reason ?? cancelled()));
    if (signal.aborted) { reject(signal.reason ?? cancelled()); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(() => reject(timeout())), duration);
    timer.unref?.();
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

async function directories(input: string, create = false): Promise<DirectoryIdentity> {
  const absolute = path.resolve(input);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(current); }
    catch (error) {
      if (!create || code(error) !== 'ENOENT') throw error;
      try { await fs.promises.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (code(mkdirError) !== 'EEXIST') throw mkdirError; }
      stat = await fs.promises.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsafeFile();
  }
  const before = await fs.promises.lstat(absolute);
  const real = await fs.promises.realpath(absolute);
  const after = await fs.promises.lstat(absolute);
  if (!before.isDirectory() || before.isSymbolicLink() || !sameFile(before, after)) unsafeFile();
  return { canonical: canonical(real), dev: after.dev, ino: after.ino };
}
function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.canonical === right.canonical && left.dev === right.dev && left.ino === right.ino;
}

export class AppUpdateService {
  private state: AppUpdateState;
  private readonly request: typeof fetch;
  private readonly directory: string;
  private rootIdentity?: DirectoryIdentity;
  private resolved?: ResolvedAppUpdate;
  private ready?: DownloadFile;
  private operation?: Operation;
  private disposed = false;

  constructor(private readonly options: AppUpdateOptions) {
    this.request = options.fetch ?? globalThis.fetch;
    this.directory = path.resolve(options.directory);
    this.state = { phase: 'idle', currentVersion: options.currentVersion, target: { ...options.target } };
  }

  getState(): AppUpdateState { return structuredClone(this.state); }

  private publish(next: AppUpdateState): void {
    if (this.disposed) return;
    this.state = structuredClone(next);
    // UI listeners cannot turn a successful download into a failure.
    try { this.options.onChange?.(this.getState()); } catch { /* Observer only. */ }
  }
  private active(operation: Operation): void {
    if (this.disposed || this.operation !== operation || operation.controller.signal.aborted) throw operation.controller.signal.reason ?? cancelled();
  }
  private begin(kind: Operation['kind'], work: (operation: Operation) => Promise<void>): Promise<AppUpdateState> {
    if (this.disposed) return Promise.resolve(this.getState());
    // A check never interrupts a download; repeated clicks share the running task.
    if (this.operation) return this.operation.promise;
    const operation = { kind, controller: new AbortController(), prior: this.getState() } as Operation;
    this.operation = operation;
    const state: AppUpdateState = { ...this.state, phase: kind, error: undefined, progress: undefined };
    if (kind === 'downloading' && this.resolved?.asset) state.progress = { downloaded: 0, total: this.resolved.asset.size };
    const timer = setTimeout(() => operation.controller.abort(timeout()), kind === 'checking' ? CHECK_TIMEOUT : DOWNLOAD_TIMEOUT);
    timer.unref?.();
    operation.promise = Promise.resolve().then(() => work(operation)).catch(error => {
      operation.controller.abort(error);
      if (this.operation === operation && !this.disposed) {
        this.publish({ ...this.state, phase: 'error', progress: undefined, error: error instanceof AppUpdateError
          ? error.message : t('无法完成更新请求，请检查网络或下载目录后重试。') });
      }
    }).finally(() => {
      clearTimeout(timer);
      if (this.operation === operation) this.operation = undefined;
    }).then(() => this.getState());
    this.publish(state);
    return operation.promise;
  }

  check(): Promise<AppUpdateState> {
    return this.begin('checking', async operation => {
      const response = await this.response(LATEST_RELEASE_URL, operation.controller.signal, false);
      let next: ResolvedAppUpdate | null = null;
      if (response.status !== 404) {
        this.requireSuccess(response);
        const contents = await this.bytes(response, MAX_RELEASE_BYTES, operation.controller.signal);
        let metadata: unknown;
        try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)); }
        catch { throw new AppUpdateError('invalid_release', t('发布信息不完整或格式不正确，请到发布页面查看。')); }
        next = resolveAppUpdate(metadata, this.state.currentVersion, this.state.target);
      } else { void response.body?.cancel().catch(() => {}); }
      this.active(operation);
      const retainReady = next?.asset && this.ready && this.ready.asset.id === next.asset.id
        && this.ready.asset.name === next.asset.name && this.ready.asset.size === next.asset.size && this.ready.asset.digest === next.asset.digest
        && this.resolved?.checksum?.id === next.checksum?.id && this.resolved?.checksum?.digest === next.checksum?.digest
        && this.resolved?.checksum?.size === next.checksum?.size;
      if (!retainReady) this.ready = undefined;
      this.resolved = next ?? undefined;
      this.publish({ ...this.state, phase: next ? (retainReady ? 'ready' : 'available') : 'current', release: next?.release,
        checkedAt: new Date().toISOString(), error: undefined, progress: undefined });
    });
  }

  download(): Promise<AppUpdateState> {
    if (this.state.phase === 'ready' && this.ready) return Promise.resolve(this.getState());
    return this.begin('downloading', async operation => {
      const update = this.resolved;
      if (!update?.asset) throw new AppUpdateError('unsupported', t('此版本没有适合当前安装方式的更新包，请到发布页面选择下载。'));
      if (!update.checksum) throw new AppUpdateError('missing_checksum', t('此版本缺少 SHA256 校验清单，请到发布页面查看。'));
      const signal = operation.controller.signal;
      const checksumResponse = await this.response(this.assetUrl(update.checksum), signal, true);
      this.requireSuccess(checksumResponse);
      const checksumBytes = await this.bytes(checksumResponse, MAX_CHECKSUM_BYTES, signal, update.checksum.size);
      if (update.checksum.digest && createHash('sha256').update(checksumBytes).digest('hex') !== update.checksum.digest) wrongContent();
      let checksumText: string;
      try { checksumText = new TextDecoder('utf-8', { fatal: true }).decode(checksumBytes); }
      catch { wrongContent(); }
      const digest = checksumForAsset(checksumText, update.asset);
      this.active(operation);
      const download = await this.downloadFile(update.asset, digest, operation);
      try {
        this.active(operation);
        this.ready = download;
        this.publish({ ...this.state, phase: 'ready', error: undefined, progress: undefined });
      } catch (error) { await this.cleanup(download); throw error; }
    });
  }

  cancel(): void {
    const operation = this.operation;
    if (!operation) return;
    this.operation = undefined;
    operation.controller.abort(cancelled());
    const prior = operation.prior;
    this.publish({ ...prior, phase: this.ready ? 'ready' : prior.release ? 'available' : prior.checkedAt ? 'current' : 'idle',
      progress: undefined, error: undefined });
  }

  /** Called only immediately before the main process hands the file to the OS. */
  async verifiedDownload(): Promise<string> {
    const ready = this.ready;
    if (this.disposed || !ready || this.state.phase !== 'ready' || this.operation) {
      throw new AppUpdateError('not_ready', t('请先下载并校验更新包。'));
    }
    try {
      await this.verifyFile(ready);
      if (this.ready !== ready || this.operation || this.disposed || this.state.phase !== 'ready') unsafeFile();
      return ready.file;
    } catch (error) {
      if (this.ready === ready) {
        this.ready = undefined;
        this.publish({ ...this.state, phase: 'error', error: t('下载文件或所在目录已被修改，请重新下载。'), progress: undefined });
      }
      throw error instanceof AppUpdateError ? error : new AppUpdateError('unsafe_file', t('下载文件或所在目录已被修改，请重新下载。'));
    }
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
    // An installer opened by the OS can still be reading its file after app exit.
  }

  private assetUrl(asset: AppUpdateAsset): string {
    // Avoid a stale CDN redirect when a maintainer replaces an asset under the same name.
    const url = new URL(asset.url); url.searchParams.set('asset_id', String(asset.id)); return url.href;
  }
  private async response(initial: string, signal: AbortSignal, asset: boolean): Promise<Response> {
    let current = new URL(initial);
    for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects++) {
      if (signal.aborted) throw signal.reason ?? cancelled();
      if (current.protocol !== 'https:' || current.port || current.username || current.password || current.hash
          || (redirects > 0 && (!asset || !ASSET_HOSTS.has(current.hostname)))) {
        throw new AppUpdateError('redirect', t('更新下载地址不受信任，已停止请求。'));
      }
      const pending = this.request(current.href, { method: 'GET', redirect: 'manual', signal, credentials: 'omit', cache: 'no-store',
        headers: asset ? { Accept: 'application/octet-stream', 'User-Agent': 'Daily-CF-Client' }
          : { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Daily-CF-Client' },
      }).then(response => {
        if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw signal.reason ?? cancelled(); }
        return response;
      });
      const response = await abortable(pending, signal);
      if (response.redirected || (response.url && response.url !== current.href)) {
        void response.body?.cancel().catch(() => {});
        throw new AppUpdateError('redirect', t('更新下载地址不受信任，已停止请求。'));
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location || redirects === REDIRECT_LIMIT) throw new AppUpdateError('redirect', t('更新下载地址不受信任，已停止请求。'));
      try { current = new URL(location, current); } catch { throw new AppUpdateError('redirect', t('更新下载地址不受信任，已停止请求。')); }
    }
    throw new AppUpdateError('redirect', t('更新下载地址不受信任，已停止请求。'));
  }
  private requireSuccess(response: Response): void {
    if (response.status === 200) return;
    void response.body?.cancel().catch(() => {});
    if (response.status === 403 || response.status === 429) {
      throw new AppUpdateError('rate_limit', t('GitHub 暂时限制了更新请求，请稍后重试或打开发布页面。'));
    }
    throw new AppUpdateError('http', t('无法获取更新文件（HTTP {{status}}），请稍后重试。', { status: response.status }));
  }
  private contentLength(response: Response, limit: number, expected?: number): void {
    const raw = response.headers.get('content-length');
    if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > limit || (expected !== undefined && Number(raw) !== expected))) wrongContent();
    // A transformed response cannot be compared safely with the declared asset size.
    if (expected !== undefined && response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') wrongContent();
  }
  private async bytes(response: Response, limit: number, signal: AbortSignal, expected?: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await this.consume(response, limit, signal, async bytes => { chunks.push(Buffer.from(bytes)); }, expected);
    return Buffer.concat(chunks);
  }
  private async consume(response: Response, limit: number, signal: AbortSignal, onChunk: (bytes: Uint8Array) => Promise<void>, expected?: number): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      this.contentLength(response, limit, expected);
      if (!response.body) wrongContent();
      reader = response.body.getReader();
      let size = 0;
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit || (expected !== undefined && size > expected)) wrongContent();
        await onChunk(chunk.value);
      }
      if (expected !== undefined && size !== expected) wrongContent();
    } finally {
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else { void response.body?.cancel().catch(() => {}); }
    }
  }

  private async root(create = false): Promise<void> {
    const identity = await directories(this.directory, create);
    if (this.rootIdentity && !sameDirectory(this.rootIdentity, identity)) unsafeFile();
    this.rootIdentity ??= identity;
  }
  private async checkFolder(download: Pick<DownloadFile, 'directory' | 'identity'>): Promise<void> {
    await this.root();
    if (path.dirname(download.directory) !== this.directory || !/^download-[0-9a-f-]{36}$/.test(path.basename(download.directory))
        || !sameDirectory(download.identity, await directories(download.directory))) unsafeFile();
  }
  private async checkFile(download: DownloadFile): Promise<fs.Stats> {
    await this.checkFolder(download);
    if (path.dirname(download.file) !== download.directory || ![download.asset.name, '.download.part'].includes(path.basename(download.file))) unsafeFile();
    const stat = await fs.promises.lstat(download.file);
    if (!regularFile(stat) || !sameFile(stat, download.stat)) unsafeFile();
    return stat;
  }

  private async downloadFile(asset: AppUpdateAsset, digest: string, operation: Operation): Promise<DownloadFile> {
    await this.root(true);
    this.active(operation);
    const directory = path.join(this.directory, `download-${randomUUID()}`);
    await fs.promises.mkdir(directory, { mode: 0o700 });
    const identity = await directories(directory);
    await this.root();
    const partial = path.join(directory, '.download.part');
    let result: DownloadFile | undefined;
    try {
      this.active(operation);
      const handle = await fs.promises.open(partial, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        result = { directory, identity, file: partial, stat: await handle.stat(), asset, digest };
        await this.checkFile(result);
        const response = await this.response(this.assetUrl(asset), operation.controller.signal, true);
        this.requireSuccess(response);
        const hash = createHash('sha256');
        let downloaded = 0; let lastProgress = 0;
        await this.consume(response, asset.size, operation.controller.signal, async bytes => {
          this.active(operation);
          let written = 0;
          while (written < bytes.byteLength) {
            const output = await handle.write(bytes, written, bytes.byteLength - written);
            if (!output.bytesWritten) throw new AppUpdateError('write', t('无法写入更新包，请检查磁盘空间和目录权限。'));
            written += output.bytesWritten;
          }
          hash.update(bytes); downloaded += bytes.byteLength;
          if (downloaded === asset.size || Date.now() - lastProgress >= 100) {
            lastProgress = Date.now();
            this.active(operation);
            this.publish({ ...this.state, progress: { downloaded, total: asset.size } });
          }
        }, asset.size);
        if (hash.digest('hex') !== digest) wrongContent();
        this.active(operation);
        // AppImage updates are opened in the file manager for replacement. Keep the
        // verified file executable for its owner without making it writable by others.
        if (this.state.target.packageKind === 'appimage') await handle.chmod(0o700);
        await handle.sync();
        const actual = await handle.stat();
        if (!regularFile(actual) || !sameFile(result.stat, actual) || actual.size !== asset.size) unsafeFile();
      } finally { await handle.close(); }
      this.active(operation);
      await this.checkFile(result);
      // Publish exclusively: a concurrent file must never be overwritten, even in our fresh directory.
      const final = path.join(directory, asset.name);
      await fs.promises.link(partial, final);
      await this.checkFolder(result);
      const [linkedPartial, linkedFinal] = await Promise.all([fs.promises.lstat(partial), fs.promises.lstat(final)]);
      if (!linkedPartial.isFile() || linkedPartial.isSymbolicLink() || linkedPartial.nlink !== 2
          || !linkedFinal.isFile() || linkedFinal.isSymbolicLink() || linkedFinal.nlink !== 2
          || !sameFile(result.stat, linkedPartial) || !sameFile(result.stat, linkedFinal)) unsafeFile();
      await fs.promises.unlink(partial);
      result.file = final;
      await this.verifyFile(result);
      this.active(operation);
      return result;
    } catch (error) {
      if (result) await this.cleanup(result);
      else {
        try { await this.checkFolder({ directory, identity }); await fs.promises.rmdir(directory); } catch { /* Never recurse into an unknown directory. */ }
      }
      throw error;
    }
  }

  private async verifyFile(download: DownloadFile): Promise<void> {
    const before = await this.checkFile(download);
    if (before.size !== download.asset.size) wrongContent();
    const handle = await fs.promises.open(download.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!regularFile(opened) || !sameFile(before, opened) || opened.size !== download.asset.size) unsafeFile();
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let size = 0;
      while (true) {
        const chunk = await handle.read(buffer, 0, buffer.length, null);
        if (!chunk.bytesRead) break;
        size += chunk.bytesRead;
        if (size > download.asset.size) wrongContent();
        hash.update(buffer.subarray(0, chunk.bytesRead));
      }
      const after = await handle.stat();
      const atPath = await this.checkFile(download);
      if (size !== download.asset.size || hash.digest('hex') !== download.digest) wrongContent();
      if (!regularFile(after) || !sameFile(after, atPath) || after.size !== before.size || atPath.size !== before.size
          || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.mtimeMs !== atPath.mtimeMs || after.ctimeMs !== atPath.ctimeMs) unsafeFile();
    } finally { await handle.close(); }
  }

  private async cleanup(download: DownloadFile): Promise<void> {
    // Only unlink the exact inode created by this operation, never recursive cleanup.
    try {
      await this.checkFile(download);
      await fs.promises.unlink(download.file);
      await this.checkFolder(download);
      await fs.promises.rmdir(download.directory);
    } catch { /* Preserve anything replaced, linked, or not owned by this operation. */ }
  }
}
