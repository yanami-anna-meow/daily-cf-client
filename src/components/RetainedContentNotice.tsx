import { CircleHelp, RefreshCw } from 'lucide-react';
import { t, useLocale } from '../i18n';

/** The shared library strip owns progress; this notice explains retained results after a failed or stopped read. */
export default function RetainedContentNotice({ retained, loading, error, onRetry }: {
  retained: boolean; loading: boolean; error?: string; onRetry?: () => void;
}) {
  useLocale();
  if (!retained || loading) return null;
  return <div className={`retained-content-note${error ? ' retained-content-warning' : ''}`} data-testid="retained-content-note" role="status">
    <CircleHelp size={15} />
    <div><span>{t('题库更新未完成，当前显示上次读取的内容。')}</span>
      {error && <small>{error}</small>}
    </div>
    {onRetry && <button type="button" className="text-button" onClick={onRetry}><RefreshCw size={14} />{t('重试')}</button>}
  </div>;
}
