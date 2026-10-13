import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle2, CircleHelp, GitBranch, LoaderCircle, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../bridge';
import type { AuthState, ForkInfo } from '../../shared/types';
import { validateForkName } from '../../shared/fork';
import { t } from '../../shared/i18n';

interface ForkSettingsProps {
  auth: AuthState;
  repository: string;
  value: string;
  onChange: (repository: string) => void;
  onBusyChange?: (busy: boolean) => void;
}

export default function ForkSettings({ auth, repository, value, onChange, onBusyChange }: ForkSettingsProps) {
  const [forks, setForks] = useState<ForkInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<'validate' | 'create' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [customRepository, setCustomRepository] = useState(value);
  const [verified, setVerified] = useState<ForkInfo | null>(null);
  const [manual, setManual] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState(repository.split('/')[1] || 'Daily_CF_Problems');
  const createNameRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const loadRequestRef = useRef(0);
  const mutationRequestRef = useRef(0);
  const externalRequestRef = useRef(0);
  const mutationBusyRef = useRef(false);
  const busyChangeRef = useRef(onBusyChange);
  const enabled = api.isDesktop && Boolean(auth.user);

  function isCurrentLifecycle(lifecycle: number) {
    return mountedRef.current && lifecycleRef.current === lifecycle;
  }

  async function loadForks() {
    if (!enabled || !mountedRef.current || mutationBusyRef.current) return;
    const lifecycle = lifecycleRef.current;
    const request = ++loadRequestRef.current;
    const isCurrent = () => isCurrentLifecycle(lifecycle) && request === loadRequestRef.current;
    setLoading(true); setError(''); setMessage(''); setForks([]); setVerified(null);
    try {
      const choices = await api.getForks();
      if (!isCurrent()) return;
      setForks(choices);
      setVerified(choices.find((fork) => fork.fullName === value) ?? null);
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (isCurrent()) setLoading(false); }
  }

  useLayoutEffect(() => { busyChangeRef.current = onBusyChange; }, [onBusyChange]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    lifecycleRef.current += 1;
    mutationBusyRef.current = false;
    setForks([]); setVerified(null); setMessage(''); setError(''); setLoading(false); setWorking(null); setManual(false);
    setCreateOpen(false); setCreateName(repository.split('/')[1] || 'Daily_CF_Problems');
    if (enabled) void loadForks();
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      loadRequestRef.current += 1;
      mutationRequestRef.current += 1;
      externalRequestRef.current += 1;
      mutationBusyRef.current = false;
      busyChangeRef.current?.(false);
    };
  }, [auth.user?.login, repository, enabled]);

  useEffect(() => { setCustomRepository(value); }, [value]);
  useEffect(() => { setVerified(forks.find((fork) => fork.fullName === value) ?? null); }, [value, forks]);
  useEffect(() => { if (createOpen) createNameRef.current?.focus(); }, [createOpen]);

  function select(value: string) {
    if (!enabled || !mountedRef.current || mutationBusyRef.current) return;
    if (value === '__manual') { setManual(true); return; }
    setManual(false); setMessage(''); setError('');
    setVerified(forks.find((fork) => fork.fullName === value) ?? null);
    onChange(value);
  }

  function beginMutation(kind: 'validate' | 'create') {
    if (!enabled || !mountedRef.current || mutationBusyRef.current) return null;
    mutationBusyRef.current = true;
    const lifecycle = lifecycleRef.current;
    const request = ++mutationRequestRef.current;
    // An older list response must not replace a newly validated or created choice.
    loadRequestRef.current += 1;
    setLoading(false); setWorking(kind); setError(''); setMessage('');
    // Notify synchronously so a same-tick settings save can see the pending mutation.
    busyChangeRef.current?.(true);
    return () => isCurrentLifecycle(lifecycle) && request === mutationRequestRef.current;
  }

  function finishMutation(isCurrent: () => boolean) {
    if (!isCurrent()) return;
    mutationBusyRef.current = false;
    setWorking(null);
    busyChangeRef.current?.(false);
  }

  async function validate() {
    if (!customRepository.trim()) return;
    const isCurrent = beginMutation('validate');
    if (!isCurrent) return;
    try {
      const fork = await api.validateFork(customRepository.trim());
      if (!isCurrent()) return;
      setForks((current) => current.some((item) => item.fullName === fork.fullName) ? current : [...current, fork]);
      setVerified(fork); setManual(false);
      setMessage('已验证并选中此 Fork，确认后生效。');
      onChange(fork.fullName);
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { finishMutation(isCurrent); }
  }

  async function create() {
    if (!createOpen || !enabled || mutationBusyRef.current) return;
    let name: string;
    try { name = validateForkName(createName); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); createNameRef.current?.focus(); return; }
    const isCurrent = beginMutation('create');
    if (!isCurrent) return;
    try {
      const fork = await api.createFork(name);
      if (!isCurrent()) return;
      setForks((current) => current.some((item) => item.fullName === fork.fullName) ? current : [...current, fork]);
      setVerified(fork); setManual(false); setCreateOpen(false);
      setMessage('已创建并选中 Fork，保存或确认后生效。');
      onChange(fork.fullName);
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { finishMutation(isCurrent); }
  }

  async function openSelectedFork() {
    if (!verified || !mountedRef.current) return;
    const lifecycle = lifecycleRef.current;
    const request = ++externalRequestRef.current;
    try { await api.openExternal(verified.url); }
    catch (cause) {
      if (isCurrentLifecycle(lifecycle) && request === externalRequestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const selected = manual ? '__manual' : !value ? '' : forks.some((fork) => fork.fullName === value) ? value : '__manual';
  return <section className="panel settings-section fork-settings">
    <div className="settings-section-title"><h2><GitBranch size={20} />{t('Fork 仓库')}</h2><button className="icon-button" title={t('刷新我的 Fork')} aria-label={t('刷新我的 Fork')} onClick={() => void loadForks()} disabled={!enabled || loading || Boolean(working)}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>
    <p className="settings-description">{t('请选择并确认要使用的个人 Fork。代码将提交到该仓库，并向 ')}<strong>{repository}</strong>{t(' 发起 PR。')}</p>
    {!enabled && <div className="fork-connect-note"><CircleHelp size={15} /><span>{api.isDesktop ? t('登录 GitHub 后可选择或创建 Fork。') : t('请在桌面客户端中登录 GitHub 后管理 Fork 仓库。')}</span></div>}
    <div className="fork-select-row"><label className="field"><span>{t('提交来源仓库')}</span><select aria-label={t('提交来源仓库')} disabled={!enabled || loading || Boolean(working)} value={selected} onChange={(event) => select(event.target.value)}><option value="" disabled>{t('请选择 Fork 仓库')}</option>{forks.map((fork) => <option key={fork.fullName} value={fork.fullName}>{fork.fullName}{fork.ownedUpstream ? t('（当前账号拥有目标仓库）') : ''}</option>)}<option value="__manual">{t('手动指定 owner/repository…')}</option></select></label><button className="button button-secondary" type="button" onClick={() => { setCreateOpen(true); setError(''); setMessage(''); }} disabled={!enabled || loading || Boolean(working) || createOpen}><Plus size={15} />{t('创建 Fork')}</button></div>
    {createOpen && <div className="fork-create-panel" role="group" aria-label={t('创建 Fork')}><h3>{t('创建 Fork')}</h3><div className="fork-create-fields"><label className="field"><span>{t('所属账号')}</span><input value={auth.user?.login || ''} readOnly aria-readonly="true" /></label><label className="field"><span>{t('仓库名称')}</span><input ref={createNameRef} value={createName} disabled={Boolean(working)} onChange={event => { setCreateName(event.target.value); setError(''); }} autoComplete="off" spellCheck={false} maxLength={100} placeholder="Daily_CF_Problems" /></label></div><p className="fork-create-path">{auth.user?.login}/<strong>{createName.trim() || t('仓库名称')}</strong></p><p className="fork-create-help">{t('创建会立即在 GitHub 新建仓库；当前绑定需保存或确认后生效。')}</p>{forks.some(fork => !fork.ownedUpstream) && <p className="fork-create-limit"><CircleHelp size={15} /><span>{t('同一账号对同一项目只能保留一个 Fork。GitHub 若返回已有仓库，客户端会提示你手动选择。')}</span></p>}<div className="fork-create-actions"><button type="button" className="button button-secondary" disabled={Boolean(working)} onClick={() => { if (mutationBusyRef.current) return; setCreateOpen(false); setError(''); }}>{t('取消')}</button><button type="button" className="button button-primary" disabled={!enabled || Boolean(working) || !createName.trim()} onClick={() => void create()}>{working === 'create' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{working === 'create' ? t('正在创建…') : t('创建并选择')}</button></div></div>}
    {!createOpen && (manual || (value && !forks.some((fork) => fork.fullName === value))) && <div className="fork-manual"><label className="field"><span>{t('仓库全名')}</span><input disabled={!enabled || Boolean(working)} value={customRepository} onChange={(event) => setCustomRepository(event.target.value)} placeholder="your_name/Daily_CF_Problems" autoComplete="off" spellCheck={false} /><small>{t('支持改名后的 Fork；客户端会检查所属账号、写入权限与仓库来源。')}</small></label><button className="button button-secondary" onClick={() => void validate()} disabled={!enabled || Boolean(working) || !customRepository.trim()}>{working === 'validate' ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}{t('验证并选择')}</button></div>}
    <div className="fork-current"><GitBranch size={14} /><span>{t('当前选择：')}<strong>{value || t('尚未选择')}</strong></span>{verified?.fullName === value && <span className="verified-fork"><CheckCircle2 size={12} />{t('已验证')}</span>}{verified?.fullName === value && <button aria-label={t('查看所选 Fork')} title={t('查看 Fork')} onClick={() => void openSelectedFork()}><ArrowUpRight size={14} /></button>}</div>
    {loading && <p className="fork-operation"><LoaderCircle size={12} className="spin" />{t('正在查找已有 Fork…')}</p>}
    {message && <p className="fork-operation fork-operation-success"><CheckCircle2 size={13} />{t(message)}</p>}
    {error && <div className="inline-error" role="alert">{error}</div>}
  </section>;
}
