import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, Download, ExternalLink, FolderOpen, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import type { AppUpdateState, AppUpdateTarget } from '../../shared/app-update';
import { CLIENT_REPOSITORY } from '../../shared/metadata';
import { api } from '../bridge';
import { t } from '../i18n';
import Modal from './Modal';
import './AppUpdateSettings.css';

type Action = 'check' | 'download' | 'cancel' | 'open' | 'reveal' | 'load' | 'release';
export interface AppUpdateClient {
  isDesktop: boolean;
  getAppUpdateState(): Promise<AppUpdateState>;
  checkAppUpdate(): Promise<AppUpdateState>;
  downloadAppUpdate(): Promise<AppUpdateState>;
  cancelAppUpdate(): Promise<void>;
  openAppUpdate(): Promise<void>;
  revealAppUpdate(): Promise<void>;
  onAppUpdate(callback: (state: AppUpdateState) => void): () => void;
  openExternal(url: string): Promise<void>;
}
export interface UpdateView {
  state: AppUpdateState | null;
  loading: boolean;
  action: Action | null;
  error: string;
}

// Reading the state and listening are deliberately separate from checking or
// downloading. A visit to Settings never starts a network request for an update.
export class AppUpdateController {
  private value: UpdateView;
  private listeners = new Set<() => void>();
  private session = 0;
  private events = 0;
  private operation = 0;
  private connected = false;
  constructor(private client: AppUpdateClient) {
    this.value = { state: null, loading: client.isDesktop, action: null, error: '' };
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<UpdateView>) {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }
  connect = () => {
    if (!this.client.isDesktop || this.connected) return () => {};
    this.connected = true;
    const session = ++this.session;
    const events = this.events;
    const current = () => this.connected && this.session === session;
    const unsubscribe = this.client.onAppUpdate(state => {
      if (!current()) return;
      this.events++;
      this.publish({ state, loading: false, error: '' });
    });
    void this.perform('load', events);
    return () => {
      if (!current()) return;
      this.connected = false;
      this.operation++;
      unsubscribe();
      this.publish({ action: null });
    };
  };
  perform = async (action: Action, events = this.events): Promise<boolean> => {
    if (!this.connected && this.client.isDesktop) return false;
    if (this.value.action && !(action === 'cancel' && this.value.action === 'download')) return false;
    const session = this.session;
    const operation = ++this.operation;
    const current = () => this.session === session && this.operation === operation && (this.connected || !this.client.isDesktop);
    this.publish({ action, error: '' });
    try {
      let state: AppUpdateState | undefined;
      if (action === 'load') state = await this.client.getAppUpdateState();
      if (action === 'check') state = await this.client.checkAppUpdate();
      if (action === 'download') state = await this.client.downloadAppUpdate();
      if (action === 'cancel') { await this.client.cancelAppUpdate(); state = await this.client.getAppUpdateState(); }
      if (action === 'open') await this.client.openAppUpdate();
      if (action === 'reveal') await this.client.revealAppUpdate();
      if (action === 'release') await this.client.openExternal(this.value.state?.release?.url || `${CLIENT_REPOSITORY.url}/releases`);
      if (!current()) return false;
      // An IPC reply can have been serialized before an event already received.
      if (state && this.events === events) this.publish({ state });
      return true;
    } catch (error) {
      // An initial read failure is obsolete once a subscription delivered state.
      // Action failures still matter after progress events (e.g. a broken download).
      if (current() && !(action === 'load' && this.events !== events)) this.publish({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (current()) this.publish({ action: null, loading: false });
    }
  };
}

function targetLabel(target: AppUpdateTarget): string {
  const platform = target.platform === 'windows' ? 'Windows' : target.platform === 'macos' ? 'macOS' : target.platform === 'linux' ? 'Linux' : t('未知平台');
  const arch = target.arch === 'unknown' ? t('未知架构') : target.arch;
  const kind = target.packageKind === 'nsis' ? t('NSIS 安装版') : target.packageKind === 'portable' ? t('便携版') : target.packageKind === 'dmg' ? 'DMG' : target.packageKind === 'appimage' ? 'AppImage' : target.packageKind === 'deb' ? 'DEB' : t('未知安装类型');
  return `${platform} · ${arch} · ${kind}`;
}

function bytes(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return `${(safe / 1024 / 1024).toFixed(1)} MB`;
}

export function AppUpdateSettingsView({ view, desktop, hasUnsavedChanges = false, onAction }: {
  view: UpdateView;
  desktop: boolean;
  hasUnsavedChanges?: boolean;
  onAction: (action: Action) => Promise<boolean>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { state, loading, action } = view;
  const phase = state?.phase;
  const busy = action !== null;
  const supported = state && !state.target.development && state.target.mode !== 'unsupported';
  const downloading = phase === 'downloading' || action === 'download';
  const ready = phase === 'ready';
  const total = state?.progress?.total;
  const knownTotal = typeof total === 'number' && Number.isFinite(total) && total > 0;
  const received = state?.progress?.downloaded;
  const downloaded = typeof received === 'number' && Number.isFinite(received) && received > 0 ? received : 0;
  const error = view.error || (phase === 'error' ? state?.error : '');
  const showDownload = supported && state.release?.asset && (phase === 'available' || phase === 'error');

  return <section className="panel settings-section app-update-settings">
    <h2><Download size={20} />{t('软件更新')}</h2>
    {!desktop ? <p className="app-update-description">{t('请在桌面客户端中检查和下载更新。')}</p> : <>
      {state && <div className="app-update-versions">
        <div><span>{t('当前版本')}</span><strong>{state.currentVersion}</strong></div>
        {state.release && <div><span>{t('最新版本')}</span><strong>{state.release.version}</strong></div>}
        <p>{targetLabel(state.target)}</p>
      </div>}
      <div className="app-update-status" role="status" aria-live="polite">
        {loading ? <p><LoaderCircle size={16} className="spin" />{t('正在读取更新状态…')}</p>
          : state?.target.development ? <p>{t('开发模式不提供应用内更新。')}</p>
            : state?.target.mode === 'unsupported' ? <p>{t('此构建不支持应用内下载更新，请从发布页选择安装包。')}</p>
              : phase === 'checking' || action === 'check' ? <p><LoaderCircle size={16} className="spin" />{t('正在检查新版本…')}</p>
                : downloading ? <p><LoaderCircle size={16} className="spin" />{t('正在下载更新…')}</p>
                  : ready ? <p><CheckCircle2 size={16} />{t('下载完成，文件校验通过。')}</p>
                    : phase === 'current' ? <p><CheckCircle2 size={16} />{t('当前已是最新版本。')}</p>
                      : phase === 'available' && state?.release ? <p>{t('可更新至 {{version}}。', { version: state.release.version })}</p> : null}
      </div>
      {downloading && <div className="app-update-progress">
        <progress aria-label={t('更新下载进度')} max={knownTotal ? total : 1} value={knownTotal ? Math.min(downloaded, total) : undefined} />
        <span>{knownTotal ? `${bytes(downloaded)} / ${bytes(total)}` : t('已下载 {{size}}', { size: bytes(downloaded) })}</span>
      </div>}
      {state?.release?.asset && (showDownload || downloading || ready) && <code className="app-update-filename">{state.release.asset.name}</code>}
      {phase === 'available' && supported && !state.release?.asset && <p className="app-update-description">{t('该版本没有适合当前平台和架构的安装包，请查看发布页。')}</p>}
      {ready && <p className="app-update-description">{state?.target.mode === 'replace-file' ? t('退出客户端后，用下载的文件替换原文件，再重新打开。') : t('打开安装包后，请按安装程序的提示完成更新。')}</p>}
      {!ready && supported && <p className="app-update-description">{t('选择下载后才会下载更新，不会自动安装或重启。')}</p>}
    </>}
    {error && <div className="alert alert-error" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}
    <div className="app-update-actions">
      {desktop && !state && !loading && <button type="button" className="button" disabled={busy} onClick={() => void onAction('load')}><RefreshCw size={15} />{t('重试')}</button>}
      {desktop && supported && !downloading && <button type="button" className="button" disabled={busy || phase === 'checking'} onClick={() => void onAction('check')}><RefreshCw size={15} />{phase === 'checking' || action === 'check' ? t('检查中…') : t('检查新版本')}</button>}
      {showDownload && !downloading && <button type="button" className="button button-primary" disabled={busy} onClick={() => void onAction('download')}><Download size={15} />{phase === 'error' ? t('重新下载') : t('下载更新')}</button>}
      {downloading && <button type="button" className="button" disabled={action === 'cancel'} onClick={() => void onAction('cancel')}>{action === 'cancel' ? t('正在取消…') : t('取消下载')}</button>}
      {ready && supported && (state.target.mode === 'replace-file'
        ? <button type="button" className="button button-primary" disabled={busy} onClick={() => void onAction('reveal')}><FolderOpen size={15} />{t('显示下载文件')}</button>
        : <button type="button" className="button button-primary" disabled={busy} onClick={() => setConfirmOpen(true)}><Download size={15} />{t('打开安装包')}</button>)}
      <button type="button" className="text-button" disabled={busy} onClick={() => void onAction('release')}>{state?.release ? t('查看发布说明') : t('打开发布页')}<ExternalLink size={14} /></button>
    </div>
    {confirmOpen && <Modal title={t('打开安装包？')} onClose={() => setConfirmOpen(false)} closable={action !== 'open'}>
      <p className="app-update-description">{t('安装程序可能要求关闭客户端。请完成当前操作后再继续。')}</p>
      {hasUnsavedChanges && <div className="alert alert-warning app-update-unsaved" role="alert"><TriangleAlert size={17} /><span>{t('有未保存的设置或尚未提交的代码。关闭客户端可能丢失这些内容。')}</span></div>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="app-update-confirm-actions">
        <button type="button" className="button" disabled={action === 'open'} onClick={() => setConfirmOpen(false)}>{t('取消')}</button>
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void onAction('open').then(opened => { if (opened) setConfirmOpen(false); })}>{action === 'open' && <LoaderCircle size={15} className="spin" />}{t('继续打开')}</button>
      </div>
    </Modal>}
  </section>;
}

export default function AppUpdateSettings({ hasUnsavedChanges = false }: { hasUnsavedChanges?: boolean }) {
  const controller = useMemo(() => new AppUpdateController(api), []);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => controller.connect(), [controller]);
  return <AppUpdateSettingsView view={view} desktop={api.isDesktop} hasUnsavedChanges={hasUnsavedChanges} onAction={controller.perform} />;
}
