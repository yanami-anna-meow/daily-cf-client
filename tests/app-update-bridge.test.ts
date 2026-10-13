import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientAPI } from '../shared/types';
import type { AppUpdateState } from '../shared/app-update';

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));
const ready: AppUpdateState = { phase: 'ready', currentVersion: '0.3.25',
  target: { platform: 'windows', arch: 'arm64', packageKind: 'nsis', mode: 'installer', development: false },
  release: { version: '0.3.26', url: 'https://github.com/yanami-anna-meow/daily-cf-client/releases/tag/v0.3.26',
    publishedAt: '2026-10-15T00:00:00Z', notes: 'Example release', asset: { name: 'Daily-CF-0.3.26-windows-arm64-nsis.exe', size: 100 } },
};

describe('app update IPC bridge', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => vi.unstubAllGlobals());

  it('does not check or download on preload and accepts no renderer-controlled file paths', async () => {
    await import('../electron/preload');
    const [, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    expect(electron.invoke).not.toHaveBeenCalled();
    electron.invoke.mockResolvedValue({ ok: true, data: ready });
    await expect(api.getAppUpdateState()).resolves.toEqual(ready);
    await expect(api.checkAppUpdate()).resolves.toEqual(ready);
    await expect(api.downloadAppUpdate()).resolves.toEqual(ready);
    await api.cancelAppUpdate(); await api.openAppUpdate(); await api.revealAppUpdate();
    expect(electron.invoke.mock.calls).toEqual([
      ['daily-cf:app-update-state'], ['daily-cf:app-update-check'], ['daily-cf:app-update-download'],
      ['daily-cf:app-update-cancel'], ['daily-cf:app-update-open'], ['daily-cf:app-update-reveal'],
    ]);
  });

  it('forwards update failures and removes only its own event listener', async () => {
    await import('../electron/preload');
    const [, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    const listener = vi.fn(); const unsubscribe = api.onAppUpdate(listener);
    const [channel, handler] = electron.on.mock.calls[0];
    expect(channel).toBe('daily-cf:app-update');
    handler({ sender: 'not exposed' }, ready);
    expect(listener).toHaveBeenCalledExactlyOnceWith(ready);
    unsubscribe(); expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith(channel, handler);
    electron.invoke.mockResolvedValue({ ok: false, error: 'Checksum mismatch' });
    await expect(api.openAppUpdate()).rejects.toThrow('Checksum mismatch');
  });

  it('never downloads, installs or invokes the desktop bridge from a browser preview', async () => {
    const open = vi.fn(); const fetcher = vi.fn(); const setItem = vi.fn();
    vi.stubGlobal('window', { open });
    vi.stubGlobal('navigator', { languages: ['zh-CN'], language: 'zh-CN' });
    vi.stubGlobal('localStorage', { length: 0, key: vi.fn(), getItem: vi.fn(() => null), setItem, removeItem: vi.fn() });
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('../src/bridge');
    expect((await api.getAppUpdateState()).target.mode).toBe('unsupported');
    await expect(api.checkAppUpdate()).rejects.toThrow();
    await expect(api.downloadAppUpdate()).rejects.toThrow();
    await expect(api.openAppUpdate()).rejects.toThrow();
    await expect(api.revealAppUpdate()).rejects.toThrow();
    await api.cancelAppUpdate(); api.onAppUpdate(vi.fn())();
    expect(open).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled(); expect(electron.invoke).not.toHaveBeenCalled();
  });
});
