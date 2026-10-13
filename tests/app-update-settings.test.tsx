import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateState } from '../shared/app-update';
import { setLocale } from '../shared/i18n';
import { AppUpdateController, AppUpdateSettingsView, type AppUpdateClient, type UpdateView } from '../src/components/AppUpdateSettings';

vi.mock('../src/bridge', () => ({ api: {} }));

const idle: AppUpdateState = {
  phase: 'idle', currentVersion: '0.3.25',
  target: { platform: 'windows', arch: 'x86_64', packageKind: 'nsis', mode: 'installer', development: false },
};
const available: AppUpdateState = {
  ...idle, phase: 'available',
  release: { version: '0.3.26', url: 'https://github.com/yanami-anna-meow/daily-cf-client/releases/tag/v0.3.26', notes: '# Notes', publishedAt: '2026-10-14T00:00:00Z', asset: { name: 'Daily-CF-0.3.26-windows-x86_64-nsis.exe', size: 1024 ** 2 } },
};
const ready: AppUpdateState = { ...available, phase: 'ready' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function setup(isDesktop = true) {
  let event: (state: AppUpdateState) => void = () => {};
  const unsubscribe = vi.fn();
  const client = {
    isDesktop,
    getAppUpdateState: vi.fn(async () => idle),
    checkAppUpdate: vi.fn(async () => available),
    downloadAppUpdate: vi.fn(async () => ready),
    cancelAppUpdate: vi.fn(async () => {}),
    openAppUpdate: vi.fn(async () => {}),
    revealAppUpdate: vi.fn(async () => {}),
    onAppUpdate: vi.fn((callback: (state: AppUpdateState) => void) => { event = callback; return unsubscribe; }),
    openExternal: vi.fn(async (_url: string) => {}),
  } satisfies AppUpdateClient;
  const controller = new AppUpdateController(client);
  return { controller, client, unsubscribe, emit: (state: AppUpdateState) => event(state) };
}

describe('user-initiated update state', () => {
  it('subscribes and reads state on entry without checking, downloading or opening anything', async () => {
    const { controller, client } = setup();
    const disconnect = controller.connect();
    await tick();
    expect(client.onAppUpdate).toHaveBeenCalledOnce();
    expect(client.getAppUpdateState).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ state: idle, loading: false, action: null });
    expect(client.checkAppUpdate).not.toHaveBeenCalled();
    expect(client.downloadAppUpdate).not.toHaveBeenCalled();
    expect(client.openAppUpdate).not.toHaveBeenCalled();
    expect(client.revealAppUpdate).not.toHaveBeenCalled();
    disconnect();
  });

  it('ignores a delayed initial read when a fresher event has arrived', async () => {
    const { controller, client, emit } = setup();
    const initial = deferred<AppUpdateState>();
    client.getAppUpdateState.mockReturnValueOnce(initial.promise);
    controller.connect();
    emit(ready);
    initial.resolve(idle);
    await tick();
    expect(controller.getSnapshot().state).toEqual(ready);
  });

  it('ignores a stale initial reply even when the event is delivered during subscription', async () => {
    const { controller, client } = setup();
    client.onAppUpdate.mockImplementationOnce(callback => { callback(ready); return vi.fn(); });
    controller.connect();
    await tick();
    expect(controller.getSnapshot().state).toEqual(ready);
  });

  it('cleans up and isolates old subscription replies after remounting', async () => {
    const { controller, client, unsubscribe, emit } = setup();
    const initial = deferred<AppUpdateState>();
    client.getAppUpdateState.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(available);
    const disconnect = controller.connect();
    disconnect();
    emit(ready);
    controller.connect();
    await tick();
    initial.resolve(idle);
    await tick();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ state: available, action: null, loading: false });
  });

  it('requires separate check, download and open actions and guards repeated clicks', async () => {
    const { controller, client } = setup();
    controller.connect(); await tick();
    const check = deferred<AppUpdateState>();
    client.checkAppUpdate.mockReturnValueOnce(check.promise);
    const pending = controller.perform('check');
    expect(await controller.perform('check')).toBe(false);
    expect(client.checkAppUpdate).toHaveBeenCalledOnce();
    check.resolve(available); await pending;
    expect(controller.getSnapshot().state).toEqual(available);
    expect(client.downloadAppUpdate).not.toHaveBeenCalled();
    await controller.perform('download');
    expect(controller.getSnapshot().state).toEqual(ready);
    expect(client.openAppUpdate).not.toHaveBeenCalled();
    await controller.perform('open');
    expect(client.openAppUpdate).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().state?.currentVersion).toBe('0.3.25');
  });

  it('can cancel an in-flight download and ignores its late completion', async () => {
    const { controller, client, emit } = setup();
    controller.connect(); await tick();
    const download = deferred<AppUpdateState>();
    client.downloadAppUpdate.mockReturnValueOnce(download.promise);
    const downloading = controller.perform('download');
    emit({ ...available, phase: 'downloading', progress: { downloaded: 128, total: 1024 } });
    client.getAppUpdateState.mockResolvedValueOnce(available);
    expect(await controller.perform('cancel')).toBe(true);
    download.resolve(ready); await downloading;
    expect(client.cancelAppUpdate).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ state: available, action: null, error: '' });
  });

  it('shows action errors after progress arrives and permits retry', async () => {
    const { controller, client, emit } = setup();
    controller.connect(); await tick();
    const download = deferred<AppUpdateState>();
    client.downloadAppUpdate.mockReturnValueOnce(download.promise);
    const pending = controller.perform('download');
    emit({ ...available, phase: 'downloading' }); download.reject(new Error('Connection interrupted')); await pending;
    expect(controller.getSnapshot().error).toBe('Connection interrupted');
    client.openAppUpdate.mockRejectedValueOnce(new Error('Cannot open installer'));
    expect(await controller.perform('open')).toBe(false);
    expect(controller.getSnapshot().error).toBe('Cannot open installer');
    expect(await controller.perform('open')).toBe(true);
    expect(controller.getSnapshot().error).toBe('');
  });

  it('does not obscure a received state with an obsolete initial read failure', async () => {
    const { controller, client, emit } = setup();
    const initial = deferred<AppUpdateState>();
    client.getAppUpdateState.mockReturnValueOnce(initial.promise);
    controller.connect(); emit(ready);
    initial.reject(new Error('Old read failed')); await tick();
    expect(controller.getSnapshot()).toMatchObject({ state: ready, error: '', loading: false });
  });

  it('shows read failures, permits retry and discards results after unmount', async () => {
    const { controller, client } = setup();
    client.getAppUpdateState.mockRejectedValueOnce(new Error('Disconnected'));
    const disconnect = controller.connect(); await tick();
    expect(controller.getSnapshot()).toMatchObject({ error: 'Disconnected', loading: false });
    await controller.perform('load');
    expect(controller.getSnapshot().state).toEqual(idle);
    const check = deferred<AppUpdateState>(); client.checkAppUpdate.mockReturnValueOnce(check.promise);
    const pending = controller.perform('check'); disconnect();
    check.resolve(available); await pending;
    expect(controller.getSnapshot().state).toEqual(idle);
  });

  it('uses the official releases page in browser preview without invoking desktop methods', async () => {
    const { controller, client } = setup(false);
    controller.connect(); await tick();
    expect(client.getAppUpdateState).not.toHaveBeenCalled();
    expect(client.onAppUpdate).not.toHaveBeenCalled();
    expect(controller.getSnapshot().loading).toBe(false);
    await controller.perform('release');
    expect(client.openExternal).toHaveBeenCalledWith('https://github.com/yanami-anna-meow/daily-cf-client/releases');
  });

  it('reveals the verified file separately and opens the selected release for notes', async () => {
    const { controller, client } = setup();
    client.getAppUpdateState.mockResolvedValueOnce(ready);
    controller.connect(); await tick();
    await controller.perform('reveal');
    await controller.perform('release');
    expect(client.revealAppUpdate).toHaveBeenCalledOnce();
    expect(client.openAppUpdate).not.toHaveBeenCalled();
    expect(client.openExternal).toHaveBeenCalledWith(ready.release?.url);
  });
});

