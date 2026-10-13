import { t } from '../shared/i18n';
import { latestPullRequests } from '../shared/contributions';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { api } from './bridge';
import type { AuthState, ClientAPI, ContributionPage, RemotePullRequest } from '../shared/types';

export interface ContributionStatusIndex {
  loading: boolean;
  complete: boolean;
  truncated: boolean;
  error: string;
  loaded: number;
  total: number | null;
}

interface ContributionSnapshot {
  key: string;
  statistics: ContributionPage | null;
  items: RemotePullRequest[];
  indexedItems: RemotePullRequest[];
  loading: boolean;
  error: string;
  statusIndex: ContributionStatusIndex;
}

interface ContributionSession {
  key: string;
  identity: string;
  // Results accumulated for this view's current traversal, never a read cache.
  pages: Map<number, ContributionPage>;
  pending: Map<number, Promise<ContributionPage>>;
  errors: Map<number, string>;
  firstPage: ContributionPage | null;
  visiblePage: number;
  nextIndexPage: number | null;
  lastPage: number | null;
  foreground: boolean;
  indexing: boolean;
}

const SEARCH_LIMIT = 1000;
const emptyIndex = (): ContributionStatusIndex => ({ loading: false, complete: false, truncated: false, error: '', loaded: 0, total: null });
const emptySnapshot = (key: string): ContributionSnapshot => ({ key, statistics: null, items: [], indexedItems: [], loading: false, error: '', statusIndex: emptyIndex() });
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const canFetchMore = (page: ContributionPage) => page.hasMore && page.page * page.pageSize < SEARCH_LIMIT;
const identityOf = (login: string, repository: string) => `${login.toLowerCase()}\n${repository.toLowerCase()}`;
const contextKey = (login: string, repository: string, scope: string | null) => JSON.stringify([login.toLowerCase(), repository.toLowerCase(), scope]);

/** All remote results belong to one visible scope and one read generation. */
export class ContributionsController {
  private context: { key: string; identity: string; enabled: boolean } | null = null;
  private session: ContributionSession | null = null;
  private snapshot = emptySnapshot('');
  private listeners = new Set<() => void>();

