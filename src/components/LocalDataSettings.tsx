import { useEffect, useRef, useState } from 'react';
import { FileJson, FolderOpen, LoaderCircle } from 'lucide-react';
import { api } from '../bridge';
import { t } from '../i18n';
import './LocalDataSettings.css';

export default function LocalDataSettings() {
  const [paths, setPaths] = useState<{ configFile: string; dataDirectory: string } | null>(null);
  const [loading, setLoading] = useState(api.isDesktop);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState<'config' | 'data' | null>(null);
  const [reload, setReload] = useState(0);
  const openingRef = useRef(false);

  useEffect(() => {
    if (!api.isDesktop) return;
    let active = true;
    setLoading(true); setError('');
    void api.getLocalPaths().then(value => { if (active) setPaths(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);

  async function open(target: 'config' | 'data') {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(target); setError('');
    try { await api.openLocalPath(target); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { openingRef.current = false; setOpening(null); }
  }

  return <section className="panel settings-section local-data-settings">
    <h2><FolderOpen size={20} />{t('本地文件')}</h2>
    {api.isDesktop ? <>
      {loading && <p className="local-data-status" role="status"><LoaderCircle size={15} className="spin" />{t('正在读取文件位置…')}</p>}
      {paths && <div className="local-data-rows">
        <div className="local-data-row">
          <div><h3>{t('配置文件')}</h3><code>{paths.configFile}</code></div>
          <button type="button" className="button" disabled={opening !== null} onClick={() => void open('config')}>
            {opening === 'config' ? <LoaderCircle size={15} className="spin" /> : <FileJson size={15} />}{t('打开配置文件位置')}
          </button>
        </div>
        <div className="local-data-row">
          <div><h3>{t('数据目录')}</h3><code>{paths.dataDirectory}</code></div>
          <button type="button" className="button" disabled={opening !== null} onClick={() => void open('data')}>
            {opening === 'data' ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />}{t('打开数据目录')}
          </button>
        </div>
      </div>}
      {error && <div className="alert alert-error" role="alert"><span>{error}</span>{!paths && <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>{t('重试')}</button>}</div>}
    </> : <p className="local-data-status">{t('请在桌面客户端中查看本地文件。')}</p>}
  </section>;
}
