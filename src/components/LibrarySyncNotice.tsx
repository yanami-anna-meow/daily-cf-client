import { CheckCircle2, Download, LoaderCircle, RefreshCw, WifiOff } from 'lucide-react';
import type { LibrarySyncProgress } from '../../shared/types';
import { getLocale, t, useLocale } from '../i18n';
import './LibrarySyncNotice.css';

function amount(value: number, bytes: boolean) {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (!bytes) return new Intl.NumberFormat(getLocale()).format(Math.floor(value));
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = value ? Math.max(0, Math.min(3, Math.floor(Math.log(value) / Math.log(1024)))) : 0;
  return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: index ? 1 : 0 }).format(value / 1024 ** index)} ${units[index]}`;
}

export default function LibrarySyncNotice({ progress, onRefresh, refreshing = false }: {
  progress: LibrarySyncProgress | null; onRefresh?: () => void; refreshing?: boolean;
}) {
  useLocale();
  if (!progress && !onRefresh) return null;
  const phase = progress?.phase;
  const busy = Boolean(phase && phase !== 'ready' && phase !== 'error');
  const title = phase === 'checking' ? t('正在更新题库…')
    : phase === 'repairing' ? t('正在修复本地题库…')
    : phase === 'downloading' ? t('正在下载题库…')
    : phase === 'indexing' ? t('正在整理题目…')
    : phase === 'ready' ? t('题库已更新')
    : phase === 'error' ? t('题库更新失败') : t('题库');
  const total = progress?.total && Number.isFinite(progress.total) && progress.total > 0 ? progress.total : undefined;
  const completed = Math.max(0, Number.isFinite(progress?.completed) ? progress!.completed : 0);
  const showProgress = phase === 'downloading' || phase === 'indexing';
  const updatedAt = progress?.updatedAt && !Number.isNaN(Date.parse(progress.updatedAt)) ? progress.updatedAt : undefined;
  const Icon = phase === 'error' ? WifiOff : phase === 'ready' ? CheckCircle2 : phase === 'downloading' ? Download : busy ? LoaderCircle : RefreshCw;

  return <section className={`library-sync-notice${phase === 'error' ? ' library-sync-error' : ''}`} data-sync-phase={phase ?? 'idle'} aria-label={t('题库更新')}>
    <Icon size={16} className={busy && phase !== 'downloading' ? 'spin' : undefined} />
    <div className="library-sync-content">
      <div className="library-sync-summary" role={phase === 'error' ? 'alert' : 'status'} aria-live="polite">
        <span>{title}</span>
        {phase === 'ready' && updatedAt && <time dateTime={updatedAt}>{new Date(updatedAt).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })}</time>}
      </div>
      {showProgress && <div className="library-sync-progress">
        <progress value={total ? Math.min(completed, total) : undefined} max={total ?? 1} aria-label={t('题库更新进度')} />
        {completed > 0 && <span>{amount(completed, progress?.unit === 'bytes')}{total ? ` / ${amount(total, progress?.unit === 'bytes')}` : ''}</span>}
      </div>}
      {phase === 'error' && progress?.message && <p>{progress.message}</p>}
    </div>
    {onRefresh && <button type="button" className="text-button library-sync-refresh" data-testid="library-sync-refresh" onClick={onRefresh} disabled={busy || refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : undefined} />{t('刷新')}</button>}
  </section>;
}