  constructor(private readonly client: Pick<ClientAPI, 'getContributions'>) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(snapshot: ContributionSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  private active(session: ContributionSession) { return this.session === session && this.context?.key === session.key; }
  private publish(session: ContributionSession, patch: Partial<ContributionSnapshot>) {
    if (this.active(session)) this.emit({ ...this.snapshot, ...patch });
  }

  enter(login: string, repository: string, scope: string | null): Promise<void> {
    const key = contextKey(login, repository, scope);
    this.context = { key, identity: identityOf(login, repository), enabled: Boolean(login) && scope !== null };
    this.session = null;
    this.emit(emptySnapshot(key));
    return this.refresh();
  }

  dispose() {
    this.context = null;
    this.session = null;
    this.emit(emptySnapshot(''));
  }

  private publishIndex(session: ContributionSession) {
    if (!this.active(session)) return;
    const pages = [...session.pages.values()].sort((a, b) => a.page - b.page);
    const indexedItems = latestPullRequests(pages.flatMap(page => page.items)).slice(0, SEARCH_LIMIT);
    const last = pages.at(-1);
    const total = pages.length ? Math.max(...pages.map(page => page.totalCount)) : null;
    const loading = session.indexing || session.pending.size > 0;
    const error = [...session.errors.entries()].sort(([a], [b]) => a - b)[0]?.[1] ?? '';
    const truncated = pages.some(page => page.truncated || page.items.some(item => item.filesTruncated))
      || (total ?? 0) > SEARCH_LIMIT || Boolean(last?.hasMore && !canFetchMore(last));
    const contiguous = pages.every((page, index) => page.page === index + 1);
    const complete = Boolean(last && !canFetchMore(last)) && contiguous && !loading && !error && !truncated
      && total !== null && indexedItems.length >= total && !pages.some(page => page.incomplete || page.totalCount !== total);
    this.publish(session, {
      indexedItems,
      items: latestPullRequests(pages.filter(page => page.page <= session.visiblePage).flatMap(page => page.items)),
      statusIndex: { loading, complete, truncated, error, loaded: indexedItems.length, total },
    });
  }

  private fetchPage(session: ContributionSession, page: number): Promise<ContributionPage> {
    // Foreground pagination and the current traversal may share only a request
    // that is still running. A later read always goes back to GitHub.
    const pending = session.pending.get(page);
    if (pending) return pending;
    session.pages.delete(page);
    session.errors.delete(page);
    if (session.lastPage === page) session.lastPage = null;
    const request = Promise.resolve().then(() => {
      if (!this.active(session)) throw new Error(t('读取已取消。'));
      return this.client.getContributions(page);
    }).then(result => {
      if (!this.active(session)) return result;
      // A fresher earlier page may establish that this pending tail no longer exists.
      if (session.lastPage !== null && page > session.lastPage) return result;
      if (identityOf(result.login, result.repository) !== session.identity) throw new Error(t('GitHub 返回的记录与当前账号或仓库不一致，请刷新后重试。'));
      if (result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize <= 0
        || !Number.isSafeInteger(result.totalCount) || result.totalCount < 0 || !Array.isArray(result.items)
        || (session.firstPage && result.pageSize !== session.firstPage.pageSize)) {
        throw new Error(t('GitHub 返回的记录分页无效，请刷新后重试。'));
      }
      session.pages.set(page, result);
      if (session.nextIndexPage === page) session.nextIndexPage = canFetchMore(result) ? page + 1 : null;
      if (!canFetchMore(result)) {
        session.lastPage = page;
        for (const knownPage of session.pages.keys()) if (knownPage > page) session.pages.delete(knownPage);
        for (const failedPage of session.errors.keys()) if (failedPage > page) session.errors.delete(failedPage);
        if (session.nextIndexPage !== null && session.nextIndexPage > page) session.nextIndexPage = null;
      }
      return result;
    }).catch(cause => {
      if (this.active(session) && (session.lastPage === null || page <= session.lastPage)) session.errors.set(page, message(cause));
      throw cause;
    }).finally(() => {
      session.pending.delete(page);
      this.publishIndex(session);
    });
    session.pending.set(page, request);
    this.publishIndex(session);
    return request;
  }

  private async indexRemaining(session: ContributionSession): Promise<void> {
    if (!this.active(session) || session.indexing || session.nextIndexPage === null) return;
    session.indexing = true;
    this.publishIndex(session);
    try {
      while (this.active(session) && session.nextIndexPage !== null) await this.fetchPage(session, session.nextIndexPage);
    } catch { /* fetchPage exposes the failed page while preserving this traversal's successful pages. */ }
    finally {
      session.indexing = false;
      this.publishIndex(session);
    }
  }

  refresh = async (): Promise<void> => {
    const context = this.context;
    if (!context?.enabled) return;
    const session: ContributionSession = {
      key: context.key, identity: context.identity, pages: new Map(), pending: new Map(), errors: new Map(),
      firstPage: null, visiblePage: 1, nextIndexPage: 1, lastPage: null, foreground: true, indexing: false,
    };
    this.session = session;
    this.emit({ ...emptySnapshot(context.key), loading: true, statusIndex: { ...emptyIndex(), loading: true } });
    try {
      const first = await this.fetchPage(session, 1);
      if (!this.active(session)) return;
      session.firstPage = first;
      this.publish(session, { statistics: { ...first, hasMore: canFetchMore(first) }, loading: false });
      this.publishIndex(session);
      void this.indexRemaining(session);
    } catch (cause) {
      this.publish(session, { loading: false, error: message(cause) });
    } finally { session.foreground = false; }
  };

  loadMore = async (): Promise<void> => {
    const session = this.session;
    if (!session || !this.active(session) || session.foreground || !session.firstPage) return;
    const current = session.pages.get(session.visiblePage);
    if (!current || !canFetchMore(current)) return;
    session.foreground = true;
    this.publish(session, { loading: true, error: '' });
    try {
      const page = await this.fetchPage(session, session.visiblePage + 1);
      if (!this.active(session)) return;
      session.visiblePage = page.page;
      this.publish(session, { statistics: { ...page, hasMore: canFetchMore(page) }, loading: false });
      this.publishIndex(session);
      void this.indexRemaining(session);
    } catch (cause) {
      this.publish(session, { loading: false, error: message(cause) });
    } finally { session.foreground = false; }
  };
}

/** GitHub owns contribution history. Scope changes and refreshes start empty. */
export function useContributions(auth: AuthState, repository: string, scope: string | null = 'page') {
  const login = auth.user?.login ?? '';
  const enabledScope = api.isDesktop ? scope : null;
  const key = contextKey(login, repository, enabledScope);
  const controllerRef = useRef<ContributionsController | null>(null);
  if (!controllerRef.current) controllerRef.current = new ContributionsController(api);
  const controller = controllerRef.current;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    void controller.enter(login, repository, enabledScope);
    return () => controller.dispose();
  }, [controller, login, repository, enabledScope]);
  const refresh = useCallback(async () => {
    if (keyRef.current === key && controller.getSnapshot().key === key) await controller.refresh();
  }, [controller, key]);
  const loadMore = useCallback(async () => {
    if (keyRef.current === key && controller.getSnapshot().key === key) await controller.loadMore();
  }, [controller, key]);
  // Hide a previous scope immediately, before its effect cleanup runs.
  const current = login && enabledScope !== null && snapshot.key === key ? snapshot : emptySnapshot(key);
  return {
    statistics: current.statistics, items: current.items, indexedItems: current.indexedItems,
    loading: current.loading, error: current.error, statusIndex: current.statusIndex,
    refresh, loadMore,
  };
}

