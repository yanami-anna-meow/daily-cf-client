import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { apiResultError } from '../shared/api-errors';
import { getLocale, t, type AppLocale } from '../shared/i18n';
import type { LibrarySyncProgress } from '../shared/types';
import { publicLibraryProgress, type LibraryMethod, type LibraryReader, type LibraryWorkerInput, type LibraryWorkerOutput } from './library-worker-protocol';

type WorkerPort = Pick<Worker, 'postMessage' | 'on' | 'off' | 'terminate'>;
interface WorkerOptions {
  onProgress?: (progress: LibrarySyncProgress) => void;
  workerFile?: string;
  timeoutMs?: number;
  createWorker?: (file: string, options: { workerData: { directory: string } }) => WorkerPort;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Git download and pack/index processing run outside Electron's main thread.
 * This object survives account/settings changes and never receives credentials.
 */
export class LibraryWorkerHost implements LibraryReader {
  private worker?: WorkerPort;
  private detach?: () => void;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;
  private locale: AppLocale = getLocale();

  constructor(private readonly directory: string, private readonly options: WorkerOptions = {}) {}

  setLocale(locale: AppLocale): void {
    this.locale = locale;
    try { this.worker?.postMessage({ type: 'locale', locale } satisfies LibraryWorkerInput); }
    catch { if (this.worker) this.fail(this.worker, new Error(t('题库读取中断，请重试。'))); }
  }

  private start(): WorkerPort {
    if (this.closed) throw new Error(t('题库读取中断，请重试。'));
    if (this.worker) return this.worker;
    const worker = (this.options.createWorker ?? ((file, options) => new Worker(file, options)))(
      this.options.workerFile ?? join(__dirname, 'library-worker.cjs'), { workerData: { directory: this.directory } });
    this.worker = worker;
    const message = (value: LibraryWorkerOutput) => {
      if (this.worker !== worker || !value || typeof value !== 'object') return;
      if (value.type === 'progress') {
        const progress = publicLibraryProgress(value.progress);
        if (progress) this.options.onProgress?.(progress);
      } else if (value.type === 'response' && Number.isSafeInteger(value.id)) {
        const request = this.pending.get(value.id);
        if (!request) return;
        this.pending.delete(value.id); clearTimeout(request.timer);
        if (value.result?.ok === true) request.resolve(value.result.data);
        else request.reject(apiResultError(value.result && typeof value.result === 'object'
          ? value.result : { ok: false, error: t('题库读取中断，请重试。') }));
      }
    };
    const error = () => this.fail(worker, new Error(t('题库读取中断，请重试。')));
    const exit = () => this.fail(worker, new Error(t('题库读取中断，请重试。')));
    worker.on('message', message); worker.on('error', error); worker.on('exit', exit);
    this.detach = () => { worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
    return worker;
  }

  private fail(worker: WorkerPort, error: Error, report = true): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    // A worker can emit its final error while termination is being scheduled.
    // Keep that event handled without allowing it to affect a replacement worker.
    const ignoreError = () => {};
    worker.on('error', ignoreError);
    this.detach?.(); this.detach = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    void worker.terminate().catch(() => {}).finally(() => worker.off('error', ignoreError));
    if (report) this.options.onProgress?.({ phase: 'error', completed: 0, unit: 'objects', message: error.message });
  }

  private async request<M extends LibraryMethod>(method: M, ...args: Parameters<LibraryReader[M]>): Promise<Awaited<ReturnType<LibraryReader[M]>>> {
    let worker: WorkerPort;
    try { worker = this.start(); }
    catch {
      const error = new Error(t('题库读取中断，请重试。'));
      this.options.onProgress?.({ phase: 'error', completed: 0, unit: 'objects', message: error.message });
      throw error;
    }
    const id = ++this.sequence;
    return await new Promise<Awaited<ReturnType<LibraryReader[M]>>>((resolve, reject) => {
      // The core bounds network time. This independent timer also covers CPU-bound
      // pack processing, which cannot service the worker's own abort timer.
      const timer = setTimeout(() => this.fail(worker, new Error(t('题库更新超时，请检查网络后重试。'))), this.options.timeoutMs ?? 210_000);
      this.pending.set(id, { resolve: value => resolve(value as Awaited<ReturnType<LibraryReader[M]>>), reject, timer });
      try { worker.postMessage({ type: 'request', id, method, args, locale: this.locale } satisfies LibraryWorkerInput); }
      catch { this.fail(worker, new Error(t('题库读取中断，请重试。'))); }
    });
  }

  syncLibrary: LibraryReader['syncLibrary'] = () => this.request('syncLibrary');
  getLocalLibraryView: LibraryReader['getLocalLibraryView'] = (...args) => this.request('getLocalLibraryView', ...args);
  getDay: LibraryReader['getDay'] = (...args) => this.request('getDay', ...args);
  getArchiveMonths: LibraryReader['getArchiveMonths'] = (...args) => this.request('getArchiveMonths', ...args);
  getArchiveSnapshot: LibraryReader['getArchiveSnapshot'] = () => this.request('getArchiveSnapshot');
  getMonthFromSnapshot: LibraryReader['getMonthFromSnapshot'] = (...args) => this.request('getMonthFromSnapshot', ...args);
  getMonth: LibraryReader['getMonth'] = (...args) => this.request('getMonth', ...args);
  getResources: LibraryReader['getResources'] = (...args) => this.request('getResources', ...args);
  getReference: LibraryReader['getReference'] = (...args) => this.request('getReference', ...args);

  dispose(): void {
    this.closed = true;
    if (this.worker) this.fail(this.worker, new Error(t('题库读取中断，请重试。')), false);
  }
}
