import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientAPI } from '../shared/types';

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

describe('external problem links', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    'https://WWW.Codeforces.com/contest/1185/problem/D?locale=en&from=archive#statement',
    'http://codeforces.com/gym/102307/problem/K?locale=ru#sample',
  ])('passes the original problem link through the external-browser IPC bridge: %s', async url => {
    await import('../electron/preload');
    const [name, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    expect(name).toBe('dailyCF');
    electron.invoke.mockResolvedValueOnce({ ok: true });
    await api.openExternal(url);
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('daily-cf:external', url);
  });

  it('localizes the isolated bridge failure after bootstrap and a successful language change', async () => {
    await import('../electron/preload');
    const [, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    const settings = { clientId: '', language: 'cpp', theme: 'light', uiLanguage: 'system' };
    electron.invoke.mockResolvedValueOnce({ ok: true, data: { settings, systemLanguages: ['en-US'] } });
    await api.bootstrap();
    electron.invoke.mockResolvedValueOnce({ ok: false });
    await expect(api.openExternal('https://codeforces.com/problemset/problem/4/A')).rejects.toThrow('The operation failed');
    electron.invoke.mockResolvedValueOnce({ ok: true, data: { ...settings, uiLanguage: 'zh-CN' } });
    await api.saveSettings({ clientId: '', language: 'cpp', theme: 'light', uiLanguage: 'zh-CN' });
    electron.invoke.mockResolvedValueOnce({ ok: false });
    await expect(api.openExternal('https://codeforces.com/problemset/problem/4/A')).rejects.toThrow('操作失败，请重试。');
  });

  it('keeps web-preview problem links external and rejects unsafe URLs without requesting a statement', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    vi.stubGlobal('navigator', { languages: ['zh-CN'], language: 'zh-CN' });
    vi.stubGlobal('localStorage', { length: 0, key: vi.fn(), getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    const fetcher = vi.fn(() => { throw new Error('Unexpected request'); }); vi.stubGlobal('fetch', fetcher);
    const { api } = await import('../src/bridge');
    const urls = [
      'https://WWW.Codeforces.com/contest/4/problem/A?locale=en&from=archive#statement',
      'http://www.codeforces.com/gym/102307/problem/K?locale=ru#sample',
      'HTTP://Codeforces.com/problemset/problem/4/A?x=%2f%2F#Input',
    ];
    for (const url of urls) await api.openExternal(url);
    expect(open.mock.calls).toEqual(urls.map(url => [url, '_blank', 'noopener,noreferrer']));
    await expect(api.openExternal('javascript:alert(1)')).rejects.toThrow();
    await expect(api.openExternal('http://github.com/Yawn-Sean/Daily_CF_Problems')).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(urls.length);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
