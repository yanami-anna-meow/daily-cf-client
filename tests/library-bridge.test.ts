import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { ArchiveSnapshot, AuthState, ClientAPI, LibrarySyncProgress, LocalLibraryViewRequest, SubmissionProgress } from '../shared/types';

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

async function desktopApi(): Promise<ClientAPI> {
  await import('../electron/preload');
  const [name, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
  expect(name).toBe('dailyCF');
  return api;
}

function previewGlobals() {
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
  vi.stubGlobal('localStorage', { length: 0, key: vi.fn(), getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
}

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (child: ts.Node) => { result.push(child); ts.forEachChild(child, visit); };
  ts.forEachChild(node, visit);
  return result;
}

const localRequests: LocalLibraryViewRequest[] = [
  { kind: 'day' },
  { kind: 'day', date: '2128-03-02' },
  { kind: 'archive', scope: 'month', month: '2128-03' },
  { kind: 'archive', scope: 'all' },
  { kind: 'resources', date: '2128-03-02', problemId: 'cf1a' },
  { kind: 'reference', path: 'daily_problems/2128/03/0302/personal_submission/cf1a_alice.py' },
];

describe('local library synchronization bridge', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('requests synchronization on every invocation and preserves the branch and revision', async () => {
    const api = await desktopApi();
    const first = { branch: 'main', revision: 'a'.repeat(40) };
    const changed = { branch: 'release/题库', revision: 'b'.repeat(40) };
    electron.invoke.mockResolvedValueOnce({ ok: true, data: first }).mockResolvedValueOnce({ ok: true, data: changed });
    expect(api.isDesktop).toBe(true);
    await expect(api.syncLibrary()).resolves.toEqual(first);
    await expect(api.syncLibrary()).resolves.toEqual(changed);
    expect(electron.invoke.mock.calls).toEqual([['daily-cf:sync-library'], ['daily-cf:sync-library']]);
  });

  it('propagates a failed synchronization instead of returning the previous revision', async () => {
    const api = await desktopApi();
    electron.invoke.mockResolvedValueOnce({ ok: true, data: { branch: 'main', revision: 'a'.repeat(40) } })
      .mockResolvedValueOnce({ ok: false, error: 'Repository update failed' })
      .mockResolvedValueOnce({ ok: true, data: { branch: 'main', revision: 'c'.repeat(40) } });
    await api.syncLibrary();
    await expect(api.syncLibrary()).rejects.toThrow('Repository update failed');
    await expect(api.syncLibrary()).resolves.toEqual({ branch: 'main', revision: 'c'.repeat(40) });
    expect(electron.invoke).toHaveBeenCalledTimes(3);
  });

  it.each(localRequests)('passes a local %j read through the dedicated channel and preserves a missing snapshot', async request => {
    const api = await desktopApi();
    electron.invoke.mockResolvedValueOnce({ ok: true, data: null });
    await expect(api.getLocalLibraryView(request)).resolves.toBeNull();
    expect(electron.invoke.mock.calls).toEqual([['daily-cf:local-library-view', request]]);
  });

  it('preserves a retained view and its exact immutable revision without starting synchronization', async () => {
    const api = await desktopApi();
    const view = { kind: 'reference', revision: 'c'.repeat(40), code: 'print("retained code")\n' };
    const request = localRequests[5];
    electron.invoke.mockResolvedValueOnce({ ok: true, data: view });
    await expect(api.getLocalLibraryView(request)).resolves.toEqual(view);
    expect(electron.invoke.mock.calls).toEqual([['daily-cf:local-library-view', request]]);
  });

  it('keeps a confirmed missing-content error distinct from a failed update at the renderer boundary', async () => {
    const api = await desktopApi();
    electron.invoke.mockResolvedValueOnce({ ok: false, error: 'The problem was removed', code: 'library_content_missing',
      token: 'never-exposed', response: { private: true } });
    const error = await api.getDay('2128-03-02').catch(error => error);
    expect(error).toMatchObject({ message: 'The problem was removed', code: 'library_content_missing' });
    expect(error).not.toHaveProperty('token');
    expect(error).not.toHaveProperty('response');
  });

  it('keeps library progress separate from auth and submission events and removes only its own listener', async () => {
    const api = await desktopApi();
    const first = vi.fn<(value: LibrarySyncProgress) => void>();
    const second = vi.fn<(value: LibrarySyncProgress) => void>();
    const auth = vi.fn<(value: AuthState) => void>();
    const submission = vi.fn<(value: SubmissionProgress) => void>();
    const unsubscribeFirst = api.onLibrarySync(first);
    const unsubscribeSecond = api.onLibrarySync(second);
    const unsubscribeAuth = api.onAuthChanged(auth);
    const unsubscribeSubmission = api.onSubmissionProgress(submission);
    const listeners = electron.on.mock.calls as [string, (event: unknown, value: unknown) => void][];
    expect(listeners.map(([channel]) => channel)).toEqual([
      'daily-cf:library-sync', 'daily-cf:library-sync', 'daily-cf:auth', 'daily-cf:progress',
    ]);
    const progress: LibrarySyncProgress = { phase: 'downloading', completed: 40, total: 100, unit: 'objects' };
    listeners[0][1]({ sender: 'not exposed to callback' }, progress);
    expect(first).toHaveBeenCalledExactlyOnceWith(progress);
    expect(second).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(submission).not.toHaveBeenCalled();

    unsubscribeFirst();
    expect(electron.removeListener.mock.calls).toEqual([['daily-cf:library-sync', listeners[0][1]]]);
    expect(listeners[0][1]).not.toBe(listeners[1][1]);
    const ready: LibrarySyncProgress = { phase: 'ready', completed: 100, total: 100, unit: 'objects', revision: 'd'.repeat(40) };
    listeners[1][1](undefined, ready);
    expect(second).toHaveBeenCalledExactlyOnceWith(ready);
    unsubscribeSecond();
    unsubscribeAuth();
    unsubscribeSubmission();
    expect(electron.removeListener.mock.calls).toEqual(listeners);
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it('uses the browser archive snapshot for fresh synchronization metadata without pretending to have local Git', async () => {
    previewGlobals();
    const { ProblemLibrary } = await import('../electron/library');
    const first: ArchiveSnapshot = { branch: 'main', revision: 'a'.repeat(40), months: [{ month: '2026-10', days: 8 }] };
    const changed: ArchiveSnapshot = { branch: 'release/题库', revision: 'b'.repeat(40), months: [{ month: '2128-01', days: 1 }] };
    const snapshot = vi.spyOn(ProblemLibrary.prototype, 'getArchiveSnapshot').mockResolvedValueOnce(first).mockResolvedValueOnce(changed);
    const { api } = await import('../src/bridge');
    expect(api.isDesktop).toBe(false);
    await expect(api.syncLibrary()).resolves.toEqual({ branch: first.branch, revision: first.revision });
    await expect(api.syncLibrary()).resolves.toEqual({ branch: changed.branch, revision: changed.revision });
    expect(snapshot.mock.calls).toEqual([[], []]);
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it('does not fall back to an earlier browser snapshot after a remote failure', async () => {
    previewGlobals();
    const { ProblemLibrary } = await import('../electron/library');
    const snapshot = vi.spyOn(ProblemLibrary.prototype, 'getArchiveSnapshot')
      .mockResolvedValueOnce({ branch: 'main', revision: 'a'.repeat(40), months: [] })
      .mockRejectedValueOnce(new Error('Snapshot unavailable'));
    const { api } = await import('../src/bridge');
    await api.syncLibrary();
    await expect(api.syncLibrary()).rejects.toThrow('Snapshot unavailable');
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it('returns no local view in browser preview without network or storage reads for any view kind', async () => {
    previewGlobals();
    const { api } = await import('../src/bridge');
    vi.mocked(localStorage.getItem).mockClear();
    for (const request of localRequests) await expect(api.getLocalLibraryView(request)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it('offers a safe browser progress unsubscribe without fabricating local synchronization events', async () => {
    previewGlobals();
    const { api } = await import('../src/bridge');
    const callback = vi.fn();
    const unsubscribe = api.onLibrarySync(callback);
    expect(unsubscribe).toBeTypeOf('function');
    expect(() => { unsubscribe(); unsubscribe(); }).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(electron.on).not.toHaveBeenCalled();
  });

  it('routes desktop day reads through the local library and preserves it when resetting account clients', () => {
    const source = ts.createSourceFile('main.ts', readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const nodes = descendants(source);
    const handlers = nodes.filter(ts.isCallExpression).filter(node => ts.isIdentifier(node.expression) && node.expression.text === 'handle');
    const day = handlers.find(node => ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'day');
    expect(day).toBeDefined();
    const dayReaders = descendants(day!.arguments[1]).filter(ts.isCallExpression)
      .map(node => node.expression).filter(ts.isPropertyAccessExpression)
      .filter(node => node.name.text === 'getDay').map(node => node.expression.getText(source));
    expect(dayReaders).toEqual(['library']);
    const sync = handlers.find(node => ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'sync-library');
    expect(sync).toBeDefined();
    const local = handlers.find(node => ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'local-library-view');
    expect(local).toBeDefined();
    const localReaders = descendants(local!.arguments[1]).filter(ts.isCallExpression)
      .map(node => node.expression).filter(ts.isPropertyAccessExpression)
      .filter(node => node.name.text === 'getLocalLibraryView').map(node => node.expression.getText(source));
    expect(localReaders).toEqual(['library']);
    const reset = nodes.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'resetClients');
    expect(reset).toBeDefined();
    const libraryAssignments = descendants(reset!).filter(ts.isBinaryExpression).filter(node =>
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === 'library');
    expect(libraryAssignments).toEqual([]);
  });
});
