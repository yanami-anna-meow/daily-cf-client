import { useEffect, useState } from 'react';
import { Clock3, Github, RefreshCw } from 'lucide-react';
import { rateLimitMessage, type RateLimitInfo } from '../../shared/rate-limit';
import { t } from '../i18n';

export function useRateLimitReady(info: RateLimitInfo | null, signedIn: boolean): boolean {
  const [now, setNow] = useState(Date.now);
  const ready = !info || now >= info.retryAt || (signedIn && !info.authenticated);
  useEffect(() => {
    if (ready) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ready, info?.retryAt]);
  return ready;
}

export default function GitHubRateLimitNotice({ info, signedIn, ready, onLogin, onRetry }: {
  info: RateLimitInfo; signedIn: boolean; ready: boolean; onLogin?: () => void; onRetry: () => void;
}) {
  const accountChanged = signedIn && !info.authenticated;
  return <section className="alert alert-warning rate-limit-notice" role="status">
    <Clock3 size={20} />
    <div className="rate-limit-content">
      <strong>{t('GitHub 请求暂时受限')}</strong>
      <p>{accountChanged ? t('已登录，可以重新加载题库。') : rateLimitMessage(info)}</p>
      {!info.authenticated && !signedIn && <p>{t('浏览器中的 GitHub 登录与客户端登录相互独立。')}</p>}
      {ready && !accountChanged && <p>{t('等待时间已到，可以重新加载。')}</p>}
      <div className="rate-limit-actions">
        {!signedIn && !info.authenticated && info.kind === 'primary' && onLogin &&
          <button type="button" className="button button-primary" onClick={onLogin}><Github size={16} />{t('登录 GitHub')}</button>}
        <button type="button" className="button button-secondary" onClick={onRetry} disabled={!ready}><RefreshCw size={16} />{t('重新加载')}</button>
      </div>
    </div>
  </section>;
}
