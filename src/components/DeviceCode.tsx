import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';
import { api } from '../bridge';
import { t } from '../../shared/i18n';

export default function DeviceCode({ code }: { code: string }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);
  const attempt = useRef(0);
  const copying = useRef(false);

  useEffect(() => {
    ++attempt.current; copying.current = false; setState('idle');
    return () => { ++attempt.current; copying.current = false; };
  }, [code]);

  async function copy() {
    inputRef.current?.select();
    if (copying.current) return;
    copying.current = true;
    const current = ++attempt.current;
    setState('copying');
    try { await api.copyText(code); if (current === attempt.current) setState('copied'); }
    catch {
      if (current === attempt.current) {
        setState('failed');
        requestAnimationFrame(() => {
          if (current !== attempt.current) return;
          inputRef.current?.focus(); inputRef.current?.select();
        });
      }
    }
    finally { if (current === attempt.current) copying.current = false; }
  }

  return <div className="device-code-section">
    <div className="device-code">
      <input ref={inputRef} aria-label={t('GitHub设备验证码')} value={code} readOnly spellCheck={false} autoComplete="off" title={t('点击复制，也可选中文字手动复制')} onFocus={event => event.currentTarget.select()} onClick={() => void copy()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void copy(); } }} />
      <button className="button button-secondary device-copy-button" type="button" disabled={state === 'copying'} onClick={() => void copy()}>{state === 'copying' ? <LoaderCircle size={16} className="spin" /> : state === 'copied' ? <Check size={16} /> : <Copy size={16} />}{t(state === 'copying' ? '正在复制…' : state === 'copied' ? '已复制验证码' : state === 'failed' ? '重试复制验证码' : '复制验证码')}</button>
    </div>
    <p className={`device-copy-status${state === 'failed' ? ' failed' : ''}`} role="status">{t(state === 'copied' ? '验证码已复制，可粘贴到 GitHub 授权页面。' : state === 'failed' ? '复制失败。验证码仍可选中，使用 Ctrl+C / ⌘C 复制，或点击重试。' : state === 'copying' ? '正在写入剪贴板…' : '点击验证码或复制按钮，也可选中文本手动复制。')}</p>
  </div>;
}