const render = (state: AppUpdateState | null, options: Partial<UpdateView> & { desktop?: boolean } = {}) => renderToStaticMarkup(
  <AppUpdateSettingsView view={{ state, loading: false, action: null, error: '', ...options }} desktop={options.desktop ?? true} onAction={async () => true} />,
);
describe('update settings rendering', () => {
  beforeEach(() => setLocale('zh-CN'));
  afterEach(() => setLocale('zh-CN'));

  it('shows the installed version, matching package and manual check without a download on idle', () => {
    const markup = render(idle);
    expect(markup).toContain('当前版本'); expect(markup).toContain('0.3.25');
    expect(markup).toContain('Windows · x86_64 · NSIS 安装版');
    expect(markup).toContain('检查新版本');
    expect(markup).not.toContain('>下载更新<');
    expect(markup).toContain('不会自动安装或重启');
  });

  it('offers the exact new package without claiming it is installed', () => {
    const markup = render(available);
    expect(markup).toContain('可更新至 0.3.26。');
    expect(markup).toContain(available.release!.asset!.name);
    expect(markup).toContain('>下载更新<');
    expect(markup).not.toContain('下载完成');
    expect(markup).not.toContain('打开安装包');
  });

  it('renders indeterminate progress safely and known progress within bounds', () => {
    for (const total of [0, -1, NaN, Infinity]) {
      const markup = render({ ...available, phase: 'downloading', progress: { downloaded: NaN, total } });
      expect(markup).toContain('<progress'); expect(markup).toContain('max="1"');
      expect(markup).not.toContain('value='); expect(markup).not.toContain('NaN'); expect(markup).not.toContain('Infinity');
      expect(markup).toContain('取消下载'); expect(markup).not.toContain('检查新版本');
    }
    const markup = render({ ...available, phase: 'downloading', progress: { downloaded: 200, total: 100 } });
    expect(markup).toContain('max="100" value="100"');
    expect(markup).toContain('aria-label="更新下载进度"');
  });

  it('distinguishes installer and replacement modes after verification', () => {
    const installer = render(ready);
    expect(installer).toContain('下载完成，文件校验通过。'); expect(installer).toContain('>打开安装包<');
    expect(installer).toContain('0.3.25'); expect(installer).not.toContain('当前已是最新版本');
    for (const packageKind of ['portable', 'appimage'] as const) {
      const markup = render({ ...ready, target: { ...ready.target, mode: 'replace-file', packageKind } });
      expect(markup).toContain('显示下载文件'); expect(markup).toContain('退出客户端后，用下载的文件替换原文件');
      expect(markup).not.toContain('>打开安装包<');
    }
  });

  it('shows release-only guidance for unsupported, development and browser builds', () => {
    expect(render(null, { desktop: false })).toContain('请在桌面客户端中检查和下载更新');
    expect(render(null, { desktop: false })).not.toContain('检查新版本');
    for (const target of [{ ...idle.target, development: true }, { ...idle.target, mode: 'unsupported' as const }]) {
      const markup = render({ ...available, target });
      expect(markup).not.toContain('>下载更新<'); expect(markup).not.toContain('检查新版本');
      expect(markup).toContain('查看发布说明');
    }
    const markup = render({ ...available, release: { ...available.release!, asset: undefined } });
    expect(markup).toContain('没有适合当前平台和架构的安装包'); expect(markup).not.toContain('>下载更新<');
  });

  it('makes failures visible as text and exposes retry without rendering remote markup', () => {
    const markup = render({ ...available, phase: 'error', error: '<script>remote</script>' });
    expect(markup).toContain('role="alert"'); expect(markup).toContain('&lt;script&gt;remote&lt;/script&gt;');
    expect(markup).toContain('重新下载'); expect(markup).toContain('检查新版本');
    expect(render(null, { error: 'Read failed' })).toContain('重试');
  });

  it('fully translates controls and progress while preserving version and filename', () => {
    setLocale('en');
    const markup = render(ready);
    expect(markup).toContain('App updates'); expect(markup).toContain('Current version');
    expect(markup).toContain('Download complete. File verified.'); expect(markup).toContain('Open installer');
    expect(markup).toContain('Windows · x86_64 · NSIS installer');
    expect(markup).toContain(ready.release!.asset!.name); expect(markup).not.toMatch(/[\p{Script=Han}]/u);
    const progress = render({ ...available, phase: 'downloading', progress: { downloaded: 0, total: 0 } });
    expect(progress).toContain('Cancel download'); expect(progress).toContain('aria-label="Update download progress"');
    expect(progress).not.toMatch(/[\p{Script=Han}]/u);
  });
});
