import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientAPI, LocalPaths } from '../shared/types';

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

describe('local paths IPC bridge', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads the application paths and opens only a named location through dedicated IPC', async () => {
    await import('../electron/preload');
    const [, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    const paths: LocalPaths = { configFile: '/profile/题库/data.json', dataDirectory: '/profile/题库' };
    electron.invoke.mockResolvedValueOnce({ ok: true, data: paths }).mockResolvedValue({ ok: true });
    await expect(api.getLocalPaths()).resolves.toEqual(paths);
    await api.openLocalPath('config');
    await api.openLocalPath('data');
    expect(electron.invoke.mock.calls).toEqual([
      ['daily-cf:local-paths'], ['daily-cf:open-local-path', 'config'], ['daily-cf:open-local-path', 'data'],
    ]);
  });

  it('propagates OS failures through the preload rather than reporting success', async () => {
    await import('../electron/preload');
    const [, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    electron.invoke.mockResolvedValue({ ok: false, error: 'File manager failed' });
    await expect(api.openLocalPath('data')).rejects.toThrow('File manager failed');
  });

  it('keeps browser preview local paths unavailable without storage writes or external launches', async () => {
    const open = vi.fn();
    const setItem = vi.fn();
    const fetcher = vi.fn(() => { throw new Error('Unexpected network request'); });
    vi.stubGlobal('window', { open });
    vi.stubGlobal('navigator', { languages: ['zh-CN'], language: 'zh-CN' });
    vi.stubGlobal('localStorage', { length: 0, key: vi.fn(), getItem: vi.fn(() => null), setItem, removeItem: vi.fn() });
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('../src/bridge');
    await expect(api.getLocalPaths()).resolves.toBeNull();
    await expect(api.openLocalPath('config')).rejects.toThrow('请在桌面客户端中打开本地文件或文件夹');
    await expect(api.openLocalPath('data')).rejects.toThrow('请在桌面客户端中打开本地文件或文件夹');
    expect(open).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
});
