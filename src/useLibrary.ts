import { t, getLocale, type AppLocale } from '../shared/i18n';
import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { ArchiveMonth, ArchiveSnapshot, ClientAPI, ProblemDay } from '../shared/types';
import { getRateLimitInfo, type RateLimitInfo } from '../shared/rate-limit';
import { api } from './bridge';

type LibraryAPI = Pick<ClientAPI, 'getDay' | 'getArchiveSnapshot' | 'getMonthFromSnapshot'>
  & Partial<Pick<ClientAPI, 'getLocalLibraryView'>>;
export type LibraryPage = 'today' | 'archive' | null;
export interface LibraryState {
  today: ProblemDay | null;
  dayLoading: boolean;
  dayError: string;
  dayRetained: boolean;
  months: ArchiveMonth[];
  archiveError: string;
  archiveRetained: boolean;
  directoryLoading: boolean;
  archiveIndex: Record<string, ProblemDay[]>;
  indexing: boolean;
  indexingMonth: string;
  indexingError: string;
  indexFailures: { month: string; error: string }[];
  indexStopped: boolean;
  indexingCompleted: number;
  indexingTotal: number;
  archiveRefreshing: boolean;
  refreshProgress: string;
  rateLimit: RateLimitInfo | null;
}
type PendingRun = { key: string; cancel: () => void; promise: Promise<void> };
type LatestRun = PendingRun & { refresh: boolean };
type ArchiveView = { snapshot: ArchiveSnapshot; index: Record<string, ProblemDay[]>; locale: AppLocale | null };
const sameArchiveSnapshot = (left: ArchiveSnapshot, right: ArchiveSnapshot): boolean => {
  if (left.revision.toLowerCase() !== right.revision.toLowerCase() || left.months.length !== right.months.length) return false;
  const leftMonths = new Map(left.months.map(entry => [entry.month, entry.days]));
  if (leftMonths.size !== left.months.length || new Set(right.months.map(entry => entry.month)).size !== right.months.length) return false;
  return right.months.every(entry => leftMonths.has(entry.month) && leftMonths.get(entry.month) === entry.days);
};
const completeArchiveIndex = (view: ArchiveView): boolean => {
  const months = new Set(view.snapshot.months.map(entry => entry.month));
  return months.size === view.snapshot.months.length && Object.keys(view.index).length === months.size
    && [...months].every(month => Object.hasOwn(view.index, month) && Array.isArray(view.index[month]));
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const hasCode = (error: unknown, code: string) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
const isRateLimited = (error: unknown) => hasCode(error, 'github_rate_limited');
const emptyState = (): LibraryState => ({
  today: null, dayLoading: false, dayError: '', dayRetained: false, months: [],
  archiveError: '', archiveRetained: false, directoryLoading: false, archiveIndex: {},
  indexing: false, indexingMonth: '', indexingError: '', indexFailures: [], indexStopped: false,
  indexingCompleted: 0, indexingTotal: 0, archiveRefreshing: false, refreshProgress: '', rateLimit: null,
});

/** Successful views live in memory; every entry checks upstream before replacing them. */
export class LibraryController {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private active = true;
  private page: LibraryPage = null;
  private latestValue: ProblemDay | null = null;
  private allView?: ArchiveView;
  private latestGeneration = 0;
  private archiveGeneration = 0;
  private latestRun?: LatestRun;
  private archiveRun?: PendingRun;

  constructor(private readonly client: LibraryAPI) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private patch(update: Partial<LibraryState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...update };
    this.listeners.forEach(listener => listener());
  }
  private cancelLatest() {
    ++this.latestGeneration;
    this.latestRun?.cancel();
    this.latestRun = undefined;
  }
  private cancelArchive() {
    ++this.archiveGeneration;
    this.archiveRun?.cancel();
    this.archiveRun = undefined;
  }
  private viewState(view: ArchiveView): Partial<LibraryState> {
    return {
      months: view.snapshot.months.map(entry => Object.hasOwn(view.index, entry.month) ? { ...entry, days: view.index[entry.month].length } : entry),
      archiveIndex: view.index,
    };
  }

  resume = () => { this.active = true; };
  dispose = () => {
    this.active = false;
    this.cancelLatest(); this.cancelArchive();
    this.page = null;
    this.latestValue = null;
    this.allView = undefined;
    this.state = emptyState();
  };

  setView = (pageActive: LibraryPage): Promise<void> => {
    if (!this.active) return Promise.resolve();
    if (this.page === pageActive) {
      return this.latestRun?.promise ?? this.archiveRun?.promise ?? Promise.resolve();
    }
    this.cancelLatest(); this.cancelArchive();
    this.page = pageActive;
    this.patch(emptyState());
    if (pageActive === 'today') return this.loadLatest();
    if (pageActive === 'archive') return this.startArchive('entry');
    return Promise.resolve();
  };

  loadLatest = (refresh = false): Promise<void> => {
    if (!this.active || this.page !== 'today') return Promise.resolve();
    if (this.latestRun && (!refresh || this.latestRun.refresh)) return this.latestRun.promise;
    this.cancelLatest();
    const generation = this.latestGeneration;
    const current = () => this.active && this.page === 'today' && generation === this.latestGeneration;
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    const run: LatestRun = { key: 'latest', refresh, cancel, promise: Promise.resolve() };
    this.latestRun = run;
    let localAllowed = !this.latestValue;
    let remoteError: unknown;
    this.patch({ today: this.latestValue, dayRetained: !!this.latestValue, dayLoading: true, dayError: '', rateLimit: null });
    void (localAllowed && this.client.getLocalLibraryView
      ? this.client.getLocalLibraryView({ kind: 'day' }).then(view => {
        if (!current() || !localAllowed || view?.kind !== 'day') return;
        this.latestValue = view.day;
        this.patch({ today: view.day, dayRetained: true, ...(remoteError ? { dayError: errorText(remoteError) } : {}) });
      }).catch(() => { /* Local preview failure must not prevent the remote read. */ })
      : Promise.resolve());
    const work = (async () => {
      try {
        const today = await this.client.getDay(undefined, true);
        if (current()) {
          localAllowed = false;
          this.latestValue = today;
          this.patch({ today, dayRetained: false });
        }
      } catch (error) {
        if (!current()) return;
        if (hasCode(error, 'library_content_missing')) {
          localAllowed = false;
          this.latestValue = null;
          this.patch({ today: null, dayRetained: false, dayError: errorText(error), rateLimit: null });
        } else {
          remoteError = error;
          this.patch({ dayError: errorText(error), rateLimit: getRateLimitInfo(error) ?? null });
        }
      } finally {
        if (current()) { this.latestRun = undefined; this.patch({ dayLoading: false }); }
      }
    })();
    run.promise = Promise.race([work, cancelled]);
    return run.promise;
  };

  private runArchive(key: string, work: (current: () => boolean) => Promise<void>): Promise<void> {
    if (!this.active || this.page !== 'archive') return Promise.resolve();
    if (this.archiveRun?.key === key) return this.archiveRun.promise;
    this.cancelArchive();
    const generation = this.archiveGeneration;
    const current = () => this.active && this.page === 'archive' && generation === this.archiveGeneration;
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    const run: PendingRun = { key, cancel, promise: Promise.resolve() };
    this.archiveRun = run;
    const task = (async () => {
      try { await work(current); }
      finally {
        if (current()) {
          this.archiveRun = undefined;
          this.patch({ directoryLoading: false, indexing: false, indexingMonth: '',
            archiveRefreshing: false, refreshProgress: '' });
        }
      }
    })();
    run.promise = Promise.race([task, cancelled]);
    return run.promise;
  }

  private startArchive(source: 'entry' | 'refresh' | 'retry'): Promise<void> {
    return this.runArchive(source, async current => {
      const requestLocale = getLocale();
      const previous = this.allView;
      let reusable = previous;
      let retained = !!previous;
      let localAllowed = !previous;
      let remoteError: unknown;
      this.patch({ ...emptyState(), ...(previous ? this.viewState(previous) : {}),
        directoryLoading: true, indexing: !previous, archiveRetained: retained,
        archiveRefreshing: source === 'refresh', refreshProgress: t('正在读取月份目录…') });
      void (localAllowed && this.client.getLocalLibraryView
        ? this.client.getLocalLibraryView({ kind: 'archive', scope: 'all' }).then(view => {
          if (!current() || !localAllowed || view?.kind !== 'archive') return;
          if (view.revision.toLowerCase() !== view.snapshot.revision.toLowerCase()) return;
          const previousLocal: ArchiveView = { snapshot: view.snapshot, index: view.index ?? {},
            locale: getLocale() === requestLocale ? requestLocale : null };
          // Only a complete local response can become a reusable full index.
          if (!view.index || !completeArchiveIndex(previousLocal)) return;
          reusable = previousLocal;
          retained = true;
          this.allView = previousLocal;
          this.patch({ ...this.viewState(previousLocal), archiveRetained: true, indexing: false,
            ...(remoteError ? { archiveError: errorText(remoteError) } : {}) });
        }).catch(() => { /* A fresh remote read remains authoritative if local data is unavailable. */ })
        : Promise.resolve());
      let snapshot: ArchiveSnapshot;
      try {
        snapshot = await this.client.getArchiveSnapshot();
      } catch (error) {
        if (current()) {
          remoteError = error;
          this.patch({ archiveError: errorText(error), indexStopped: isRateLimited(error), rateLimit: getRateLimitInfo(error) ?? null });
        }
        return;
      }
      if (!current()) return;
      // Once fresh reads start, a late old disk view cannot displace partial fresh results.
      localAllowed = false;
      const months = snapshot.months;
      // Git commits are immutable. A successful remote check of the same
      // complete snapshot confirms the visible content without parsing it again.
      // Branch names can change without changing that content; publish the fresh metadata.
      if (reusable && reusable.locale === requestLocale && getLocale() === requestLocale && sameArchiveSnapshot(reusable.snapshot, snapshot)
        && completeArchiveIndex(reusable)) {
        const confirmed: ArchiveView = { ...reusable, snapshot };
        this.allView = confirmed;
        this.patch({ ...this.viewState(confirmed), archiveRetained: false, directoryLoading: false, indexing: false,
          indexingCompleted: months.length, indexingTotal: months.length });
        return;
      }
      const draft: ArchiveView = { snapshot, index: {}, locale: requestLocale };
      this.patch({ directoryLoading: false, indexing: true, indexingTotal: months.length });
      if (!retained) this.patch(this.viewState(draft));
      const failures: { month: string; error: string }[] = [];
      for (const [index, entry] of months.entries()) {
        if (!current()) return;
        this.patch({ indexingMonth: entry.month, refreshProgress: t('正在读取 {{month}}（{{completed}}/{{total}}）', { month: entry.month, completed: index + 1, total: months.length }) });
        try {
          const days = await this.client.getMonthFromSnapshot(entry.month, snapshot);
          draft.index = { ...draft.index, [entry.month]: days };
          if (!current()) return;
          if (!retained) this.patch(this.viewState(draft));
        } catch (error) {
          if (!current()) return;
          failures.push({ month: entry.month, error: errorText(error) });
          const summary = failures.map(item => t('{{month}}：{{error}}', { month: item.month, error: item.error })).join(getLocale() === 'en' ? '; ' : '；');
          this.patch({ indexFailures: [...failures], indexingError: summary });
          if (isRateLimited(error)) {
            this.patch({ indexStopped: true, indexingCompleted: index + 1, rateLimit: getRateLimitInfo(error) ?? null });
            return;
          }
        }
        if (current()) this.patch({ indexingCompleted: index + 1 });
      }
      if (!current() || failures.length) return;
      draft.locale = getLocale() === requestLocale ? requestLocale : null;
      this.allView = draft;
      this.patch({ ...this.viewState(draft), archiveRetained: false });
    });
  }

  refreshArchive = (): Promise<void> => this.startArchive('refresh');
  indexArchive = (): Promise<void> => {
    if (!this.active || this.page !== 'archive') return Promise.resolve();
    if (this.archiveRun) return this.archiveRun.promise;
    return this.startArchive('retry');
  };

  stopRefresh = () => {
    if (!this.archiveRun) return;
    this.cancelArchive();
    const retained = this.state.archiveRetained;
    this.patch({ archiveRefreshing: false, refreshProgress: '', directoryLoading: false,
      indexing: false, indexingMonth: '', indexStopped: true,
      indexingError: retained ? t('更新已停止，仍显示上次读取的内容。') : t('加载已停止，当前仅显示本次已读取的月份。'),
      ...(this.state.directoryLoading ? { archiveError: retained ? t('更新已停止，仍显示上次读取的内容。') : t('读取已停止，请重新加载题库目录。') } : {}) });
  };
  stopIndexing = this.stopRefresh;
}

export function useLibrary({ pageActive }: { pageActive: LibraryPage }) {
  const [controller] = useState(() => new LibraryController(api));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => {
    controller.resume();
    return controller.dispose;
  }, [controller]);
  useLayoutEffect(() => { void controller.setView(pageActive); }, [controller, pageActive]);
  return { ...state, loadLatest: controller.loadLatest, refreshArchive: controller.refreshArchive,
    indexArchive: controller.indexArchive, stopIndexing: controller.stopIndexing, stopRefresh: controller.stopRefresh };
}
